#! /bin/bash

cd /root

export HOME=/root
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | /bin/bash
[ -s "$HOME/.nvm/nvm.sh" ] && \. "/root/.nvm/nvm.sh"
[ -s "$HOME/.nvm/bash_completion" ] && \. "/root/.nvm/bash_completion"

nvm install 16.4.2

yum install -y htop jq

# mkdir /tmp/warcannon
# chmod 777 /tmp/warcannon

#mount -t tmpfs -o size=80% ramdisk /tmp/warcannon

# mkfs.ext4 /dev/nvme2n1
# mount /dev/nvme2n1 /tmp/warcannon

cat <<- EOF > warcannon.sh
	#! /bin/bash

	[ -s "$HOME/.nvm/nvm.sh" ] && \. "/root/.nvm/nvm.sh"
	[ -s "$HOME/.nvm/bash_completion" ] && \. "/root/.nvm/bash_completion"

	rm -f function.zip
	wget \$(aws --region us-east-1 lambda get-function --function-name warcannon | jq -r '.Code.Location') -O function.zip
	
	rm -Rf warcannon
	unzip function.zip -d warcannon
	cd warcannon

	# rm -f /tmp/warcannon

	npm install

	node ./yargs.js fire ${results_bucket} ${sqs_queue_url} ${parallelism_factor}
EOF

chmod +x warcannon.sh
./warcannon.sh