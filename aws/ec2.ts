import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { Ec2InstanceSecurity } from "./security";
import { getDefaultTags, getAmi } from "../utils";

export interface SpotInstanceArgs {
    privateKey: pulumi.Input<string>;
    privateKeyPassphrase?: pulumi.Input<string>;
    publicKey: pulumi.Input<string>;

    instanceType: aws.ec2.InstanceType | string,
    /**
     * The max price per hour that you are willing to pay for the instance.
     */
    maxSpotPrice: string;
    blockDurationMinutes: number;
}

export class SpotInstance extends pulumi.ComponentResource {
    private name: string;
    private args: SpotInstanceArgs;

    public spotRequest: aws.ec2.SpotInstanceRequest | undefined;

    private ec2Security: Ec2InstanceSecurity;

    constructor(name: string, args: SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:ec2", name, undefined, opts);
        this.args = args;
        this.name = name;

        this.ec2Security = new Ec2InstanceSecurity(name, { ...opts, parent: this });
        this.createInstance();
        this.registerOutputs({
            instance: this.spotRequest,
        });
    }

    private async createInstance(): Promise<boolean> {
        if (!this.ec2Security.instanceProfile) {
            throw new Error("IAM instance profile doesn't seem to have been initialized.");
        }
        if (!this.ec2Security.subnet || !this.ec2Security.securityGroup) {
            throw new Error("Instance security has not been created. Cannot create a spot instance request.");
        }

        // Create an EC2 server that we'll then provision stuff onto.
        const key = new aws.ec2.KeyPair(`${this.name}-InstanceKey`, {
            publicKey: this.args.publicKey,
        }, { parent: this });
        this.spotRequest = new aws.ec2.SpotInstanceRequest(`${this.name}-Instance`, {
            instanceType: this.args.instanceType,
            ami: pulumi.output(getAmi()).apply(ami => ami.id),
            keyName: key.keyName,
            rootBlockDevice: {
                volumeSize: 50,
            },
            tags: getDefaultTags(),
            availabilityZone: this.ec2Security.subnet.availabilityZone,
            vpcSecurityGroupIds: [this.ec2Security.securityGroup.id],
            subnetId: this.ec2Security.subnet.id,
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
            userData:
                `#!/bin/bash
sudo apt-get update --yes
sudo apt-get install ec2-instance-connect --yes

echo "Preparing the instance..."
sudo apt install gcc --yes

echo "Installing NVIDIA CUDA drivers..."
# https://developer.nvidia.com/cuda-downloads?target_os=Linux&target_arch=x86_64&target_distro=Ubuntu&target_version=1804&target_type=deblocal
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu1804/x86_64/cuda-ubuntu1804.pin
sudo mv cuda-ubuntu1804.pin /etc/apt/preferences.d/cuda-repository-pin-600
wget http://developer.download.nvidia.com/compute/cuda/10.2/Prod/local_installers/cuda-repo-ubuntu1804-10-2-local-10.2.89-440.33.01_1.0-1_amd64.deb
sudo dpkg -i cuda-repo-ubuntu1804-10-2-local-10.2.89-440.33.01_1.0-1_amd64.deb
sudo apt-key add /var/cuda-repo-10-2-local-10.2.89-440.33.01/7fa2af80.pub
sudo apt-get update
sudo apt-get -y install cuda
echo "Installed CUDA drivers."`
        }, { parent: this });

        return true;
    }
}
