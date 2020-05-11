import * as pulumi from "@pulumi/pulumi";

import { AzureSpotVm } from "./azure/vm";
import { ResourceGroup } from "@pulumi/azure/core";
import { Account, Container, Blob } from "@pulumi/azure/storage";
import { AzureEvents } from "./azure/events";

import * as aws from "@pulumi/aws";
import { Ec2SpotInstance } from "./aws/ec2";
import { AwsEvents } from "./aws/events";
import { storage } from "@pulumi/azure";


// Get the config ready to go.
const config = new pulumi.Config();
const publicKey = config.require("publicKey");
const privateKey = config.requireSecret("privateKey");
const privateKeyPassphrase = config.get("privateKeyPassphrase") || "";
const fahAllowedIP = config.requireSecret("fahAllowedIP");
const cloudProvider = config.get("cloudProvider") || "aws";

export interface SpotInstanceArgs { }

export class SpotInstance extends pulumi.ComponentResource {
    private name: string;

    public spotRequestId?: pulumi.Output<string>;
    public instanceId?: pulumi.Output<string>;
    public objectStorage?: pulumi.Output<string>;

    constructor(name: string, args?: SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance", name, undefined, opts);
        this.name = name;

        if (cloudProvider === "aws") {
            this.createAwsInfra();
        } else if (cloudProvider === "azure") {
            this.createAzureInfra();
        } else {
            throw new Error(`Unknown cloud provider ${cloudProvider}.`);
        }
    }

    private createAzureInfra() {
        const resourceGroupName = "fah-linux";
        const resourceGroup = new ResourceGroup(resourceGroupName, {
            name: resourceGroupName,
        }, { parent: this });

        // The storage to use for storing the workload scripts, as well as
        // the Azure Functions zip-blob.
        const storageAccount = new Account(`${this.name}`, {
            accountReplicationType: "LRS",
            resourceGroupName: resourceGroup.name,
            accountTier: "Standard",
        }, { parent: resourceGroup });

        const blobContainer = new Container(`${this.name}-cntnr`, {
            containerAccessType: "private",
            storageAccountName: storageAccount.name,
            name: "scripts",
        }, { parent: storageAccount });

        const azureSpotVm = new AzureSpotVm(`${this.name}`, {
            resourceGroup,
            publicKey,

            // Use Azure VM the price configurator to find the best price.
            // https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/
            maxSpotPrice: 0.2,
            securityGroupRules: [
                {
                    name: "AllowSSH",
                    access: "Allow",
                    direction: "Inbound",
                    priority: 300,
                    protocol: "TCP",

                    sourcePortRange: "*",
                    sourceAddressPrefix: pulumi.interpolate`${fahAllowedIP}/32`,

                    destinationAddressPrefix: "VirtualNetwork",
                    destinationPortRange: "22",
                },
                {
                    name: "AllowFAHRemoteControl",
                    access: "Allow",
                    direction: "Inbound",
                    priority: 400,
                    protocol: "TCP",

                    sourcePortRange: "*",
                    sourceAddressPrefix: pulumi.interpolate`${fahAllowedIP}/32`,

                    destinationAddressPrefix: "VirtualNetwork",
                    destinationPortRange: "36330",
                }
            ]
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

        const scriptsBlob = new Blob(`${this.name}-blob`, {
            storageAccountName: storageAccount.name,
            storageContainerName: blobContainer.name,
            type: "Block",
            name: "scripts",
            contentType: "application/zip",
            source: new pulumi.asset.FileArchive("./scripts")
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
                        sseAlgorithm: "AES256"
                    }
                }
            },
            versioning: {
                enabled: true
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
            instanceType: "g4dn.xlarge",
            /**
             * Max per-hour spot price is based on the price history for the instance
             * per https://aws.amazon.com/ec2/spot/pricing/.
             */
            maxSpotPrice: "0.2",
            /**
             * Defined duration spot instances are less likely to be interrupted.
             * And if they are interrupted, we won't incur charges for the hour
             * in which it is interrupted. That sounds like a good deal.
             */
            // blockDurationMinutes: 180,

            privateKey,
            publicKey,
            privateKeyPassphrase,

            ingressRules: [
                // For SSH access to the instance from the remote IP.
                { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: [pulumi.interpolate`${fahAllowedIP}/32`] },
                // For SSH access to the instance from resources within the security group.
                { protocol: "tcp", fromPort: 22, toPort: 22, self: true },
                // To allow FAHControl on a remote IP to be able to connect to/control the FAHClient on the EC2 instance.
                { protocol: "tcp", fromPort: 36330, toPort: 36330, cidrBlocks: [pulumi.interpolate`${fahAllowedIP}/32`] }
            ],
        }, { dependsOn: bucket, parent: this });

        if (!ec2SpotInstance || !ec2SpotInstance.spotRequest) {
            return;
        }

        const zipFileName = "fah-scripts";
        const events = new AwsEvents("fah-events", {
            ec2Security: ec2SpotInstance.ec2Security,
            spotInstanceRequest: ec2SpotInstance.spotRequest,
            bucket,
            zipFileName,
        }, { dependsOn: ec2SpotInstance, parent: this });

        const bucketObject = new aws.s3.BucketObject("fah-scripts", {
            bucket: bucket,
            key: zipFileName,
            serverSideEncryption: "AES256",
            source: new pulumi.asset.FileArchive("./scripts")
        }, { dependsOn: events, parent: bucket });

        this.objectStorage = bucket.bucket;
        this.spotRequestId = ec2SpotInstance.spotRequest?.id;
        this.registerOutputs({
            objectStorage: bucket.bucket,
            spotRequestId: ec2SpotInstance.spotRequest?.id,
        });
    }
}