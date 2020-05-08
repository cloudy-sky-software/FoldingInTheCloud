import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { ResourceGroup } from "@pulumi/azure/core";
import { FunctionApp } from "@pulumi/azure/appservice";

export interface EventsHandlerArgs {
    resourceGroup: ResourceGroup;
    privateNic: N
}

export class EventsHandler extends pulumi.ComponentResource {
    private name: string;
    private args: EventsHandlerArgs;

    constructor(name: string, args: EventsHandlerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:events:functions:handler", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.registerOutputs({});
        const functionApp = new FunctionApp(`${this.name}-func`, {
            resourceGroupName: this.args.resourceGroup.name,
            version: "~3",

        }, { parent: this });
    }
}
