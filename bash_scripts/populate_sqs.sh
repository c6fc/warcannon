#! /bin/bash

if [[ -f __/spot_request.json ]]; then
	echo "You must run this from the warcannon folder."
	exit 1
fi


if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 lambda invoke --function-name cc_loader --payload '{"crawl":"CC-MAIN-2020-34","chunk":2,"max":2}' /dev/stdout