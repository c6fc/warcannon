'use strict';

exports.mime_types = [
    'text/html',
    'text/javascript',
    'text/ecmascript',
    'application/javascript',
    'application/ecmascript',
    'application/json'
];

exports.domains = [];
// exports.domains = [/^.*?$/];

exports.regex_patterns = {
	access_key_id: /(\'A|"A)(SIA|KIA|IDA|ROA)[JI][A-Z0-9]{14}[AQ][\'"]/g,
	user_pool_id: /[\'"](us|ap|ca|eu)((-gov)|(-iso(b?)))?-[a-z]+-\d{1}_[a-zA-Z0-9]{9}[\'"]/g,
	// identity_pool_id: /[\'"](us|ap|ca|eu)-(central|east|west|south|northeast|southeast)-(1|2):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[\'"]/g,
	identity_pool_id: /[\'"](us|ap|ca|eu)((-gov)|(-iso(b?)))?-[a-z]+-\d{1}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[\'"]/g,
	hosted_ui: /[\'"]https:\/\/[^ ]+?\/login\?[^ ]*?client_id=[a-z0-9]{26}[^ ]/g,
	cognito_domain: /[\'"]https:\/\/[a-z0-9\-]+\.auth\.(us|ap|ca|eu)((-gov)|(-iso(b?)))?-[a-z]+-\d{1}\.amazoncognito\.com/g,
	assumerolewithwebidentity: /assumeRoleWithWebIdentity\(/g,
	arn: /arn:aws:[a-z0-9-]+:((us|ap|ca|eu)((-gov)|(-iso(b?)))?-[a-z]+-\d{1})?:(\d{12})?:[a-z0-9-]+([\/:][a-zA-Z0-9_+=,.@-]+)?/g,

	google_appid: /[\'"][0-9]{12}-[0-9a-z]{32}\.apps\.googleusercontent\.com[\'"]/g,

	amazon_appid: /[\'"]amzn1\.application-oa2-client\.[0-9a-f]{32}[\'"]/g,
	amazon_authorize: /amazon\.Login\.authorize\(/g,

	// Find s3 buckets
	s3_buckets: /https?:\/\/[^ \.\/]+?\.s3\.amazonaws\.com/g,

	// Find proxies
	safebase64_url: /['"]https?:\/\/[^'"]+[&?/]{1}aHR0c[A-Za-z0-9_-]+[^ ]*?['"]/g,
	base64_url: /['"]https?:\/\/[^'"]+[&?/]{1}aHR0c[A-Za-z0-9+/]+={0,2}[^ ]*?['"]/g,
};

// custom functions are executed against regex matches of the associated key.
// A return value of boolean false will be discarded from further processing.
exports.custom_functions = {
	base64_url: function(match) {
		if (match.indexOf("google.com/recaptcha/") >= 0 ||
			match.indexOf("uenc/aHR0c") >= 0 ||
			match.indexOf("/referer/aHR0c") >= 0
		) {
			return false;
		}

		let text = false; 
		try {
			let intermatch = match.match(/aHR0c[A-Za-z0-9+/]+={0,2}/)
			text = new Buffer.from(intermatch[0], 'base64').toString('ascii');
		} catch(e) {
			return false;
		}

		if (text.indexOf("\n") >= 0 ||
			text.indexOf("\r") >= 0 ||
			text.indexOf("commoncrawl.org") >= 0
		) {
			return false;
		}

		// console.log(match, text);
		
		return match;
	},

	safebase64_url: function(match) {
		if (match.indexOf("google.com/recaptcha/") >= 0 ||
			match.indexOf("uenc/aHR0c") >= 0 ||
			match.indexOf("/referer/aHR0c") >= 0
		) {
			return false;
		}

		let text = false; 
		try {
			let intermatch = match.match(/aHR0c[A-Za-z0-9_-]+/)[0].replace('-', '+').replace('_', '/');
			while (intermatch.length % 4) {
				intermatch += '=';
			}

			text = new Buffer.from(intermatch, 'base64').toString('ascii');
		} catch(e) {
			return false;
		}

		if (text.indexOf("\n") >= 0 ||
			text.indexOf("\r") >= 0 ||
			text.indexOf("commoncrawl.org") >= 0
		) {
			return false;
		}

		// console.log(match, text);
		
		return match;
	}
}