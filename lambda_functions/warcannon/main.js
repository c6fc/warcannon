'use strict';

const fs = require("fs");
const aws = require('aws-sdk');
const zlib = require('minizlib')
const crypto = require('crypto');
const parse_regex = require("./parse_regex.js");

const { Duplex } = require('stream');
const { WARCStreamTransform } = require('node-warc');

const s3 = new aws.S3({region: "us-east-1"});

exports.main = async function(event, context, callback) {

	console.log(event);

	let results;
	let warcContent = {};
	
	try {
		const isLocal = event.hasOwnProperty('stream');

		if (isLocal) {
			console.log(`[*] Running in local mode; stream: ${event?.stream}. Hello friend!`);
		}

		if (!!!event.stream) {
			if (fs.existsSync("/tmp/warcannon.testLocal")) {
				const gzip = await isGzip('/tmp/warcannon.testLocal');

				console.log(`[*] Local is gzip: ${gzip.toString()}`);

				if (gzip) {
					results = await parse_regex.main(
						fs.createReadStream('/tmp/warcannon.testLocal')
						.pipe(new zlib.Gunzip())
						.pipe(new WARCStreamTransform()),
						true
					);
				} else {
					results = await parse_regex.main(
						fs.createReadStream('/tmp/warcannon.testLocal')
						.pipe(new WARCStreamTransform()),
						true
					);
				}

				return results

			}
		}

		if (!event.warc) {
			return callback("event.warc must be a full path to a warc in the commoncrawl bucket.");
		}

		if (isLocal) {
			console.log(`[*] Using stream method. WarcPath: ${event.warc}`);
		}

		/*warcContent = await s3.getObject({
			Bucket: 'commoncrawl',
			Key: event.warc
		}).promise();*/

		results = await parse_regex.main(
				s3.getObject({
					Bucket: "commoncrawl",
					Key: event.warc
				}).createReadStream()
				.pipe(new zlib.Gunzip())
				.pipe(new WARCStreamTransform()),
				isLocal
			);

		/*results = await parse_regex.main(
			bufferToStream(warcContent.Body)
				.pipe(new zlib.Gunzip())
				.pipe(new WARCStreamTransform()),
				isLocal
			);*/

		return results;

	} catch (err) {
		console.trace(err);
		console.log(derp);
		// return err;
	}
}

function bufferToStream(myBuffer) {
    let tmp = new Duplex();
    tmp.push(myBuffer);
    tmp.push(null);
    return tmp;
}

async function isGzip(file) {
	return new Promise((success, failure) => {
		fs.open(file, 'r', function(status, fd) {
			const buffer = new Buffer.alloc(3);
			fs.read(fd, buffer, 0, buffer.length, 0, function(err, bytes) {

				const header = buffer.slice(0, bytes).toString('hex');
				fs.close(fd, function (err) {
					if (err) {
						console.log(err);
					}

					if (header == "1f8b08") {
						return success(true);
					}

					return success(false);
				});
			});
		});
	});
}