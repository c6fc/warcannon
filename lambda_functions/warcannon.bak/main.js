'use strict';

const fs = require('fs');
const aws = require('aws-sdk');
const zlib = require('zlib')
const crypto = require('crypto');
const { Duplex } = require('stream');
const { exec, fork } = require('child_process');
const { WARCStreamTransform } = require('node-warc');

var s3 = new aws.S3({region: "us-east-1"});

const mime_types = [
    'text/html',
    'text/javascript',
    'text/ecmascript',
    'application/javascript',
    'application/ecmascript'
];

const regex_patterns = {
	"access_key_id": /(\'A|"A)(SIA|KIA|IDA|ROA)[JI][A-Z0-9]{14}[AQ][\'"]/g,
	"user_pool_id": /[\'"](us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2)_[a-zA-Z0-9]{9}[\'"]/g,
	"identity_pool_id": /[\'"](us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[\'"]/g,
	"hosted_ui": /[\'"]https:\/\/[^ ]+?\/login\?[^ ]*?client_id=[a-z0-9]{26}[^ ]/g,
	"cognito_domain": /[\'"]https:\/\/[a-z0-9\-]+\.auth\.(us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2)\.amazoncognito.com/g,
	"assumerolewithwebidentity": /assumeRoleWithWebIdentity\(/,

	"google_appid": /[\'"][0-9]{12}-[0-9a-z]{32}\.apps\.googleusercontent\.com[\'"]/,

	"amazon_appid": /[\'"]amzn1\.application-oa2-client\.[0-9a-f]{32}[\'"]/,
	"amazon_authorize": /amazon\.Login\.authorize\(/
};

var metrics = {};

exports.main = (event, context, callback) => {

	processWarc(event.warc).then((result) => {
		return uploadResults(JSON.stringify(result), event.warc);
	}, (err) => {
		return callback(err);
	}).then(() => {
		return callback(null, "[+] Finished");
	}, (err) => {
		return callback(err);
	});
	
};

function bufferToStream(myBuffer) {
    let tmp = new Duplex();
    tmp.push(myBuffer);
    tmp.push(null);
    return tmp;
}

function processWarc(warc) {

	metrics = {
		total_hits: 0,
		regex_hits: {}
	};

	Object.keys(regex_patterns).forEach((e) => {
		metrics.regex_hits[e] = {
			domains: {}
		};
	});

	var records = 0;
	var records_processed = 0;
	var last_status_report = 0;

	return new Promise((success, failure) => {

		var start_download = new Date();

		getObject("commoncrawl", warc).then((warcContent) => {
			var end_download = new Date() - start_download;
			console.log("[+] Downloaded warc in " + Math.round(end_download / 1000) + " seconds.");

			var start_processing = new Date();

			// var parser = fs.createReadStream('/dev/shm/warc').pipe(zlib.createGunzip()).pipe(new WARCStreamTransform())
			var parser = bufferToStream(warcContent.Body).pipe(zlib.createGunzip()).pipe(new WARCStreamTransform())
			.on('data', (record) => {
				records++;
				
				// Only process response records with mime-types we care about.
				if (record.warcHeader['WARC-Type'] == "response" && mime_types.indexOf(record.warcHeader['WARC-Identified-Payload-Type']) >= 0) {

					records_processed++;

					var domain = record.warcHeader['WARC-Target-URI'].split('/')[2];
					Object.keys(regex_patterns).forEach((e) => {
						var matches = record.content.toString().match(regex_patterns[e]);
						if (matches != null) {
							metrics.total_hits++;

							if (!metrics.regex_hits[e].domains.hasOwnProperty(domain)) {
								metrics.regex_hits[e].domains[domain] = {
									"matches": [],
									"target_uris": []
								};
							};

							matches.forEach((m) => {
								if (m !== null) {
									metrics.regex_hits[e].domains[domain].matches.push(m.trim().replace(/['"]+/g, ""));
								}
							})

							if (metrics.regex_hits[e].domains[domain].target_uris.indexOf(record.warcHeader['WARC-Target-URI']) < 0) {
								metrics.regex_hits[e].domains[domain].target_uris.push(record.warcHeader['WARC-Target-URI']);
							}
						}
					});

					if (records_processed % 100 == 0 && new Date() - last_status_report > 5000) {
						last_status_report = new Date();
						console.log(records);
					}
				}

				return true;
			})
			.on('end', () => {
				var end_processing = new Date() - start_processing;
				console.log("[+] Finished processing in " + end_processing + "ms");

				success(metrics);
			});

		}).catch((e) => {
			console.log(warc + " download failed; " + e);
		});
	})
};

function getObject(bucket, key) {
	return s3.getObject({
		Bucket: bucket,
		Key: key
	}).promise();
};

function uploadResults(what, key) {
	return s3.putObject({
		Bucket: process.env.DESTINATIONBUCKET,
		Key: key,
		Body: what,
		ContentType: "application/json",
	}).promise();
};