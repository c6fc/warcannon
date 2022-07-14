'use strict';

var aws = require('aws-sdk');
const zlib = require('zlib');

var s3 = new aws.S3({region: "us-east-1"});
var sqs = new aws.SQS({region: "us-east-1"});

exports.main = async function(event, context, callback) {

	console.log(event);

	var start = new Date();

	if (!event.crawl) {
		console.log('No crawl specified. Use a payload like {"crawl": "CC-MAIN-2020-34"}');
		return callback('No crawl specified. Use a payload like {"crawl": "CC-MAIN-2020-34"}');
	}

	var segmentCount = 0;
	var maxChunks = event.max || 300000;
	var chunkSize = event.chunk || 10;

	var promiseError = false;

	const s3obj = await s3.getObject({
		Bucket: "commoncrawl",
		Key: "crawl-data/" + event.crawl + "/warc.paths.gz"
	}).promise()

	console.log("s3 promise returned after " + (new Date() - start));

	const fileList = zlib.gunzipSync(s3obj.Body)

	console.log("zlib promise returned after " + (new Date() - start));

	var lines = fileList.toString().split("\n");
	lines.pop();

	segmentCount = lines.length;

	var mask = false;
	var chunk = {};
	var chunks = [];
	
	for (let a = 0; a < lines.length; a++) {
		if (!mask || lines[a].substring(0, mask.length) != mask) {
			let next = (a + 10 > lines.length - 1) ? lines.length - 1 : a + 10;
			mask = getMask(lines[a], lines[next]);
			chunk[mask] = [];
		}

		// add the line to 'chunks' without the 'warc.gz' at the end.
		chunk[mask].push(lines[a].substring(mask.length, lines[a].length - 8));

		if ((a + 1) % chunkSize == 0 || a == lines.length) {
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

	const results = await Promise.all(sqsPromises);

	let totalCount = 0;
	results.forEach((result) => {
		totalCount += result.Successful.length;
	});

	return callback(null,  `Created ${totalCount} chunks of ${chunkSize} from ${segmentCount} available segments`);
}

function getMask(left, right) {
	var a = 1;
	while (left.substring(0, a) == right.substring(0, a) && a < left.length) {
		a++;
	}

	return left.substring(0, a - 1);
}