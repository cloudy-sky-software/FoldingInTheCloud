import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { ResourceGroup } from "@pulumi/azure/core";
import { FunctionApp } from "@pulumi/azure/appservice";
import { NetworkInterface } from "@pulumi/azure/network";
import { Account } from "@pulumi/azure/storage";

export interface EventsHandlerArgs {
    resourceGroup: ResourceGroup;
    privateNic: NetworkInterface;
    storageAccount: Account;
}

export class EventsHandler extends pulumi.ComponentResource {
    private name: string;
    private args: EventsHandlerArgs;

    constructor(name: string, args: EventsHandlerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:events:functions:handler", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.registerOutputs({});
    }
}
