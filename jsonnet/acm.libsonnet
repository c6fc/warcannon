local certificate(dns_name, sans = []) = std.prune({
	"provider": "aws.us-east-1",
	"domain_name": dns_name,
	"validation_method": "DNS",
	"subject_alternative_names": sans
});

local certificate_validation(arn, fqdns) = {
	"provider": "aws.us-east-1" ,
	"certificate_arn": arn,
	"validation_record_fqdns": [fqdns]
};

local route53_record(name, type, records, zone) = {
	"name": name,
	"type": type,
	"zone_id": zone,
	"records": [records],
	"ttl": 60
};

local manual_record(name, type, records) = {
	"value": "Create [" + type + "] record at [" + name + "] with value [" + records + "]" 
};

{
	"certificate": certificate,
	"certificate_validation": certificate_validation,
	"route53_record": route53_record,
	"manual_record": manual_record
}