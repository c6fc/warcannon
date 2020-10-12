#! /bin/bash

# Install NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.3/install.sh | bash
export NVM_DIR="$([ -z "$${XDG_CONFIG_HOME-}" ] && printf %s "$${HOME}/.nvm" || printf %s "$${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm

sudo yum install -y htop

nvm install 12
mkdir /tmp/warcannon
chmod 777 /tmp/warcannon

# sudo mount -t tmpfs -o size=200g ramdisk /tmp/warcannon
MEMORY=`free --giga | grep Mem | awk ' { print($2) } '`
RAMDISK=$((MEMORY / 2))
echo $RAMDISK

sudo mount -t tmpfs -o size=$${RAMDISK}g ramdisk /tmp/warcannon
aws s3 cp s3://${site_bucket}/package.zip .
unzip package.zip
npm install

# node warcannon.js crawl-data/CC-MAIN-2020-10/warc.paths.gz 1 56000 1 warc-results
node warcannon-noninteractive.js ${results_bucket} ${sqs_queue_url} ${parallelism_factor}

# aws --region us-east-1 lambda invoke --function-name cc_loader --payload '{"crawl":"CC-MAIN-2020-34","chunk":4,"max":10}' /dev/stdout