import * as pulumi from "@pulumi/pulumi";
import { ResourceGroup } from "@pulumi/azure/core";
import { Account, Container, Blob } from "@pulumi/azure/storage";
import * as aws from "@pulumi/aws";

import { AzureSpotVm } from "./azure/vm";
import { AzureEvents } from "./azure/events";

import { Ec2SpotInstance } from "./aws/ec2";
import { AwsEvents } from "./aws/events";

import {
    allowedIP,
    cloudProvider,
    instanceType,
    maxBidPrice,
    privateKey,
    publicKey,
    privateKeyPassphrase,
} from "./config";
import { getAwsSecurityGroupIngressRules } from "./awsUtils";
import { getAzureVmIngressRules } from "./azureUtils";

export interface SpotInstanceArgs {
    /**
     * By default, the SSH port (22) is open and allowed access from the
     * `allowedIP` IP address. Specify additional ports that you
     * want to expose on the VM. These additional ports will also only be
     * accessible from the `allowedIP` IP address.
     */
    exposedPorts: number[];
}

export class SpotInstance extends pulumi.ComponentResource {
    private name: string;
    private args: SpotInstanceArgs;

    public spotRequestId?: pulumi.Output<string>;
    public instanceId?: pulumi.Output<string>;
    public objectStorage?: pulumi.Output<string>;

    constructor(name: string, args: SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance", name, undefined, opts);
        this.name = name;
        this.args = args;

        if (cloudProvider === "aws") {
            this.createAwsInfra();
        } else if (cloudProvider === "azure") {
            this.createAzureInfra();
        } else {
            throw new Error(`Unknown cloud provider ${cloudProvider}.`);
        }
    }

    private createAzureInfra() {
        const resourceGroup = new ResourceGroup(this.name, {
            name: this.name,
        }, { parent: this });

        // The storage to use for storing the workload scripts, as well as
        // the Azure Functions zip-blob.
        const storageAccount = new Account(`${this.name}`, {
            accountReplicationType: "LRS",
            resourceGroupName: resourceGroup.name,
            accountTier: "Standard",
        }, { parent: resourceGroup });

        const blobContainer = new Container(`${this.name}Container`, {
            containerAccessType: "private",
            storageAccountName: storageAccount.name,
            name: "scripts",
        }, { parent: storageAccount });

        const azureSpotVm = new AzureSpotVm(`${this.name}`, {
            resourceGroup,
            publicKey,

            // Use Azure VM the price configurator to find the best price.
            // https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/
            maxSpotPrice: maxBidPrice,
            instanceType: instanceType,
            securityGroupRules: [
                {
                    name: "AllowSSH",
                    access: "Allow",
                    direction: "Inbound",
                    priority: 300,
                    protocol: "TCP",

                    sourcePortRange: "*",
                    sourceAddressPrefix: pulumi.interpolate`${allowedIP}/32`,

                    destinationAddressPrefix: "VirtualNetwork",
                    destinationPortRange: "22",
                },
                ...getAzureVmIngressRules(allowedIP, this.args.exposedPorts, 400),
            ],
        }, { parent: resourceGroup, dependsOn: storageAccount });

        if (!azureSpotVm.spotInstance || !azureSpotVm.vmSecurity.securityGroup) {
            return;
        }

        const events = new AzureEvents(`${this.name}-events`, {
            scriptsContainer: blobContainer,
            securityGroup: azureSpotVm.vmSecurity.securityGroup,
            vm: azureSpotVm.spotInstance,
            privateKey,
            resourceGroup,
            storageAccount,
        }, { parent: resourceGroup, dependsOn: azureSpotVm });

        const _scriptsBlob = new Blob(`${this.name}-blob`, {
            storageAccountName: storageAccount.name,
            storageContainerName: blobContainer.name,
            type: "Block",
            name: "scripts",
            contentType: "application/zip",
            source: new pulumi.asset.FileArchive("./scripts"),
        }, { parent: resourceGroup, dependsOn: events });

        this.objectStorage = storageAccount.name;
        this.instanceId = azureSpotVm.spotInstance?.id;
        this.registerOutputs({
            objectStorage: undefined,
            spotRequestId: azureSpotVm.spotInstance?.id,
        });
    }

    private createAwsInfra() {
        const bucket = new aws.s3.Bucket("fah-bucket", {
            bucket: "fah-bucket",
            serverSideEncryptionConfiguration: {
                rule: {
                    applyServerSideEncryptionByDefault: {
                        sseAlgorithm: "AES256",
                    },
                },
            },
            versioning: {
                enabled: true,
            },
        }, { parent: this });

        const ec2SpotInstance = new Ec2SpotInstance(`${this.name}`, {
            /**
             * When picking an instance type, be sure to also pick a region
             * where the chance of interruption is low. Set the location using
             * `pulumi config set aws:region <region>` to use that region.
             * Use the Spot Instance Advisor to find a region for the instance type.
             * https://aws.amazon.com/ec2/spot/instance-advisor/
             */
            instanceType,
            /**
             * Max per-hour spot price is based on the price history for the instance
             * per https://aws.amazon.com/ec2/spot/pricing/.
             */
            maxSpotPrice: `${maxBidPrice}`,

            privateKey,
            publicKey,
            privateKeyPassphrase,

            ingressRules: [
                // For SSH access to the instance from the remote IP.
                {
                    protocol: "tcp",
                    fromPort: 22,
                    toPort: 22,
                    cidrBlocks: [pulumi.interpolate`${allowedIP}/32`],
                },
                // For SSH access to the instance from resources within the security group.
                {
                    protocol: "tcp",
                    fromPort: 22,
                    toPort: 22,
                    self: true,
                },
                ...getAwsSecurityGroupIngressRules(allowedIP, this.args.exposedPorts),
            ],
        }, { dependsOn: bucket, parent: this });

        if (!ec2SpotInstance || !ec2SpotInstance.spotRequest) {
            throw new Error("Cannot proceed since the instance request is undefined.");
        }

        const zipFileName = "workload-scripts";
        const events = new AwsEvents("events", {
            ec2Security: ec2SpotInstance.ec2Security,
            spotInstanceRequest: ec2SpotInstance.spotRequest,
            bucket,
            zipFileName,
        }, { dependsOn: ec2SpotInstance, parent: this });

        // Create the BucketObject just before we exit the process, because the BucketNotification
        // resource itself is created on process exit. If we don't do this, the BucketObject
        // will always be created _before_ the BucketNotification exists and therefore,
        // there wouldn't be anything to handle the notification. With this trick,
        // we are delaying the creation of the BucketObject to after the BucketNotification
        // is created, which itself is created via a process `beforeExit` handler.
        // See https://github.com/pulumi/pulumi-aws/blob/master/sdk/nodejs/s3/s3Mixins.ts#L187.
        const bucketObjectOpts: pulumi.CustomResourceOptions = {
            parent: this,
            dependsOn: events,
        };
        // Use a flag to indicate that the BucketObject resource was already created.
        // Otherwise, when we enter the handler for the `beforeExit` event, we will
        // once again try to create the same resource because `beforeExit` would be invoked
        // anytime the Node process queue empties-out.
        let bucketObjectCreated = false;
        process.on("beforeExit", () => {
            if (bucketObjectCreated) {
                return;
            }

            const _bucketObject = new aws.s3.BucketObject(zipFileName, {
                bucket: bucket,
                key: zipFileName,
                serverSideEncryption: "AES256",
                source: new pulumi.asset.FileArchive("./scripts"),
            }, bucketObjectOpts);
            bucketObjectCreated = true;
        });

        this.objectStorage = bucket.bucket;
        this.spotRequestId = ec2SpotInstance.spotRequest?.id;
        this.registerOutputs({
            objectStorage: bucket.bucket,
            spotRequestId: ec2SpotInstance.spotRequest?.id,
        });
    }
}
