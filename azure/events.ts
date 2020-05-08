import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { NetworkInterface } from "@pulumi/azure/network";
import { ResourceGroup } from "@pulumi/azure/core";

export interface EventsArgs {
    resourceGroup: ResourceGroup;
    privateNic: NetworkInterface;
}

export class Events extends pulumi.ComponentResource {
    private name: string;
    private args: EventsArgs;

    constructor(name: string, args: EventsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:events", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.registerOutputs({});
    }
}

