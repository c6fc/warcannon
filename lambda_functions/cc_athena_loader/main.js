'use strict';

var aws = require('aws-sdk');
const zlib = require('zlib');

var athena = new aws.Athena({region: "us-east-1"});
var s3 = new aws.S3({region: "us-east-1"});
var sqs = new aws.SQS({region: "us-east-1"});

exports.main = async function(event, context, callback) {

	let start = new Date();

	if (!event.queryExecutionId) {
		let message = 'No queryExecutionId specified. Use a payload like {"queryExecutionId": "ed8488d3-df35-40dd-80cd-fbfe722dc7d3"}';
		console.log(message);
		return callback(message);
	}

	let segmentCount = 0;
	const maxChunks = event.max || 1000000000;
	const chunkSize = event.chunk || 10;

	var promiseError = false;

	try {

		let execution = await athena.getQueryExecution({
				QueryExecutionId: event.queryExecutionId
			}).promise();

		let location = execution.QueryExecution.ResultConfiguration.OutputLocation;
		let s3Obj = await s3.getObject({
				Bucket: location.split('/')[2],
				Key: location.split('/').slice(3).join('/')
			}).promise()

		let s3Body = Buffer.from(s3Obj.Body).toString('UTF-8').split("\n");
		let columnHeaders = s3Body[0].split(",");
		let warcFilenameHeaderPosition = columnHeaders.indexOf('"warc_filename"');

		if (warcFilenameHeaderPosition < 0) {
			let message = 'Unable to find "warc_filename" among CSV headers. Your query must contain this column.';
			console.log(message);
			return callback(message);
		}

		console.log(`[+] warc_filename found at column ${warcFilenameHeaderPosition}`);

		let lines = [];

		s3Body.shift();
		s3Body.forEach((line) => {
			if (line == "") {
				return false;
			}
			
			lines.push(line.split(',')[warcFilenameHeaderPosition].slice(1, -1))
		});

		segmentCount = lines.length;

		let mask = false;
		let chunk = {};
		let chunks = [];
		
		for (let a = 0; a < lines.length; a++) {
			if (!mask || lines[a].substring(0, mask.length) != mask) {
				let next = (a + 10 > lines.length - 1) ? lines.length - 1 : a + 10;
				mask = getMask(lines[a], lines[next]);
				chunk[mask] = [];
			}

			// add the line to 'chunks' without the 'warc.gz' at the end.
			chunk[mask].push(lines[a].substring(mask.length, lines[a].length - 8));

			if (a % chunkSize == 0 || a == lines.length - 1) {
				chunks.push(chunk);
				chunk = {};
				mask = "";
			}
		}

		console.log(chunks.length + " chunks, size " + JSON.stringify(chunks).length);
		console.log("finished after " + (new Date() - start));

		console.log(process.env.QUEUEURL);

		var sqsPromises = [];
		for (let a = 0; a < chunks.length / 10 && a < maxChunks; a++) {

			var entries = [];
			for (let x = 0; x <= 9 && ((a * 10) + x) < maxChunks; x++) {
				if (!chunks[(a * 10) + x]) {
					continue;
				}

				entries.push({
					Id: event.crawl + "-" + ((a * 10) + x),
					MessageBody: JSON.stringify(chunks[(a * 10) + x])
				});
			}

			if (entries.length > 0) {
				sqsPromises.push(sqs.sendMessageBatch({
					Entries: entries,
					QueueUrl: process.env.QUEUEURL
				}).promise());
			}
		}

		console.log("Created " + sqsPromises.length + " SQS batches");

		let results = await Promise.all(sqsPromises);
		let totalCount = 0;
		results.forEach((result) => {
			totalCount += result.Successful.length;
		});

		return Promise.resolve(callback(null,  "Created " + totalCount + " chunks of " + chunkSize + " from " + segmentCount + " available segments"));
		
	} catch (e) {
		return Promise.reject(callback(e));
	}
}

function getMask(left, right) {
	var a = 1;
	while (left.substring(0, a) == right.substring(0, a) && a < left.length) {
		a++;
	}

	return left.substring(0, a - 1);
}