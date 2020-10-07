local json(capacity, instanceTypes, subnets) = {
    IamFleetRole: "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-ec2-spot-fleet-tagging-role",
    AllocationStrategy: "lowestPrice",
    TargetCapacity: capacity,
    TerminateInstancesWithExpiration: true,
    LaunchSpecifications: [
        {
            ImageId: "ami-0947d2ba12ee1ff75",
            InstanceType: instanceType,
            SubnetId: subnets,
            KeyName: "warcannon",
            BlockDeviceMappings: [
                {
                    DeviceName: "/dev/sda1",
                    Ebs: {
                        DeleteOnTermination: true,
                        SnapshotId: "snap-0299d083f0ce6cd12",
                        VolumeSize: 8,
                        Encrypted: false,
                        VolumeType: "gp2"
                    }
                }
            ],
            IamInstanceProfile: {
                Arn: "${aws_iam_instance_profile.warcannon_instance_profile.arn}"
            },
            SecurityGroups: [
                {
                    GroupId: "${aws_security_group.warcannon_node.id}"
                }
            ],
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
        } for instanceType in instanceTypes
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