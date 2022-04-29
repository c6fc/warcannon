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

		this.parallelism = this.settings.parallelism_factor * os.cpus().length;

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
		this.queue = new queue(this.parallelism, Infinity);
		this.messages = {};

		//this.instanceId = await this.getInstanceId();
		this.instanceId = "manual";

		console.log(`[*] Got Instance ID [ ${this.instanceId} ]`);

		this.receiveSQSMessage();
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
				return true;
			}

			message.Messages.map(e => {
				const warc_list = this.convertSQSMessageToWARCList(e);
				this.messages[e.ReceiptHandle] = warc_list;

				console.log(`[+] Message [ ${e.ReceiptHandle.substr(0, 8)} ] received with [ ${warc_list.length} ] WARCs`)

				warc_list.map(warc => {
					this.queue.add(() => this.processWarc(warc, e.ReceiptHandle))
				});
			});

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

	async processWarc(warc, ReceiptHandle) {

		this.progress[warc] = -1;
		const warcfile = await getObjectQuickly(warc);
		this.progress[warc] = 0;

		try {
			fork('./parse_regexv2.js', [warcfile])
				.on('message', (message) => {
					switch (message.type) {
						case "progress": 
							// I guess IPC can fire out-of-order under load?
							if (!progress.warc) {
								return false;
							}

							message.recordcount = (message.recordcount > max_records) ? max_records : message.recordcount;
							progress[warc] = (message.recordcount / max_records).toFixed(3);
						break;

						case "done":
							message = message.message;
							this.metrics.total_hits += message.total_hits

							Object.keys(message.regex_hits).forEach((e) => {
								if (!metrics.regex_hits.hasOwnProperty(e)) {
									metrics.regex_hits[e] = { domains: {} };
								}

								Object.keys(message.regex_hits[e].domains).forEach((d) => {
									if (!metrics.regex_hits[e].domains.hasOwnProperty(d)) {
										metrics.regex_hits[e].domains[d] = {
											"matches": [],
											"target_uris": []
										};
									}

									message.regex_hits[e].domains[d].matches.forEach((m) => {
										if (metrics.regex_hits[e].domains[d].matches.indexOf(m) < 0) {
											metrics.regex_hits[e].domains[d].matches.push(m);
										}
									});

									message.regex_hits[e].domains[d].target_uris.forEach((m) => {
										if (metrics.regex_hits[e].domains[d].target_uris.indexOf(m) < 0) {
											metrics.regex_hits[e].domains[d].target_uris.push(m);
										}
									});
								})
							});
						break;

						default:
							// console.log("Received unexpected IPC message.");
						break;
					}
				})
				.on('exit', () => {

				})
		} catch (e) {
			console.log(e);

			delete this.progress[warc];
			fs.unlinkSync(warcfile);
		}


		await this.removeWARCFromReceiptHandle(warc, ReceiptHandle)
	}
}

// Don't ask me, dude. I guess spawning the CLI is like a billion times faster than using the SDK.
getObjectQuickly(key) {
	return new Promise((success, failure) => {
		const outfile = `/tmp/warcannon/${hash(key)}`;
		const command = `aws s3 cp s3://commoncrawl/${key} ${outfile}`;

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