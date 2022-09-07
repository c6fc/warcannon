#! /bin/bash


while ([[ ! -f $2 ]]); do
	DLS=`ps aux | grep aws | wc -l`;

	while ([[ $DLS -gt 30 ]]); do
		echo "[...] Staggering S3 Files."
		sleep 2
		DLS=`ps aux | grep aws | wc -l`;
	done

	aws s3 cp s3://commoncrawl/$1 $2 2>&1
done;