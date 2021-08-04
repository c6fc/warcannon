#! /bin/bash

if [[ $# -ne 0 ]]; then
	echo "Syntax: $0"
	exit 1
fi

AWSPROFILE=`jq -r '.awsProfile' settings.json`

DATABASE=$(terraform output athena_table)
WORKGROUP=$(terraform output athena_workgroup)

query_athena () {
	QUERYEXECID=`aws athena start-query-execution \
		--profile $AWSPROFILE \
		--region us-east-1 \
		--work-group ${WORKGROUP} \
		--query-execution-context Database=${DATABASE} \
		--query-string "$1" \
		| jq -r '.QueryExecutionId'`

	if [[ $? -ne 0 || "$QUERYEXECID" == "" ]]; then
		echo "[!] Query failed. Unable to proceed."
		exit 1
	fi

	echo -n "[+] Query Exec Id: $QUERYEXECID "

	STATE="QUEUED"
	while [[ "$STATE" == "QUEUED" || "$STATE" == "RUNNING" ]]; do
		sleep 1
		STATE=`aws --profile $AWSPROFILE --region us-east-1 athena get-query-execution --query-execution-id $QUERYEXECID | jq -r '.QueryExecution.Status.State'`
		echo -n "."
	done

	if [[ "$STATE" == "CANCELLED" ]]; then
		echo
		echo "[!] Query entered state 'cancelled'. Unable to proceed."
		exit 1
	fi

	if [[ "$STATE" == "FAILED" ]]; then
		echo
		echo "[!] Query entered state 'failed'. Unable to proceed."
		exit 1
	fi

	echo " SUCCEEDED"
}

echo "[+] Populating athena with database ${DATABASE} and workgroup ${WORKGROUP}"
query_athena "CREATE EXTERNAL TABLE IF NOT EXISTS ccindex ( url_surtkey STRING, url STRING, url_host_name STRING, url_host_tld STRING, url_host_2nd_last_part STRING, url_host_3rd_last_part STRING, url_host_4th_last_part STRING, url_host_5th_last_part STRING, url_host_registry_suffix STRING, url_host_registered_domain STRING, url_host_private_suffix STRING, url_host_private_domain STRING, url_protocol STRING, url_port INT, url_path STRING, url_query STRING, fetch_time TIMESTAMP, fetch_status SMALLINT, content_digest STRING, content_mime_type STRING, content_mime_detected STRING, content_charset STRING, content_languages STRING, warc_filename STRING, warc_record_offset INT, warc_record_length INT, warc_segment STRING) PARTITIONED BY (crawl STRING, subset STRING) STORED AS parquet LOCATION 's3://commoncrawl/cc-index/table/cc-main/warc/';"
query_athena "MSCK REPAIR TABLE ccindex"

## These are test queries still under development.
# query_athena "PREPARE domain_search_all FROM SELECT DISTINCT(warc_filename) as warc_filename FROM ${DATABASE}.ccindex WHERE subset = 'warc' AND url_host_registered_domain = ? ORDER BY warc_filename ASC"
# query_athena "PREPARE domain_search FROM SELECT warc_filename, COUNT(url_path) as num FROM ${DATABASE}.ccindex WHERE subset = 'warc' AND url_host_registered_domain = ? AND crawl = ? GROUP BY warc_filename ORDER BY num DESC"
# query_athena "EXECUTE domain_search USING 'domain.com', 'CC-MAIN-2021-04'"
# query_athena "SELECT warc_filename, COUNT(url_path) as num FROM ${DATABASE}.ccindex WHERE subset = 'warc' AND url_host_registered_domain IN ('domain1.com', 'domain2.com') AND crawl = 'CC-MAIN-2021-04' GROUP BY warc_filename ORDER BY num DESC"