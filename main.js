'use strict';

var start = new Date();


const fs = require('fs');
const { AutoWARCParser } = require('node-warc');

if (!fs.existsSync(process.argv[2])) {
	console.log("Usage: " + process.argv[1] + " <file.warc>");
	process.exit();
}

const parser = new AutoWARCParser(process.argv[2]);

const mime_types = [
    'text/html',
    'text/javascript',
    'text/ecmascript',
    'application/javascript',
    'application/ecmascript'
];

const regex_patterns = {
	"access_key_id": /(\'A|"A)(SIA|KIA|IDA|ROA)[JI][A-Z0-9]{14}[AQ][\'"]/g,
	"user_pool_id": /(us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2)_[a-zA-Z0-9]{9}/g,
	"identity_pool_id": /(us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
	"hosted_ui": /"https:\/\/[^ ]+?\/login\?[^ ]*?client_id=[a-z0-9]{26}[^ ]*?"/g,
	"cognito_domain": /https:\/\/[a-z0-9\-]+\.auth\.(us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2)\.amazoncognito.com/g,

	"assumerolewithwebidentity": /assumeRoleWithWebIdentity\(/,

	"google_appid": /[0-9]{12}-[0-9a-z]{32}\.apps\.googleusercontent\.com/,

	"amazon_appid": /[\'"]amzn1\.application-oa2-client\.[0-9a-f]{32}[\'"]/,
	"amazon_authorize": /amazon\.Login\.authorize\(/
};

var metrics = {
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
var update_timer = null;

parser.on('record', (record) => {

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
	}

	return true;
});

parser.on('done', () => {
	clearTimeout(update_timer);
	// console.log(JSON.stringify(metrics));
	process.send({message: metrics, type: "done"});

	var total_mem = 0;
	var mem = process.memoryUsage();
	for (let key in mem) {
		total_mem += mem[key];
	}

	var end = new Date() - start;

	// console.log("Processed " + records_processed + " of " + records + " records");
	// console.log("Used " + Math.ceil(total_mem / 1024 / 1024) + " MB");
	// console.log("Took %d seconds", (end / 1000));
});

parser.on('error', (error) => {
	console.error(error);
});

function sendStatusUpdate() {
	process.send({type: "progress", recordcount: records});

	update_timer = setTimeout(sendStatusUpdate, 1000);
}

parser.start();
sendStatusUpdate();