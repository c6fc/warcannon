#! /bin/bash

if [[ -f __/spot_request.json ]]; then
	echo "You must run this from the warcannon folder."
	exit 1
fi


if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

if [[ $# -lt 1 ]]; then
	echo "Syntax: $0 <search_string>"
	echo "Example: $0 2021"
	exit 1
fi

aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 s3api list-objects-v2 \
	--bucket commoncrawl --prefix cc-index/collections/ --delimiter "/" | \
	jq -r '.CommonPrefixes[].Prefix' | cut -d"/" -f 3 | grep $1