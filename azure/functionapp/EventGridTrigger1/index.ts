import { AzureFunction, Context } from "@azure/functions";
import * as unzipper from "unzipper";

import { LOCAL_SCRIPTS_PATH, copyFile, LINUX_USER_SCRIPTS_DIR, INSTANCE_USER, ConnectionArgs, runCommand } from "../../../sshUtils";
import { Readable } from "stream";

const eventGridTrigger: AzureFunction = async function (context: Context): Promise<void> {
    const eventGridEvent = context.bindings.eventGridEvent;
    context.log(eventGridEvent);
    const inputBlob = context.bindings.inputBlob;
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
        Readable
            .from(inputBlob)
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
