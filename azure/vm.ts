import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { TemplateDeployment } from "@pulumi/azure/core";

export interface SpotInstanceArgs { }

export class SpotInstance extends pulumi.ComponentResource {
    constructor(name: string, args: SpotInstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("", name, undefined, opts);
    }

    private createInstance() {
        const vm = new azure.compute.LinuxVirtualMachine("", {
            os
        });
    }
}
