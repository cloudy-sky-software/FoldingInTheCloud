import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { getAwsAz } from "../awsUtils";

export interface Ec2InstanceSecurityArgs {
    securityGroupIngressRules: aws.types.input.ec2.SecurityGroupIngress[];
}

export class Ec2InstanceSecurity extends pulumi.ComponentResource {
    private name: string;
    private args: Ec2InstanceSecurityArgs;

    public instanceProfile: aws.iam.InstanceProfile | undefined;
    public publicSubnet: aws.ec2.Subnet | undefined;
    public privateSubnet: aws.ec2.Subnet | undefined;
    public securityGroup: aws.ec2.SecurityGroup | undefined;

    constructor(
        name: string, args: Ec2InstanceSecurityArgs, opts?: pulumi.ComponentResourceOptions) {
        super("aws:security", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.setupIdentities();
        this.setupNetworking();

        this.registerOutputs({
            instanceProfile: this.instanceProfile,
            subnet: this.publicSubnet,
            securityGroup: this.securityGroup,
        });
    }

    private setupIdentities() {
        const assumeInstanceRolePolicyDoc: aws.iam.PolicyDocument = {
            Version: "2012-10-17",
            Statement: [
                {
                    Action: ["sts:AssumeRole"],
                    Effect: "Allow",
                    Principal: {
                        Service: ["ec2.amazonaws.com"],
                    },
                },
            ],
        };

        const instanceRolePolicyDoc: aws.iam.PolicyDocument = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["cloudwatch:*", "ec2:*"],
                    Resource: "*",
                },
            ],
        };
        const instanceRole = new aws.iam.Role(
            `${this.name}-role`,
            {
                assumeRolePolicy: JSON.stringify(assumeInstanceRolePolicyDoc),
            },
            { parent: this },
        );

        const _instanceRolePolicy = new aws.iam.RolePolicy(
            `${this.name}-policy`,
            {
                role: instanceRole.id,
                policy: instanceRolePolicyDoc,
            },
            { parent: this },
        );

        this.instanceProfile = new aws.iam.InstanceProfile(
            `${this.name}-profile`,
            {
                role: instanceRole,
            },
            { parent: this },
        );
    }

    private setupPrivateSubnet(vpc: aws.ec2.Vpc) {
        if (!this.privateSubnet || !this.publicSubnet) {
            return;
        }

        const eip = new aws.ec2.Eip(
            `${this.name}-eip`,
            {
                vpc: true,
            },
            { parent: this },
        );

        const natGw = new aws.ec2.NatGateway(
            `${this.name}-natgw`,
            {
                allocationId: eip.id,
                subnetId: this.publicSubnet.id,
            },
            { parent: this },
        );

        const privateRouteTable = new aws.ec2.RouteTable(
            `${this.name}-nat-rt`,
            {
                vpcId: vpc.id,
                routes: [
                    {
                        natGatewayId: natGw.id,
                        cidrBlock: "0.0.0.0/0",
                    },
                ],
            },
            { parent: this },
        );

        /**
         * Associate the NAT gateway route with the private subnet.
         * This allows resources in the private subnet to talk to the NAT gateway
         * destined for the internet without letting the anything on the internet initiate
         * connections with them.
         */
        const _natRouteTableAssoc = new aws.ec2.RouteTableAssociation(
            `${this.name}-nat-rtAssoc`,
            {
                routeTableId: privateRouteTable.id,
                subnetId: this.privateSubnet.id,
            },
            { parent: this },
        );
    }

    private setupInternetGateway(vpc: aws.ec2.Vpc) {
        if (!this.publicSubnet) {
            return;
        }

        const ig = new aws.ec2.InternetGateway(
            `${this.name}-ig`,
            {
                vpcId: vpc.id,
            },
            { parent: this, customTimeouts: { delete: "1h" } },
        );

        const routeTable = new aws.ec2.RouteTable(
            `${this.name}-rt`,
            {
                vpcId: vpc.id,
                routes: [
                    {
                        gatewayId: ig.id,
                        cidrBlock: "0.0.0.0/0",
                    },
                ],
            },
            { parent: this },
        );

        /**
         * Create a route table association for the public subnet to the internet gateway.
         * This gives resources in the public subnet direct access to the internet and
         * also makes them reachable from the internet.
         */
        const _routeTableAssoc = new aws.ec2.RouteTableAssociation(
            `${this.name}-rtAssoc`,
            {
                routeTableId: routeTable.id,
                subnetId: this.publicSubnet.id,
            },
            { parent: this },
        );
    }

    private setupNetworking() {
        const vpc = new aws.ec2.Vpc(
            `${this.name}-vpc`,
            {
                cidrBlock: "10.10.0.0/16",
                enableDnsHostnames: true,
            },
            { parent: this, customTimeouts: { delete: "1h" } },
        );

        this.publicSubnet = new aws.ec2.Subnet(
            `${this.name}-subnet`,
            {
                vpcId: vpc.id,
                cidrBlock: "10.10.0.0/24",
                availabilityZone: pulumi.output(getAwsAz(0)),
                mapPublicIpOnLaunch: true,
            },
            { parent: this, customTimeouts: { delete: "1h" } },
        );

        this.privateSubnet = new aws.ec2.Subnet(
            `${this.name}-priv-subnet`,
            {
                vpcId: vpc.id,
                // We will also use this subnet to deploy Lambda resources.
                cidrBlock: "10.10.1.0/24",
                availabilityZone: pulumi.output(getAwsAz(0)),
                mapPublicIpOnLaunch: false,
            },
            { parent: this, customTimeouts: { delete: "1h" } },
        );

        this.securityGroup = new aws.ec2.SecurityGroup(
            `${this.name}-secGroup`,
            {
                description: "Security group for Spot instance.",
                ingress: this.args.securityGroupIngressRules,
                egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
                vpcId: vpc.id,
            },
            { parent: this, customTimeouts: { delete: "1h" } },
        );

        this.setupInternetGateway(vpc);
        this.setupPrivateSubnet(vpc);
    }
}
