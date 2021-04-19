'use strict';

var aws = require('aws-sdk');
const zlib = require('zlib');

var s3 = new aws.S3({region: "us-east-1"});
var sqs = new aws.SQS({region: "us-east-1"});

exports.main = function(event, context, callback) {

	var start = new Date();

	if (!event.crawl) {
		console.log('No crawl specified. Use a payload like {"crawl": "CC-MAIN-2020-34"}');
		return callback('No crawl specified. Use a payload like {"crawl": "CC-MAIN-2020-34"}');
	}

	var segmentCount = 0;
	var maxChunks = event.max || 300000;
	var chunkSize = event.chunk || 10;

	var promiseError = false;

	return s3.getObject({
		Bucket: "commoncrawl",
		Key: "crawl-data/" + event.crawl + "/warc.paths.gz"
	}).promise()
	.then((s3obj) => {
		console.log("s3 promise returned after " + (new Date() - start));

		return new Promise((success, failure) => {
			zlib.gunzip(s3obj.Body, function(err, data) {
				if (err) {
					promiseError = true;

					console.log(err);
					return Promise.reject(callback(err));
				}

				return success(data);
			});
		})
	}, (err) => {
		promiseError = true;

		console.log(err);
		return Promise.reject(callback(err));
	}).then((data) => {

		if (promiseError) {
			return Promise.reject('Skipping due to previous error');
		}

		console.log("zlib promise returned after " + (new Date() - start));

		var lines = data.toString().split("\n");
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

			if (a % chunkSize == 0 || a == lines.length - 1) {
				chunks.push(chunk);
				chunk = {};
				mask = "";
			}
		}

		return Promise.resolve(chunks);
	}, (err) => {
		promiseError = true;

		console.log(err);
		return Promise.reject(callback(err));
	}).then((chunks) => {
		
		if (promiseError) {
			return Promise.reject('Skipping due to previous error');
		}

		console.log(chunks.length + " chunks, size " + JSON.stringify(chunks).length);
		console.log("finished after " + (new Date() - start));

		console.log(process.env.QUEUEURL);

		var sqsPromises = [];
		for (let a = 0; a < chunks.length / 10 && a < maxChunks; a++) {

			var entries = [];
			for (let x = 0; x <= 9 && ((a * 10) + x) < maxChunks; x++) {
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

		return Promise.all(sqsPromises);

	}, (err) => {
		promiseError = true;
		
		console.log(err);
		return Promise.reject(callback(err));
	}).then((results) => {
		
		if (promiseError) {
			return Promise.reject('Skipping due to previous error');
		}

		let totalCount = 0;
		results.forEach((result) => {
			totalCount += result.Successful.length;
		});

		return Promise.resolve(callback(null,  "Created " + totalCount + " chunks of " + chunkSize + " from " + segmentCount + " available segments"));

	}, (err) => {
		promiseError = true;
		
		console.log(err);
		return Promise.reject(callback(err));
	})
}

function getMask(left, right) {
	var a = 1;
	while (left.substring(0, a) == right.substring(0, a) && a < left.length) {
		a++;
	}

	return left.substring(0, a - 1);
}