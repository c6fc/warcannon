{
	"resource":	{
		"aws_iam_role": {
			"cognito_admins": {
				"name_prefix": "cognito_admins_role_",
				"assume_role_policy": '{"Version": "2012-10-17","Statement": [{
			    	"Effect": "Allow",
			    	"Principal": {"Federated": "cognito-identity.amazonaws.com"},
			    	"Action": "sts:AssumeRoleWithWebIdentity",
			    	"Condition": {
			    		"StringEquals": {"cognito-identity.amazonaws.com:aud": "${aws_cognito_identity_pool.mspassumerole.id}"},
			    		"ForAnyValue:StringLike": {"cognito-identity.amazonaws.com:amr": "authenticated"}
				}}]}'
			},
			"cognito_authenticated": {
				"name_prefix": "cognito_authenticated_role_",
				"assume_role_policy": '{"Version": "2012-10-17","Statement": [{
			    	"Effect": "Allow",
			    	"Principal": {"Federated": "cognito-identity.amazonaws.com"},
			    	"Action": "sts:AssumeRoleWithWebIdentity",
			    	"Condition": {
			    		"StringEquals": {"cognito-identity.amazonaws.com:aud": "${aws_cognito_identity_pool.mspassumerole.id}"},
			    		"ForAnyValue:StringLike": {"cognito-identity.amazonaws.com:amr": "authenticated"}
				}}]}'
			},
			"cognito_unauthenticated": {
				"name_prefix": "cognito_unauthenticated_role_",
				"assume_role_policy": '{"Version": "2012-10-17","Statement": [{
					"Effect": "Allow","Principal": {"Federated": "cognito-identity.amazonaws.com"},
					"Action": "sts:AssumeRoleWithWebIdentity"}
				]}'
			},
		},
		"aws_iam_role_policy": {
			"cognito_admins": {
				"name_prefix": "cognito_admins_policy_",
				"role": "${aws_iam_role.cognito_admins.id}",
				"policy": "${data.aws_iam_policy_document.cognito_admins.json}"
			},
			"cognito_authenticated": {
				"name_prefix": "cognito_authenticated_policy_",
				"role": "${aws_iam_role.cognito_authenticated.id}",
				"policy": "${data.aws_iam_policy_document.cognito_authenticated.json}"
			},
			"cognito_unauthenticated": {
				"name_prefix": "cognito_authenticated_policy_",
				"role": "${aws_iam_role.cognito_unauthenticated.id}",
				"policy": "${data.aws_iam_policy_document.cognito_unauthenticated.json}"
			}
		},
		"aws_cognito_identity_pool_roles_attachment": {
			"default": {
				"identity_pool_id": "${aws_cognito_identity_pool.mspassumerole.id}",
				"roles": {
					"authenticated": "${aws_iam_role.cognito_authenticated.arn}",
					"unauthenticated": "${aws_iam_role.cognito_unauthenticated.arn}"
				},

				"role_mapping": {
					"identity_provider": "${aws_cognito_user_pool.mspassumerole.endpoint}:${aws_cognito_user_pool_client.mspassumerole.id}",
					"ambiguous_role_resolution": "AuthenticatedRole",
					"type": "Rules",

					"mapping_rule": [{
						"claim": "cognito:groups",
						"match_type": "Contains",
						"value": "msp-admins",
						"role_arn": "${aws_iam_role.cognito_admins.arn}"

					}]
				}
			}
		}
	},
	data(settings)::
	{
		"aws_iam_policy_document": {
			"cognito_admins": {
				"statement": [{
					"sid": "1",
					"actions": [
						"cognito-identity:*",
						"mobileanalytics:PutEvents",
						"cognito-sync:*"
					],
					"resources": [
						"*"
					]
				},{
					"sid": "ddb",
					"actions": [
						"dynamodb:Scan"
					],
					"resources": [
						"${aws_dynamodb_table.MSPAssumeRole.arn}"
					]
				},{
					"sid": "apigateway",
					"actions": [
						"execute-api:Invoke"
					],
					"resources": [
						"${aws_api_gateway_deployment.mspassumerole.execution_arn}/*/api/*",
					]
				}]
			},
			"cognito_authenticated": {
				"statement": [{
					"sid": "1",
					"actions": [
						"cognito-identity:*",
						"mobileanalytics:PutEvents",
						"cognito-sync:*"
					],
					"resources": [
						"*"
					]
				},{
					"sid": "apigateway",
					"actions": [
						"execute-api:Invoke"
					],
					"resources": [
						"${aws_api_gateway_deployment.mspassumerole.execution_arn}/GET/api/*"
					]
				}]
			},
			"cognito_unauthenticated": {
				"statement": [{
					"sid": "logs",
					"actions": [
						"cognito-identity:*",
						"mobileanalytics:PutEvents",
						"cognito-sync:*"
					],
					"resources": [
						"*"
					]
				}]
			}
		}
	}
}