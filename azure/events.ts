import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { ResourceGroup } from "@pulumi/azure/core";
import { Container, Account } from "@pulumi/azure/storage";
import { LinuxVirtualMachine } from "@pulumi/azure/compute";

import { EventsHandler } from "./eventsHandler";

export interface EventsArgs {
    resourceGroup: ResourceGroup;
    scriptsContainer: Container;
    storageAccount: Account;
    vm: LinuxVirtualMachine;
    privateKey: pulumi.Input<string>;
}

export class AzureEvents extends pulumi.ComponentResource {
    private name: string;
    private args: EventsArgs;

    constructor(name: string, args: EventsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:events", name, undefined, opts);
        this.name = name;
        this.args = args;

        const handler = new EventsHandler(`${this.name}-hndlr`, {
            privateKey: this.args.privateKey,
            resourceGroup: this.args.resourceGroup,
            vm: this.args.vm,
            scriptsContainer: this.args.scriptsContainer,
            storageAccount: this.args.storageAccount,
        }, { parent: this });

        const functionAppName = handler.functionApp.functionApp.name;
        const functionName = "EventGridTrigger1";
        const systemKey = pulumi.output(handler.functionApp.functionApp.getHostKeys()).apply(keys => keys.systemKeys["eventgrid_extension"]);
        const url =
            pulumi.interpolate`https://${functionAppName}.azurewebsites.net/runtime/webhooks/eventgrid?functionName=${functionName}&code=${systemKey}`;
        const evSub = new azure.eventgrid.EventSubscription(`${this.name}-sub`, {
            scope: this.args.storageAccount.id,
            retryPolicy: {
                eventTimeToLive: 120,
                maxDeliveryAttempts: 20,
            },
            subjectFilter: {
                subjectBeginsWith: pulumi.interpolate`/blobServices/default/containers/${this.args.scriptsContainer.name}`
            },
            includedEventTypes: [
                "Microsoft.Storage.BlobCreated"
            ],
            eventDeliverySchema: "EventGridSchema",
            webhookEndpoint: {
                url
            }
        }, { parent: this });

        this.registerOutputs({});
    }
}

