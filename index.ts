import { execSync } from "child_process";

import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import * as ssh2 from "ssh2";
import { ParsedKey } from "ssh2-streams";

import { allowedIP, fahPassKey, fahUsername, privateKey, privateKeyPassphrase } from "./config";
import { registerDefaultTags } from "./tags";
import { SpotInstance } from "./spotInstance";

// Register default tags for all taggable resources.
registerDefaultTags();

pulumi.all([privateKey, privateKeyPassphrase]).apply(([prKey, pass]) => {
    pulumi.log.info("Parsing private key...", undefined, undefined, true);
    const key = ssh2.utils.parseKey(prKey, pass) as ParsedKey;
    if (key.type !== "ssh-rsa") {
        throw new Error(`${key.type} is invalid. Private key type must be ssh-rsa.`);
    }

    pulumi.log.info("Parsed private key successfully!", undefined, undefined, true);
});

const randomPassword = new random.RandomPassword("fahRandomPassword", {
    length: 12,
    special: true,
    upper: true,
    number: true,
    lower: true,
    overrideSpecial: "!@#$%^*()",
});
export const fahRemoteControlPass = pulumi.secret(randomPassword.result);

// Transform the FAH config.xml with the stack config properties provided by the user.
pulumi.all(
    [
        fahUsername,
        fahPassKey,
        fahRemoteControlPass,
        allowedIP,
    ])
    .apply(async ([un, pk, rcPass, ip]) => {
        const execLocal = (cmd: string) => {
            execSync(cmd, {
                cwd: "./scripts",
            });
        };
        pulumi.log.info("Updating config.xml");
        execLocal("cp config.xml.template config.xml");
        execLocal(`sed -i 's/{{Username}}/${un}/g' config.xml`);
        execLocal(`sed -i 's/{{PassKey}}/${pk}/g' config.xml`);
        execLocal(`sed -i 's/{{RemoteControlPass}}/${rcPass}/g' config.xml`);
        execLocal(`sed -i 's/{{AllowedIP}}/${ip}/g' config.xml`);
        pulumi.log.info("Updated config.xml");
    });

const spotInstance = new SpotInstance("fah", {
    // To allow the FAHControl client running on a specific to be able to connect to and
    // control the FAHClient on the remote EC2 instance.
    exposedPorts: [36330],
});
export const spotRequestId = spotInstance.spotRequestId;
export const instanceId = spotInstance.instanceId;
export const objectStorage = spotInstance.objectStorage;
