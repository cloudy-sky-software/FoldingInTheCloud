import * as pulumi from "@pulumi/pulumi";

import * as axios from "axios";
import * as ssh2 from "ssh2";
import { ParsedKey } from "ssh2-streams";

import { SpotInstance } from "./aws/ec2";
import { execSync } from "child_process";

// Get the config ready to go.
const config = new pulumi.Config();
const publicKey = config.require("publicKey");
const privateKey = config.requireSecret("privateKey");
const privateKeyPassphrase = config.get("privateKeyPassphrase") || "";

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
pulumi.all([fahUsername, fahPassKey, fahRemoteControlPass]).apply(async ([un, pk, rcPass]) => {
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

    // Find this machine's IP as seen by the internet.
    const resp = await axios.default.get<string>("https://ipecho.net/plain");
    pulumi.log.info(`Setting FAH remote control client IP to ${resp.data}`);
    execLocal(`sed -i 's/{{AllowedIP}}/${resp.data}/g' config.xml`);
    pulumi.log.info("Updated config.xml");
});

const spotInstance = new SpotInstance("linux", {
    instanceType: "g4dn.xlarge",
    // Max per-hour spot price is $0.3612 USD.
    maxSpotPrice: "0.1578",
    privateKey,
    publicKey,
    privateKeyPassphrase,
});

export const spotRequestId = spotInstance.spotRequest?.id;
