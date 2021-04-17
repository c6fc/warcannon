#! /bin/bash

if [[ -f __/spot_request.json ]]; then
	echo "You must run this from the warcannon folder."
	exit 1
fi


if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 lambda invoke \
	--function-name cc_loader --cli-binary-format raw-in-base64-out --invocation-type RequestResponse \
	--payload '{"crawl":"CC-MAIN-2020-34","chunk":1,"max":3}' /dev/stdout