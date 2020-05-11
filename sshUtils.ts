import * as ssh2 from "ssh2";
import * as path from "path";

/**
 * The user name to use when connecting to the instance.
 */
export const INSTANCE_USER = "ubuntu";
/**
 * The path on the instance where the scripts should be copied.
 */
export const LINUX_USER_SCRIPTS_DIR = `/home/${INSTANCE_USER}/`;

/**
 * ConnectionArgs tells a provisioner how to access a remote resource.
 * For example, it may need to use SSH or WinRM to connect to the
 * resource in order to run a command or copy a file.
 */
export interface ConnectionArgs {
    type?: ConnectionType;
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string;
    privateKeyPassphrase?: string;
}

/**
 * ConnectionType is the set of legal connection mechanisms to use.
 * Default is `ssh`.
 */
export type ConnectionType = "ssh" | "winrm";

function connTypeOrDefault(conn: ConnectionArgs): ConnectionType {
    return conn.type || "ssh";
}

function connPortOrDefault(conn: ConnectionArgs): number {
    if (conn.port !== undefined) {
        return conn.port;
    }

    const connType = connTypeOrDefault(conn);
    switch (connType) {
        case "ssh":
            return 22;
        case "winrm":
            return 5985;
        default:
            throw new Error(`unrecognized connectiont ype ${connType}`);
    }
}

function connUsernameOrDefault(conn: ConnectionArgs): string {
    if (conn.username) {
        return conn.username;
    }

    const connType = connTypeOrDefault(conn);
    switch (connType) {
        case "ssh":
            return "root";
        case "winrm":
            return "Administrator";
        default:
            throw new Error(`unrecognized connectiont ype ${connType}`);
    }
}

function connToSsh2(conn: ConnectionArgs): any {
    return {
        host: conn.host,
        port: conn.port,
        username: connUsernameOrDefault(conn),
        password: conn.password,
        privateKey: conn.privateKey,
        passphrase: conn.privateKeyPassphrase,
    };
}

export async function copyFile(conn: ConnectionArgs, src: string, dest: string): Promise<void> {
    const connType = connTypeOrDefault(conn);
    if (connType !== "ssh") {
        throw new Error("only SSH connection types currently supported");
    }

    const scp2 = require("scp2");
    const mkdirPromise = new Promise((resolve, reject) => {
        scp2.defaults({ ...connToSsh2(conn) });
        scp2.mkdir(path.dirname(dest), (err: any) => {
            if (!err) {
                resolve();
                return;
            }
            console.error("Error running mkdir", err);
            reject(err);
        });
    });
    let connectionFailCount = 0;
    return mkdirPromise.then(() => {
        return new Promise((resolve, reject) => {
            function scp() {
                scp2.scp(
                    src,
                    { path: dest, ...connToSsh2(conn) },
                    (err: any) => {
                        if (err) {
                            connectionFailCount++;
                            if (connectionFailCount > 10) {
                                reject(err);
                            } else {
                                setTimeout(scp, connectionFailCount * 500);
                            }
                            return;
                        }
                        resolve();
                    },
                );
            }
            scp();
        });
    });
}

export async function runCommand(conn: ConnectionArgs, cmd: string): Promise<string> {
    const connType = connTypeOrDefault(conn);
    if (connType !== "ssh") {
        throw new Error("only SSH connection types currently supported");
    }

    const sshConn = connToSsh2(conn);
    let connectionFailCount = 0;
    return new Promise((resolve, reject) => {
        const conn = new ssh2.Client();
        function connect() {
            conn.on("ready", () => {
                conn.exec(cmd, (err: any, stream: any) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    stream.on("close", (code: string, signal: string) => {
                        conn.end();
                        if (code) {
                            reject(new Error("Command exited with " + code));
                        } else {
                            resolve();
                        }
                    }).on("data", (data: any) => {
                        console.log(data.toString("utf8"));
                    }).stderr.on("data", (data: any) => {
                        console.log(data.toString("utf8"));
                    });
                });
            }).on("error", (err: any) => {
                connectionFailCount++;
                if (connectionFailCount > 10) {
                    reject(err);
                } else {
                    setTimeout(connect, connectionFailCount * 500);
                }
            }).connect(sshConn);
        }
        connect();
    });
}

export interface CopyFileArgs {
    // conn contains information on how to connect to the destination, in addition to dependency information.
    conn: ConnectionArgs;
    // src is the source of the file or directory to copy. It can be specified as relative to the current
    // working directory or as an absolute path. This cannot be specified if content is set.
    src: string;
    // // content is the in-memory content to copy to the destination. If the destination is a file, the content
    // // will be written on that file, whereas if it's a directory, a file named `pulumi-content` is created.
    // content?: pulumi.Input<string>;
    // dest is required and specifies the absolute path on the target where the file will be copied to.
    dest: string;
}

export interface RemoteExecArgs {
    conn: ConnectionArgs;
    command?: string;
    commands?: string[];
}

