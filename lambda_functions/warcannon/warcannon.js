'use strict';

const os = require('os');
const fs = require('fs');
const aws = require('aws-sdk');
const zlib = require('zlib');
const queue = require('promise-queue');
const crypto = require('crypto');
const { exec, fork } = require('child_process');

const region = 'us-east-1';

const s3 = new aws.S3({ region });
const ddb = new aws.DynamoDB({ region });
const meta = new aws.MetadataService();

class WARCannon {
	constructor() {
		this.settings = {
			queue_factor: 0.5,
			parallelism_factor: 1
		};

		this.receivingSQSMessage = false;

		return this.configure(...arguments);
	}

	configure(settings = {}) {
		Object.assign(this.settings, settings);

		const max_parallelism = Math.floor(os.totalmem() / (1073741824 * 0.6)); // Reserve 0.6GiB of memeory per thread.
		// const max_parallelism = Math.floor(os.totalmem() / (1073741824 * 1.7)); // Reserve 1.7GiB of memeory per thread.
		this.parallelism = Math.floor(this.settings.parallelism_factor * os.cpus().length);
		this.parallelism = (this.parallelism > max_parallelism) ? max_parallelism : this.parallelism;

		console.log(`[*] Using parallelism of [ ${this.parallelism} ]`);

		console.log(this.settings);

		return this;
	}

	getInstanceId() {
		// I guess there's no .promise() method for IMDS.
		return new Promise((success, failure) => {
			meta.request('/latest/meta-data/instance-id', {
				method: "GET"
			}, (err, data) => {
				if (err)
					return success("manual");

				return success(data);
			});
		});
	}

	async start() {
		console.log(`[+] Starting WARCannon.`);

		this.sqs = new aws.SQS({ region });
		this.queue = new queue(this.parallelism, Infinity, { onEmpty: () => this.queueEmpty() });
		this.metrics = { regex_hits: {}, total_hits: 0 };
		this.messages = {};
		this.progress = {};

		this.startTime = new Date();
		this.lastUpload = new Date();

		this.completedWarcCount = 0;

		//this.statusReport = setTimeout(() => this.sendStatusReport(), 10000);

		this.instanceId = await this.getInstanceId();
		//this.instanceId = "manual";

		this.state = "Starting";

		console.log(`[*] Got Instance ID [ ${this.instanceId} ]`);

		await this.receiveSQSMessage();
		this.sendStatusReport();
	}

	async receiveSQSMessage() {
		if (!this.receivingSQSMessage && this.queue.getQueueLength() < this.parallelism * this.settings.queue_factor) {
			this.receivingSQSMessage = true;

			console.log(`[*] Loading message from SQS queue.`);

			const message = await this.sqs.receiveMessage({
				QueueUrl: this.settings.sqs_url,
				MaxNumberOfMessages: 1
			}).promise();

			if (!message.Messages || message.Messages?.length == 0) {
				console.log(`[-] Got empty response from SQS`);
				this.state = "Draining";
				return true;
			}

			message.Messages.map(e => {
				const warc_list = this.convertSQSMessageToWARCList(e);
				this.messages[e.ReceiptHandle] = warc_list;

				console.log(`[+] Message [ ${e.ReceiptHandle.substr(0, 8)} ] received with [ ${warc_list.length} ] WARCs`)

				warc_list.map((warc, i) => {
					this.queue.add(() => this.processWarc(warc, e.ReceiptHandle))
				});
			});

			this.state = "Running";
			console.log(`[*] Queue has [ ${this.queue.getPendingLength()} ] pending and [ ${this.queue.getQueueLength()} ] queued.`);

			this.receivingSQSMessage = false;

			if (this.queue.getQueueLength() < this.parallelism * this.settings.queue_factor) {
				return this.receiveSQSMessage();
			}
		}

		return true;
	}

	async removeWARCFromReceiptHandle(warc, ReceiptHandle) {
		// Remove the warc based on its index.
		this.messages[ReceiptHandle].splice(
				this.messages[ReceiptHandle].indexOf(warc),
				1
			);

		// If the ReceiptHandle is empty, delete the message from SQS:
		if (this.messages[ReceiptHandle].length == 0) {
			console.log(`[*] [ ${ReceiptHandle.substr(0, 8)} ] Finished.`);
			await this.sqs.deleteMessage({
				QueueUrl: this.settings.sqs_url,
				ReceiptHandle
			}).promise();

			console.log(`[+] [ ${ReceiptHandle.substr(0, 8)} ] Deleted.`);

			delete this.messages[ReceiptHandle];

			this.receiveSQSMessage();
		}
	}

	convertSQSMessageToWARCList(message) {
		const chunks = JSON.parse(message.Body);

		return Object.keys(chunks)
			.reduce((acc, cur) => {
				return acc.concat(chunks[cur].map(e => `${cur}${e}.warc.gz`));
			}, []);
	}

	generateResultKey() {
		return `${this.instanceId}_${new Date().toISOString()}.json`;
	}

	async queueEmpty() {
		clearTimeout(this.statusReport);
		await this.sendStatusReport();
	}

	async sendStatusReport() {
		const partialWarcCount = Object.keys(this.progress)
			.filter(e => this.progress[e] > 0)
			.reduce((acc, e) => acc + this.progress[e], 0);

		const status = {
			timestamp: new Date() - 0,
			parallelism: this.parallelism,
			instanceId: this.instanceId,
			load: os.loadavg(),
			memory: {
				free: os.freemem(),
				total: os.totalmem()
			},
			progress: this.progress,
			state: this.state,
			totalHits: this.metrics.total_hits,
			completedWarcCount: this.completedWarcCount,
			partialWarcCount: this.completedWarcCount + (partialWarcCount / 100),
			runtime: Math.round((new Date() - this.startTime) / 1000),
			warcListLength: this.queue.getPendingLength() + this.queue.getQueueLength(),
			until: Math.round((new Date() / 1000) + 300)
		}

		if (status.warcListLength > 0) {
			this.statusReport = setTimeout(() => this.sendStatusReport(), 10000);
		} else {
			console.log(`[+] Queue is empty. Work is done.`);
			status.state = "Exhausted";

			await this.uploadResults(true);

			await ddb.putItem({
				Item: aws.DynamoDB.Converter.marshall(status),
				TableName: "warcannon_progress",
				ReturnConsumedCapacity: "NONE",
				ReturnValues: "NONE"
			}).promise();

			return Promise.resolve();
		}

		return ddb.putItem({
			Item: aws.DynamoDB.Converter.marshall(status),
			TableName: "warcannon_progress",
			ReturnConsumedCapacity: "NONE",
			ReturnValues: "NONE"
		}).promise();
	}

	async uploadResults(force = false) {

		if (!force && this.lastUpload > new Date() - 10000) {
			// console.log(`[-] Results were saved too recently. Skipping.`);
			return Promise.resolve(false);
		}

		this.results_key ??= this.generateResultKey();

		const results = JSON.stringify(this.metrics);

		const key = this.results_key.toString();
		if (results.length > (250 * 1024 * 1024)) {
			console.log(`[+] Results is [ ${results.length / (1024 * 1024).toFixed(3)} ] MiB. Saving to ${this.results_key}. Before rotating key.`);
			await s3.putObject({
				Bucket: this.settings.results_bucket,
				Key: this.results_key,
				Body: results,
				ContentType: "application/json"
			}).promise();

			this.metrics = { regex_hits: {}, total_hits: 0 };
			this.results_key = this.generateResultKey();

			console.log(`[*] Key rotated to ${this.results_key}`);

			return Promise.resolve();
		}

		console.log(`[*] Saving results.`);
		this.lastUpload = new Date();

		return s3.putObject({
			Bucket: this.settings.results_bucket,
			Key: this.results_key,
			Body: results,
			ContentType: "application/json"
		}).promise();
	}

	async processWarc(warc, ReceiptHandle) {

		/*this.progress[warc] = -1;
		
		let warcfile = "";
		try {
			warcfile = await getObjectQuickly(warc);
		} catch (e) {
			delete this.progress[warc];
			this.queue.add(() => this.processWarc(warc, ReceiptHandle));
			return Promise.resolve();
		}*/

		this.progress[warc] = 0;

		await new Promise((success, failure) => {
			try {
				// fork('./parse_regex.js', [warcfile])
				fork('./parse_regex.js', [warc])
					.on('message', (message) => {
						switch (message.type) {
							case "progress":

								// I guess IPC can fire out-of-order under load?
								if (!this.progress.hasOwnProperty(warc)) {
									return false;
								}

								message.recordcount = (message.recordcount > 130000) ? 130000 : message.recordcount;
								this.progress[warc] = Math.round(message.recordcount / 15) / 100;
							break;

							case "done":
								message = message.message;
								
								this.metrics.total_hits ??= 0;
								this.metrics.regex_hits ??= {};

								this.metrics.total_hits += message.total_hits

								Object.keys(message.regex_hits).map((e) => {
									this.metrics.regex_hits[e] ??= {};

									let metric = this.metrics.regex_hits[e];
									let matches = message.regex_hits[e];

									// Concatenate unique URI results, up to 3 per unique result+domain combination.
									Object.keys(matches).map(hash => {
										metric[hash] ??= { value: matches[hash].value };
										Object.keys(matches[hash])
											.filter(x => x !== "value")
											.map(domain => {
												metric[hash][domain] ??= [];

												if (metric[hash][domain].length < 3) {
													metric[hash][domain] = metric[hash][domain]
														.concat(matches[hash][domain].filter(uri => !metric[hash][domain].includes(uri)))
														.splice(0, 3);
												}
											});
									});
								});
							break;

							default:
								
							break;
						}
					})
					.on('exit', () => {
						try {
							this.completedWarcCount++;
							delete this.progress[warc];
							// fs.unlinkSync(warcfile);
						} catch (e) {
							// dgaf
						}

						return success();
					})
					.on('error', () => {
						try {
							delete this.progress[warc];
							// fs.unlinkSync(warcfile);
						} catch (e) {
							// dgaf
						}

						return success();
					})
			} catch (e) {
				console.log(e);

				try {
					delete this.progress[warc];
					// fs.unlinkSync(warcfile);
				} catch (e) {
					// dgaf
				}

				return success();
			}
		});

		await this.uploadResults();
		await this.removeWARCFromReceiptHandle(warc, ReceiptHandle)
	}
}

// Don't ask me, dude. I guess spawning the CLI is like a billion times faster than using the SDK.
function getObjectQuickly(key) {
	return new Promise((success, failure) => {
		const outfile = `/tmp/warcannon/${hash(key)}`;
		const command = `aws s3 cp s3://commoncrawl/${key} ${outfile}`;
		// const command = `./staggerS3File.sh ${key} ${outfile}`;

		// console.log("Command: " + command);
		exec(command, (error, stdout, stderr) => {
			if (error) {
				if (fs.existsSync(outfile)) {
					fs.unlinkSync(outfile);
				}

				return failure("CLI Error: " + error);
			} else {
				return success(outfile);
			}
		})
	});
}

function hash(what) {
	return crypto.createHash("sha1").update(what).digest("hex");
}

function tail(what, length) {
	// what = " ".repeat(length) + what;
	return what.substr(0 - length);
}

exports.WARCannon = WARCannon;