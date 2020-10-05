{
	resource(settings): {
		"aws_cognito_user_pool": {
			"mspassumerole": {
				"name": "mspassumerole",
				"mfa_configuration": "${var.cognito_user_mfa}",
				"password_policy": {
					"minimum_length": 12,
					"require_lowercase": true,
					"require_uppercase": true,
					"require_symbols": false,
					"require_numbers": true,
					"temporary_password_validity_days": 3,
				},
				"admin_create_user_config": {
					"allow_admin_create_user_only": true,
					"invite_message_template": {
						"email_subject": "Observian MSP Onboarding",
						"email_message": "An account has been created for you on the Observian MSP Portal (styx.observian.com). Use {username} and {####} to log in.",
						"sms_message": "Observian MSP Portal user created. Use {username} and {####} to log in."
					}
				},
				"auto_verified_attributes": ["email"],
				"username_attributes": ["email"]
			}
		},
		"aws_cognito_user_pool_client": {
			"mspassumerole": {
				"name": "mspassumerole_client",
				"user_pool_id": "${aws_cognito_user_pool.mspassumerole.id}",
				"generate_secret": false
			}
		},
		"aws_cognito_identity_pool": {
			"mspassumerole": {
				"identity_pool_name": "mspassumerole Identity Pool",
				"allow_unauthenticated_identities": false,
				"cognito_identity_providers": {
					"client_id": "${aws_cognito_user_pool_client.mspassumerole.id}",
					"provider_name": "${aws_cognito_user_pool.mspassumerole.endpoint}",
					"server_side_token_check": true,
				}
			}
		},
		"aws_cognito_user_pool_domain": {
			"mspassumerole": {
				"domain": "cognito.msp.observian.com",
				"certificate_arn": "${aws_acm_certificate.cognito.arn}",
				"user_pool_id": "${aws_cognito_user_pool.mspassumerole.id}",
				"depends_on": [
					"aws_route53_record.root-record"
				]
			}
		},
		"aws_cognito_user_group": {
			"msp-admins": {
				"name": "msp-admins",
				"user_pool_id": "${aws_cognito_user_pool.mspassumerole.id}",
				"description": "Administrators of Styx",
				"precedence": "0",
				"role_arn": "${aws_iam_role.cognito_admins.arn}"
			}
		}
	}
}