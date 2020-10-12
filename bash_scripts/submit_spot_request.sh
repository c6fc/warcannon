#! /bin/bash

if [[ -f __/spot_request.json ]]; then
	echo "You must run this from the warcannon folder."
	exit 1
fi


if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

AWSACCOUNT=`aws --profile $(jq -r '.awsProfile' settings.json) sts get-caller-identity | jq -r '.Account'`
QUEUELENGTH=`aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 sqs get-queue-attributes --queue-url "https://sqs.us-east-1.amazonaws.com/${AWSACCOUNT}/warcannon_queue" --attribute-names ApproximateNumberOfMessages | jq -r '.Attributes.ApproximateNumberOfMessages'`

if [[ "$QUEUELENGTH" -eq 0 ]]; then
	echo "Yeah, no tho. Queue length is zero. Populate the queue first."
	exit 1
fi

VALIDUNTIL=$((`date "+%s"` + `jq -r '.nodeMaxDuration' settings.json`))
cat spot_request.json | jq ". += {\"ValidUntil\":$VALIDUNTIL}" > tmp_request.json

aws --profile $(jq -r '.awsProfile' settings.json) --region us-east-1 ec2 request-spot-fleet --spot-fleet-request-config file://tmp_request.json
rm tmp_request.json