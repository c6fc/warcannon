'use strict';

const yargs = require('yargs');
const colors = require('@colors/colors');
const { WARCannon } = require('./warcannon.js');

yargs
	.usage("Syntax: $0 <command> [options]")
	.command("*", "RTFM is hard", yargs => yargs, (argv) => {
		console.log("[~] RTFM is hard. (Try 'help')".rainbow);
	})
	.command("fire <results_bucket> <sqs_url> <parallelism_factor>", "Process WARCs from an SQS queue", yargs => {
		return yargs.option('results_bucket', {
			type: 'string',
			description: 'The bucket to store results to.'
		}).option('sqs_url', {
			type: 'string',
			description: 'The SQS queue URL of the queue to load work from.'
		}).option('parallelism_factor', {
			type: 'number',
			description: 'How many WARCs to run in parallel per-vCPU.'
		});
	}, async (argv) => {
		const warcannon = new WARCannon({
			results_bucket: argv.results_bucket,
			sqs_url: argv.sqs_url,
			parallelism_factor: argv.parallelism_factor
		});

		await warcannon.start();

		return true;
	})
	.help("help")
	.argv;