local distribution(settings) = {
	resource: {
		"aws_cloudfront_origin_access_identity": {
			"warcannon": {
				"comment": "OAI for Warcannon",
			},
		},
		"aws_cloudfront_distribution": {
			"warcannon": {
				"comment": "Warcannon",
				"enabled": true,
				"is_ipv6_enabled": false,
				"default_root_object": "index.html",
				"origin": {
					"domain_name": "${aws_s3_bucket.static_site.bucket_regional_domain_name}",
					"origin_id": "static",

					"s3_origin_config": {
						"origin_access_identity": "${aws_cloudfront_origin_access_identity.warcannon.cloudfront_access_identity_path}",
					}
				},
				"default_cache_behavior": {
					"allowed_methods": ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
					"cached_methods": ["GET", "HEAD"],
					"target_origin_id": "static",
					"forwarded_values": {
						"query_string": false,

						"cookies": {
							"forward": "none",
						}
					},
					"viewer_protocol_policy": "redirect-to-https",
					"min_ttl": 0,
					"max_ttl": 300,
					"default_ttl": 0,
				},
				"price_class": "PriceClass_100",
				"restrictions": {
					"geo_restriction": {
						"restriction_type": "none",
					}
				},

				"viewer_certificate": {
					"cloudfront_default_certificate": true,
				}

			}
		}
	},
	"output": {
		"cloudfront_url": {
			"value": "${aws_cloudfront_distribution.warcannon.domain_name}"
		}
	}
};

{
	distribution: distribution
}