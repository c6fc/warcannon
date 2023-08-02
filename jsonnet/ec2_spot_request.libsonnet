local json(capacity, instanceTypes, subnets, key) = {
    IamFleetRole: "${aws_iam_role.warcannon_spotfleet_role.arn}",
    AllocationStrategy: "lowestPrice",
    TargetCapacity: capacity,
    TerminateInstancesWithExpiration: true,
    LaunchSpecifications: [
        {
            ImageId: "ami-06b8f0fe534eceb95", //ARM
            // ImageId: "ami-0947d2ba12ee1ff75", //x86
            InstanceType: instanceType,
            KeyName: key,
            BlockDeviceMappings: [
                {
                    DeviceName: "/dev/sda1",
                    Ebs: {
                        DeleteOnTermination: true,
                        SnapshotId: "snap-03d46705db42dbe81", //ARM
                        // SnapshotId: "snap-0299d083f0ce6cd12", //x86
                        VolumeSize: 8,
                        Encrypted: false,
                        VolumeType: "gp2"
                    }
                }
            ],
            IamInstanceProfile: {
                Arn: "${aws_iam_instance_profile.warcannon_instance_profile.arn}"
            },
            NetworkInterfaces: [{
                DeviceIndex: 0,
                DeleteOnTermination: true,
                AssociatePublicIpAddress: true,
                SubnetId: subnet,
                Groups: ["${aws_security_group.warcannon_node.id}"]
            }],
            TagSpecifications: [
                {
                    ResourceType: "instance",
                    Tags: [
                        {
                            Key: "Name",
                            Value: "Warcannon_Node"
                        }
                    ]
                }
            ],
            UserData: "${base64encode(data.template_file.userdata.rendered)}"
        }

        for instanceType in instanceTypes
        for subnet in subnets
    ],
    TagSpecifications: [
        {
            ResourceType: "spot-fleet-request",
            Tags: [
                {
                    Key: "Name",
                    Value: "Warcannon"
                }
            ]
        }
    ]
};

{
    json: json
}