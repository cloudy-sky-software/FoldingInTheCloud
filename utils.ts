import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export async function getAwsAz(index: number): Promise<string> {
    const azs = await aws.getAvailabilityZones({
        state: "available",
    });
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
                name: "name",
                values: ["ubuntu/images/hvm-ssd/ubuntu-bionic-18.04-amd64-server-20200408"]
            }
        ],
    });

    return ami;
}

/**
 * Calculates a hash for all of the files under the scripts directory.
 */
async function getScriptsHash(): Promise<string> {
    const p = new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash("md5");
        fs.readdir(path.join(__dirname, "scripts"), { encoding: "utf8" }, (err, files) => {
            if (err) {
                reject(err);
                return;
            }

            files.forEach(f => {
                const data = fs.readFileSync(path.join(__dirname, "scripts", f), { encoding: "utf8" });
                hash.update(data, "utf8");
            });

            resolve(hash.digest("hex"));
        });
    });
    return p;
}
