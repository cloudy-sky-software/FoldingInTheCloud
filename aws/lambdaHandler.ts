import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import * as sshpk from "sshpk";
import { generateKeyPair } from "crypto";

import {
    sendSSHPublicKeyToInstance,
    downloadS3Object,
    getSpotInstance,
    provisionInstance
} from "./provisioner";
import { Context } from "@pulumi/aws/lambda";

export interface LambdaProvisionerArgs {
    spotInstanceRequestId: pulumi.Output<string>;
    bucket: aws.s3.Bucket;
    zipFilename: string;
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

            const eventRule = new aws.cloudwatch.EventRule(`${this.name}-fulfilled-event`, {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    "source": ["aws.ec2"],
                    "detail-type": ["EC2 Instance State-change Notification"],
                    "detail": {
                        "state": ["running"]
                    }
                }),
            }, { parent: this });

            eventRule.onEvent(`${this.name}-event-invocation`, this.callbackFunction, undefined, { parent: this });

            this.registerOutputs({
                serverlessFunction: this.callbackFunction,
            });
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

                        "events:DescribeRule",
                        "events:PutRule",
                        "events:DeleteRule",

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
            callback: async (e, ctx: Context) => {
                console.log("lambda event", e);
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
            memorySize: 128, // MB
            timeout: 600, // Seconds
            runtime: aws.lambda.NodeJS12dXRuntime,
        }, { parent: this });
    }
}
