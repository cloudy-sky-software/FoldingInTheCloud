import { Config } from "@pulumi/pulumi";

const config = new Config();

export const cloudProvider = config.get("cloudProvider") || "aws";

/**
 * The max price (per hour) in USD you are willing to pay for the instance.
 */
export const maxBidPrice = config.requireNumber("maxBidPrice");
export const instanceType = config.require("instanceType");

export const allowedIP = config.requireSecret("allowedIP");

export const publicKey = config.require("publicKey");
export const privateKey = config.requireSecret("privateKey");
export const privateKeyPassphrase = config.get("privateKeyPassphrase") || "";

export const fahPassKey = config.requireSecret("fahPassKey");
export const fahUsername = config.require("fahUsername");

