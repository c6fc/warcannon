{
	resource(settings): {
		"resource": {
			"null_resource": {
				"s3-sync-static-content": {
					"provisioner": [{
						"local-exec": {
							"command": "aws s3 --region us-east-1 sync ../site_contents/ s3://${aws_s3_bucket.static_site.id}"
						}
					}],

					"depends_on": ["aws_s3_bucket.static_site"],
					"triggers": {
						"always-trigger": "${timestamp()}",
					}
				}
			}
		}
	}
}
