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
import { Ec2InstanceSecurity } from "./security";

export interface LambdaProvisionerArgs {
    ec2Security: Ec2InstanceSecurity;
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
                        // To allow the Lambda to create CW event rules if a failure is encountered,
                        // so that it can retry provisioning an instance.
                        "events:DescribeRule",
                        "events:PutRule",
                        "events:DeleteRule",
                        "events:PutTargets",
                        "events:RemoveTargets",

                        "ec2:DescribeSpotInstanceRequests",
                        "ec2:DescribeInstances",
                        // To use EC2 Instance Connect to perform provisioning actions via SSH.
                        "ec2-instance-connect:SendSSHPublicKey",

                        // To download the provisioning scripts from S3.
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

        new aws.iam.RolePolicyAttachment(`${this.name}-lambda-attach-pol1`, {
            role: this.role,
            policyArn: iamPolicy.arn,
        }, { parent: this });

        // Network interface actions to allow Lambda to bind to an available
        // interface within the VPC.
        new aws.iam.RolePolicyAttachment(`${this.name}-lambda-attach-pol2`, {
            role: this.role,
            policyArn: aws.iam.ManagedPolicies.AWSLambdaVPCAccessExecutionRole,
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
                            await runShutdownScript(ctx, spotInstanceRequestId, instance.PublicIpAddress!, privateKey);
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
                        await provisionInstance(ctx, spotInstanceRequestId, instance.PublicIpAddress!, privateKey);
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
            vpcConfig: {
                subnetIds: [this.args.ec2Security.subnet?.id!],
                securityGroupIds: [this.args.ec2Security.securityGroup?.id!],
            }
        }, { parent: this });
    }
}
