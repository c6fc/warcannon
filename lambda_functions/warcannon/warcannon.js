'use strict';

if (process.argv.length < 5) {
	console.log("Usage: node " + process.argv[1] + " <results_bucket> <sqs_url> <parallelism_factor>");
	process.exit();
}

var warc_paths = [];
var failed_warcs = [];
var results_bucket = process.argv[2];
var sqs_url = process.argv[3];
var sqs_isEmpty = false;
var parallelism_factor = process.argv[4];

var warcannon_start = new Date();

const os = require('os');
const fs = require('fs');
const aws = require('aws-sdk');
const zlib = require('zlib');
const crypto = require('crypto');
const { exec, fork } = require('child_process');
var last_warc_lookup = 0;
var last_result_upload = new Date();
var fire_delay = null;

var max_records = 150000;

var progress = {};

var s3 = new aws.S3({region: "us-east-1"});
var ddb = new aws.DynamoDB({region: "us-east-1"});
var meta = new aws.MetadataService();

var instance_id = "";
var results_key = "";

var bucket = "commoncrawl";
var completed_warc_count = 0;

var metrics = {
	"total_hits": 0,
	"regex_hits": {}
};

var state = "starting";

var parallelism = getParallelism(parallelism_factor);

function getInstanceId() {
	return new Promise((success, failure) => {
		meta.request('/latest/meta-data/instance-id', {
			method: "GET"
		}, function(err, data) {
			if (err) {
				console.log("Unable to get instance metadata: " + err);
				console.log("Setting instance ID to 'manual'");
				instance_id = "manual";
				return success("manual");
			}

			console.log("[+] Got instance id: " + data);
			instance_id = data;

			return success(data);
		});
	});
}

function getParallelism(factor) {
	var cpus = os.cpus().length;
	var memory = os.totalmem() / 1024 / 1024 / 1024;

	parallelism = Math.floor(memory * 0.8 / 1.2);
	if (cpus * factor < parallelism) {
		parallelism = Math.floor(cpus * factor);
	}

	console.log("[+] Using parallelism " + parallelism);

	return parallelism;
}

function getWarcListLength() {
	var length = 0;
	warc_paths.forEach(function(e) {
		length += e.warcs.length;
	});

	return length;
}

let warcQueue = class {
	#sqs = "";
	#state = {
		exhausted: false,
		populated: false,
		receiving: false		
	};
	#queueUrl = "";
	#queueTarget = 0;
	#callbacks = {
		received: {},
		populated: {},
		exhausted: {}
	};

	#sqsMessages = [];
	#sqsDeleteQueue = [];
	#sqsProgress = {};
	#warcListLength = 0;

	constructor(queueUrl, queueTarget) {
		this.#queueUrl = queueUrl;
		this.#queueTarget = queueTarget;
		this.#sqs = new aws.SQS({region: "us-east-1"});
		this.#receiveSqsMessage();

		console.log("[+] WarcQueue started with target [" + queueTarget + "]");

		return this;
	};

	isExhausted = function() {
		return this.#state.exhausted;
	};
	
	isPopulated = function() {
		return this.#state.populated;
	};

	isReceiving = function() {
		return this.#state.receiving;
	};

	queueLength = function() {
		return this.#warcListLength;
	};

	setCallback = function(event, index, callback) {
		this.#callbacks[event][index] = callback;

		return this;
	};

	#deleteSqsMessage = function(receiptHandle) {

		var self = this;
		var deletePromises = [];

		this.#sqsDeleteQueue.push(receiptHandle);
		this.#sqsDeleteQueue.forEach(function(e) {
			deletePromises.push(new Promise((success, failure) => {
				self.#sqs.deleteMessage({
					QueueUrl: self.#queueUrl,
					ReceiptHandle: e
				}).promise()
				.then(() => {
					return true;
				}, (err) => {
					console.log("warcQueue: Failed to remove SQS message. Added back to the deletion queue.");
				});
			}));
		});

		return Promise.allSettled(deletePromises);
	}

	getNextWarcPath = function() {
		if (!this.#state.populated) {
			if (!this.#state.receiving) {
				this.#receiveSqsMessage();
			}

			return false;
		}

		if (this.#sqsMessages.length == 0) {
			this.#state.populated = false;
			return false;
		}

		if (this.#sqsMessages[0].warcs.length == 0) {
			this.#sqsMessages.shift();

			return this.getNextWarcPath();
		}

		return this.#sqsMessages[0].warcs.shift();
	};

	#getWarcListLength = function() {
		var length = 0;

		this.#sqsMessages.forEach(function(e) {
			length += e.warcs.length;
		});

		return length;
	};

	#executeCallbacks = function(event) {
		var self = this;

		Object.keys(this.#callbacks[event]).forEach(function(index) {
			self.#callbacks[event][index]();
		});
	};

	markWarcComplete = function(warc) {
		var self = this;

		Object.keys(this.#sqsProgress).forEach(function(i) {
			if (self.#sqsProgress[i].indexOf(warc) > -1) {
				self.#sqsProgress[i].splice(self.#sqsProgress[i].indexOf(warc), 1);

				if (self.#sqsProgress[i].length == 0) {
					delete self.#sqsProgress[i];
					self.#deleteSqsMessage(i);
				}
			}
		});
	};

	#receiveSqsMessage = function() {
		if (this.#state.receiving || this.#state.exhausted) {
			return Promise.resolve(false);
		}

		this.#state.receiving = true;
		console.log("[+] Queue is receiving...");

		var self = this;
		return new Promise((success, failure) => {
			self.#sqs.receiveMessage({
				QueueUrl: self.#queueUrl,
				MaxNumberOfMessages: 1
			}).promise()
			.then((data) => {
				if (!data.hasOwnProperty('Messages')) {
					console.log("[-] Got empty response from SQS. Marking queue exhausted.");

					self.#executeCallbacks('exhausted');

					self.#state.exhausted = true;
					self.#state.receiving = false;
					return success(false);
				}

				console.log("[+] Received message from SQS. Adding to queue...");

				data.Messages.forEach(function(message) {
					var warc_list = [];
					var warc_chunks = JSON.parse(message.Body);

					Object.keys(warc_chunks).forEach(function(w) {
						warc_chunks[w].forEach(function(s) {
							warc_list.push(w + s + ".warc.gz");
						});
					});

					self.#sqsMessages.push({
						receiptHandle: message.ReceiptHandle,
						warcs: warc_list
					});

					self.#sqsProgress[message.ReceiptHandle] = JSON.parse(JSON.stringify(warc_list));
				});

				self.#warcListLength = self.#getWarcListLength();

				// Raise 'received'
				self.#state.receiving = false;
				self.#executeCallbacks("received");

				// If we were empty, raise 'populated' too.
				if (!self.#state.populated) {
					self.#state.populated = true;
					self.#executeCallbacks('populated');
				}

				// If the queue is less than target, preload.
				if (self.#getWarcListLength() < self.#queueTarget) {
					console.log("[*] Preload triggered.");
					self.#receiveSqsMessage();
				}

				return success(true);
			}, (err) => {
				console.log("Encountered error: " + err);
				return success(false);
			});
		});
	};
}

// Don't ask me, dude. I guess spawning the CLI is like a billion times faster than using the SDK.
function getObjectQuickly(bucket, key, outfile) {
	return new Promise((success, failure) => {
		var command = 'aws s3 cp s3://' + bucket + '/' + key + ' ' + outfile;
		// console.log("Command: " + command);
		exec('aws s3 cp s3://' + bucket + '/' + key + ' ' + outfile, (error, stdout, stderr) => {
			if (error) {
				if (fs.existsSync(outfile)) {
					fs.unlinkSync(outfile);
				}

				return failure("CLI Error: " + error);
			} else {
				return success();
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

var active_warcs = {};
function processNextWarc(warc) {
	if (active_warcs.length >= parallelism) {
		// Race conditions exist that could put the active > parallelism, so don't do it.
		return false;
	}

	// getNextWarcPath will return false if warcs are exhausted or not populated.
	if (warc === false) {
		return Promise.resolve(false);
	}

	// If the warc is otherwise wonky.
	if (typeof warc !== "string") {
		return Promise.resolve(false);
	}

	// If the warc is already running. This can happen if SQS is populated weirdly.
	// markWarcComplete should mark common warcs in all messages complete when it finishes.
	if (progress.hasOwnProperty(warc)) {
		return Promise.resolve(false);
	}

	// console.log("Got valid warc " + warc);

	var warchash = hash(warc);
	// console.log("[*] Processing ..." + warc.substring(warc.length - 15));

	var start_download = new Date();
	progress[warc] = -1;

	active_warcs[warc] = getObjectQuickly(bucket, warc, '/tmp/warcannon/' + warchash).then(() => {

		var end_download = new Date() - start_download;
		// console.log("[+] Downloaded " + warchash + " in " + Math.round(end_download / 1000) + " seconds.");

		progress[warc] = 0;
		var start_processing = new Date();
		fork('./parse_regex.js', ['/tmp/warcannon/' + warchash])
		.on('message', (message) => {

			switch (message.type) {
				case "progress": 
					// I guess IPC can fire out-of-order under load?
					if (!progress.hasOwnProperty(warc)) {
						return false;
					}

					message.recordcount = (message.recordcount > max_records) ? max_records : message.recordcount;
					progress[warc] = Math.round(message.recordcount / max_records * 10000) / 100;
				break;

				case "done":
					message = message.message;
					metrics.total_hits += message.total_hits

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
			fs.unlinkSync('/tmp/warcannon/' + warchash);
			delete active_warcs[warc];
			delete progress[warc];
			myQueue.markWarcComplete(warc);
			completed_warc_count++;
			fire();
		});
	}).catch((e) => {
		console.log(warc + " download failed; " + e);
		delete active_warcs[warc];
		delete progress[warc];
		myQueue.markWarcComplete(warc);
		failed_warcs.push(warc);
		fire_delay = setTimeout(function() {
			fire();
		}, 10000);
	});
}

function uploadResults(what, force = false) {
	if (!force && last_result_upload > new Date() - 10000) {
		return Promise.resolve(false);
	}

	last_result_upload = new Date();

	return s3.putObject({
		Bucket: results_bucket,
		Key: results_key,
		Body: what,
		ContentType: "application/json",
	}).promise();
};

function reportStatus() {

	var partialWarcs = 0;
	Object.keys(progress).forEach(function(e) {
		if (progress[e] > 0) {
			partialWarcs += progress[e];
		}
	});
	
	var status = {
		timestamp: new Date() - 0,
		parallelism: parallelism,
		instanceId: instance_id,
		load: os.loadavg(),
		memory: {
			free: os.freemem(),
			total: os.totalmem()
		},
		progress: progress,
		state: state,
		completedWarcCount: completed_warc_count,
		partialWarcCount: completed_warc_count + (partialWarcs / 100),
		runtime: Math.round((new Date() - warcannon_start) / 1000),
		warcListLength: myQueue.queueLength(),

		// Until is set to 5 minutes. This should allow for the spot fleet to cycle without killing the fleet
		until: Math.round((new Date() / 1000) + 300)
	};

	console.dir(status, null, 3);

	ddb.putItem({
		Item: aws.DynamoDB.Converter.marshall(status),
		TableName: "warcannon_progress",
		ReturnConsumedCapacity: "NONE",
		ReturnValues: "NONE"
	}).promise();

	if (!myQueue.isExhausted() || Object.keys(active_warcs).length > 0) {
		setTimeout(reportStatus, 10000);
	}
};

function fire() {

	if (!myQueue.isExhausted()) {
		console.log("Attempting to start " + (parallelism - Object.keys(active_warcs).length) + " warcs");
		for (var a = Object.keys(active_warcs).length; a < parallelism; a++) {
			processNextWarc(myQueue.getNextWarcPath());
		}
	}

	let active = Object.keys(active_warcs).length;
	console.log("[+] " + active + " warcs now active");

	if (active < parallelism) {
		// setTimeout(fire, 4000); //why is this so hard?
	}

	let content = JSON.stringify(metrics);

	if (content.length > 250 * 1024 * 1024) {
		uploadResults(content, true);
		results_key = instance_id + "_" + new Date().toISOString();
		metrics = {};
	} else {
		uploadResults(content);
	}

	if (myQueue.isExhausted() && Object.keys(active_warcs).length == 0) {
		state = "finished";
		console.log("[+] All work complete.");
		uploadResults(content, true).then(() => {
			console.log("[+] All results uploaded.");
			setTimeout(function() {
				reportStatus();
			}, 10000);
		});
	}
}

function finish() {
	if (timeout == null && Object.keys(active_warcs).length == 0) {
		console.log("[+] Warc processing is complete.");

		putObject(results_bucket, results_filename, JSON.stringify(metrics), "text/json").then(() => {
			console.log("[+] Results File Uploaded to S3");
		});

		console.log(metrics);
	}
}

var myQueue = new warcQueue(sqs_url, Math.ceil(parallelism * 1));
// var myQueue = new warcQueue(sqs_url, 1);

try {

	myQueue.setCallback('populated', 'init', function() {
		state = "running";
		console.log("Populated event fired with [" + myQueue.queueLength() + "] items in queue.");
		fire();
	});

	myQueue.setCallback('exhausted', 'init', function() {
		state = "running - exhausted";
		console.log("Exhausted event fired.");
	});

	getInstanceId().then(() => {
		results_key = instance_id + "_" + new Date().toISOString();

	 	reportStatus();
	});

} catch (e) {
	console.log(e);
}
