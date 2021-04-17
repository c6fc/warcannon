'use strict';

exports.mime_types = [
    'text/html',
    'text/javascript',
    'text/ecmascript',
    'application/javascript',
    'application/ecmascript'
];

exports.regex_patterns = {
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