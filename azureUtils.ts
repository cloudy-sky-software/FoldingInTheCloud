import { interpolate, Output } from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";

export function getAzureVmIngressRules(
    allowedIP: Output<string>, ports: number[], priorityStart: number):
        azure.types.input.network.NetworkSecurityGroupSecurityRule[] {
    return ports.map((p: number, idx: number) => {
        return {
            name: `Allow-${p}`,
            access: "Allow",
            direction: "Inbound",
            priority: priorityStart + idx,
            protocol: "TCP",

            sourcePortRange: "*",
            sourceAddressPrefix: interpolate`${allowedIP}/32`,

            destinationAddressPrefix: "VirtualNetwork",
            destinationPortRange: `${p}`,
        };
    });
}
