import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { Context } from "@pulumi/aws/lambda";

import * as sshpk from "sshpk";
import { generateKeyPair, RSAKeyPairOptions } from "crypto";

import {
    sendSSHPublicKeyToInstance,
    downloadS3Object,
    getSpotInstance,
    provisionInstance,
    runShutdownScript
} from "./provisioner";

export interface LambdaProvisionerArgs {
    spotInstanceRequestId: string;
    bucketName: string;
    zipFilename: string;
}

export class EventsHandler extends pulumi.ComponentResource {
    private name: string;
    private args: LambdaProvisionerArgs;

    public callbackFunction: aws.lambda.CallbackFunction<any, void> | undefined;
    private role: aws.iam.Role | undefined;

    constructor(name: string, args: LambdaProvisionerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("events:lambda:handler", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.createIAM();
        this.createLambda(args.spotInstanceRequestId, args.bucketName);
        if (!this.callbackFunction) {
            return;
        }

        this.registerOutputs({
            serverlessFunction: this.callbackFunction,
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
            description: "Custom IAM policy for Lambda execution.",
            policy: JSON.stringify(rolePolicyDoc),
        }, { parent: this });

        new aws.iam.RolePolicyAttachment(`${this.name}-lambda-attach-pol`, {
            role: this.role,
            policyArn: iamPolicy.arn,
        }, { parent: this });

        new aws.iam.RolePolicyAttachment(`${this.name}-lambda-attach-pol`, {
            role: this.role,
            policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
        }, { parent: this });
    }

    createLambda(spotInstanceRequestId: string, bucketName: string) {
        const zipFilename = this.args.zipFilename;
        this.callbackFunction = new aws.lambda.CallbackFunction(`${this.name}-provisioner`, {
            callback: async (e: any, ctx: Context) => {
                console.log("lambda event", e);
                console.log("Spot Instance request id", spotInstanceRequestId);
                const instance = await getSpotInstance(spotInstanceRequestId);
                if (!instance.PublicIpAddress || !instance.Placement) {
                    throw new Error("Got an unknown instance from Spot request.");
                }

                const keypairSettings: RSAKeyPairOptions<"pem", "pem"> = {
                    modulusLength: 4096,
                    publicKeyEncoding: {
                        type: "spki",
                        format: "pem"
                    },
                    privateKeyEncoding: {
                        type: "pkcs1",
                        format: "pem",
                    }
                };
                if (e.hasOwnProperty("source") && e.source === "aws.ec2" && e.detail["instance-action"] === "terminate") {
                    const p = new Promise((resolve, reject) => {
                        generateKeyPair("rsa", keypairSettings, async (err: any, publicKey: string, privateKey: string) => {
                            if (err) {
                                reject(err);
                                return;
                            }

                            // Convert the public to an OpenSSH public key format.
                            const sshPublicKey = sshpk.parseKey(publicKey, "pem").toString("ssh");
                            await sendSSHPublicKeyToInstance(instance, sshPublicKey);
                            await runShutdownScript(instance.PublicIpAddress!, privateKey);
                            console.log("All done!");
                            resolve();
                        });
                    });
                    return p;
                }

                await downloadS3Object(bucketName, zipFilename);
                const p = new Promise((resolve, reject) => {
                    generateKeyPair("rsa", keypairSettings, async (err: any, publicKey: string, privateKey: string) => {
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
            timeout: 800, // Seconds
            runtime: aws.lambda.NodeJS12dXRuntime,
        }, { parent: this });
    }
}
