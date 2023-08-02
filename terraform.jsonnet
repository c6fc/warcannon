local sonnetry = import 'sonnetry';
local aws = import 'aws-sdk';

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

local settings = import './settings.json';

local availabilityzones = aws.getAvailabilityZones()['us-east-1'];

{
	'athena.tf.json': {
		resource: {
			aws_athena_database: {
				warcannon_commoncrawl: {
					name: "warcannon_commoncrawl",
					bucket: "${aws_s3_bucket.warcannon_results.id}",
					force_destroy: true
				}
			},
			aws_athena_workgroup: {
				warcannon: {
					name: "warcannon",
					configuration: {
						result_configuration: {
							output_location: "s3://${aws_s3_bucket.warcannon_results.bucket}/athena/"
						}
					},
					force_destroy: true
				}
			},
			null_resource:: {
				athena_populate: {
					triggers: {
						new_database: "${aws_athena_database.warcannon_commoncrawl.name}"
					},

					provisioner: [{
						"local-exec": {
							command: "./populate_athena.sh",
							interpreter: ["/bin/bash"]
						}
					}],

					depends_on: [ "aws_athena_database.warcannon_commoncrawl", "aws_athena_workgroup.warcannon" ]
				}
			}
		},
		output: {
			athena_table: {
				value: "${aws_athena_database.warcannon_commoncrawl.name}"
			},
			athena_workgroup: {
				value: "${aws_athena_workgroup.warcannon.id}"
			}
		}
	},
	'backend.tf.json': sonnetry.bootstrap('c6fc_warcannon'),
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
					Resource: "arn:aws:logs:*:*:*"
				}, {
					Effect: "Allow",
					Action: "s3:PutObject",
					Resource: "${aws_s3_bucket.warcannon_results.arn}/*"
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
				}, {
					Effect: "Allow",
					Action: "lambda:GetFunction",
					Resource: "${aws_lambda_function.warcannon.arn}"
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
	'iam-spotfleet_role.tf.json': {
		resource: iam.iam_role(
			"warcannon_spotfleet_role",
			"Spot fleet role for Warcannon",
			{
				AmazonEC2SpotFleetTaggingRole: "arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole"
			},
			{ },
			[{
				Effect: "Allow",
				Principal: {
					Service: "spotfleet.amazonaws.com"
				},
				Action: "sts:AssumeRole"
			}],
			false
		)
	},
	'lambda_cc_athena_loader.tf.json': lambda.lambda_function("cc_athena_loader", {
		handler: "main.main",
		timeout: 30,
		memory_size: 1024,

		vpc_config:: {
			subnet_ids: ["${aws_subnet.warcannon-us-east-1-subnet-" + azi + ".id}" for azi in availabilityzones],
			security_group_ids: ["${aws_security_group.lambda.id}"]
		},

		environment: {
			variables: {
				QUEUEURL: "${aws_sqs_queue.warcannon_queue.id}",
				BUCKET: "${aws_s3_bucket.warcannon_results.id}"
			}
		}
	}, {
		statement: [{
			Sid: "sqs",
			Effect: "Allow",
			Action:"sqs:SendMessage",
			Resource: "${aws_sqs_queue.warcannon_queue.arn}"
		}, {
			Sid: "accessAthenaQueries",
			Effect: "Allow",
            Action: "athena:GetQueryExecution",
            Resource: "${aws_athena_workgroup.warcannon.arn}"
        }, {
			Sid: "accessAthenaResults",
			Effect: "Allow",
            Action: "s3:GetObject",
            Resource: "${aws_s3_bucket.warcannon_results.arn}/athena/*"
        }, {
			Sid: "allowVPCAccess",
			Effect: "Allow",
            Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            Resource: "*"
        }]
	}),
	'lambda_cc_loader.tf.json': lambda.lambda_function("cc_loader", {
		handler: "main.main",
		timeout: 30,
		memory_size: 1024,

		vpc_config:: {
			subnet_ids: ["${aws_subnet.warcannon-us-east-1-subnet-" + azi + ".id}" for azi in availabilityzones],
			security_group_ids: ["${aws_security_group.lambda.id}"]
		},

		environment: {
			variables: {
				QUEUEURL: "${aws_sqs_queue.warcannon_queue.id}"
			}
		}
	}, {
		statement: [{
			Sid: "sqs",
			Effect: "Allow",
			Action: "sqs:SendMessage",
			Resource: "${aws_sqs_queue.warcannon_queue.arn}"
		}, {
			Sid: "getCommonCrawl",
			Effect: "Allow",
			Action: "s3:GetObject",
			Resource: "arn:aws:s3:::commoncrawl/*"
		}, {
			Sid: "allowVPCAccess",
			Effect: "Allow",
            Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            Resource: "*"
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
			Sid: "s3",
			Effect: "Allow",
			Action: "s3:PutObject",
			Resource: "${aws_s3_bucket.static_site.arn}/progress.json"
		}, {
			Sid: "dynamodb",
			Effect: "Allow",
			Action: "dynamodb:Scan",
			Resource: "${aws_dynamodb_table.warcannon_progress.arn}"
		}, {
			Sid: "dynamodbstream",
			Effect: "Allow",
			Action: [
				"dynamodb:DescribeStream",
                "dynamodb:GetRecords",
                "dynamodb:GetShardIterator",
                "dynamodb:ListStreams"
			],
			Resource: "${aws_dynamodb_table.warcannon_progress.arn}/stream/*"
		}, {
			Sid: "sqs",
			Effect: "Allow",
			Action: "sqs:GetQueueAttributes",
			Resource: "${aws_sqs_queue.warcannon_queue.arn}"
		}, {
			Sid: "ec2",
			Effect: "Allow",
			Action: [
				"ec2:CancelSpotFleetRequests",
				"ec2:DescribeSpotFleetRequests"
			],
			Resource: "*"
		}]
	}),
	'lambda_warcannon_singlefire.tf.json': lambda.lambda_function("warcannon", {
		handler: "main.main",
		timeout: 600,
		memory_size: 3008,

		runtime: "nodejs16.x",
		layers:: ["arn:aws:lambda:us-east-1:072686360478:layer:node-16_4_2:3"],

		environment: {
			variables: {
				DESTINATIONBUCKET: "${aws_s3_bucket.warcannon_results.id}"
			}
		},

		vpc_config:: {
			subnet_ids: ["${aws_subnet.warcannon-us-east-1-subnet-" + azi + ".id}" for azi in availabilityzones],
			security_group_ids: ["${aws_security_group.lambda.id}"]
		}
	}, {
		statement: [{
			Sid: "s3",
			Effect: "Allow",
			Action: "s3:PutObject",
			Resource: "${aws_s3_bucket.warcannon_results.arn}/*"
		}, {
			Sid: "getCommonCrawl",
			Effect: "Allow",
			Action: "s3:GetObject",
			Resource: "arn:aws:s3:::commoncrawl/*"
		}, {
			Sid: "allowVPCAccess",
			Effect: "Allow",
            Action: [
                "ec2:CreateNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
                "ec2:DeleteNetworkInterface"
            ],
            Resource: "*"
        }]
	}),
	'null_resources.tf.json': null_resources.resource(settings),
	'provider.tf.json': {
		terraform: {
			required_providers: {
				aws: {
					source: "hashicorp/aws",
					version: "~> 3.76.1"
				},
				archive: {
					source: "hashicorp/archive",
					version: "~> 2.2.0"
				}
			}
		},
		provider: [{
			aws: {
				region: 'us-east-1'
			}
		}, {
			aws: {
				region: 'us-east-1',
				alias: 'us-east-1'
			}
		}, {
			archive: {}
		}]
	},
	's3.tf.json': {
		resource: {
			aws_s3_bucket: {
				warcannon_results: s3.bucket("warcannon-results-"),
				static_site: s3.bucket("warcannon-site-content-"),
			}
		},
		output: {
			results_bucket: {
				value: "${aws_s3_bucket.warcannon_results.id}"
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
					}, {
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
				lambda: {
					name: "lambda",
					vpc_id: "${aws_vpc.warcannon-us-east-1.id}"
				},
				warcannon_node: {
					name: "warcannon_node",
					vpc_id: "${aws_vpc.warcannon-us-east-1.id}"
				},
			},
			aws_security_group_rule: {
				lambda_any_egress: vpc.sg_single("all", "lambda", "egress"),
				lambda_self_egress: vpc.sg_single("any:self", "lambda", "egress"),
				[if std.objectHas(settings, 'allowSshFrom') then 'warcannon_node_ssh_ingress' else null]: vpc.sg_single("tcp:%s:22" % settings.allowSshFrom, "warcannon_node", "ingress"),
				warcannon_node_any_egress: vpc.sg_single("all", "warcannon_node", "egress"),
				warcannon_node_self_egress: vpc.sg_single("any:self", "warcannon_node", "egress")
			}
		}
	},
	'sqs.tf.json': {
		resource: {
			aws_sqs_queue: {
				warcannon_queue: {
					name: "warcannon_queue",
					visibility_timeout_seconds: 3600,
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
	'template_spot_request.tf.json': template.file(
		"spot_request",
		"spot_request.json",
		std.manifestJsonEx(
			ec2_spot_request.json(
				settings.nodeCapacity,
				settings.nodeInstanceType,
				["${aws_subnet.warcannon-us-east-1-subnet-" + azi + ".id}" for azi in availabilityzones],
				if std.objectHas(settings, 'sshKeyName') && settings.sshKeyName != "" then settings.sshKeyName else null
			), "\t"),
		{}
	),
	'template_userdata.tf.json': template.file(
		"userdata",
		"userdata.sh",
		'${file("%s/templates/userdata.tpl")}' % sonnetry.path(),
		{
			results_bucket: "${aws_s3_bucket.warcannon_results.id}",
			site_bucket: "${aws_s3_bucket.static_site.id}",
			sqs_queue_url: "${aws_sqs_queue.warcannon_queue.id}",
			parallelism_factor: settings.nodeParallelism
		}
	),
	'vpc.tf.json': vpc.public_vpc("warcannon", 'us-east-1', "10.18.24.0/22", availabilityzones, 0, ['s3'])
}