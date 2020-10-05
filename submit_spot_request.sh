#! /bin/bash

if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 ec2 request-spot-fleet --spot-fleet-request-config file://spot_request.json