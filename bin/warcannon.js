#! /usr/bin/env node

const fs = require('fs');
const os = require('os');
const aws = require('aws-sdk'); 
const path = require('path');
const yargs = require('yargs');
const colors = require('@colors/colors');
const readline = require('readline');

const expectedPath = path.resolve(__dirname, '..');

if (process.cwd() !== expectedPath) {
	console.log(`[!] The 'warcannon' command can only be used from ` + `${expectedPath}`.blue);
	process.exit(1);
}

const { Sonnet } = require('@c6fc/sonnetry');

const cf = new aws.CloudFront({ region: 'us-east-1' });
const s3 = new aws.S3({ region: 'us-east-1' });
const ec2 = new aws.EC2({ region: 'us-east-1' });
const sqs = new aws.SQS({ region: 'us-east-1' });
const sts = new aws.STS({ region: 'us-east-1' });
const lambda = new aws.Lambda({
	region: 'us-east-1',
	httpOptions: {
		timeout: 610000
	}
});

let identity = false;
let settings = false;

const sonnetry = new Sonnet({
	renderPath: './render-warcannon',
	cleanBeforeRender: true
});

const resultsPath = `${os.homedir()}/.warcannon/`;

(async () => {

	settings = fs.readFileSync('./settings.json');

	yargs
		.usage("Syntax: $0 <command> [options]")
		.command("*", "RTFM is hard", (yargs) => {
			yargs
		}, (argv) => {
			console.log("[~] RTFM is hard. (Try 'help')".rainbow);
		})
		.command("deploy", "Deploy the WARCannon", (yargs) => {
			return yargs.option('skipInit', {
				alias: 's',
				type: 'boolean',
				description: 'Skip the Terraform Init phase. Useful for development.'
			}).option('autoApprove', {
				alias: 'y',
				type: 'boolean',
				description: 'Auto-approve Terraform changes. Useful for development.'
			});
		}, async (argv) => {
			showBanner();

			await sonnetry.auth();

			await sonnetry.render('terraform.jsonnet');

			sonnetry.write();

			const success = await sonnetry.apply(argv.skipInit, argv.autoApprove);
		})
		.command("status", "Shows the status of the WARCannon deployment", (yargs) => yargs, async (argv) => {
			await showStatus();
		})
		.command("emptyQueue", "Empties the WARCannon work queue", (yargs) => yargs, async (argv) => {
			const identity = await sts.getCallerIdentity().promise();

			const QueueUrl = `https://sqs.us-east-1.amazonaws.com/${identity.Account}/warcannon_queue`;

			let length = await sqs.getQueueAttributes({
				QueueUrl,
				AttributeNames: ["ApproximateNumberOfMessages"]
			}).promise();

			length = length.Attributes.ApproximateNumberOfMessages;

			if (length == 0) {
				console.log("[*] Queue is already empty.".blue);
				return true;
			}

			await sqs.purgeQueue({
				QueueUrl
			}).promise();

			console.log(`[+] Removed ${length} messages from the queue`.green);
		})
		.command("clearResults", "Delete remote result files", (yargs) => yargs, async (argv) => {
			const result_bucket = await getWarcannonBucket();
			await emptyS3Bucket(result_bucket);

			console.log("[+] Emptied the results bucket.".green);
		})
		.command("list [search]", "Shows Crawls matching the provided search string", (yargs) => {
			return yargs.option('search', {
				type: 'string',
				description: 'The string to search for among available crawls.'
			})
		}, async (argv) => {
			const crawls = await s3.listObjectsV2({
				Bucket: 'commoncrawl',
				Prefix: 'cc-index/collections/',
				Delimiter: '/'
			}).promise();

			crawls.CommonPrefixes.map(e => {
				if (!!!argv.search || e.Prefix.indexOf(argv.search) >= 0) {
					console.log(e.Prefix.split('/')[2]);
				}
			});
		})
		.command("populate <crawl> [chunk_size] [num_chunks]", "Populates a job from the provided Crawl, optionally segmenting it by chunk size and count.", (yargs) => {
			return yargs.option('crawl', {
				type: 'string',
				description: 'A string matching precisely one crawl.'
			}).option('chunk_size', {
				type: 'number',
				description: 'The number of WARCs to pack per chunk of work.',
				default: 10
			}).option('num_chunks', {
				type: 'number',
				description: 'How many chunks of work to send to the queue.'
			})
		}, async (argv) => {
			const crawls = await s3.listObjectsV2({
				Bucket: 'commoncrawl',
				Prefix: 'cc-index/collections/',
				Delimiter: '/'
			}).promise();

			const matchingCrawls = [];
			crawls.CommonPrefixes.map(e => {
				if (e.Prefix.indexOf(argv.crawl) >= 0) {
					matchingCrawls.push(e.Prefix.split('/')[2]);
				}
			});

			if (matchingCrawls.length != 1) {
				console.log(`[!] Provided crawl matched [${matchingCrawls.length}] Crawls. Should match exactly 1.`.red);
				return false;
			}

			try {
				await s3.headObject({
					Bucket: "commoncrawl",
					Key: "crawl-data/" + matchingCrawls[0] + "/warc.paths.gz"
				}).promise();
			} catch(e) {
				console.log("[!] Unable to locate the index file for this crawl.".red)
				console.log("[!] This might mean that the crawl is still in progress, or".red);
				console.log("[!] is otherwise not ready for use. Try a different crawl.".red);
				return false;
			}

			console.log('[*] Loading job. Please wait...'.blue);

			const loader = await lambda.invoke({
				FunctionName: "cc_loader",
				InvocationType: "RequestResponse",
				LogType: "None",
				Payload: JSON.stringify({
					crawl: matchingCrawls[0],
					chunk: argv.chunk_size,
					max: argv.num_chunks
				})
			}).promise();

			if ([...loader.StatusCode+''][0] == '2') {
				console.log(`[+] Loader completed successfully. Received response:\n${loader.Payload.toString()}`.green);
				return true;
			}

			console.log(`[!] Loader failed with code [${loader.StatusCode}]:\n${loader.Payload.toString()}`.red);
			return false;
		})
		.command("createAthena", "Creates and initializes tables for Athena queries", (yargs) => yargs, async (argv) => {
			console.log('[*] Creating Athena table...'.blue);

			const athena = new aws.Athena({ region: "us-east-1" });

			await athena.startQueryExecution({
				QueryString: "CREATE EXTERNAL TABLE IF NOT EXISTS ccindex (url_surtkey STRING, url STRING, url_host_name STRING, url_host_tld STRING, url_host_2nd_last_part STRING, url_host_3rd_last_part STRING, url_host_4th_last_part STRING, url_host_5th_last_part STRING, url_host_registry_suffix STRING, url_host_registered_domain STRING, url_host_private_suffix STRING, url_host_private_domain STRING, url_protocol STRING, url_port INT, url_path STRING, url_query STRING, fetch_time TIMESTAMP, fetch_status SMALLINT, content_digest STRING, content_mime_type STRING, content_mime_detected STRING, content_charset STRING, content_languages STRING, warc_filename STRING, warc_record_offset INT, warc_record_length INT, warc_segment STRING) PARTITIONED BY (crawl STRING, subset STRING) STORED AS parquet LOCATION 's3://commoncrawl/cc-index/table/cc-main/warc/';",
				QueryExecutionContext: {
					Database: "warcannon_commoncrawl"
				},
				WorkGroup: "warcannon"
			}).promise();

			console.log('[*] Initializing Athena table...'.blue);

			await athena.startQueryExecution({
				QueryString: "MSCK REPAIR TABLE ccindex",
				QueryExecutionContext: {
					Database: "warcannon_commoncrawl"
				},
				WorkGroup: "warcannon"
			}).promise();

			console.log('[+] Table created...'.green);
		})
		.command("populateAthena <executionId>", "Populates a job based on a previous Athena query.", (yargs) => yargs, async (argv) => {
			console.log('[*] Loading job. Please wait...'.blue);

			const loader = await lambda.invoke({
				FunctionName: "cc_athena_loader",
				InvocationType: "RequestResponse",
				LogType: "None",
				Payload: JSON.stringify({
					queryExecutionId: argv.executionId
				})
			}).promise();

			if ([...loader.StatusCode+''][0] == '2') {
				console.log(`[+] Loader completed successfully. Received response:\n${loader.Payload.toString()}`.green);
				return true;
			}

			console.log(`[!] Loader failed with code [${loader.StatusCode}]:\n${loader.Payload.toString()}`.red);
			return false;
		})
		.command("syncResults", "Download results from WARCannon to the local machine", (yargs) => yargs, async (argv) => {
			const Bucket = await getWarcannonBucket();
			const items = await getFullS3PrefixList(Bucket, '');

			ensurePathExists(resultsPath);

			const writes = items.map(e => {
				return downloadS3File(Bucket, e.Key, path.join(resultsPath, e.Key));
			});

			await Promise.all(writes);

			console.log("[+] Sync'd results to " + `${resultsPath}`.blue);

			return true;
		})
		.command("terminate", "Terminate all WARCannon spot fleets", (yargs) => yargs, async (argv) => {
			const sfrs = await ec2.describeSpotFleetRequests().promise();

			const warcannonSfrs = sfrs.SpotFleetRequestConfigs.map(e => {
				if (e.SpotFleetRequestState == "active") {
					if (e.Tags.filter(t => t.Key == "Name" && t.Value == "Warcannon").length > 0) {
						return e.SpotFleetRequestId
					}
				}

				return false
			}).filter(e => e != false)

			if (!warcannonSfrs.length) {
				console.log(`[*] No active campaigns found.`.blue);
				return true;
			}

			await ec2.cancelSpotFleetRequests({
				SpotFleetRequestIds: warcannonSfrs,
				TerminateInstances: true
			}).promise();

			console.log(`[+] Sent termination request for [${warcannonSfrs.length}] Spot Fleet(s)`.green);

			return true;

		})
		.command("testLocal [warcPath]", "Test the filter function locally", (yargs) => {
			return yargs.option('warcPath', {
				alias: 'w',
				default: 'crawl-data/CC-MAIN-2020-34/segments/1596439735792.85/warc/CC-MAIN-20200803083123-20200803113123-00033.warc.gz',
				type: 'string',
				description: 'The full path to a Common Crawl WARC.'
			}).option('force', {
				alias: 'f',
				default: false,
				type: 'boolean',
				description: 'Perform the test, ignoring changes to settings.json or matches.js.'
			}).option('stream', {
				alias: 's',
				default: false,
				type: 'boolean',
				description: 'Stream the WARC instead of downloading it.'
			});
		}, async (argv) => {
			if (needsRedeploy() && !argv.force) {
				console.log(`[*] Run a deploy, or try again with -f.`.blue);
				return false;
			}

			if (!argv.stream && !fs.existsSync('/tmp/warcannon.testLocal')) {
				console.log("[!] Downloading ~1.2GiB WARC. This may take several minutes.");
				await downloadS3File('commoncrawl', argv.warcPath, '/tmp/warcannon.testLocal');
			}

			ensurePathExists(resultsPath);

			resultFile = path.join(resultsPath, 'testResults.json');

			!fs.existsSync(resultFile) || fs.unlinkSync(resultFile);

			process.env.WARCANNON_IS_LOCAL = "true";
			const localTest = require(path.join(process.cwd(), '/lambda_functions/warcannon/main.js'));

			const waitForLocalTest = new Promise((success, failure) => {
				localTest.main({ warc: argv.warcPath, stream: argv.stream }, {}, console.log);
			});

			await waitForLocalTest;

			if (!fs.existsSync(resultFile)) {
				console.log(`[+] Local test succeeded. Results are stored in ${path.relative(resultsPath, resultFile)}`);
				return true;
			}

			console.log(`[-] Local test produced no results.`.blue)
			return false;
		})
		.command("test [warcPath]", "Test the filter function in Lambda", (yargs) => {
			return yargs.option('warcPath', {
				alias: 'w',
				default: 'crawl-data/CC-MAIN-2020-34/segments/1596439735792.85/warc/CC-MAIN-20200803083123-20200803113123-00033.warc.gz',
				type: 'string',
				description: 'The full path to a Common Crawl WARC.'
			}).option('force', {
				alias: 'f',
				default: false,
				type: 'boolean',
				description: 'Perform the test, ignoring changes to settings.json or matches.js.'
			});
		}, async (argv) => {
			if (needsRedeploy() && !argv.force) {
				console.log(`[*] Run a deploy, or try again with -f.`.blue);
				return false;
			}

			console.log('[*] Starting Lambda test. This may take several minutes, please be patient...'.blue);

			let loader;

			try {
				loader = await lambda.invoke({
					FunctionName: "warcannon",
					InvocationType: "RequestResponse",
					LogType: "None",
					Payload: JSON.stringify({
						warc: argv.warcPath
					})
				}).promise();
			} catch(e) {
				console.log(`[!] Lambda execution failed with error: ${e}\n`);
				console.log(`[!] If the function timed out, your regex pattern is likely too expensive.`)
				console.log(`[!] Consider optimizing your regex, otherwise stick to local tests or limited test campaigns.`);
				return false;
			}

			if ([...loader.StatusCode+''][0] == '2') {
				console.log(`[+] Loader completed successfully. Received response:\n${loader.Payload.toString()}`.green);
				return true;
			}

			console.log(`[!] Loader failed with code [${loader.StatusCode}]:\n${loader.Payload.toString()}`.red);
			return false;

		})
		.command("fire", "Fires the WARCannon.", (yargs) => yargs, async (argv) => {
			const ready = await verifyStatus();

			if (!ready) {
				return true;
			}

			const settings = JSON.parse(fs.readFileSync('settings.json'));

			console.log(`[+] This will request [ ${settings.nodeCapacity.toString().green} ] nodes of type [ ${settings.nodeInstanceType.join(", ").green} ]`);
			console.log("	lasting for [ " + `${(Math.round(settings.nodeMaxDuration / 360) / 10).toString()} hours`.green + " ]\n");
			console.log("To change this, edit your settings in " + "'settings.json'".green + " and re-deploy.");

			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout
			});

			const fire = await new Promise((success, failure) => {
				rl.question("--> Ready to fire? [Only " + "Yes".green + " will be accepted]: ", function(answer) {
					rl.close();


					return success(answer == "Yes");
				});
			});

			if (!fire) {
				console.log("[!] WARCannon aborted.");
				return true;
			}
			
			const sfr = await ec2.requestSpotFleet({
				SpotFleetRequestConfig: JSON.parse(fs.readFileSync('./render-warcannon/spot_request.json'))
			}).promise();

			console.log(sfr);

			const distributions = await cf.listDistributions().promise();
			const url = distributions.DistributionList.Items.filter(e => e.Comment == "Warcannon")?.[0]?.DomainName;

			console.log("[+] Spot fleet request has been sent, and nodes should start coming online within ~5 minutes.".green);
			console.log("[+] Monitor node status and progress at ".green + `https://${url}`.blue + "\n");
			
			return true
		})
		.command("quickResults [pattern]", "Show the value and source of locally-synced results from files matching an optional pattern.", (yargs) => yargs, async (argv) => {
			const quickResults = fs.readdirSync(resultsPath)
				.filter(e => !!!argv.pattern || e.indexOf(argv.pattern))
				.reduce((a, e) => {
					const results = JSON.parse(fs.readFileSync(path.join(resultsPath, e)));

					Object.keys(results.regex_hits)
						.map(regex => {
							if (!!!a[regex]) {
								a[regex] = {};
							};

							Object.keys(results.regex_hits[regex])
								.filter(x => !!!a[regex][x.value])
								.map(x => {
									x = results.regex_hits[regex][x];
									const firstSource = Object.keys(x).filter(k => k != "value")[0]
									a[regex][x.value] = x[firstSource][0];
								});
						});

					return a;
				}, {});

				console.log(JSON.stringify(quickResults));
			
			return true
		})
		.help("help")
		.argv;
})();

function showBanner() {
	if (process.stdout.columns < 200 && process.stdout.columns > 79) {
		console.log("((((((  /((((   ((((((  ((((((/     ((((((((((*     /(((((((((");
		console.log("((((((  ((((((  (((((  ((((((((     ((((((((((((  ((((((((((( ");
		console.log(" (((((/#(((((( (((((( *(((((((((    (((((/ (((((*((((((       ");
		console.log("  ((((((((((((((((((  ((((( (((((   (((((((((((  ((((((       ");
		console.log("  ((((((((  (((((((/ (((((((((((((  (((((((((((  /((((((((((( ");
		console.log("   ((((((/  #(((((# (((((*   (((((# (((((/ ((((((  (((((((((((");
		console.log("         @@@@@@    %@@@@@/  &@@@@@ @@@@@@   @@@@@   @@@@@@@@@@@* @@@@@    @@@@@");
		console.log("        @@@@@@@&   %@@@@@@% &@@@@@ @@@@@@@  @@@@@ &@@@@@@@@@@@@* @@@@@@   @@@@@");
		console.log("       @@@@@@@@@(  %@@@@@@@@&@@@@@ @@@@@@@@*@@@@@ @@@@@     @@@@ @@@@@@@@*@@@@@");
		console.log("      @@@@@ @@@@@* %@@@@@@@@@@@@@@ @@@@@@@@@@@@@@ @@@@@     @@@@ @@@@@@@@@@@@@@");
		console.log("     @@@@@**(@@@@@ %@@@@@  @@@@@@@ @@@@@  @@@@@@@ @@@@@@@@@@@@@/ @@@@@   @@@@@@");
		console.log("   *@@@@@####@@@@@%%@@@@@*  @@@@@@ @@@@@*  @@@@@@   @@@@@@@@@%   @@@@@*   @@@@@");
		console.log("         <a @c6fc project>");
		console.log("\n\n");
	}

	if (process.stdout.columns > 200) {
		console.log("                                                                                                                                                     ");
		console.log("     ((((((  /((((   ((((((  ((((((/     ((((((((((*     /(((((((((      @@@@@@     %@@@@@/  &@@@@@ @@@@@@   @@@@@/    @@@@@@@@@*    @@@@@@   @@@@@  ");
		console.log("     ((((((  ((((((  (((((  ((((((((     ((((((((((((  (((((((((((*     @@@@@@@&    %@@@@@@% &@@@@@ @@@@@@@  @@@@@/ &@@@@@@@@@@@@@@  @@@@@@@  @@@@@  ");
		console.log("      (((((/#(((((( (((((( *(((((((((    (((((/ (((((*((((((           @@@@@@@@@(   %@@@@@@@@&@@@@@ @@@@@@@@*@@@@@/@@@@@@     @@%/****(#%%(***&@@@@  ");
		console.log("       ((((((((((((((((((  ((((( (((((   (((((((((((  ((((((          @@@@@ @@@@@*  %@@@@@@@@@@@@@@ @@@@@%@@@@@@@@/@#/****(##(%%%#/********##*@@@@@  ");
		console.log("       ((((((((  (((((((/ (((((((((((((  (((((((((((  /(((((((((((   @@@#***(###/% ####**( @@@@@@@# ***/*****/######%%%(***********#(***(& #@@@@@@@  ");
		console.log("        ((((((/  #(((((# (((((*   (((((# (((((/ ((((((  ((((((((****###(/########/%/#####%**((****/#*#/#*%*##*************(%***/@%   @@@@@  /@@@@@@  ");
		console.log("                                                         **/#(******//((#########**/######/**//***  *# #*********/#***                               ");
		console.log("                                                  */#(*(****** ((/*%(****## *###*##**#####%*#(***(#/**#*#*****                   *                   ");
		console.log("                                                *#* **********#**#((*%*##( **/##/*#/(*#####%**###****(****                     #                     ");
		console.log("                                              **/%*/**/******#**/##%(#/** *#**/##*##***####%/********(##/                    #*                      ");
		console.log("                                          */%((*/*(*#*******%%%%*#((#*%** *****/##*##**/####%******%( ###*##           /###(                         ");
		console.log("                                         *#(**(#(**(%%%%(*****%%*#*%(*%%#%%%%(**/#/**#**#(####%******/###/*#*###   #*# *             /               ");
		console.log("                                      *  %%%%#* * * ####(%#*#%*(*/##**%%%%%%%%#***####/**#*###############*  #/# *# #(          (#                   ");
		console.log("                              (/    #  **##*######/####*%/****#*%%%%#***(((((((***/####***#*** ((####*###/(*****#/(###        //                     ");
		console.log("                           #/     #* *#*###/#####**####(%***/%%*%%%%%#**/%%%%%%**(*(####********/(###((//(#*   #*##*##/###                           ");
		console.log("                         ((      #/ **#*##*(###(*#/###/%%*#/((/*#%%%##*%*(*###******(/######/* /(#((/*******#####*#*   *###(##/                      ");
		console.log("                /#      (#*    *###  %*### */(****####*%%* *#%%**%%%#(*%#******#***#####/#** **#*##########*  **(%%%%* #*** (*                       ");
		console.log("             #/      *###*### (#/###*%*###******/*####*%%****#%****%%%/%%**** *%******(/**********(##%%%(/**#%#**(%%%(**    *#*       *              ");
		console.log("            #/        #(#####*###  *#%*###(##(########/%(*(***%*******((%**(((*%***#/********#((****/(%#(*******#/****(%##* *#*/ *###*       /       ");
		console.log("           ( /   (  **#( ####    //*%/################/%(*********************************************(********#*%***%%%%(#*#*  (#((     ###*        ");
		console.log("         ##     ####   ##   ###(*/ *%*##*******/%%/* ** * *********************/%/***//##########***%%(##** ***#*%***%/%%##*/#** #(   /#/            ");
		console.log("         (     ### *#((   ##    **/########(/*%%#***(#**%%%%%%*****%*#**(***/#%%(%%%%%#(///*****%%%%%%%%##%%#(***%***(*%%%#/***#*## ##(#*   //       ");
		console.log("           #   (#( #(     #  *#**/(#%%%%%%#%#%##   ##(**%%##(%****/(#*#***##%%%%%%%%%%%%%%%%%%/%%%%%%#*%**##**%##/****#%%%## **(#* (((    ((         ");
		console.log("          #*###     **/#/***#%%%(**** *****/*%#***(##**%%%%%******#**#**(#%************* */#%%%%%%#*((####*******(%(#** %%##**(%#*####*              ");
		console.log("         #(***/#******#*#(*#*****/######((*/*/( **####**#*##%***#  (***##(/**#(((########*#*%%%%#****##%(************%%#*((#****#*   (##(##          ");
		console.log("       (#%#%%%%%#%%%%%*#**%/***/%%%####%%%*#*#***#(######/*/**/#/*****#%*(*#*(%%#######(*(*%###*(/****#%%%%%%(%%##******%#/****#(#*   #######        ");
		console.log("    *#% (%/********%%*//*%*(*(*/********** /*#***/*(##(##/######*** *#** **************** #/#*#****#**/####%%%%#%%#*#(#****%( */(#*##(  /####((      ");
		console.log("   ***%*** *****(**%%*#*#/(##/****** ***********/############/##****#(#%%%%%%#/* *********#*#****#*****##****/##%%%%%%%%##****%(*#*  /##  (*#/#      ");
		console.log("     ***#***/#(/***%%**(%%%%%%#%%%%%###*****(***#*****####(***** **/* #%%%%%%%%%%%%%%%%%#******#***#***********  (#%%#/***///***(#*   ##  * ##*      ");
		console.log("    *###********##(*%**(##%%%#%%%#####/*****(*************/////****/* */#(#####%#######/**//((**/*%*****************(********##****(*     (##        ");
		console.log("   ***#########/(** (/ ***/##*####/*********/****############******# ************/((/*****************(####*(##/****%##/***(#%**(*** #####(          ");
		console.log("   /(##(####***********#**********//((((((//##***#############***** ////(#######***********************(######(#*###********#**##**#*    ##/         ");
		console.log("  *################(*/*****//#################****####((((((((/****###*** *(#####((#/*** **********(##########**#*/*/%%%%#**/*#** /(*(*/##   /       ");
		console.log("  */**/########*/*******%#*(*****##*%(*****###*/**#########(*******%#*%*** **#//%******##****#*#########*####*(****%%#***%(*/##*/****#**####*        ");
		console.log("  *(#########/***********%*/#/****##*%***** #(#****###########*****##*%/*****#*/%******#********/###########**#***%%***(#*%*#// */******/#           ");
		console.log("   *############( **/*(#**#**%**** #(*%*/***/###******************* #* (  ***#(*%******#******(#(###########*#** #%***#*#*%***(*(/*(/*/**#           ");
		console.log("    /###########*/*****(******%*****##*%(/*** ###***************** */#*%*****(#*%******#**/(#//########(/##/*#***%%  *#*#*%** (#**/***#**   #/       ");
		console.log("    *(###***(##**(((****(**/****%* **/#/*%*/***/###******************(#*%/****#*%#/****#*****/****////(####*(#***%#* (#(*#***********(***  *         ");
		console.log("     *(################* *(#*#************** * /**/***** **************(*/****#//%*****#******#############*/#***%#*#(//*#*#** / **#****/            ");
		console.log("       *##(######(#(#***** #****%%%**#*(   */***/********************************/******#** **(####*###(*//* #***%%*/#*(%   /#*(#**#****(#           ");
		console.log("        *####((#####/**/##****#*******/ * **/********** **** *  ******************************########(#####*##**(%%%%%/* ( #**(#*(***(*             ");
		console.log("          *####(#########*(***** (#*//(# ** ****                           ***** ***********((###############*##%**/(***/* #**/****                  ");
		console.log("            */(##****(########(#**#***********                               ****************** ###########****(##%*****/***( **                     ");
		console.log("                          * *******                <a @c6fc project>          ******        **/*****############*/###*#(##**                         ");
		console.log("                                                                                                      ************** *                               ");
		console.log("\n\n");
	}
}

async function showStatus() {

	if (!fs.existsSync('render-warcannon/userdata.sh')) {
		console.log(`Deployed [ ${"NO".red} ]; Run ${"warcannon deploy".blue} to get started`);
		return false;
	}

	try {

		const identity = await sts.getCallerIdentity().promise();
		
		const [queue, distributions, sfrs] = await Promise.all([
			
			sqs.getQueueAttributes({
				QueueUrl: `https://sqs.us-east-1.amazonaws.com/${identity.Account}/warcannon_queue`,
				AttributeNames: ["ApproximateNumberOfMessages"]
			}).promise(),
			cf.listDistributions().promise(),
			ec2.describeSpotFleetRequests().promise()
		]);

		const url = distributions.DistributionList.Items.filter(e => e.Comment == "Warcannon")?.[0]?.DomainName;
		const sfr = sfrs.SpotFleetRequestConfigs.filter(e => {
			if (e.SpotFleetRequestState == "active") {
				return !!e.Tags.filter(t => t.Key == "Name" && t.Value == "Warcannon").length;
			}

			return false;
		})?.[0];

		const queueStatus = (queue.Attributes.ApproximateNumberOfMessages == 0) ? "EMPTY".blue : `${queue.Attributes.ApproximateNumberOfMessages} Messages`.green;

		console.log(`Deployed [ ${"YES".green} ] SQS Status: [ ${queueStatus} ] `);

		if (!sfr) {
			console.log(`Job Status: [ ${ "INACTIVE".red } ]`);
		} else {
			console.log(`Job Status: [ ${ sfr.SpotFleetRequestState.green } ] [ ${ sfr.SpotFleetRequestId.green } ]`);
			//console.log(`Requested Nodes: ${settings.nodeCapacity.toString().blue}x [ ${settings.nodeInstanceType.blue} ]`);
			console.log(`Active job url: ` + `https://${url}`.blue);
		}
	} catch(e) {
		console.log(`Deployed [ ${"NO".red} ]; Run ${"warcannon deploy".blue} to get started`);
		return false;
	}
}

async function verifyStatus() {

	if (!fs.existsSync('render-warcannon/userdata.sh')) {
		console.log(`[!] WARCannon must be deployed first.`.red);
		return false;
	}

	if (needsRedeploy()) {
		console.log(`[*] Run a deploy, then try again.`.blue);
		return false;
	}	

	const identity = await sts.getCallerIdentity().promise();
	
	const [queue, sfrs] = await Promise.all([
		
		sqs.getQueueAttributes({
			QueueUrl: `https://sqs.us-east-1.amazonaws.com/${identity.Account}/warcannon_queue`,
			AttributeNames: ["ApproximateNumberOfMessages"]
		}).promise(),
		ec2.describeSpotFleetRequests().promise()
	]);

	const sfr = sfrs.SpotFleetRequestConfigs.filter(e => {
		if (e.SpotFleetRequestState == "active") {
			return !!e.Tags.filter(t => t.Key == "Name" && t.Value == "Warcannon").length;
		}

		return false;
	})?.[0];

	if (!!sfr) {
		console.log(`[!] You already have a campaign running.`.red);
		return false;
	}

	const queueEmpty = (queue.Attributes.ApproximateNumberOfMessages == 0);

	if (queueEmpty) {
		console.log(`[!] Queue is empty. Populate it first.`.red);
		return false;
	}

	return true;
}

async function emptyS3Bucket(Bucket) {
	const list = await s3.listObjects({
		Bucket
	}).promise();

	if (list.Contents.length > 0) {
		await s3.deleteObjects({
			Bucket,
			Delete: {
				Objects: list.Contents.map(e => { return { Key: e.Key }})
			}
		}).promise();

		return emptyS3Bucket(Bucket);
	}

	return true;
}

async function getFullS3PrefixList(Bucket, Prefix, NextContinuationToken = null) {
	let objects = [];

	const list = await s3.listObjects({
		Bucket,
		Prefix,
		[ (!!NextContinuationToken) ? 'NextContinuationToken' : null ]: NextContinuationToken
	}).promise();

	objects = objects.concat(list.Contents);

	if (list.NextContinuationToken) {
		return getFullS3PrefixList(Bucket, Prefix, list.NextContinuationToken);
	}

	return objects;
}

async function getWarcannonBucket() {
	const buckets = await s3.listBuckets().promise();

	const warcannonBuckets = buckets.Buckets
		.map(e => {
			if (/^warcannon-results-[0-9]+$/.test(e.Name)) {
				return e.Name
			}

			return false
		})
		.filter(e => e != false);

	if (warcannonBuckets.length == 0) {
		console.log(`[!] Unable to locate WARCannon Results bucket.`)
		return false;
	}

	if (warcannonBuckets.length > 1) {
		console.log(`[!] You have more than one results bucket in your account. Unable to proceed.`);
		return false;
	}

	return warcannonBuckets[0];
}

function downloadS3File(Bucket, Key, outputFile) {
	return new Promise((success, failure) => {
		const file = fs.createWriteStream(path.join(outputFile));
		s3.getObject({ Bucket, Key })
			.createReadStream()
			.on('end', () => {
				console.log(Key.green);
				return success();
			})
			.on('error', (err) => {
				console.log(`${Key}: ${err}`.red);
				return failure(err);
			})
			.pipe(file);
	});
}

function newerThan(first, second) {
	const one = fs.statSync(first);
	const two = fs.statSync(second);

	return one.mtimeMs > two.mtimeMs;
}

function ensurePathExists(path) {
	if (!fs.existsSync(path)) {
		fs.mkdirSync(path);
	}

	return true;
}

function needsRedeploy() {
	let redeploy = false;

	if (newerThan('settings.json', 'render-warcannon/backend.tf.json')) {
		console.log(`[!] settings.json has been changed since last deploy.`.red);
		redeploy = true;
	}

	if (newerThan('lambda_functions/warcannon/matches.js', 'render-warcannon/backend.tf.json')) {
		console.log(`[!] matches.js has been changed since last deploy.`.red);
		redeploy = true;
	}

	return redeploy;
}