{
	resource(settings): {
		"resource": {
			"null_resource": {
				"s3-sync-static-content": {
					"provisioner": [{
						"local-exec": {
							"command": "aws --profile " + settings.awsProfile + " s3 --region " + settings.defaultRegion + " sync ${path.module}/site_content/ s3://${aws_s3_bucket.static_site.id}"
						}
					}],

					"depends_on": ["aws_s3_bucket.static_site", "local_file.cognito_config"],
					#"triggers": {
						#"always-trigger": "${timestamp()}",
					#}
				}
			}
		}
	}
}
