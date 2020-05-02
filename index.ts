import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import * as axios from "axios";
import * as ssh2 from "ssh2";
import { ParsedKey } from "ssh2-streams";

import { SpotInstance } from "./aws/ec2";
import { execSync } from "child_process";
import { registerDefaultTags } from "./tags";
import { Events } from "./aws/events";

// Get the config ready to go.
const config = new pulumi.Config();
const publicKey = config.require("publicKey");
const privateKey = config.requireSecret("privateKey");
const privateKeyPassphrase = config.get("privateKeyPassphrase") || "";

// Register default tags for all taggable resources.
registerDefaultTags();

pulumi.all([privateKey, privateKeyPassphrase]).apply(([prKey, pass]) => {
    pulumi.log.info("Parsing private key...", undefined, undefined, true);
    const key = ssh2.utils.parseKey(prKey, pass) as ParsedKey;
    if (key.type !== "ssh-rsa") {
        throw new Error(`${key.type} is invalid. Private key type must be ssh-rsa.`);
    }

    pulumi.log.info("Parsed private key successfully!", undefined, undefined, true);
});

const fahPassKey = config.requireSecret("fahPassKey");
const fahUsername = config.require("fahUsername");
const fahRemoteControlPass = config.requireSecret("fahRemoteControlPass");
const fahAllowedIP = config.requireSecret("fahAllowedIP");

// Transform the FAH config.xml with the stack config properties provided by the user.
pulumi.all([fahUsername, fahPassKey, fahRemoteControlPass, fahAllowedIP]).apply(async ([un, pk, rcPass, allowedIP]) => {
    const execLocal = (cmd: string) => {
        execSync(cmd, {
            cwd: "./scripts",
        });
    };
    pulumi.log.info("Updating config.xml");
    execLocal("cp config.xml.template config.xml");
    execLocal(`sed -i 's/{{Username}}/${un}/g' config.xml`);
    execLocal(`sed -i 's/{{PassKey}}/${pk}/g' config.xml`);
    execLocal(`sed -i 's/{{RemoteControlPass}}/${rcPass}/g' config.xml`);
    execLocal(`sed -i 's/{{AllowedIP}}/${allowedIP}/g' config.xml`);
    pulumi.log.info("Updated config.xml");
});

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
});

const spotInstance = new SpotInstance("fah-linux", {
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
    maxSpotPrice: "0.442",
    /**
     * Defined duration spot instances are less likely to be interrupted.
     * And if they are interrupted, we won't incur charges for the hour
     * in which it is interrupted. That sounds like a good deal.
     */
    blockDurationMinutes: 180,

    privateKey,
    publicKey,
    privateKeyPassphrase,

    ingressRules: [
        // For SSH access to the instance.
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
        // To allow FAHControl on a remote IP to be able to connect to/control the FAHClient on the EC2 instance.
        { protocol: "tcp", fromPort: 36330, toPort: 36330, cidrBlocks: [pulumi.interpolate`${fahAllowedIP}/32`] }
    ],
}, { dependsOn: bucket });

export const bucketArn = bucket.arn;
export const spotRequestId = spotInstance.spotRequest?.id;

if (spotInstance && spotInstance.spotRequest) {
    const zipFileName = "fah-scripts";
    const events = new Events("fah-events", {
        ec2Security: spotInstance.ec2Security,
        spotInstanceRequest: spotInstance.spotRequest,
        bucket,
        zipFileName,
    }, { dependsOn: spotInstance });

    const bucketObject = new aws.s3.BucketObject("fah-scripts", {
        bucket: bucket,
        key: zipFileName,
        serverSideEncryption: "AES256",
        source: new pulumi.asset.FileArchive("./scripts")
    }, { dependsOn: events });
}
