local settings = import 'generated-settings.jsonnet';
local backend = import 'jsonnet/backend.libsonnet';
local vpc = import 'jsonnet/vpc.libsonnet';
local subnet = import 'jsonnet/subnet.libsonnet';
local route = import 'jsonnet/routetable.libsonnet';
local igw = import 'jsonnet/igw.libsonnet';
local iam = import 'jsonnet/iam.libsonnet';
local dynamodb = import 'jsonnet/dynamodb.libsonnet';
local route53 = import 'jsonnet/route53.libsonnet';
local s3 = import 'jsonnet/s3.libsonnet';
local acm = import 'jsonnet/acm.libsonnet';
local provider = import 'jsonnet/provider.libsonnet';
local api_gateway = import 'jsonnet/api_gateway_map.libsonnet';
local cloudfront = import 'jsonnet/cloudfront.libsonnet';
local cognito = import 'jsonnet/cognito.libsonnet';
local cognito_iam_roles = import 'jsonnet/cognito_iam_roles.libsonnet';
local lambda = import 'jsonnet/lambda.libsonnet';
local null_resources = import 'jsonnet/null_resources.libsonnet';
local template = import 'jsonnet/template.libsonnet';
local ec2_spot_request = import 'jsonnet/ec2_spot_request.libsonnet';

local regionKeys = std.objectFields(settings.regions);

{
	'backend.tf.json': backend(settings),
	'cloudfront.tf.json': cloudfront.distribution(settings),
	'data.tf.json': {
		data: {
			aws_caller_identity: {
				current: {}
			}
		}
	},
	'dynamodb_warcannon_identities.tf.json': {
		resource: {
			aws_dynamodb_table: dynamodb.table(
				"warcannon_identities",
				"PAY_PER_REQUEST",
				"identityPoolId",
				"privilegeLevel",
				[{
					name: "identityPoolId",
					type: "S"
				},{
					name: "privilegeLevel",
					type: "S"
				}],
				null,
				null
			)
		}
	},
	'dynamodb_warcannon_progress.tf.json': {
		resource: {
			aws_dynamodb_table: dynamodb.table(
				"warcannon_progress",
				"PAY_PER_REQUEST",
				"instanceId",
				null,
				[{
					name: "instanceId",
					type: "S"
				}],
				null,
				{
					enabled: true,
					attribute_name: "until"
				},
				{
					stream_enabled: true,
					stream_view_type: "KEYS_ONLY"
				}
			)
		}
	},
	'event_source_mapping.tf.json': {
		resource: {
			aws_lambda_event_source_mapping: {
				warcannon_progress: {
					event_source_arn: "${aws_dynamodb_table.warcannon_progress.stream_arn}",
					function_name: "${aws_lambda_function.progress_stream_processor.arn}",
					starting_position: "LATEST"
				}
			}
		}
	},
	'iam.tf.json': {
		resource: iam.iam_role(
			"warcannon_instance_profile",
			"EC2 instance profile for Warcannon compute nodes",
			{},
			{
				warcannonComputeNode: [{
					Effect: "Allow",
					Action: [
						"logs:CreateLogGroup",
						"logs:CreateLogStream",
						"logs:PutLogEvents"
					],
					Resource: [
						"arn:aws:logs:*:*:*"
					]
				}, {
					Effect: "Allow",
					Action: "s3:PutObject",
					Resource: "${aws_s3_bucket.warcannon_results.arn}/*"
				}, {
					Effect: "Allow",
					Action: "s3:GetObject",
					Resource: "${aws_s3_bucket.static_site.arn}/package.zip"
				}, {
					Effect: "Allow",
					Action: [
						"s3:GetObject",
						"s3:HeadObject"
					],
					Resource: "arn:aws:s3:::commoncrawl/*"
				}, {
					Effect: "Allow",
					Action: "dynamodb:PutItem",
					Resource: "${aws_dynamodb_table.warcannon_progress.arn}"
				}, {
					Effect: "Allow",
					Action: [
						"sqs:DeleteMessage",
						"sqs:ReceiveMessage"
					],
					Resource: "${aws_sqs_queue.warcannon_queue.arn}"
				}]
			},
			[{
				Effect: "Allow",
				Principal: {
					Service: "ec2.amazonaws.com"
				},
				Action: "sts:AssumeRole"
			}],
			true
		)
	},
	'igw.tf.json': {
		resource: {
			aws_internet_gateway: {
				[regionKeys[i]]: igw(regionKeys[i]) for i in std.range(0, std.length(regionKeys) - 1)
			}
		}
	},
	'lambda_cc_loader.tf.json': lambda.lambda_function("cc_loader", {
		handler: "main.main",
		timeout: 30,
		memory_size: 1024,

		vpc_config:: {
			subnet_ids: ["${aws_subnet." + azi + ".id}" for azi in settings.regions["us-east-1"]],
			security_group_ids: ["${aws_security_group.lambda.id}"]
		},

		environment: {
			variables: {
				QUEUEURL: "${aws_sqs_queue.warcannon_queue.id}"
			}
		}
	}, {
		statement: [{
			sid: "sqs",
			actions: [
				"sqs:SendMessage"
			],
			resources: [
				"${aws_sqs_queue.warcannon_queue.arn}"
			]
		}, {
			sid: "getCommonCrawl",
			actions: [
				"s3:GetObject"
			],
			resources: [
				"arn:aws:s3:::commoncrawl/*"
			]
		}, {
			sid: "allowVPCAccess",
            actions: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            resources: [
            	"*"
            ]
        }, {
			"sid": "xray",
            "actions": [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
                "xray:GetSamplingStatisticSummaries"
            ],
            "resources": [
                "*"
            ]
        }]
	}),
	'lambda_progress_stream_processor.tf.json': lambda.lambda_function("progress_stream_processor", {
		handler: "main.main",
		timeout: 2,
		memory_size: 256,

		environment: {
			variables: {
				DESTINATIONBUCKET: "${aws_s3_bucket.static_site.id}",
				QUEUEURL: "${aws_sqs_queue.warcannon_queue.id}"
			}
		}
	}, {
		statement: [{
			sid: "s3",
			actions: [
				"s3:PutObject"
			],
			resources: [
				"${aws_s3_bucket.static_site.arn}/progress.json"
			]
		}, {
			sid: "dynamodb",
			actions: [
				"dynamodb:Scan"
			],
			resources: [
				"${aws_dynamodb_table.warcannon_progress.arn}"
			]
		}, {
			sid: "dynamodbstream",
			actions: [
				"dynamodb:DescribeStream",
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
                "dynamodb:ListStreams"
			],
			resources: [
				"${aws_dynamodb_table.warcannon_progress.arn}/stream/*"
			]
		}, {
			sid: "sqs",
			actions: [
				"sqs:GetQueueAttributes"
			],
			resources: [
				"${aws_sqs_queue.warcannon_queue.arn}"
			]
		}, {
			sid: "ec2",
			actions: [
				"ec2:CancelSpotFleetRequests",
				"ec2:DescribeSpotFleetRequests"
			],
			resources: [
				"*"
			]
		}, {
			sid: "logxray",
            actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
                "xray:GetSamplingStatisticSummaries",
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
            ],
            resources: [
                "*"
            ]
        }]
	}),
	'lambda_warcannon.tf.json': lambda.lambda_function("warcannon", {
		handler: "main.main",
		timeout: 600,
		memory_size: 2048,

		environment: {
			variables: {
				DESTINATIONBUCKET: "${aws_s3_bucket.warcannon_results.id}"
			}
		},

		vpc_config:: {
			subnet_ids: ["${aws_subnet." + azi + ".id}" for azi in settings.regions["us-east-1"]],
			security_group_ids: ["${aws_security_group.lambda.id}"]
		}
	}, {
		statement: [{
			sid: "s3",
			actions: [
				"s3:PutObject"
			],
			resources: [
				"${aws_s3_bucket.warcannon_results.arn}/*"
			]
		}, {
			sid: "getCommonCrawl",
			actions: [
				"s3:GetObject"
			],
			resources: [
				"arn:aws:s3:::commoncrawl/*"
			]
		}, {
			sid: "allowVPCAccess",
            actions: [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            resources: [
            	"*"
            ]
        }, {
			sid: "logxray",
            actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
                "xray:GetSamplingStatisticSummaries",
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
            ],
            resources: [
                "*"
            ]
        }]
	}),
	'null_resources.tf.json': null_resources.resource(settings),
	'package.tf.json': {
		resource: {
			aws_s3_bucket_object: {
				package: {
					bucket: "${aws_s3_bucket.static_site.id}",
					key: "package.zip",
					source: "${path.module}/lambda_functions/zip_files/package.zip",
					etag: "${data.archive_file.package.output_md5}"
				}
			}
		},
		data: {
			archive_file: {
				package: {
					type: "zip",
					source_dir: "${path.module}/node.js/",
					output_path: "${path.module}/lambda_functions/zip_files/package.zip",
				}
			}
		}
	},
	'provider-aws.tf.json': {
		provider: [
			provider.aws_provider(settings.awsProfile, "us-east-1")
		] + [
			provider.aws_alias(settings.awsProfile, region) for region in regionKeys
		]
	},
	'public_key.tf.json': {
		resource: {
			aws_key_pair: {
				warcannon: {
					key_name: "warcannon",
					public_key: settings.sshPubkey
				}
			}
		}
	},
	'routetable.tf.json': {
		resource: {
			aws_route_table: {
				[regionKeys[i]]: route.routetable(regionKeys[i]) for i in std.range(0, std.length(regionKeys) - 1)
			},
			aws_route_table_association: { 
				[settings.regions[regionKeys[i]][azi]]: route.association(regionKeys[i], settings.regions[regionKeys[i]][azi])
					for i in std.range(0, std.length(regionKeys) - 1)
					for azi in std.range(0, std.length(settings.regions[regionKeys[i]]) - 1)
			},
			aws_vpc_endpoint_route_table_association: {
				[regionKeys[i]]: route.endpoint(regionKeys[i], "s3-" + regionKeys[i]) for i in std.range(0, std.length(regionKeys) - 1)
			},
		}
	},
	's3.tf.json': {
		resource: {
			aws_s3_bucket: {
				warcannon_results: s3.bucket("warcannon-results-"),
				static_site: s3.bucket("warcannon-site-content-"),
			}
		}
	},
	's3_policies.tf.json': {
		data: {
			aws_iam_policy_document: {
				warcannon_results: {
					statement: [{
						actions: ["s3:PutObject"],
						resources: ["${aws_s3_bucket.warcannon_results.arn}/*"],
						principals: {
							type: "AWS",
							identifiers: ["${aws_iam_role.warcannon_instance_profile.arn}"]
						}
					}]
				},
				static_site: {
					statement: [{
						actions: ["s3:GetObject"],
						resources: ["${aws_s3_bucket.static_site.arn}/*"],
						principals: {
							type: "AWS",
							identifiers: ["${aws_cloudfront_origin_access_identity.warcannon.iam_arn}"]
						}
					}]
				}
			}
		},
		resource: {
			aws_s3_bucket_policy: {
				warcannon_results: {
					bucket: "${aws_s3_bucket.warcannon_results.id}",
					policy: "${data.aws_iam_policy_document.warcannon_results.json}"
				},
				static_site: {
					bucket: "${aws_s3_bucket.static_site.id}",
					policy: "${data.aws_iam_policy_document.static_site.json}"
				}
			}
		}
	},
	'security_groups.tf.json': {
		resource: {
			aws_security_group: {
				lambda: vpc.security_group(
					"lambda",
					"us-east-1",
					"us-east-1",
					[],
					[{
						from_port: 0,
						to_port: 0,
						protocol: "-1",
						cidr_blocks: ["0.0.0.0/0"]
					}],
					null
				),
				warcannon_node: vpc.security_group(
					"warcannon_node",
					"us-east-1",
					"us-east-1",
					[{
						from_port: 22,
						to_port: 22,
						protocol: "tcp",
						cidr_blocks: [settings.allowSSHFrom]
					}],
					[{
						from_port: 0,
						to_port: 0,
						protocol: "-1",
						cidr_blocks: ["0.0.0.0/0"]
					}],
					null
				)
			}
		}
	},
	'sqs.tf.json': {
		resource: {
			aws_sqs_queue: {
				warcannon_queue: {
					name: "warcannon_queue",
					visibility_timeout_seconds: 420,
					message_retention_seconds: 86400,
					redrive_policy: std.manifestJsonEx({
						deadLetterTargetArn: "${aws_sqs_queue.warcannon_dlq.arn}",
						maxReceiveCount: 3
					}, " ")
				},
				warcannon_dlq: {
					name: "warcannon_dlq"
				}
			},
			aws_sqs_queue_policy: {
				warcannon_queue: {
					queue_url: "${aws_sqs_queue.warcannon_queue.id}",
					policy: std.manifestJsonEx({
						Version: "2012-10-17",
						Id: "warcannon_redrive",
						Statement: [{
								Sid: "allow_redrive",
								Effect: "Allow",
								Principal: "*",
								Action: "sqs:SendMessage",
								Resource: "${aws_sqs_queue.warcannon_dlq.arn}",
								Condition: {
									ArnEquals: {
										"aws:SourceArn": "${aws_sqs_queue.warcannon_queue.arn}"
									}
								}
							}]
					}, " ")
				}
			}
		}
	},
	'subnet.tf.json': {
		resource: {
			aws_subnet: {
				[settings.regions[regionKeys[i]][azi]]: subnet(regionKeys[i], settings.regions[regionKeys[i]][azi], azi, true)
					for i in std.range(0, std.length(regionKeys) - 1)
					for azi in std.range(0, std.length(settings.regions[regionKeys[i]]) - 1)
			} 
		}
	},
	'template_spot_request.tf.json': template.file(
		"spot_request",
		"spot_request.json",
		std.manifestJsonEx(
			ec2_spot_request.json(
				settings.nodeCapacity,
				settings.nodeInstanceType,
				std.join(", ", ["${aws_subnet." + azi + ".id}" for azi in settings.regions["us-east-1"]])
			), "\t"),
		{}
	),
	'template_userdata.tf.json': template.file(
		"userdata",
		"userdata.sh",
		'${file("${path.module}/node.js/userdata.tpl")}',
		{
			results_bucket: "${aws_s3_bucket.warcannon_results.id}",
			site_bucket: "${aws_s3_bucket.static_site.id}",
			sqs_queue_url: "${aws_sqs_queue.warcannon_queue.id}",
			parallelism_factor: settings.nodeParallelism
		}
	),
	'vpc.tf.json': {
		resource: {
			aws_vpc: {
				[regionKeys[i]]: vpc.vpc(regionKeys[i], i) for i in std.range(0, std.length(regionKeys) - 1)
			},
			aws_vpc_endpoint: {
				["s3-" + region]: vpc.endpoint(region, "s3") for region in regionKeys
			}
		}
	}
}