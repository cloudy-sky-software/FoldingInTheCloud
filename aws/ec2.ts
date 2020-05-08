import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { Ec2InstanceSecurity } from "./security";
import { getAmi, getAwsUserData } from "../utils";

export interface Ec2SpotInstanceArgs {
    privateKey: pulumi.Input<string>;
    privateKeyPassphrase?: pulumi.Input<string>;
    publicKey: pulumi.Input<string>;

    instanceType: aws.ec2.InstanceType | string,
    /**
     * The max price per hour that you are willing to pay for the instance.
     */
    maxSpotPrice: string;
    blockDurationMinutes?: number;

    ingressRules: aws.types.input.ec2.SecurityGroupIngress[];
}

export class Ec2SpotInstance extends pulumi.ComponentResource {
    private name: string;
    private args: Ec2SpotInstanceArgs;

    public spotRequest: aws.ec2.SpotInstanceRequest | undefined;

    public ec2Security: Ec2InstanceSecurity;

    constructor(name: string, args: Ec2SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:ec2", name, undefined, opts);
        this.args = args;
        this.name = name;

        this.ec2Security = new Ec2InstanceSecurity(`${name}-sec`,
            {
                securityGroupIngressRules: args.ingressRules,
            },
            { ...opts, parent: this });
        this.createInstance();
        this.registerOutputs({
            instance: this.spotRequest,
        });
    }

    private async createInstance(): Promise<boolean> {
        if (!this.ec2Security.instanceProfile) {
            throw new Error("IAM instance profile doesn't seem to have been initialized.");
        }
        if (!this.ec2Security.publicSubnet || !this.ec2Security.securityGroup) {
            throw new Error("Instance security has not been created. Cannot create a spot instance request.");
        }

        // Create an EC2 server that we'll then provision stuff onto.
        const key = new aws.ec2.KeyPair(`${this.name}-InstanceKey`, {
            publicKey: this.args.publicKey,
        }, { parent: this });
        this.spotRequest = new aws.ec2.SpotInstanceRequest(`${this.name}-spotreq`, {
            instanceType: this.args.instanceType,
            ami: pulumi.output(getAmi()).apply(ami => ami.id),
            keyName: key.keyName,
            rootBlockDevice: {
                volumeSize: 50,
            },
            availabilityZone: this.ec2Security.publicSubnet.availabilityZone,
            vpcSecurityGroupIds: [this.ec2Security.securityGroup.id],
            subnetId: this.ec2Security.publicSubnet.id,
            spotPrice: this.args.maxSpotPrice,
            blockDurationMinutes: this.args.blockDurationMinutes,
            monitoring: true,
            associatePublicIpAddress: true,
            iamInstanceProfile: this.ec2Security.instanceProfile.name,
            waitForFulfillment: false,
            metadataOptions: {
                // The default is `enabled`, but being explicit that the IMDS is enabled.
                httpEndpoint: "enabled",
            },
            userData: getAwsUserData(),
        }, { parent: this });

        return true;
    }
}
