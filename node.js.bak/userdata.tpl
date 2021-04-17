#! /bin/bash

# Install NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.3/install.sh | bash
. ~/.bashrc

sudo yum install -y htop jq

nvm install 12
mkdir /tmp/warcannon
chmod 777 /tmp/warcannon

# sudo mount -t tmpfs -o size=200g ramdisk /tmp/warcannon
MEMORY=`free --giga | grep Mem | awk ' { print($2) } '`
RAMDISK=$((MEMORY / 2))
echo $RAMDISK

sudo mount -t tmpfs -o size=$${RAMDISK}g ramdisk /tmp/warcannon
wget `aws --region us-east-1 lambda get-function --function-name warcannon_singlefire | jq -r '.Code.Location'` -O function.zip
unzip function.zip
npm install

# node warcannon.js crawl-data/CC-MAIN-2020-10/warc.paths.gz 1 56000 1 warc-results
node warcannon.js ${results_bucket} ${sqs_queue_url} ${parallelism_factor}

# aws --region us-east-1 lambda invoke --function-name cc_loader --payload '{"crawl":"CC-MAIN-2020-34","chunk":4,"max":10}' /dev/stdout