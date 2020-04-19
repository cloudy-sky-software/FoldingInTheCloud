import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export async function getAwsAz(index: number): Promise<string> {
    let azs = await aws.getAvailabilityZones({
        state: "available",
    }, { async: true });
    return azs.names[index];
}

export function getDefaultTags(): { [key: string]: string } {
    return {
        project: pulumi.getProject(),
        stack: pulumi.getStack(),
    };
}

export async function getAmi(): Promise<aws.GetAmiResult> {
    const ami = await aws.getAmi({
        owners: ["099720109477"],
        mostRecent: true,
        filters: [
            {
                name: "image-id",
                // Ubuntu Server 18.04 LTS (HVM), SSD Volume Type
                values: ["ami-003634241a8fcdec0"],
            }
        ],
    }, { async: true });

    return ami;
}
