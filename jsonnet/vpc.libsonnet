local vpc(region, index) = {
	provider: "aws." + region,
	cidr_block: "10." + (200 + (index - 1)) + ".0.0/16"
};

local endpoint(region, service) = {
	provider: "aws." + region,
	vpc_id: "${aws_vpc." + region + ".id}",
	service_name: "com.amazonaws." + region + "." + service
};

local security_group(name, region, vpc, ingress, egress, tags) = std.prune({
	name: name,
	provider: "aws." + region,
	vpc_id: "${aws_vpc." + vpc + ".id}",
	ingress: ingress,
	egress: egress,
	tags: tags
});

{
	vpc: vpc,
	endpoint: endpoint,
	security_group: security_group
}