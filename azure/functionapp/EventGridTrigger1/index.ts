import { AzureFunction, Context } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";

import * as unzipper from "unzipper";

import {
    copyFile,
    LINUX_USER_SCRIPTS_DIR,
    INSTANCE_USER,
    ConnectionArgs,
    runCommand,
} from "../../../sshUtils";

// https://github.com/projectkudu/kudu/wiki/Understanding-the-Azure-App-Service-file-system#temporary-files
const LOCAL_SCRIPTS_PATH = "D:\\local\\Temp";

const eventGridTrigger: AzureFunction = async function (context: Context): Promise<void> {
    const eventGridEvent = context.bindings.eventGridEvent;
    context.log("event", eventGridEvent);
    const storageConnectionString = process.env["AzureWebJobsStorage"];
    if (!storageConnectionString) {
        throw new Error("Unable to read AzureWebJobsStorage app setting.");
    }

    const scriptsContainer = process.env["scriptsContainer"];
    if (!scriptsContainer) {
        throw new Error("Could not find scriptsContainer in the environment settings.");
    }
    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    const containerClient = blobServiceClient.getContainerClient(scriptsContainer);
    const inputBlob = await containerClient.getBlockBlobClient("scripts").download();
    // Connection strings are made available to functions as environment settings.
    // https://docs.microsoft.com/en-us/azure/app-service/configure-common#configure-connection-strings
    const privateKey = process.env["CUSTOMCONNSTR_sshPrivateKey"];
    if (!privateKey) {
        throw new Error("sshPrivateKey is missing in the environment settings.");
    }
    const instancePublicIp = process.env["instancePublicIp"];
    if (!instancePublicIp) {
        throw new Error("instancePublicIp is missing in the environment settings.");
    }
    if (!inputBlob.readableStreamBody) {
        throw new Error("Response body stream is undefined.");
    }

    const p = new Promise<void>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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

    await p;
};

async function provisionInstance(context: Context, conn: ConnectionArgs) {
    context.log("Provisioning instance...");
    context.log("Copying files...");
    await copyFile(conn, LOCAL_SCRIPTS_PATH, LINUX_USER_SCRIPTS_DIR);

    const commands = [
        `chmod 755 ${LINUX_USER_SCRIPTS_DIR}*.sh`,
        `. ${LINUX_USER_SCRIPTS_DIR}install.sh`,
    ];

    context.log("Executing commands on the instance...");
    for (const cmd of commands) {
        await runCommand(conn, cmd);
    }
}

export default eventGridTrigger;
