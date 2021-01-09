import * as azure from "@pulumi/azure";
import { NetworkInterface, NetworkSecurityGroup, PublicIp, VirtualNetwork } from "@pulumi/azure/network";
import * as pulumi from "@pulumi/pulumi";

export interface AzureSecurityArgs {
    resourceGroup: azure.core.ResourceGroup;
    securityGroupRules: pulumi.Input<azure.types.input.network.NetworkSecurityGroupSecurityRule>[];
}

export class AzureSecurity extends pulumi.ComponentResource {
    private name: string;
    private args: AzureSecurityArgs;
    private readonly publicSubnetName = "publicSubnet";

    public publicNic: NetworkInterface | undefined;
    public vnet: VirtualNetwork | undefined;
    public securityGroup: NetworkSecurityGroup | undefined;

    constructor(name: string, args: AzureSecurityArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:security", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.setupNetworking();
        this.registerOutputs({
            networkInterface: this.publicNic,
            securityGroup: this.securityGroup,
            vnet: this.vnet,
        });
    }

    private getSubnetId(subnetName: string): pulumi.Output<string> {
        if (!this.vnet) {
            throw new Error("VNet hasn't been created yet.");
        }
        const s = this.vnet.subnets.apply((subnets) => subnets.filter((s) => s.name === subnetName));
        if (!s || !s.length) {
            throw new Error(`Could not find subnet with name ${subnetName} in the vnet.`);
        }

        return s[0].id;
    }

    private setupNetworking() {
        if (this.args.securityGroupRules.length === 0) {
            pulumi.log.warn("Custom security rules not provided. The default allows SSH access from any source.");
        }

        this.securityGroup = new NetworkSecurityGroup(
            `${this.name}-securityGroup`,
            {
                resourceGroupName: this.args.resourceGroup.name,
                securityRules: this.args.securityGroupRules || [
                    {
                        name: "AllowSSH",
                        access: "Allow",
                        direction: "Inbound",
                        priority: 300,
                        protocol: "TCP",

                        // The default rule is to allow SSH from ANY source.
                        sourcePortRange: "*",
                        sourceAddressPrefix: "*",

                        destinationAddressPrefix: "*",
                        destinationPortRange: "22",
                    },
                ],
            },
            { parent: this }
        );

        this.vnet = new VirtualNetwork(
            `${this.name}-vnet`,
            {
                addressSpaces: ["10.10.0.0/24"],
                resourceGroupName: this.args.resourceGroup.name,
                subnets: [
                    {
                        name: this.publicSubnetName,
                        addressPrefix: "10.10.0.0/24",
                        securityGroup: this.securityGroup.id,
                    },
                ],
            },
            { parent: this }
        );

        const publicIPs = new PublicIp(
            `${this.name}-publicIp`,
            {
                allocationMethod: "Dynamic",
                resourceGroupName: this.args.resourceGroup.name,
                sku: "Basic",
                idleTimeoutInMinutes: 4,
                ipVersion: "IPv4",
            },
            { parent: this }
        );

        this.publicNic = new NetworkInterface(
            `${this.name}-pub`,
            {
                resourceGroupName: this.args.resourceGroup.name,
                ipConfigurations: [
                    {
                        name: "publicIpConfig",
                        privateIpAddressAllocation: "Dynamic",
                        primary: true,
                        subnetId: this.getSubnetId(this.publicSubnetName),
                        publicIpAddressId: publicIPs.id,
                    },
                ],
            },
            { parent: this }
        );
    }
}
