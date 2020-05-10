import * as pulumi from "@pulumi/pulumi";

import { ResourceGroup } from "@pulumi/azure/core";
import { ArchiveFunctionApp } from "@pulumi/azure/appservice";
import { Account, Container } from "@pulumi/azure/storage";
import { LinuxVirtualMachine } from "@pulumi/azure/compute";

export interface EventsHandlerArgs {
    resourceGroup: ResourceGroup;
    vm: LinuxVirtualMachine;
    storageAccount: Account;
    scriptsContainer: Container;

    privateKey: pulumi.Input<string>;
}

export class EventsHandler extends pulumi.ComponentResource {
    private name: string;
    private args: EventsHandlerArgs;

    public functionApp: ArchiveFunctionApp;

    constructor(name: string, args: EventsHandlerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:events:functions:handler", name, undefined, opts);
        this.name = name;
        this.args = args;

        const faContainer = new Container(`${this.name}-funcstrg`, {
            storageAccountName: this.args.storageAccount.name,
            containerAccessType: "private",
            name: "function-app-storage"
        }, { parent: this });

        this.functionApp = new ArchiveFunctionApp(`${this.name}-func`, {
            resourceGroup: this.args.resourceGroup,
            // The connection string for this is stored as `AzureWebJobsStorage` automatically
            // in the Connection Strings panel by the Azure Functions service.
            account: this.args.storageAccount,
            container: faContainer,
            enabled: true,
            httpsOnly: true,
            archive: new pulumi.asset.FileArchive("./azure/functionapp"),
            connectionStrings: [
                {
                    name: "sshPrivateKey",
                    type: "Custom",
                    value: this.args.privateKey,
                }
            ],
            siteConfig: {
                use32BitWorkerProcess: false,
                alwaysOn: true,
                ftpsState: "Disabled",
            },
            appSettings: {
                "scriptsContainer": this.args.scriptsContainer.name,
                "instancePublicIp": this.args.vm.publicIpAddress,
            }
        }, { parent: this });

        this.registerOutputs({
            functionApp: this.functionApp
        });
    }
}
