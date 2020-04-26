import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { DescribeSpotInstanceRequestsResult, DescribeInstancesResult, Instance } from "aws-sdk/clients/ec2";

import * as unzipper from "unzipper";
import * as sshpk from "sshpk";

import { copyFile, ConnectionArgs, runCommand } from "../provisioners";
import { Context } from "@pulumi/aws/lambda";
import { getDefaultTags } from "../utils";
import { generateKeyPair } from "crypto";

const AWS_REGION = aws.config.region;
/**
 * The name of the scheduled event that is created when copying a file to
 * the EC2 instance fails after several retries. The scheduled event
 * will be removed once an instance is successfully provisioned.
 */
const SCHEDULED_EVENT_NAME_PREFIX = "ScheduledEC2Provisioner";

/**
 * The path where the Lambda will download/extract the scripts zip file.
 */
const LOCAL_SCRIPTS_PATH = "/tmp/scripts";

const INSTANCE_USER = "ubuntu";
const LINUX_USER_SCRIPTS_DIR = `/home/${INSTANCE_USER}/`;

export interface LambdaProvisionerArgs {
    spotInstanceRequestId: pulumi.Output<string>;
    bucket: aws.s3.Bucket;
    zipFilename: string;
}

async function downloadS3Object(bucketName: string, zipFilename: string) {
    const s3 = new aws.sdk.S3({
        region: AWS_REGION,
    });

    const s3Stream = s3.getObject({
        Bucket: bucketName,
        Key: zipFilename,
    }).createReadStream();
    // Listen for errors returned by the service
    s3Stream.on("error", function (err) {
        // NoSuchKey: The specified key does not exist
        console.error(err);
    });

    s3Stream.pipe(unzipper.Extract({ path: LOCAL_SCRIPTS_PATH })).on("error", (err) => {
        console.error("File Stream error:", err);
    }).on("close", () => {
        console.log("Downloaded s3 object to local path.");
    });
}

async function getSpotInstance(spotRequestId: string): Promise<Instance> {
    const ec2 = new aws.sdk.EC2({
        region: AWS_REGION,
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

    return describeInstanceResult.Reservations[0].Instances[0];
}

async function sendSSHPublicKeyToInstance(instance: Instance, publicKey: string) {
    console.log("Sending SSH public key to the EC2 instance...");
    const ec2 = new aws.sdk.EC2InstanceConnect({
        region: AWS_REGION,
    });

    const result = await ec2.sendSSHPublicKey({
        AvailabilityZone: instance.Placement!.AvailabilityZone!,
        InstanceId: instance.InstanceId!,
        SSHPublicKey: publicKey,
        InstanceOSUser: INSTANCE_USER,
    }).promise();

    if (!result.Success) {
        throw new Error(`Sending the SSH public key to the instance failed: ${result.$response.error}`)
    }
    console.log("SSH public key sent.");
}

async function checkAndCreateScheduledEvent(spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });
    const result = await cw.describeRule({
        Name: `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`,
    }).promise();
    if (result.$response.httpResponse.statusCode === 200) {
        console.log(`Scheduled event ${SCHEDULED_EVENT_NAME_PREFIX} already exists.`);
        return;
    }

    await cw.putRule({
        Name: `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`,
        Description: "Scheduled Event to provision an EC2 spot instance until it succeeds. This is a temporary event and will be deleted.",
        ScheduleExpression: "rate(15 minutes)",
    }).promise();
}

async function deleteScheduledEvent(spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });
    const result = await cw.deleteRule({
        Name: `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`,
    }).promise();
}

async function provisionInstance(spotInstanceRequestId: string, instancePublicIp: string, sshPrivateKey: string) {
    const conn: ConnectionArgs = {
        type: "ssh",
        host: instancePublicIp,
        username: INSTANCE_USER,
        privateKey: sshPrivateKey,
    };

    try {
        console.log(`Copying files to the instance ${instancePublicIp}...`);
        // Copy the files to the EC2 instance.
        await copyFile(conn, LOCAL_SCRIPTS_PATH, LINUX_USER_SCRIPTS_DIR);
    } catch (err) {
        console.error("Could not copy files to the instance at this time. Will schedule a future event to try again.");
        checkAndCreateScheduledEvent(spotInstanceRequestId);
        return;
    }

    const commands = [
        `chmod 755 ${LINUX_USER_SCRIPTS_DIR}*.sh`,
        `. ${LINUX_USER_SCRIPTS_DIR}install.sh`
    ];

    console.log("Executing commands on the instance...");
    for (const cmd of commands) {
        await runCommand(conn, cmd);
    }
    await deleteScheduledEvent(spotInstanceRequestId);
}

export class LambdaProvisioner extends pulumi.ComponentResource {
    private name: string;
    private args: LambdaProvisionerArgs;

    public callbackFunction: aws.lambda.CallbackFunction<any, void> | undefined;
    private role: aws.iam.Role | undefined;

    constructor(name: string, args: LambdaProvisionerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lambda:provisioner", name, opts);
        this.name = name;
        this.args = args;

        this.createIAM();
        pulumi.all([this.args.spotInstanceRequestId, this.args.bucket.bucket]).apply(([spotInstanceRequestId, bucketName]) => {
            this.createLambda(spotInstanceRequestId, bucketName);
            if (!this.callbackFunction) {
                return;
            }

            this.args.bucket.onObjectCreated("fah-object-created", this.callbackFunction);

            this.registerOutputs({
                serverlessFunction: this.callbackFunction,
            });

            const eventRule = new aws.cloudwatch.EventRule(`${this.name}-fulfilled-event`, {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    "source": ["aws.ec2"],
                    "detail-type": ["EC2 Instance State-change Notification"],
                    "detail": {
                        "state": ["running"]
                    }
                }),
                tags: getDefaultTags()
            }, { parent: this });

            eventRule.onEvent(`${this.name}-event-invocation`, this.callbackFunction, undefined, { parent: this });
        });
    }

    createIAM() {
        // Configure IAM so that the AWS Lambda can be run.
        this.role = new aws.iam.Role(`${this.name}-lambda-role`, {
            assumeRolePolicy: {
                Version: "2012-10-17",
                Statement: [{
                    Action: "sts:AssumeRole",
                    Principal: {
                        Service: "lambda.amazonaws.com",
                    },
                    Effect: "Allow",
                    Sid: "",
                }],
            },
            tags: getDefaultTags()
        }, { parent: this });

        const rolePolicyDoc: aws.iam.PolicyDocument = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",

                        "events:PutRule",

                        "ec2:DescribeSpotInstanceRequests",
                        "ec2:DescribeInstances",
                        "ec2-instance-connect:SendSSHPublicKey",

                        "s3:GetObject",
                    ],
                    Resource: "*",
                },
            ],
        };
        const iamPolicy = new aws.iam.Policy(`${this.name}-lambda-pol`, {
            description: "IAM policy for Lambda execution.",
            policy: JSON.stringify(rolePolicyDoc),
        }, { parent: this });

        new aws.iam.RolePolicyAttachment(`${this.name}-lambda-attach-pol`, {
            role: this.role,
            policyArn: iamPolicy.arn,
        }, { parent: this });
    }

    createLambda(spotInstanceRequestId: string, bucketName: string) {
        const zipFilename = this.args.zipFilename;
        this.callbackFunction = new aws.lambda.CallbackFunction(`${this.name}-provisioner`, {
            callback: async (e: any, ctx: Context) => {
                console.log("Spot Instance request id", spotInstanceRequestId);
                const instance = await getSpotInstance(spotInstanceRequestId);
                if (!instance.PublicIpAddress || !instance.Placement) {
                    throw new Error("Got an unknown instance from Spot request.");
                }

                await downloadS3Object(bucketName, zipFilename);
                const p = new Promise((resolve, reject) => {
                    generateKeyPair("rsa", {
                        modulusLength: 4096,
                        publicKeyEncoding: {
                            type: "spki",
                            format: "pem"
                        },
                        privateKeyEncoding: {
                            type: "pkcs1",
                            format: "pem",
                        }
                    }, async (err: any, publicKey: string, privateKey: string) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        // Convert the public to an OpenSSH public key format.
                        const sshPublicKey = sshpk.parseKey(publicKey, "pem").toString("ssh");
                        await sendSSHPublicKeyToInstance(instance, sshPublicKey);
                        await provisionInstance(spotInstanceRequestId, instance.PublicIpAddress!, privateKey);
                        console.log("All done!");
                        resolve();
                    });
                });
                return p;
            },
            role: this.role,
            timeout: 600, // Seconds
            runtime: aws.lambda.NodeJS12dXRuntime,
            tags: getDefaultTags()
        }, { parent: this });
    }
}
