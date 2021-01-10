import { RSAKeyPairOptions, generateKeyPair } from "crypto";

import * as aws from "@pulumi/aws";
import { Context } from "@pulumi/aws/lambda";
import * as pulumi from "@pulumi/pulumi";

import { Instance } from "aws-sdk/clients/ec2";
import * as sshpk from "sshpk";

import {
    downloadS3Object,
    getInstanceInfo,
    getSpotInstance,
    provisionInstance,
    runShutdownScript,
    sendSSHPublicKeyToInstance,
} from "./provisioner";
import { Ec2InstanceSecurity } from "./security";

export interface LambdaProvisionerArgs {
    ec2Security: Ec2InstanceSecurity;
    spotInstanceRequestId: pulumi.Output<string>;
    bucketName: pulumi.Output<string>;
    zipFilename: string;
}

/**
 * Creates an AWS Lambda function that handles various events.
 * Specifically, the Lambda is used to provision an instance fulfilled
 * by a Spot Instance Request or to deprovision it.
 */
export class EventsHandler extends pulumi.ComponentResource {
    private name: string;
    private args: LambdaProvisionerArgs;

    public callbackFunction: aws.lambda.CallbackFunction<any, void> | undefined;
    private role: aws.iam.Role | undefined;

    constructor(name: string, args: LambdaProvisionerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("aws:events:lambda:handler", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.createIAM();
        this.createLambda();
        if (!this.callbackFunction) {
            return;
        }

        this.registerOutputs({
            serverlessFunction: this.callbackFunction,
        });
    }

    createIAM(): void {
        // Configure IAM so that the AWS Lambda can be run.
        this.role = new aws.iam.Role(
            `${this.name}-lambda-role`,
            {
                assumeRolePolicy: {
                    Version: "2012-10-17",
                    Statement: [
                        {
                            Action: "sts:AssumeRole",
                            Principal: {
                                Service: "lambda.amazonaws.com",
                            },
                            Effect: "Allow",
                            Sid: "",
                        },
                    ],
                },
            },
            { parent: this },
        );

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
                        "lambda:AddPermission",
                        "lambda:RemovePermission",

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
        const iamPolicy = new aws.iam.Policy(
            `${this.name}-lambda-pol`,
            {
                description: "Custom IAM policy for Lambda execution.",
                policy: JSON.stringify(rolePolicyDoc),
            },
            { parent: this },
        );

        new aws.iam.RolePolicyAttachment(
            `${this.name}-lambda-attach-pol1`,
            {
                role: this.role,
                policyArn: iamPolicy.arn,
            },
            { parent: this },
        );

        // Network interface actions to allow Lambda to bind to an available
        // interface within the VPC.
        new aws.iam.RolePolicyAttachment(
            `${this.name}-lambda-attach-pol2`,
            {
                role: this.role,
                policyArn: aws.iam.ManagedPolicies.AWSLambdaVPCAccessExecutionRole,
            },
            { parent: this },
        );
    }

    createLambda(): void {
        if (!this.args.ec2Security.privateSubnet || !this.args.ec2Security.securityGroup) {
            throw new Error("Network security is not configured properly. Cannot create a Lambda.");
        }

        const zipFileName = this.args.zipFilename;
        const bucketName = this.args.bucketName;
        const spotInstanceRequestId = this.args.spotInstanceRequestId;
        this.callbackFunction = new aws.lambda.CallbackFunction(
            `${this.name}-provisioner`,
            {
                callback: this.getCallbackFunction(bucketName, spotInstanceRequestId, zipFileName),
                role: this.role,
                memorySize: 128, // MB
                timeout: 800, // Seconds
                runtime: aws.lambda.NodeJS12dXRuntime,
                vpcConfig: {
                    // If the private subnet and the security group are defined, then they will
                    // definitely have an id.
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    subnetIds: [this.args.ec2Security.privateSubnet.id!],
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    securityGroupIds: [this.args.ec2Security.securityGroup.id!],
                },
            },
            { parent: this },
        );
    }

    private getCallbackFunction(
        bucketName: pulumi.Output<string>,
        spotInstanceRequestId: pulumi.Output<string>,
        zipFilename: string,
    ) {
        return async (e: any, ctx: Context) => {
            console.log("lambda event", e);
            console.log("Spot Instance request id", spotInstanceRequestId);
            let instance: Instance;
            // For aws.ec2 events, the instance ID is in the event.
            if (e["source"] && e.source === "aws.ec2") {
                const instanceId = e.detail["instance-id"];
                instance = await getInstanceInfo(instanceId);
            } else {
                // For other events, we must query the spot instance
                // request and get the currently running instance as
                // it can change anytime.
                instance = await getSpotInstance(spotInstanceRequestId.get());
            }
            if (!instance.PublicIpAddress || !instance.Placement) {
                throw new Error("Got an unknown instance from Spot request.");
            }

            const keypairSettings: RSAKeyPairOptions<"pem", "pem"> = {
                modulusLength: 4096,
                publicKeyEncoding: {
                    type: "spki",
                    format: "pem",
                },
                privateKeyEncoding: {
                    type: "pkcs1",
                    format: "pem",
                },
            };
            // If the instance is either interrupted due to a price change
            // or terminated due to a scheduled termination,
            // we should give the chance to "deprovision" the instance,
            // so run the selected deprovision script in the instance.
            if (
                e["source"] &&
                e.source === "aws.ec2" &&
                (
                    e.detail["instance-action"] === "terminate" ||
                    e.detail["state"] === "shutting-down"
                )
            ) {
                const p = new Promise<void>((resolve, reject) => {
                    generateKeyPair(
                        "rsa", keypairSettings,
                        async (err: any, publicKey: string, privateKey: string) => {
                            if (err) {
                                reject(err);
                                return;
                            }

                            // Convert the public to an OpenSSH public key format.
                            const sshPublicKey = sshpk.parseKey(publicKey, "pem").toString("ssh");
                            await sendSSHPublicKeyToInstance(instance, sshPublicKey);
                            await runShutdownScript(
                                ctx,
                                spotInstanceRequestId.get(),
                                // The instance will have a private IP address.
                                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                                instance.PrivateIpAddress!,
                                privateKey,
                            );
                            console.log("All done!");
                            resolve();
                        });
                });
                return p;
            }

            await downloadS3Object(bucketName.get(), zipFilename);
            const p = new Promise<void>((resolve, reject) => {
                generateKeyPair(
                    "rsa", keypairSettings,
                    async (err: any, publicKey: string, privateKey: string) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        // Convert the public key to an OpenSSH public key format.
                        const sshPublicKey = sshpk.parseKey(publicKey, "pem").toString("ssh");
                        await sendSSHPublicKeyToInstance(instance, sshPublicKey);
                        await provisionInstance(
                            ctx,
                            spotInstanceRequestId.get(),
                            // An instance will always have a private IP address.
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            instance.PrivateIpAddress!,
                            privateKey,
                        );
                        console.log("All done!");
                        resolve();
                    });
            });
            return p;
        };
    }
}
