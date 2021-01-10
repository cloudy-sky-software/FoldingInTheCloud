import * as azure from "@pulumi/azure";
import { LinuxVirtualMachine } from "@pulumi/azure/compute";
import { ResourceGroup } from "@pulumi/azure/core";
import { NetworkSecurityGroup, NetworkSecurityRule } from "@pulumi/azure/network";
import { Account, Container } from "@pulumi/azure/storage";
import * as pulumi from "@pulumi/pulumi";

import { EventsHandler } from "./eventsHandler";

export interface EventsArgs {
    resourceGroup: ResourceGroup;
    scriptsContainer: Container;
    securityGroup: NetworkSecurityGroup;
    storageAccount: Account;

    /**
     * The VM that is the target will be the target of the provisioning actions.
     *
     * Unfortunately, we can't do without this information because we are unable
     * to listen to VM events from a Function App. VM events are delivered through
     * [Scheduled Events](https://docs.microsoft.com/en-us/azure/virtual-machines/windows/scheduled-events#scope)
     * which is accessible only through a metadata endpoint internal to the VM's VNET.
     * Since our Function App is not in the same VNET (or in any for that matter!) due
     * to limitations in Azure's Function App Consumption Plan, we don't have a better
     * choice here.
     * 
     * This also means a VM MUST be available to be fulfilled at the requested price at
     * the time of creation. Otherwise, the whole infrastructure fails to be created due
     * to this requirement.
     *
     * Alternatively, this requirement could be removed by listening to resource actions
     * at a resource group level, but the VM should be the only resource in that resource
     * group.
     * See https://docs.microsoft.com/en-us/azure/event-grid/monitor-virtual-machine-changes-event-grid-logic-app.
     */
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

        const handler = new EventsHandler(
            `${this.name}-hndlr`,
            {
                privateKey: this.args.privateKey,
                resourceGroup: this.args.resourceGroup,
                vm: this.args.vm,
                scriptsContainer: this.args.scriptsContainer,
                storageAccount: this.args.storageAccount,
            },
            { parent: this },
        );

        const sourceIpAddresses = pulumi
            .all([
                handler.functionApp.functionApp.outboundIpAddresses,
                handler.functionApp.functionApp.possibleOutboundIpAddresses,
            ])
            .apply(([outboundIpAddresses, possibleOutboundIpAddresses]) => {
                return [
                    ...outboundIpAddresses.split(","),
                    ...possibleOutboundIpAddresses.split(","),
                ];
            });
        const _networkSg = new NetworkSecurityRule(
            `${this.name}`,
            {
                name: "AllowSSHFromFunc",
                description: "Allow SSH access from Function App.",
                resourceGroupName: this.args.resourceGroup.name,
                networkSecurityGroupName: this.args.securityGroup.name,
                access: "Allow",
                direction: "Inbound",
                priority: 500,
                protocol: "TCP",

                sourcePortRange: "*",
                sourceAddressPrefixes: sourceIpAddresses,

                destinationAddressPrefix: "VirtualNetwork",
                destinationPortRange: "22",
            },
            { parent: this },
        );
        const functionAppName = handler.functionApp.functionApp.name;
        const functionName = "EventGridTrigger1";
        const systemKey = pulumi
            .output(handler.functionApp.functionApp.getHostKeys())
            .apply((keys) => keys.systemKeys["eventgrid_extension"]);
        const url = pulumi.interpolate `https://${functionAppName}.azurewebsites.net/runtime/webhooks/eventgrid?functionName=${functionName}&code=${systemKey}`;
        const _evSub = new azure.eventgrid.EventSubscription(
            `${this.name}-blob-sub`,
            {
                scope: this.args.storageAccount.id,
                retryPolicy: {
                    eventTimeToLive: 120,
                    maxDeliveryAttempts: 20,
                },
                subjectFilter: {
                    subjectBeginsWith: pulumi.interpolate`/blobServices/default/containers/${this.args.scriptsContainer.name}`,
                },
                includedEventTypes: ["Microsoft.Storage.BlobCreated"],
                eventDeliverySchema: "EventGridSchema",
                webhookEndpoint: {
                    url,
                },
            },
            { parent: this },
        );

        this.registerOutputs({});
    }
}
