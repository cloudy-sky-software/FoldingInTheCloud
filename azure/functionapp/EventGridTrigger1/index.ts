import { AzureFunction, Context } from "@azure/functions";

import {
    BlobServiceClient
} from "@azure/storage-blob";
import * as unzipper from "unzipper";

import { copyFile, LINUX_USER_SCRIPTS_DIR, INSTANCE_USER, ConnectionArgs, runCommand } from "../../../sshUtils";

const LOCAL_SCRIPTS_PATH = "D:\\local\\Temp"

const eventGridTrigger: AzureFunction = async function (context: Context): Promise<void> {
    const eventGridEvent = context.bindings.eventGridEvent;
    context.log("event", eventGridEvent);
    const storageConnectionString = process.env["AzureWebJobsStorage"];
    if (!storageConnectionString) {
        context.done("Unable to read AzureWebJobsStorage app setting.");
        return;
    }

    const scriptsContainer = process.env["scriptsContainer"];
    if (!scriptsContainer) {
        context.done("Could not find scriptsContainer in the environment settings.");
        return;
    }
    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    const containerClient = blobServiceClient.getContainerClient(scriptsContainer);
    const inputBlob = await containerClient.getBlockBlobClient("scripts").download();
    // Connection strings are made available to functions as environment settings.
    // https://docs.microsoft.com/en-us/azure/app-service/configure-common#configure-connection-strings
    const privateKey = process.env["CUSTOMCONNSTR_sshPrivateKey"];
    if (!privateKey) {
        context.done("sshPrivateKey is missing in the environment settings.");
        return;
    }
    const instancePublicIp = process.env["instancePublicIp"];
    if (!instancePublicIp) {
        context.done("instancePublicIp is missing in the environment settings.");
        return;
    }

    const p = new Promise((resolve, reject) => {
        inputBlob.readableStreamBody!
            .pipe(unzipper.Extract({ path: LOCAL_SCRIPTS_PATH })).on("error", (err) => {
                context.log("File Stream error:", err);
                reject(err);
            }).on("close", async () => {
                context.log("Extracted blob to local path.");
                const conn: ConnectionArgs = {
                    type: "ssh",
                    host: instancePublicIp,
                    username: INSTANCE_USER,
                    privateKey,
                };
                await provisionInstance(context, conn);
                resolve();
            });
    });

    try {
        await p;
    } catch (err) {
        context.done(err);
        return;
    }

    context.done();
};

async function provisionInstance(context: Context, conn: ConnectionArgs) {
    context.log("Provisioning instance...");
    try {
        context.log("Copying files...");
        await copyFile(conn, LOCAL_SCRIPTS_PATH, LINUX_USER_SCRIPTS_DIR);
    } catch (err) {
        context.done(err);
        return;
    }

    try {
        const commands = [
            `chmod 755 ${LINUX_USER_SCRIPTS_DIR}*.sh`,
            `. ${LINUX_USER_SCRIPTS_DIR}install.sh`
        ];

        context.log("Executing commands on the instance...");
        for (const cmd of commands) {
            await runCommand(conn, cmd);
        }
    } catch (err) {
        context.done(err);
        return;
    }
}

export default eventGridTrigger;
