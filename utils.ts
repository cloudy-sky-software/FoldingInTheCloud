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

export function getUserData(): string {
    const PATH = "export PATH=/usr/local/cuda-10.2/bin:${PATH}";

    return `#!/bin/bash
sudo apt-get update --yes
sudo apt-get install ec2-instance-connect --yes

echo "Preparing the instance..."
sudo apt install gcc --yes

echo "Installing NVIDIA CUDA drivers..."
# https://developer.nvidia.com/cuda-downloads?target_os=Linux&target_arch=x86_64&target_distro=Ubuntu&target_version=1804&target_type=deblocal
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu1804/x86_64/cuda-ubuntu1804.pin
sudo mv cuda-ubuntu1804.pin /etc/apt/preferences.d/cuda-repository-pin-600
wget http://developer.download.nvidia.com/compute/cuda/10.2/Prod/local_installers/cuda-repo-ubuntu1804-10-2-local-10.2.89-440.33.01_1.0-1_amd64.deb
sudo dpkg -i cuda-repo-ubuntu1804-10-2-local-10.2.89-440.33.01_1.0-1_amd64.deb
sudo apt-key add /var/cuda-repo-10-2-local-10.2.89-440.33.01/7fa2af80.pub
sudo apt-get update
sudo apt-get -y install cuda
echo "Installed CUDA drivers."

${PATH}
sudo systemctl enable nvidia-persistenced
sudo cp /lib/udev/rules.d/40-vm-hotadd.rules /etc/udev/rules.d
sed '9d' /etc/udev/rules.d/40-vm-hotadd.rules

echo "Rebooting the instance..."
sudo reboot`;
}
