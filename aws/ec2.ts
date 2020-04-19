import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { DescribeSpotInstanceRequestsResult, DescribeInstancesResult } from "aws-sdk/clients/ec2";

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { CopyFile, RemoteExec, ConnectionArgs } from "../provisioners";

import { Ec2InstanceSecurity } from "./security";
import { InstanceSecurity } from "../instanceSecurity";
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
}

export class SpotInstance extends pulumi.ComponentResource {
    private readonly INSTANCE_USER = "ubuntu";
    private readonly LINUX_USER_SCRIPTS_DIR = `/home/${this.INSTANCE_USER}/scripts/`;

    private name: string;
    private args: SpotInstanceArgs;

    public spotRequest: aws.ec2.SpotInstanceRequest | undefined;

    private instanceSecurity: InstanceSecurity;

    constructor(name: string, args: SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:ec2", name, undefined, opts);
        this.args = args;
        this.name = name;

        this.instanceSecurity = new Ec2InstanceSecurity(name, { parent: this });
        this.createInstance();
        this.registerOutputs({
            instance: this.spotRequest,
        });
    }

    private getProvisionerCommands(): string[] {
        return [
            `chmod 755 ${this.LINUX_USER_SCRIPTS_DIR}*.sh`,
            `. ${this.LINUX_USER_SCRIPTS_DIR}install.sh`
        ];
    }

    /**
     * Calculates a hash for all of the files under the scripts directory.
     */
    private async getScriptsHash(): Promise<string> {
        const p = new Promise<string>((resolve, reject) => {
            const hash = crypto.createHash("md5");
            fs.readdir(path.join(__dirname, "scripts"), { encoding: "utf8" }, (err, files) => {
                if (err) {
                    reject(err);
                    return;
                }

                files.forEach(f => {
                    const data = fs.readFileSync(path.join(__dirname, "scripts", f), { encoding: "utf8" });
                    hash.update(data, "utf8");
                });

                resolve(hash.digest("hex"));
            });
        });
        return p;
    }

    private async provisionInstance(spotRequestId: string) {
        const ec2 = new aws.sdk.EC2({
            region: aws.config.region,
        });

        await ec2.waitFor("spotInstanceRequestFulfilled", {
            $waiter: {
                maxAttempts: 20,
                delay: 10,
            },
            SpotInstanceRequestIds: [spotRequestId]
        }).promise();

        const latestSpotRequest = await ec2.describeSpotInstanceRequests({
            SpotInstanceRequestIds: [spotRequestId]
        }).promise();

        const fulfilledInstanceRequest = latestSpotRequest.$response.data as DescribeSpotInstanceRequestsResult;
        if (!fulfilledInstanceRequest.SpotInstanceRequests) {
            throw new Error("Spot instance request could not be fetched.");
        }
        const instanceId = fulfilledInstanceRequest.SpotInstanceRequests[0].InstanceId;
        if (!instanceId) {
            throw new Error("InstanceId is undefined. Spot instance request has not been fulfilled yet.");
        }

        await ec2.waitFor("instanceRunning", {
            $waiter: {
                maxAttempts: 20,
                delay: 10,
            },
            InstanceIds: [instanceId]
        }).promise();

        const describeInstanceResponse = await ec2.describeInstances({
            InstanceIds: [instanceId],
        }).promise();

        const describeInstanceResult = describeInstanceResponse.$response.data as DescribeInstancesResult;
        if (!describeInstanceResult.Reservations || !describeInstanceResult.Reservations[0].Instances) {
            throw new Error(`Could not find instance ${instanceId}`);
        }

        const instancePublicIp = describeInstanceResult.Reservations[0].Instances[0].PublicIpAddress!;
        const hash = await this.getScriptsHash();
        pulumi.log.info(`Directory hash is ${hash}`, this, undefined, true);
        const conn: ConnectionArgs = {
            type: "ssh",
            host: instancePublicIp,
            username: this.INSTANCE_USER,
            privateKey: this.args.privateKey,
            privateKeyPassphrase: this.args.privateKeyPassphrase,
            changeToken: hash,
        };

        // Copy a config file to our server.
        const cpScripts = new CopyFile(`${this.name}-copy-script`, {
            conn,
            src: "scripts/",
            dest: this.LINUX_USER_SCRIPTS_DIR,
        }, { parent: this, dependsOn: this.spotRequest });

        // Execute the setup script.
        const execSetupScript = new RemoteExec(`${this.name}-run-script`, {
            conn,
            commands: this.getProvisionerCommands(),
        }, { parent: this, dependsOn: cpScripts });
    }

    private async createInstance(): Promise<boolean> {
        await this.instanceSecurity.setupIdentities();
        await this.instanceSecurity.setupPrivateNetworking();

        const ec2Security = this.instanceSecurity as Ec2InstanceSecurity;
        if (!ec2Security.instanceProfile) {
            throw new Error("IAM instance profile doesn't seem to have been initialized.");
        }
        if (!ec2Security.subnet || !ec2Security.securityGroup) {
            throw new Error("Instance security has not been created. Cannot create a spot instance request.");
        }

        const ami = await getAmi();
        // Create an EC2 server that we'll then provision stuff onto.
        const key = new aws.ec2.KeyPair(`${this.name}-InstanceKey`, {
            publicKey: this.args.publicKey,
        }, { parent: this });
        this.spotRequest = new aws.ec2.SpotInstanceRequest(`${this.name}-Instance`, {
            instanceType: this.args.instanceType,
            ami: ami.id,
            keyName: key.keyName,
            tags: getDefaultTags(),
            availabilityZone: ec2Security.subnet.availabilityZone,
            vpcSecurityGroupIds: [ec2Security.securityGroup.id],
            subnetId: ec2Security.subnet.id,
            spotPrice: this.args.maxSpotPrice,
            monitoring: true,
            associatePublicIpAddress: true,
            iamInstanceProfile: ec2Security.instanceProfile.name,
            waitForFulfillment: false,
            userData: `
sudo apt update --yes
`
        }, { parent: this });

        const spotRequestId = this.spotRequest.id.apply(async (id) => {
            pulumi.log.info("Provisioning the instance...", this, undefined, true);
            await this.provisionInstance(id);
        });

        return true;
    }
}
