{
	aws_provider(profile, region): {
		aws: {
			profile: profile,
			region: region
		}
	},

	aws_alias(profile, region): {
		aws: {
			alias: region,
			profile: profile,
			region: region
		}
	}
}
