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
var results_key = os.hostname() + "-" + new Date().toString();

var bucket = "commoncrawl";
var completed_warc_count = 0;

var metrics = {
	"total_hits": 0,
	"regex_hits": {}
};

//var parallelism = getParallelism(parallelism_factor);
var parallelism = 1

function getParallelism(factor) {
	var cpus = os.cpus().length;
	var memory = os.totalmem() / 1024 / 1024 / 1024;

	var parallelism = 0;
	if (cpus * factor > (memory * 2) + 10) {
		parallelism = Math.floor(cpus * factor);
	} else {
		parallelism = Math.floor((memory - 20) / 2);
	}

	console.log(parallelism);

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
	#warcListLength = 0;

	constructor(queueUrl, queueTarget) {
		this.#queueUrl = queueUrl;
		this.#queueTarget = queueTarget;
		this.#sqs = new aws.SQS({region: "us-east-1"});
		this.#receiveSqsMessage();

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
			return false;
		}

		if (this.#sqsMessages.length == 0) {
			this.#state.populated = false;
			return false;
		}

		if (this.#sqsMessages[0].warcs.length == 0) {
			this.#deleteSqsMessage(this.#sqsMessages[0].receiptHandle);
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

		this.#callbacks[event] = {};
	};

	#receiveSqsMessage = function() {
		if (this.#state.receiving || this.#state.exhausted) {
			return Promise.resolve(false);
		}

		this.#state.receiving = true;

		var self = this;
		return new Promise((success, failure) => {
			self.#sqs.receiveMessage({
				QueueUrl: self.#queueUrl,
				MaxNumberOfMessages: 1
			}).promise()
			.then((data) => {
				if (!data.hasOwnProperty('Messages')) {
					console.log("Got empty response from SQS");

					self.#executeCallbacks('exhausted');

					self.#state.exhausted = true;
					self.#state.receiving = false;
					return success(false);
				}

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

				// If the queue is less than parallelism * 1.5, preload.
				if (self.#getWarcListLength() < self.#queueTarget) {
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
		//console.log("Command: " + command);
		exec('aws s3 cp s3://' + bucket + '/' + key + ' ' + outfile, (error, stdout, stderr) => {
			if (error) {
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

	// If the worc is otherwise wonky.
	if (typeof warc !== "string") {
		return Promise.resolve(false);
	}

	console.log("Got valid warc " + warc);

	var warchash = hash(warc);
	//console.log("[*] Processing ..." + warc.substring(warc.length - 15));

	var start_download = new Date();
	progress[warc] = -1;

	active_warcs[warc] = getObjectQuickly(bucket, warc, '/tmp/warcannon/' + warchash).then(() => {

		var end_download = new Date() - start_download;
		// console.log("[+] Downloaded " + warchash + " in " + Math.round(end_download / 1000) + " seconds.");

		progress[warc] = 0;
		var start_processing = new Date();
		fork('./main.js', ['/tmp/warcannon/' + warchash])
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
			completed_warc_count++;
			fire();
		});
	}).catch((e) => {
		// console.log(warc + " download failed; " + e);
		delete active_warcs[warc];
		delete progress[warc];
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
	
	var status = {
		instanceId: os.hostname(),
		load: os.loadavg(),
		progress: progress,
		until: Math.round(new Date() / 1000)
	};

	console.dir(status, null, 3);

	ddb.putItem({
		Item: aws.DynamoDB.Converter.marshall(status),
		TableName: "warcannon_progress",
		ReturnConsumedCapacity: "NONE",
		ReturnValues: "NONE"
	}).promise();

	if (!myQueue.isExhausted()) {
		setTimeout(reportStatus, 2000);
	}
};

function fire() {

	console.log("Attempting to start " + (parallelism - Object.keys(active_warcs).length) + " warcs");
	for (var a = Object.keys(active_warcs).length; a < parallelism; a++) {
		processNextWarc(myQueue.getNextWarcPath());
	}

	console.log(Object.keys(active_warcs).length + " warcs now active");

	let content = JSON.stringify(metrics);

	if (content.length > 250 * 1024 * 1024) {
		uploadResults(content, true);
		results_key	= os.hostname() + "-" + new Date().toString();
		metrics = {};
	} else {
		uploadResults(content);
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

try {
	getParallelism(parallelism_factor);
	var myQueue = new warcQueue(process.env.QUEUEURL, Math.ceil(parallelism * 1.5));

	myQueue.setCallback('populated', 'init', function() {
		console.log("Populated event fired with [" + myQueue.queueLength() + "] items in queue.");
		fire();

		setTimeout(reportStatus, 2000);
	});

	myQueue.setCallback('exhausted', 'init', function() {
		console.log("Exhausted event fired.");
	});

} catch (e) {
	console.log(e);
}
