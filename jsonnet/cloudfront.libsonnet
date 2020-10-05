
{
	resource(settings): {
		"aws_cloudfront_origin_access_identity": {
			"mspassumerole": {
				"comment": "OAI for Observian MSP AssumeRole",
			},
		},
		"aws_cloudfront_distribution": {
			"mspassumerole": {
				"comment": "Observian MSP AssumeRole",
				"enabled": true,
				"is_ipv6_enabled": false,
				"default_root_object": "index.html",
				"logging_config": {
					"include_cookies": false,
					"bucket": "${aws_s3_bucket.logs.bucket_domain_name}",
					"prefix": "cloudfront",
				},
				"origin": {
					"domain_name": "${aws_s3_bucket.static_site.bucket_regional_domain_name}",
					"origin_id": "static",

					"s3_origin_config": {
						"origin_access_identity": "${aws_cloudfront_origin_access_identity.mspassumerole.cloudfront_access_identity_path}",
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

				"aliases": ["styx.observian.com"],
				"viewer_certificate": {
					"cloudfront_default_certificate": false,
					"acm_certificate_arn": "${aws_acm_certificate.www.arn}",
					"ssl_support_method": "sni-only",
				},

				"depends_on": ["aws_acm_certificate_validation.www"]

			},
			"mspassumerole-endpoint": {
				"comment": "Observian MSP AssumeRole Endpoint",
				"enabled": true,
				"is_ipv6_enabled": false,
				"default_root_object": "",
				"logging_config": {
					"include_cookies": false,
					"bucket": "${aws_s3_bucket.endpoint-logs.bucket_domain_name}",
					"prefix": "cloudfront",
				},
				"origin": {
					"domain_name": "${aws_api_gateway_rest_api.mspassumerole.id}.execute-api.us-west-2.amazonaws.com",
					"origin_path": "/v1/endpoint",
					"origin_id": "api-gateway-endpoint",

					"custom_origin_config": {
						"http_port": 80,
						"https_port": 443,
						"origin_protocol_policy": "https-only",
						"origin_ssl_protocols": ["TLSv1.2"]
					}
				},
				"default_cache_behavior": {
					"allowed_methods": ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
					"cached_methods": ["GET", "HEAD"],
					"target_origin_id": "api-gateway-endpoint",
					"forwarded_values": {
						"query_string": true,

						"cookies": {
							"forward": "none",
						}
					},
					"lambda_function_association":: {
						event_type: "viewer-request",
						lambda_arn: "${aws_lambda_function.msp-assumerole_endpoint_proxy.qualified_arn}",
						include_body: true
					},
					"viewer_protocol_policy": "https-only",
					"min_ttl": 0,
					"max_ttl": 0,
					"default_ttl": 0,
				},
				"price_class": "PriceClass_100",
				"restrictions": {
					"geo_restriction": {
						"restriction_type": "none",
					}
				},

				"aliases": ["assumerole.msp.observian.com"],
				"viewer_certificate": {
					"cloudfront_default_certificate": false,
					"acm_certificate_arn": "${aws_acm_certificate.endpoint.arn}",
					"ssl_support_method": "sni-only",
				}
			}
		}
	},
	"output": {
		"cloudfront_url": {
			"value": "${aws_cloudfront_distribution.mspassumerole.domain_name}"
		}
	}
}