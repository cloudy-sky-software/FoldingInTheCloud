import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { EventsHandler } from "./eventsHandler";

export interface EventsArgs {
    bucket: aws.s3.Bucket;
    spotInstanceRequest: aws.ec2.SpotInstanceRequest;
    zipFileName: string;
}

export class Events extends pulumi.ComponentResource {
    constructor(name: string, args: EventsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("ec2:events", name, undefined, opts);

        pulumi.all([args.spotInstanceRequest.id, args.bucket.bucket]).apply(([spotInstanceRequestId, bucketName]) => {
            const handler = new EventsHandler("fah", {
                bucketName: bucketName,
                spotInstanceRequestId: spotInstanceRequestId,
                zipFilename: args.zipFileName,
            }, { parent: this });

            if (!handler.callbackFunction) {
                return;
            }

            args.bucket.onObjectCreated("fah-object-created", handler.callbackFunction, undefined, { parent: this });

            const instanceRunningEvent = new aws.cloudwatch.EventRule(`${name}-inst-running`, {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    "source": ["aws.ec2"],
                    "detail-type": ["EC2 Instance State-change Notification"],
                    "detail": {
                        "state": ["running"]
                    }
                }),
            }, { parent: this });

            instanceRunningEvent.onEvent(`${name}-inst-running-sub`, handler.callbackFunction, undefined, { parent: this });

            const eventRule = new aws.cloudwatch.EventRule(`${name}-interruption`, {
                description: "Event rule for Spot Instance request fulfillment.",
                eventPattern: JSON.stringify({
                    "source": ["aws.ec2"],
                    "detail-type": ["EC2 Spot Instance Interruption Warning"]
                }),
            }, { parent: this });

            eventRule.onEvent(`${name}-interruption-sub`, handler.callbackFunction, undefined, { parent: this });

            this.registerOutputs({});
        });
    }
}

