#! /bin/bash

if [[ -f __/spot_request.json ]]; then
	echo "You must run this from the warcannon folder."
	exit 1
fi


if [[ ! -f spot_request.json ]]; then
	echo "You must run terraform first!"
	exit 1
fi

AWSPROFILE=$(jq -r '.awsProfile' settings.json)
SFRS=`aws --profile $AWSPROFILE --region us-east-1 ec2 describe-spot-fleet-requests | jq '.SpotFleetRequestConfigs[] | select(.SpotFleetRequestState=="active") | select((.Tags[]|select(.Key=="Name")|.Value) | match("Warcannon")) | .SpotFleetRequestId'`
echo $SFRS | awk -v profile=$AWSPROFILE ' { system("aws --profile " profile " --region us-east-1 ec2 cancel-spot-fleet-requests --spot-fleet-request-ids " $1 " --terminate-instances") } '