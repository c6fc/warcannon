# WARCannon - Catastrophically powerful parallel WARC processing

![Image](http://c6fc.io/warcannon-cli.png)

WARCannon was built to simplify and cheapify the process of 'grepping the internet'.

With WARCannon, you can:
* Build and test regex patterns against real Common Crawl data
* Easily load Common Crawl datasets for parallel processing
* Scale compute capabilities to asynchronously crunch through WARCs at frankly unreasonable capacity.
* Store and easily retrieve the results

## How it Works

WARCannon leverages clever use of AWS technologies to horizontally scale to any capacity, minimize cost through spot fleets and same-region data transfer, draw from S3 at incredible speeds (up to 100Gbps per node), parallelize across hundreds of CPU cores, report status via DynamoDB and CloudFront, and store results via S3.

In all, WARCannon can process multiple regular expression patterns across 400TB in a few hours for around $100.

## Installation

WARCannon requires that you have the following installed: 
* **awscli** (v2)
* **terraform** (v0.11)
* **jq**
* **jsonnet**
* **npm** (v12 or v14)

**ProTip:** To keep things clean and distinct from other things you may have in AWS, it's STRONGLY recommended that you deploy WARCannon in a fresh account. You can create a new account easily from the 'Organizations' console in AWS. **By 'STRONGLY recommended', I mean 'seriously don't install this next to other stuff'.**

First, clone the repo and copy the example settings.

```sh
$ git clone git@github.com:c6fc/warcannon.git
$ cd warcannon
warcannon$ cp settings.json.sample settings.json
```

Edit `settings.json` to taste:

* `backendBucket`: Is the bucket to store the terraform state in. If it doesn't exist, WARCannon will create it for you. Replace '&lt;somerandomcharacters&gt;' with random characters to make it unique, or specify another bucket you own.
* `awsProfile`: The profile name in `~/.aws/credentials` that you want to piggyback on for the installation.

* `nodeInstanceType`: An array of instance types to use for parallel processing. 'c'-types are best value for this purpose, and any size can be used. `["c5n.18xlarge"]` is the recommended value for true campaigns.
* `nodeCapacity`: The number of nodes to request during parallel processing. The resulting nodes will be an arbitrary distribution of the `nodeInstanceTypes` you specify.
* `nodeParallelism`: The number of simultaneous WARCs to process *per vCPU*. `2` is a good number here. If nodes have insufficient RAM to run at this level of parallelism (as you might encounter with 'c'-type instances), they'll run at the highest safe parallelism instead.
* `nodeMaxDuration`: The maximum lifespan of compute nodes in seconds. Nodes will be automatically terminated after this time if the job has still not completed. Default value is 24 hours.
* `sshPubkey`: A public SSH key to facilitate remote access to nodes for troubleshooting.
* `allowSSHFrom`: A CIDR mask to allow SSH from. Typically this will be `&lt;yourpublicip&gt;/32`

## Grepping the Internet

WARCannon is fed by [Common Crawl](https://commoncrawl.org/) via the [AWS Open Data](https://registry.opendata.aws/) program. Common Crawl is unique in that the data retrieved by their spiders not only captures website text, but also other text-based content like JavaScript, TypeScript, full HTML, CSS, etc. By constructing suitable Regular Expressions capable of identifying unique components, researchers can identify websites by the technologies they use, and do so without ever touching the website themselves. The problem is that this requires parsing hundreds of terabytes of data, which is a tall order no matter what resources you have at your disposal.

### Developing Regular Expressions

Grepping the internet isn't for the faint of heart, but starting with an effective seive is the first start. WARCannon supports this by enabling local verification of regular expressions against real Common Crawl data. First, open `lambda_functions/warcannon/matches.js` and modify the `regex_patterns` object to include the regular expressions you wish to use in `name: pattern` format. Here's an example from the default search set:

```javascript
exports.regex_patterns = {
	"access_key_id": /(\'A|"A)(SIA|KIA|IDA|ROA)[JI][A-Z0-9]{14}[AQ][\'"]/g,
};
```

Strings matching this expression will be saved under the corresponding key in the results; `access_key_id` in this case. **Protip:** Use (RegExr)[https://regexr.com] with the 'JavaScript' format to build and test regular expressions against known-good matches.

Once the `matches.js` is populated, run the following command:
```bash
warcannon$ ./warcannon testLocal <warc_path>
```

WARCannon will then download the warc and parse it with your configured matches. There are a few quality-of-life things that WARCannon does by default that you should be aware of:
1. WARCannon will download the warc to `/tmp/warcannon.testLocal` on first run, and will re-use the downloaded warc from then on even if you change the warc_path. If you wish to use a different warc, you must delete this file.
2. Warcs are large; most coming in at just under 1GB. WARCannon uses the CLI for multi-threaded downloads, but if you have slow internet, you'll need to exercize patience the first time around.

On top of everything else, WARCannon will attempt to evalutate the total compute cost of your regular expressions when run locally. This way, you can be informed if a given regular expression will significantly impact performance *before* you execute your campaign.

![Image](http://c6fc.io/warcannon-dev.png)

### Performing Custom Processing

Sometimes a simple regex pattern isn't sufficient on its own, and you need some additional steps to ensure you're returning the right information. In this case, simply adding a function to the `exports.custom_functions` object with the same key name allows you to perform any additional processing you see fit.

```javascript
exports.regex_patterns = {
	"access_key_id": /(\'A|"A)(SIA|KIA|IDA|ROA)[JI][A-Z0-9]{14}[AQ][\'"]/g,
};

exports.custom_functions = {
	"access_key_id": function(match) {
		// Ignore matches with 'EXAMPLE' in the text, since this is common for documentation.
		if (match.text(/EXAMPLE/) != null) {
			// Returning a boolean 'false' discards the match.
			return false
		}
	}
}
```

**Note: WARCannon is meant to crunch through text at stupid speeds.** While it's certainly *possible* to perform any type of operation you'd like, adding high-latency custom functions such as network calls can significantly increase processing time and costs. Network calls could also result in LOTS of calls against a website, which could get you in trouble. Be smart about how you use these functions.

### Performing a One-Off Test in AWS

The costs of AWS can be anxiety-inducing, especially when you're only looking to do some research. WARCannon is built to allow both one-off executions in addition to full campaigns, so you can be confident in the results you'll get back. Once you're happy with the results you get with `testLocal`, you can deploy your updated matches and run a cloud-backed test easily:
```bash
warcannon$ ./warcannon deploy
warcannon$ ./warcannon test <warc_path>
```

This will synchronously execute a Lambda function with the regular expressions you've configured, and immediately return the results. This process takes about 2.5 minutes, so don't be afraid to wait while it does its magic.

### Launching a Real Campaign

Once you're happy with the results you get in Lambda, you're ready to grep the internet for real. We'll first go over some basic housekeeping, then kick it off.

#### Clearing the Queue

WARCannon uses AWS Simple Queue Service to distribute work to the compute nodes. To ensure that your results aren't tainted with any prior runs, you can tell WARCannon to empty the queue:
```bash
warcannon$ ./warcannon empty
[+] Cleared [ 15 ] messages from the queue
```

You can then verify the state of the queue:
```bash
warcannon$ ./warcannon status
	Deployed: [ YES ]; SQS Status: [ EMPTY ]
	Job Status: [ INACTIVE ]
	Active job url: https://d201offlnmhkmd.cloudfront.net
```

Verify the following before proceeding:
1. The SQS Queue is empty
2. The job status is 'INACTIVE'

#### Populating the Queue

In order to create the queue messages that the compute nodes will consume, you must first populate SQS with crawl data. WARCannon has several commands to help with this, starting with the ability to show the available scans. In this case, let's look at the scans available for the year 2021:
```bash
warcannon$ ./warcannon list 2021
CC-MAIN-2021-04
CC-MAIN-2021-10
```

We have two scans matching the string "2021" to work with. We can now instruct WARCannon to populate the queue based on one of these scans. This time, we need to provide a parameter that uniquely identifies one of the scans. "2021-04" will do the trick. We could choose to populate only a partial scan by also specifying a number of chunks and a chunk size, but we'll skip that for now.

```bash
warcannon$ ./warcannon populate 2021-04
{Created 799 chunks of 100 from 79840 available segments"
    "StatusCode": 200,
    "ExecutedVersion": "$LATEST"
}
```

#### Firing the WARCannon

With the queue populated, we're ready to fire. WARCannon will do a few sanity checks to ensure everything is in order, then show you the configuration of the campaign and give you one last opportunity to abort before you finalize the order.

```bash
warcannon$ ./warcannon fire
[!] This will request [ 6 ] spot instances of type [ m5n.24xlarge, m5dn.24xlarge ]
    lasting for [ 86400 ] seconds.

To change this, edit your settings in settings.json and run ./warcannon deploy
--> Ready to fire? [Yes]: 
```

Pull the trigger by responding with 'Yes'.
```bash
--> Ready to fire? [Yes]: Yes
{
    "SpotFleetRequestId": "sfr-03dd32b8-51f7-4c8e-802b-a702fc3c8c95"
}
[+] Spot fleet request has been sent, and nodes should start coming online within ~5 minutes.
    Monitor node status and progress at https://d201offlnmhkmd.cloudfront.net
```

The response includes a link to your unique status URL, where you can monitor the progress of your campaign and the performance of each node.

![Image](http://c6fc.io/warcannon-progress.png)

#### Obtaining Results

Results are stored in S3 in JSON format, broken down by each node responsible for producing the results.