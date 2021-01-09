import * as pulumi from "@pulumi/pulumi";

function getDefaultTags(): Record<string, string> {
    return {
        project: pulumi.getProject(),
        stack: pulumi.getStack(),
    };
}

function isTaggable(type: string): boolean {
    switch (type) {
    case "aws:iam/instanceProfile:InstanceProfile":
    case "aws:iam/policy:Policy":
    case "aws:iam/rolePolicy:RolePolicy":
    case "aws:iam/rolePolicyAttachment:RolePolicyAttachment":
    case "aws:ec2/routeTableAssociation:RouteTableAssociation":
    case "aws:cloudwatch/eventTarget:EventTarget":
    case "aws:lambda/permission:Permission":
    case "aws:s3/bucketNotification:BucketNotification":

    // eslint-disable-next-line no-fallthrough
    case "azure:network/subnetNatGatewayAssociation:SubnetNatGatewayAssociation":
    case "azure:storage/container:Container":
    case "azure:eventgrid/eventSubscription:EventSubscription":
    case "azure:storage/blob:Blob":
    case "azure:network/networkSecurityRule:NetworkSecurityRule":

    // eslint-disable-next-line no-fallthrough
    case "random:index/randomPassword:RandomPassword":
        return false;
    default:
        return true;
    }
}

/**
 * registerDefaultTags registers a global stack transformation that merges a set
 * of tags with whatever was also explicitly added to the resource definition.
 */
export function registerDefaultTags(): void {
    const autoTags = getDefaultTags();
    pulumi.runtime.registerStackTransformation((args) => {
        if (isTaggable(args.type)) {
            args.props["tags"] = { ...args.props["tags"], ...autoTags };
            return { props: args.props, opts: args.opts };
        }
        return undefined;
    });
}
