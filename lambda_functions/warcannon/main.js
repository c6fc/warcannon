'use strict';

const fs = require("fs");
const aws = require('aws-sdk');
const zlib = require('zlib')
const crypto = require('crypto');
const parse_regex = require("./parse_regex.js");

const { Duplex } = require('stream');
const { WARCStreamTransform } = require('node-warc');

const s3 = new aws.S3({region: "us-east-1"});

exports.main = async function(event, context, callback) {

	if (!event.warc) {
		return callback("event.warc must be a full path to a warc in the commoncrawl bucket.");
	}

	let warcContent = {};
	try {
		if (fs.existsSync("/tmp/warcannon.50825c10bcad65e3b46895824fc619e48e10742a")) {
			warcContent = { Body: fs.readFileSync("/tmp/warcannon.50825c10bcad65e3b46895824fc619e48e10742a") }
		} else {
			warcContent = await s3.getObject({
				Bucket: 'commoncrawl',
				Key: event.warc
			}).promise();
		}

		const results = await parse_regex.main(
			bufferToStream(warcContent.Body)
				.pipe(zlib.createGunzip())
				.pipe(new WARCStreamTransform()));

		return callback(null, results);

	} catch (err) {
		console.log(err);
		return err;
	}
}

function bufferToStream(myBuffer) {
    let tmp = new Duplex();
    tmp.push(myBuffer);
    tmp.push(null);
    return tmp;
}