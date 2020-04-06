'use strict';

if (process.argv.length < 6) {
	console.log("Usage: node " + process.argv[1] + " </path/to/warc_files.gz> <this_node> <node_count> <parallelism> <results_bucket>");
	process.exit();
}

var warc_paths = [];
var warc_file_path = process.argv[2];
var this_node = process.argv[3];
var node_count = process.argv[4];
var parallelism = process.argv[5];
var results_bucket = process.argv[6];

var warcannon_start = new Date();

if (this_node < 1 || this_node > node_count) {
	console.log("<this_node> must be greater than 1 and less than or equal to <node_count>");
}

const fs = require('fs');
const aws = require('aws-sdk');
const zlib = require('zlib');
const crypto = require('crypto');
const progress = require('cli-progress');
const { exec, fork } = require('child_process');
const results_filename = hash(warc_file_path) + '-' + this_node + '_of_' + node_count + '.json';
var last_result_upload = new Date();

const multibar = new progress.MultiBar({
	format: "{bar} [{value}] ETA: {eta}s {filename}",
	barsize: 80,
    clearOnComplete: false,
    hideCursor: true
 
}, progress.Presets.shades_grey);

var max_records = 150000;

var progress_bars = {};
var total_progress_bar = null;

var s3 = new aws.S3({region: "us-east-1"});

var bucket = "commoncrawl";
var key = warc_file_path;
var completed_warc_count = 0;

var metrics = {
	"total_hits": 0,
	"regex_hits": {}
};

function getObject(bucket, key) {
	return new Promise((success, failure) => {
		s3.getObject({
			Bucket: bucket,
			Key: key
		}, function(err, data) {
			if (err) {
				return failure(err);
				process.exit();
			}

			success(data.Body);
		});
	});
}

function putObject(bucket, key, contents, contentType = "text/plain") {
	return new Promise((success, failure) => {
		s3.putObject({
			Body: contents,
			Bucket: bucket,
			Key: key,
			ContentType: contentType
		}, function(err, data) {
			if (err) {
				return failure(err);
				process.exit();
			}

			success(data);
		});
	});
}

// Don't ask me, dude. I guess spawning the CLI is like a billion times faster than using the SDK.
function getObjectQuickly(bucket, key, outfile) {
	return new Promise((success, failure) => {
		var command = 'aws s3 cp s3://' + bucket + '/' + key + ' ' + outfile;
		// console.log("Command: " + command);
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

function getWarcPaths() {
	console.log("[*] Retrieving Warc Paths")

	return new Promise((success, failure) => {
		getObject(bucket, key).then((data) => {
			zlib.gunzip(data, function(err, body) {
				if (err) {
					return failure(err);
				}

				warc_paths = body.toString().split("\n");
				warc_paths.pop();
				var total_paths = warc_paths.length;
				var per_node = Math.ceil(warc_paths.length / node_count);
				warc_paths = warc_paths.slice(per_node * (this_node - 1), per_node * this_node);
				console.log("[*] Paths retrieved. Processing " + warc_paths.length + " of " + total_paths);

				success();
			});
		});	
	});
}

function tail(what, length) {
	// what = " ".repeat(length) + what;
	return what.substr(0 - length);
}

var active_warcs = {};
function processNextWarc() {
	
	if (active_warcs.length >= parallelism) {
		// Race conditions exist that could put the active > parallelism, so don't do it.
		return false;
	}

	var warc = warc_paths.shift();

	if (typeof warc === "undefined") {

		// If the warclist is empty
		return false;
	}

	var warchash = hash(warc);
	//console.log("[*] Processing ..." + warc.substring(warc.length - 15));

	var start_download = new Date();
	progress_bars[warc] = multibar.create(max_records, 0, {filename: "{inc} " + tail(warc, 24)});
	active_warcs[warc] = getObjectQuickly(bucket, warc, '/tmp/warcannon/' + warchash).then(() => {

		var end_download = new Date() - start_download;
		// console.log("[+] Downloaded " + warchash + " in " + Math.round(end_download / 1000) + " seconds.");
		progress_bars[warc].update(0, {filename: "{" + Math.round(end_download / 1000) + "} " + tail(warc, 24)});

		var start_processing = new Date();
		fork('./main.js', ['/tmp/warcannon/' + warchash])
		.on('message', (message) => {

			switch (message.type) {
				case "progress": 
					if (!progress_bars.hasOwnProperty(warc)) {
						console.log("Dude, seriously?: " + warc);
						return false;
					}

					message.recordcount = (message.recordcount > max_records) ? max_records : message.recordcount;
					progress_bars[warc].update(message.recordcount, {
						filename: tail(warc, 30)
					});
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
			// var end_processing = new Date() - start_processing;
			//console.log("[+] Finished processing " + warchash + " after " + Math.round(end_processing / 1000) + " seconds");
			fs.unlinkSync('/tmp/warcannon/' + warchash);
			delete active_warcs[warc];
			multibar.remove(progress_bars[warc])
			delete progress_bars[warc];
			completed_warc_count++;
			fire();
		});
	}).catch((e) => {
		console.log(warc + " download failed; " + e);
		delete active_warcs[warc];
		multibar.remove(progress_bars[warc])
		delete progress_bars[warc];
		warc_paths.push(warc);
	});
}

var timeout = null;
function fire() {

	/*
	if (Object.keys(active_warcs).length < parallelism) {
		processNextWarc();
	}
	*/

	for (var a = Object.keys(active_warcs).length; a < parallelism; a++) {
		processNextWarc();
	}

	total_progress_bar.update(completed_warc_count);

	if (new Date() - last_result_upload > 30000) {
		last_result_upload = new Date();
		putObject(results_bucket, results_filename, JSON.stringify(metrics), "text/json");
	}

	if (warc_paths.length == 0) {
		finish();
	}
}

function finish() {
	if (timeout == null && Object.keys(active_warcs).length == 0) {
		multibar.stop();
		console.log("[+] Warc processing is complete.");
		putObject(results_bucket, results_filename, JSON.stringify(metrics), "text/json").then(() => {
			console.log("[+] Results File Uploaded to S3");
		});
		console.log(metrics);
	}
}

try {
	getWarcPaths().then(() => {
		total_progress_bar = multibar.create(warc_paths.length, 0, {filename: " [Of All WARCs] "});
		fire();
	});	
} catch (e) {
	console.log(e);
	fs.writeFileSync("./error-" + results_filename, JSON.stringify(metrics));
}
