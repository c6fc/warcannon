#! /bin/bash

ERR=0;
if [[ ! -f $(which jsonnet) ]]; then
	ERR=1;
	echo "Error: Must have 'jsonnet' command installed.";
fi

if [[ ! -f $(which jq) ]]; then
	ERR=1;
	echo "Error: Must have 'jq' command installed.";
fi

if [[ ! -f $(which aws) ]]; then
	ERR=1;
	echo "Error: Must have AWSCLI installed.";
fi

if [[ ! -f $(which npm) ]]; then
	ERR=1;
	echo "Error: Must have NPM installed.";
fi

if [[ ! -f $(which terraform) ]]; then
	ERR=1;
	echo "Error: Must have Terraform installed.";
fi

if [[ "$(terraform -v | grep v0.11 | wc -l)" != "1" ]]; then
	ERR=1;
	echo "Error: Wrong version of Terraform is installed. Warcannon requires Terraform v0.11.";
fi

if [[ "$ERR" == "1" ]]; then
	echo -e "\nInstall missing components, then try again.\n"
	exit 1
fi

echo "[*] Preparing to deploy the warcannon"

if [[ ! -f regions.json ]]; then
	echo "[*] Getting availabilityzones from AWS"
	# Get the availability zones for each region
	echo "[*] - us-east-1"
	aws --profile $(jq -r '.awsProfile' settings.json) ec2 --region us-east-1 describe-availability-zones | jq '{"us-east-1": [.AvailabilityZones[] | select(.State=="available") | .ZoneName]}' | jq '{"regions": .}' > regions.json
fi

echo "[*] Checking service-linked roles for EC2 spot fleets"
aws --profile $(jq -r '.awsProfile' settings.json) iam get-role --role-name AmazonEC2SpotFleetRole > /dev/null
if [[ $? -eq 255 ]]; then
	echo "[+] Creating service-linked roles for EC2 spot fleets"
	aws --profile $(jq -r '.awsProfile' settings.json) iam create-role --role-name AmazonEC2SpotFleetRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Sid":"","Effect":"Allow","Principal":{"Service":"spotfleet.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
	aws --profile $(jq -r '.awsProfile' settings.json) iam attach-role-policy --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole --role-name AmazonEC2SpotFleetRole
	aws --profile $(jq -r '.awsProfile' settings.json) iam create-service-linked-role --aws-service-name spot.amazonaws.com
	aws --profile $(jq -r '.awsProfile' settings.json) iam create-service-linked-role --aws-service-name spotfleet.amazonaws.com
fi

echo "[*] Generating combined settings file"
jq -s '.[0] * .[1]' settings.json regions.json > generated-settings.jsonnet

rm *.tf.json
echo "[*] Generating Terraform configurations"
# Generate terraform configs
jsonnet -m . terraform.jsonnet

# terraform init
# terraform apply
terraform apply -auto-approve