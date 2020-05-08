import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { NetworkInterface, VirtualNetwork, NetworkSecurityGroup, PublicIp, NetworkInterfaceSecurityGroupAssociation, NatGateway, SubnetNatGatewayAssociation, RouteTable, VirtualNetworkGateway, LocalNetworkGateway } from "@pulumi/azure/network";

export interface AzureSecurityArgs {
    resourceGroup: azure.core.ResourceGroup;
    securityGroupRules: pulumi.Input<azure.types.input.network.NetworkSecurityGroupSecurityRule>[];
}

export class AzureSecurity extends pulumi.ComponentResource {
    private name: string;
    private args: AzureSecurityArgs;

    public networkInterface: NetworkInterface;
    public vnet: VirtualNetwork;
    public securityGroup: NetworkSecurityGroup;

    constructor(name: string, args: AzureSecurityArgs, opts?: pulumi.ComponentResourceOptions) {
        super("azure:security", name, undefined, opts);
        this.name = name;
        this.args = args;

        this.setupNetworking();
        this.registerOutputs({
            networkInterface: this.networkInterface,
            securityGroup: this.securityGroup,
            vnet: this.vnet,
        });
    }

    private setupPrivateSubnet() {
        const natPublicIP = new PublicIp(`${this.name}-natPubIp`, {
            allocationMethod: "Static",
            resourceGroupName: this.args.resourceGroup.name,
            sku: "Basic",
            ipVersion: "IPv4",
            idleTimeoutInMinutes: 2,
        }, { parent: this });
        const natGateway = new NatGateway(`${this.name}-natGw`, {
            resourceGroupName: this.args.resourceGroup.name,
            idleTimeoutInMinutes: 2,
            skuName: "Standard",
            publicIpAddressIds: [natPublicIP.id],
            // TODO
            zones: [],
        }, { parent: this });
        const natAssociation = new SubnetNatGatewayAssociation(`${this.name}-natAssoc`, {
            natGatewayId: natGateway.id,
            subnetId: this.getSubnetId("privateSubnet")
        }, { parent: this });
    }

    private getSubnetId(subnetName: string): pulumi.Output<string> {
        if (!this.vnet) {
            throw new Error("VNet hasn't been created yet.");
        }
        const s = this.vnet.subnets.apply(subnets => subnets.filter(s => s.name === subnetName));
        if (!s || !s.length) {
            throw new Error(`Could not find subnet with name ${subnetName} in the vnet.`);
        }

        return s[0].id;
    }

    private setupNetworking() {
        this.securityGroup = new NetworkSecurityGroup(`${this.name}-securityGroup`, {
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
                }
            ],
        }, { parent: this });

        this.vnet = new VirtualNetwork(`${this.name}-vnet`, {
            addressSpaces: ["10.0.0.0/16"],
            resourceGroupName: this.args.resourceGroup.name,
            subnets: [
                {
                    name: "publicSubnet",
                    addressPrefix: "10.10.0.0/24",
                    securityGroup: this.securityGroup.id
                },
                {
                    name: "privateSubnet",
                    addressPrefix: "10.10.1.0/24",
                    securityGroup: this.securityGroup.id
                }
            ]
        }, { parent: this });

        const publicIPs = new PublicIp(`${this.name}-publicIp`, {
            allocationMethod: "Dynamic",
            resourceGroupName: this.args.resourceGroup.name,
            sku: "Basic",
            idleTimeoutInMinutes: 2,
            ipVersion: "IPv4"
        }, { parent: this });

        this.networkInterface = new NetworkInterface(`${this.name}-nic`, {
            resourceGroupName: this.args.resourceGroup.name,
            ipConfigurations: [
                {
                    name: "publicIpConfig",
                    privateIpAddressAllocation: "Dynamic",
                    primary: true,
                    subnetId: this.getSubnetId("publicSubnet"),
                    publicIpAddressId: publicIPs.id
                },
                {
                    name: "privateIpConfig",
                    privateIpAddressAllocation: "Dynamic",
                    subnetId: this.getSubnetId("privateSubnet"),
                }
            ],
        }, { parent: this });

        this.setupPrivateSubnet();
    }
}