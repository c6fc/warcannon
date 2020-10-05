local subnet(region, az, i, auto_assign) = 
	{
		provider: "aws." + region,
		vpc_id: "${aws_vpc." + region + ".id}",
		availability_zone: az,
		map_public_ip_on_launch: auto_assign,
		cidr_block: "${cidrsubnet(aws_vpc." + region + ".cidr_block, 8, " + (i + 1) + ")}"
	};

subnet