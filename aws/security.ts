import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { getAwsAz } from "../utils";

export class Ec2InstanceSecurity extends pulumi.ComponentResource {
    private name: string;

    public instanceProfile: aws.iam.InstanceProfile | undefined;
    public subnet: aws.ec2.Subnet | undefined;
    public securityGroup: aws.ec2.SecurityGroup | undefined;

    constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:ec2:security", name, undefined, opts);
        this.name = name;

        this.setupIdentities();
        this.setupPrivateNetworking();

        this.registerOutputs({
            instanceProfile: this.instanceProfile,
            subnet: this.subnet,
            securityGroup: this.securityGroup,
        });
    }

    private setupIdentities() {
        const assumeInstanceRolePolicyDoc: aws.iam.PolicyDocument = {
            Version: "2012-10-17",
            Statement: [{
                Action: [
                    "sts:AssumeRole",
                ],
                Effect: "Allow",
                Principal: {
                    Service: ["ec2.amazonaws.com"],
                },
            }],
        };

        const instanceRolePolicyDoc: aws.iam.PolicyDocument = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "cloudwatch:*",

                        "ec2:*",
                    ],
                    Resource: "*",
                },
            ],
        };
        const instanceRole = new aws.iam.Role(`${this.name}-role`, {
            assumeRolePolicy: JSON.stringify(assumeInstanceRolePolicyDoc),
        }, { parent: this });

        const instanceRolePolicy = new aws.iam.RolePolicy(`${this.name}-policy`, {
            role: instanceRole.id,
            policy: instanceRolePolicyDoc,
        }, { parent: this });

        this.instanceProfile = new aws.iam.InstanceProfile(`${this.name}-profile`, {
            role: instanceRole,
        }, { parent: this });
    }

    private getIngressRules(): aws.types.input.ec2.SecurityGroupIngress[] {
        return [
            // For SSH access to the instance.
            { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
            // For FAHControl application to be control the FAHClient on the EC2 instance.
            { protocol: "tcp", fromPort: 36330, toPort: 36330, cidrBlocks: ["0.0.0.0/0"] }
        ];
    }

    private setupPrivateNetworking() {
        const vpc = new aws.ec2.Vpc(`${this.name}-vpc`, {
            cidrBlock: "10.10.0.0/24",
            enableDnsHostnames: true,
        }, { parent: this });

        this.subnet = new aws.ec2.Subnet(`${this.name}-subnet`, {
            vpcId: vpc.id,
            cidrBlock: "10.10.0.0/24",
            availabilityZone: pulumi.output(getAwsAz(0)),
            mapPublicIpOnLaunch: true,
        }, { parent: this });

        this.securityGroup = new aws.ec2.SecurityGroup(`${this.name}-secGroup`, {
            description: "Security group for Spot instance.",
            ingress: this.getIngressRules(),
            egress: [
                { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
            ],
            vpcId: vpc.id,
        }, { parent: this });

        const ig = new aws.ec2.InternetGateway(`${this.name}-ig`, {
            vpcId: vpc.id,
        }, { parent: this });

        const routeTable = new aws.ec2.RouteTable(`${this.name}-rt`, {
            vpcId: vpc.id,
            routes: [
                {
                    gatewayId: ig.id,
                    cidrBlock: "0.0.0.0/0",
                }
            ],
        }, { parent: this });

        const routeTableAssoc = new aws.ec2.RouteTableAssociation(`${this.name}-rtAssoc`, {
            routeTableId: routeTable.id,
            subnetId: this.subnet.id,
        }, { parent: this });
    }
}
