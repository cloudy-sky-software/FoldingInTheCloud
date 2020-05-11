import * as pulumi from "@pulumi/pulumi";

import * as ssh2 from "ssh2";
import { ParsedKey } from "ssh2-streams";

import { execSync } from "child_process";
import { registerDefaultTags } from "./tags";
import { SpotInstance } from "./spotInstance";

// Get the config ready to go.
const config = new pulumi.Config();
const privateKey = config.requireSecret("privateKey");
const privateKeyPassphrase = config.get("privateKeyPassphrase") || "";

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

const fahPassKey = config.requireSecret("fahPassKey");
const fahUsername = config.require("fahUsername");
const fahRemoteControlPass = config.requireSecret("fahRemoteControlPass");
const fahAllowedIP = config.requireSecret("fahAllowedIP");

// Transform the FAH config.xml with the stack config properties provided by the user.
pulumi.all([fahUsername, fahPassKey, fahRemoteControlPass, fahAllowedIP]).apply(async ([un, pk, rcPass, allowedIP]) => {
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
    execLocal(`sed -i 's/{{AllowedIP}}/${allowedIP}/g' config.xml`);
    pulumi.log.info("Updated config.xml");
});

const spotInstance = new SpotInstance("fah", {});
export const spotRequestId = spotInstance.spotRequestId;
export const instanceId = spotInstance.instanceId;
export const objectStorage = spotInstance.objectStorage;
