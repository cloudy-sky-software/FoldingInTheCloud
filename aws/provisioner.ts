import * as aws from "@pulumi/aws";
import { Context } from "@pulumi/aws/lambda";

import { DescribeSpotInstanceRequestsResult, DescribeInstancesResult, Instance } from "aws-sdk/clients/ec2";
import * as unzipper from "unzipper";

import { copyFile, ConnectionArgs, runCommand } from "../ssh-utils";

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

export async function downloadS3Object(bucketName: string, zipFilename: string) {
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

export async function getSpotInstance(spotRequestId: string): Promise<Instance> {
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

export async function sendSSHPublicKeyToInstance(instance: Instance, publicKey: string) {
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

function getScheduledEventRuleName(spotInstanceRequestId: string): string {
    return `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`;
}

async function checkAndCreateScheduledEvent(ctx: Context, spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });
    let result;
    try {
        result = await cw.describeRule({
            Name: getScheduledEventRuleName(spotInstanceRequestId),
        }).promise();
        if (result.$response.httpResponse.statusCode === 200) {
            console.log(`Scheduled event ${SCHEDULED_EVENT_NAME_PREFIX} already exists. Won't re-create it.`);
            return;
        }
    } catch (err) {
        /**
         * If the error is anything else other than a `ResourceNotFoundException`, re-throw it.
         * We expect to _not_ find it, so we can actually create it.
         */
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }

    const rule = await cw.putRule({
        Name: `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`,
        Description: "Scheduled Event to provision an EC2 spot instance until it succeeds. This is a temporary event and will be deleted.",
        ScheduleExpression: "rate(15 minutes)",
    }).promise();
    await cw.putTargets({
        Rule: rule.RuleArn!,
        Targets: [{
            Arn: ctx.invokedFunctionArn,
            Id: ctx.functionName,
        }],
    }).promise();
}

async function deleteScheduledEvent(ctx: Context, spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });

    const ruleName = getScheduledEventRuleName(spotInstanceRequestId);
    let result;
    try {
        result = await cw.deleteRule({
            Name: ruleName,
        }).promise();
        await cw.removeTargets({
            Rule: ruleName,
            Ids: [ctx.functionName]
        }).promise();
    } catch (err) {
        // If the error is anything but a 404, re-throw it. Otherwise, ignore it.
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }
}

export async function provisionInstance(ctx: Context, spotInstanceRequestId: string, instancePublicIp: string, sshPrivateKey: string) {
    const conn: ConnectionArgs = {
        type: "ssh",
        host: instancePublicIp,
        username: INSTANCE_USER,
        privateKey: sshPrivateKey,
    };

    try {
        await checkAndCreateScheduledEvent(ctx, spotInstanceRequestId);
        console.log(`Copying files to the instance ${instancePublicIp}...`);
        // Copy the files to the EC2 instance.
        await copyFile(conn, LOCAL_SCRIPTS_PATH, LINUX_USER_SCRIPTS_DIR);
    } catch (err) {
        console.error("Could not copy files to the instance at this time.", err);
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
    await deleteScheduledEvent(ctx, spotInstanceRequestId);
}

export async function runShutdownScript(ctx: Context, spotInstanceRequestId: string, instancePublicIp: string, sshPrivateKey: string) {
    const conn: ConnectionArgs = {
        type: "ssh",
        host: instancePublicIp,
        username: INSTANCE_USER,
        privateKey: sshPrivateKey,
    };

    console.log("Removing any previously created scheduled events...");
    await deleteScheduledEvent(ctx, spotInstanceRequestId);
    console.log("Running shutdown script on the instance...");
    await runCommand(conn, `. ${LINUX_USER_SCRIPTS_DIR}shutdown.sh`);
}
