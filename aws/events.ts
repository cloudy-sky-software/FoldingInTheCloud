import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { EventsHandler } from "./eventsHandler";
import { Ec2InstanceSecurity } from "./security";

export interface EventsArgs {
    ec2Security: Ec2InstanceSecurity;

    bucket: aws.s3.Bucket;
    spotInstanceRequest: aws.ec2.SpotInstanceRequest;
    zipFileName: string;
}

/**
 * Creates an `EventHandler` instance and subscribes it to the following events:
 * - EC2 events [`running`, `shutting-down`]
 * - Spot instance interruption warning
 * - S3 object creation
 */
export class AwsEvents extends pulumi.ComponentResource {
    constructor(name: string, args: EventsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("aws:events", name, undefined, opts);

        const handler = new EventsHandler(
            "fah",
            {
                ec2Security: args.ec2Security,
                bucketName: args.bucket.bucket,
                spotInstanceRequestId: args.spotInstanceRequest.id,
                zipFilename: args.zipFileName,
            },
            { parent: this },
        );

        if (!handler.callbackFunction) {
            throw new Error(
                "Handler has an undefined callback function property. Cannot subscribe to events.");
        }

        args.bucket.onObjectCreated(
            "fah-object-created", handler.callbackFunction, undefined, { parent: this });

        const instanceRunningEvent = new aws.cloudwatch.EventRule(
            `${name}-inst-running`,
            {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    source: ["aws.ec2"],
                    "detail-type": ["EC2 Instance State-change Notification"],
                    detail: {
                        state: ["running", "shutting-down"],
                    },
                }),
            },
            { parent: this },
        );

        instanceRunningEvent.onEvent(
            `${name}-inst-running-sub`, handler.callbackFunction, undefined, { parent: this });

        const eventRule = new aws.cloudwatch.EventRule(
            `${name}-interruption`,
            {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    source: ["aws.ec2"],
                    "detail-type": ["EC2 Spot Instance Interruption Warning"],
                }),
            },
            { parent: this },
        );

        eventRule.onEvent(
            `${name}-interruption-sub`, handler.callbackFunction, undefined, { parent: this });

        this.registerOutputs({});
    }
}
