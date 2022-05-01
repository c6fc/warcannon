local lambda_function(name, config, role_policy) = {
	resource: {
		aws_lambda_function: {
			[name]: {
				runtime: "nodejs14.x",
			} + config + {
				function_name: name,
				filename: "../lambda_functions/zip_files/" + name + ".zip",
				source_code_hash: "${data.archive_file." + name + ".output_base64sha256}",
				role: "${aws_iam_role.lambda-" + name + ".arn}",
				depends_on: ["data.archive_file." + name, "aws_iam_role_policy.lambda-" + name],
			}
		},
		null_resource: {
			["npm_install-" + name]: {
				provisioner: [{
					"local-exec": {
						command: "cd ${path.module}/../lambda_functions/" + name + "/ && npm install",
					}
				}]
			}
		},
		aws_iam_role: {
			["lambda-" + name]: {
				name: "lambda_" + name,
				description: "Lambda Role for " + name,
				assume_role_policy: '{"Version": "2012-10-17","Statement": [{
					"Effect": "Allow","Principal": {"Service": ["edgelambda.amazonaws.com", "lambda.amazonaws.com"]},
					"Action": "sts:AssumeRole"
				}]}'
			}
		},
		aws_iam_role_policy: {
			["lambda-" + name]: {
				name: "lambda-" + name,
				role: "${aws_iam_role.lambda-" + name + ".id}",
				policy: std.manifestJsonEx({
					Version: "2012-10-17",
					Statement: role_policy.statement + [{
						Effect: "Allow",
				        Action: [
				            "logs:CreateLogGroup",
				            "logs:CreateLogStream",
				            "logs:PutLogEvents",
				        ],
				        Resource: "arn:aws:logs:*:*:*"
				    }, {
				    	Effect: "Allow",
				        Action: [
				            "xray:PutTraceSegments",
				            "xray:PutTelemetryRecords",
				            "xray:GetSamplingRules",
				            "xray:GetSamplingTargets",
				            "xray:GetSamplingStatisticSummaries"
				        ],
				        Resource: "*"
			    	}]
				}, " ")
			}
		},
		local_file: {
			["lambda-" + name + "_envvars"]: {
				content: std.join("\n", [
					"declare %s='%s'\nexport %s" % [key, config.environment.variables[key], key]
					for key in std.objectFields(config.environment.variables)
				]),
				filename: "${path.module}/../lambda_functions/" + name + "/ENVVARS",
				file_permission: "0664"
			}
		}
	},
	data: {
		archive_file: {
			[name]: {
				depends_on: [
					"null_resource.npm_install-" + name
				] + if std.objectHas(config, 'depends_on') then config.depends_on else [],
				type: "zip",
				source_dir: "${path.module}/../lambda_functions/" + name + "/",
				output_path: "${path.module}/../lambda_functions/zip_files/" + name + ".zip",
			}
		}
	}
};

local cloudwatch_trigger(name, schedule_expression) = {
	resource: {
		aws_lambda_permission: {
			[name]: {
				statement_id: "AllowExecutionFromCloudWatch",
				action: "lambda:InvokeFunction",
				function_name: "${aws_lambda_function." + name + ".function_name}",
				principal: "events.amazonaws.com",
				source_arn: "${aws_cloudwatch_event_rule." + name + ".arn}"
			}
		},
		aws_cloudwatch_event_rule: {
			[name]: {
				name: name,
				schedule_expression: schedule_expression
			}
		},
		aws_cloudwatch_event_target: {
			[name]: {
				rule: name,
				target_id: name,
				arn: "${aws_lambda_function." + name + ".arn}"
			}
		}
	}
};

{
	lambda_function: lambda_function,
	cloudwatch_trigger: cloudwatch_trigger
}