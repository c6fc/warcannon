'use strict';
var AWS = require("aws-sdk");
var s3 = new AWS.S3({region: "us-east-1"});
var ddb = new AWS.DynamoDB({region: "us-east-1"});

exports.main = (event, context, callback) => {

	ddb.scan({
		TableName: "warcannon_progress"
	}).promise()
	.then((data) => {
		var progressObj = {
			generated: new Date() - 0,
			metrics: []
		};

		data.Items.forEach(function(i) {
			progressObj.metrics.push(AWS.DynamoDB.Converter.unmarshall(i));
		});

		console.log(progressObj);

		return s3.putObject({
			Bucket: process.env.DESTINATIONBUCKET,
			Key: 'progress.json',
			Body: JSON.stringify(progressObj),
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