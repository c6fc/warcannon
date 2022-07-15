'use strict';

var start = new Date();

const fs = require("fs");
const os = require("os");
const aws = require("aws-sdk");
const zlib = require('minizlib');
const crypto = require('crypto');
const { Duplex } = require('stream');
const { WARCStreamTransform } = require('node-warc');
const { mime_types, domains, regex_patterns, custom_functions } = require("./matches.js");

const combined = new RegExp(Object.keys(regex_patterns).map(e => {
	return `(?<${e}>${regex_patterns[e].source})`
}).join("|"), 'g');

const s3 = new aws.S3({ region: "us-east-1" });

const isLocal = !!process.env?.WARCANNON_IS_LOCAL;

let resultsPath = false;

exports.main = function(parser) {

	let regexStartTime = 0;
	let recordStartTime = 0;

	const recordCost = { count: 0, total: 0 };

	if (isLocal) {
		console.log('[*] parse_regex.js: Running in test mode.');
		resultsPath = `${os.homedir()}/.warcannon/`;
	}

	const parseStartTime = hrtime();

	return new Promise((success, failure) => {
		process.send = (typeof process.send == "function") ? process.send : console.log;

		const metrics = {
			total_hits: 0,
			regex_hits: {}
		};

		// Catch sigint when running locally, and save results.
		if (isLocal) {
			process.on('SIGINT', function() {
				console.log(`\n\n[!] Caught interrupt. Saving results to [ ` + `${ resultsPath }localResults.json`.blue + ` ]\n`);
				console.log("--- Performance statistics ---");
				const record = roundAvg(recordCost.total, recordCost.count);
				const totalTime = hrtime() - parseStartTime;
				const avgTotal = totalTime / recordCost.count;
				console.log(`Total processing time: ${totalTime}`);
				console.log(`Average per-record Total processing time:  ${Math.round(avgTotal)}ns`);
				console.log(`Average per-record RegExp processing time: ${record}ns`);

				const ratio = avgTotal / record;
				const estimatedCost = 25 / (avgTotal - record) * avgTotal;

				console.log(`RegExp ration to overhead is ${ratio.toFixed(2)}`);
				console.log(`Rough estimate cost for 72,000 WARC campaign: $${estimatedCost.toFixed(2)}`);
				console.log("^ this will be wildly inaccurate (low) in 'testLocal -s' mode.");

				var total_mem = 0;
				var mem = process.memoryUsage();
				console.log("\n--- Memory statistics ---");
				for (let key in mem) {
					console.log(`${key} ${Math.round(mem[key] / 1024 / 1024 * 100) / 100} MB`);
					total_mem += mem[key];
				}

				console.log(`${Math.round(total_mem / 1024 / 1024 * 100) / 100} MB`);
				fs.writeFileSync(`${resultsPath}localResults.json`, JSON.stringify(metrics));

				console.log(`\n[*] Exiting gracefully.`);
				process.exit();
			});
		}

		Object.keys(regex_patterns).map((e) => {
			metrics.regex_hits[e] = {};
		});

		let records = 0;
		let records_processed = 0;
		let last_status_report = new Date();

		parser.on('data', (record) => {

			if (new Date() - last_status_report > 1000) {
				last_status_report = new Date();
				process.send({type: "progress", recordcount: records, recordsprocessed: records_processed});
			}

			records++;

			// Only process response records with mime-types we care about.
			if (record.warcHeader['WARC-Type'] != "response") {
				return true;
			}

			if (mime_types.length > 0 && !mime_types.includes(record.warcHeader['WARC-Identified-Payload-Type'])) {
				return true;
			}

			const domain = record.warcHeader['WARC-Target-URI'].split('/')[2];

			// Only process warcs in the domains we specify.
			if (!!domains.length && !domains.includes(domain)) {
				return true;
			}

			records_processed++;

			if (isLocal) {
				recordStartTime = hrtime();
			}

			const matches = record.content.toString().matchAll(combined);

			// matchAll is an iterator with one match per capture group per yield
			// Capture groups with no match are undefined.
			for (const match of matches) {
				Object.keys(match.groups).map(e => {
					if (!!!match.groups[e]) {
						return false;
					}

					let value = match.groups[e];
					if (!!custom_functions[e]) {
						value = custom_functions[e](value);

						// (return === false) drops the result
						if (value === false) {
							return false;
						}
					}

					metrics.total_hits++;
					value = value.trim().replace(/['"]+/g, "");
					const key = hash(value);

					metrics.regex_hits[e][key] ??= { value };
					metrics.regex_hits[e][key][domain] ??= [];

					let uri = record.warcHeader['WARC-Target-URI'];
					let uris = metrics.regex_hits[e][key][domain];

					if (uris.length < 3 && !uris.includes(uri)) {
						uris.push(uri);
					}

				});
			}

			if (isLocal) {
				recordCost.count++
				recordCost.total += hrtime() - recordStartTime;
			}

			return true;
		});

		parser.on('end', function () {
			
			process.send({message: metrics, type: "done"});

			if (isLocal) {
				console.log(`\n\n[+] Parser finished. Saving results to [ ` + `${ resultsPath }localResults.json`.blue + ` ]\n`);
				console.log("--- Performance statistics ---");
				const record = roundAvg(recordCost.total, recordCost.count);
				const totalTime = hrtime() - parseStartTime;
				const avgTotal = totalTime / recordCost.count;
				console.log(`Total processing time: ${totalTime}`);
				console.log(`Average per-record Total processing time:  ${Math.round(avgTotal)}ns`);
				console.log(`Average per-record RegExp processing time: ${record}ns`);

				const ratio = avgTotal / record;
				const estimatedCost = 25 / (avgTotal - record) * avgTotal;

				console.log(`RegExp ration to overhead is ${ratio.toFixed(2)}`);
				console.log(`Rough estimate cost for 72,000 WARC campaign: $${estimatedCost.toFixed(2)}`);
				console.log("^ this will be wildly inaccurate (low) in 'testLocal -s' mode.");

				var total_mem = 0;
				var mem = process.memoryUsage();
				console.log("\n--- Memory statistics ---");
				for (let key in mem) {
					console.log(`${key} ${Math.round(mem[key] / 1024 / 1024 * 100) / 100} MB`);
					total_mem += mem[key];
				}

				console.log(`${Math.round(total_mem / 1024 / 1024 * 100) / 100} MB`);
				fs.writeFileSync(`${resultsPath}localResults.json`, JSON.stringify(metrics));
			}

			success(metrics);
		});

		parser.on('error', (err) => {
			console.log(err);
		});
	});
}
// Link process.send() to console.log() if there's no IPC;
function bufferToStream(myBuffer) {
    let tmp = new Duplex();
    tmp.push(myBuffer);
    tmp.push(null);
    return tmp;
}

function roundAvg(total, count, magnitude=1) {
	return Math.round(total * magnitude / count) / magnitude;
}

function toFixedLength(what, length) {
	what = (what.length <= length) ? what : what.substring(0, length - 3).concat('...');
	while (what.length < length) {
		what = what.concat(" ");
	}

	return what;
}

function hrtime() {
	let time = process.hrtime();
	return time[0] * 1000000000 + time[1];
}

function hash(what) {
	return crypto.createHash("sha1").update(what).digest("hex");
}

if (!isLocal && !!process.argv?.[2]) {
	if (process.argv?.[2]?.indexOf('crawl-data/') !== 0) {
		console.log(`[!] parse_regex.js: Not isLocal, but got crawl [ ${process.argv[2]} ]`)
		return false;
	}

	let warcFile = process.argv[2];

	exports.main(s3.getObject({
						Bucket: "commoncrawl",
						Key: warcFile
					}).createReadStream()
				.pipe(new zlib.Gunzip())
				.pipe(new WARCStreamTransform()));

	/*exports.main(fs.createReadStream('/tmp/warcannon.testLocal')
				.pipe(new zlib.Gunzip())
				.pipe(new WARCStreamTransform()));*/
}