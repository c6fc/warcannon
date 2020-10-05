local backend(settings) = {
	terraform: {
		backend: {
			s3: {
				bucket: settings.backendBucket,
				key: "terraform.tfstate",
				profile: settings.awsProfile,

				region: "us-east-1"
			}
		},
	}
};

backend