import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";

export interface AzureSecurityArgs {
    resourceGroup: azure.core.ResourceGroup;
}

export class AzureSecurity extends pulumi.ComponentResource {
    private name: string;
    private args: AzureSecurityArgs;

    constructor(name: string, args: AzureSecurityArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:security", name, undefined, opts);
        this.name = name;
        this.args = args;



        this.registerOutputs({});
    }
}
