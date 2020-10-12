'use strict';
var AWS = require("aws-sdk");
var s3 = new AWS.S3({region: "us-east-1"});
var ec2 = new AWS.EC2({region: "us-east-1"});
var sqs = new AWS.SQS({region: "us-east-1"});
var ddb = new AWS.DynamoDB({region: "us-east-1"});

exports.main = (event, context, callback) => {

	var message = {};
	var terminate = true;

	ddb.scan({
		TableName: "warcannon_progress"
	}).promise()
	.then((data) => {
		var progressObj = {
			generated: new Date() - 0,
			metrics: []
		};

		var now = new Date() - 0;
		data.Items.forEach(function(i) {
			var item = AWS.DynamoDB.Converter.unmarshall(i);

			if (item.until > new Date() / 1000) {
				if (item.state == "starting" || item.warcListLength > 0) {
					terminate = false;
				}

				progressObj.metrics.push(item);
			}
		});

		message = progressObj;

		return sqs.getQueueAttributes({
			QueueUrl: process.env.QUEUEURL,
			AttributeNames: [
				"ApproximateNumberOfMessages",
				"ApproximateNumberOfMessagesNotVisible"
			]
		}).promise();

	}).then((result) => {	

		message.sqs = result.Attributes;

		if (terminate || (message.sqs.ApproximateNumberOfMessages == 0 && message.sqs.ApproximateNumberOfMessagesNotVisible == 0)) {
			return cancelWarcannonSpotFleetRequests();
		} else {
			return Promise.resolve();
		}

	}).then(() => {

		return s3.putObject({
			Bucket: process.env.DESTINATIONBUCKET,
			Key: 'progress.json',
			Body: JSON.stringify(message),
			ContentType: 'application/json'
		}).promise()

	}).then((result) => {

		console.log("Updated successfully.")
		callback(null, "Updated successfully.");

	}, (err) => {

		console.log(err);
		callback(err);

	});
};

function cancelWarcannonSpotFleetRequests() {
	return new Promise((success, failure) => {
		var sfrsToTerminate = [];

		console.log("cancelWarcannonSpotFleetRequests() triggered.");
		ec2.describeSpotFleetRequests().promise()
		.then((data) => {
			data.SpotFleetRequestConfigs.forEach(function(c) {
				if (c.SpotFleetRequestState == "active") {
					c.Tags.forEach(function(t) {
						if (t.Key == "Name" && t.Value == "Warcannon") {
							sfrsToTerminate.push(c.SpotFleetRequestId);
						}
					});
				}
			});

			if (sfrsToTerminate.length > 0) {
				console.log("Have " + sfrsToTerminate.length + " to kill.");
				ec2.cancelSpotFleetRequests({
					SpotFleetRequestIds: sfrsToTerminate,
					TerminateInstances: true
				}).promise()
				.then((data) => {
					return success();
				});
			}

			return success();
		})
	});
}