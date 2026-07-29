import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import { createRequire } from "node:module";
import type * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { spawn } from "node:child_process";
import { LimitQueue } from "./utils/limit-queue";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { sync as commandExistsSync } from "command-exists";
import { log } from "./log";
import { commandEnvironment } from "./container-engine/container-engine";
import type { EngineCommand } from "./container-engine/types";
import type { PodmanLogContainer } from "./container-engine/output-parser";

const require = createRequire(import.meta.url);
let ptyModule : typeof pty | undefined;

function loadPty() : typeof pty {
    ptyModule ??= require("@homebridge/node-pty-prebuilt-multiarch") as typeof pty;
    return ptyModule;
}

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected envDefaults? : Readonly<Record<string, string>>;
    protected env? : Readonly<Record<string, string>>;
    protected callback? : (exitCode : number) => void;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};
    private hasExited : boolean = false;

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string, envDefaults?: Readonly<Record<string, string>>, env?: Readonly<Record<string, string>>) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;
        this.envDefaults = envDefaults;
        this.env = env;

        Terminal.terminalMap.set(this.name, this);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            this._ptyProcess = loadPty().spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: TERMINAL_COLS,
                rows: this.rows,
                ...(this.envDefaults === undefined && this.env === undefined ? {} : {
                    env: {
                        ...this.envDefaults,
                        ...process.env,
                        ...this.env,
                    },
                }),
            });

            // On Data
            this._ptyProcess.onData(this.writeData);

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);
                const exitCode = Number(error.message.split(" ").pop());
                this.exit({
                    exitCode,
                });
            }
        }
    }

    /** Add bounded output and broadcast it to every current terminal client. */
    protected writeData = (data: string) => {
        this.buffer.pushItem(data);

        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalWrite", this.name, data);
        }
    };

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        if (this.hasExited) {
            return;
        }
        this.hasExited = true;

        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        Terminal.terminalMap.delete(this.name);
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        if (this.callback) {
            this.callback(res.exitCode);
        }
    };

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    public join(socket : DockgeSocket) {
        this.socketList[socket.id] = socket;
    }

    public leave(socket : DockgeSocket) {
        delete this.socketList[socket.id];
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    close() {
        clearInterval(this.keepAliveInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
    }

    /**
     * Get a running and non-exited terminal
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string, envDefaults?: Readonly<Record<string, string>>, env?: Readonly<Record<string, string>>) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd, envDefaults, env);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string, envDefaults?: Readonly<Record<string, string>>, env?: Readonly<Record<string, string>>) : Promise<number> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.terminalMap.has(terminalName)) {
                reject("Another operation is already running, please try again later.");
                return;
            }

            let terminal = new Terminal(server, terminalName, file, args, cwd, envDefaults, env);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                resolve(exitCode);
            });
            terminal.start();
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }
}

export interface PodmanLogFollower {
    readonly container: PodmanLogContainer;
    readonly command: EngineCommand;
}

export interface PodmanLogChild {
    readonly stdout?: PodmanLogStream;
    readonly stderr?: PodmanLogStream;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
}

export interface PodmanLogStream {
    on(event: "data", listener: (data: Buffer | string) => void): unknown;
}

export type PodmanLogSpawner = (
    file: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
) => PodmanLogChild;

const defaultPodmanLogSpawner: PodmanLogSpawner = (file, args, options) => {
    return spawn(file, [ ...args ], {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        shell: false,
        stdio: [ "ignore", "pipe", "pipe" ],
    });
};

/** A readable source label that distinguishes scaled-service followers. */
export function describePodmanLogSource(container: PodmanLogContainer): string {
    if (container.service && container.name) {
        return `${container.service}/${container.name}`;
    }
    return container.service ?? container.name ?? container.id.slice(0, 12);
}

/**
 * Merge one remote-Podman log follower per project container into Dockge's
 * existing terminal socket and bounded buffer. `podman logs` accepts one
 * remote container at a time, unlike podman-compose's multi-container path.
 */
export class PodmanCombinedLogsTerminal extends Terminal {
    private readonly followers: readonly PodmanLogFollower[];
    private readonly spawner: PodmanLogSpawner;
    private readonly children = new Set<PodmanLogChild>();
    private started : boolean = false;
    private stopping : boolean = false;
    private pendingFollowers : number = 0;
    private exitCode : number = 0;

    constructor(
        server: DockgeServer,
        name: string,
        cwd: string,
        followers: readonly PodmanLogFollower[],
        spawner: PodmanLogSpawner = defaultPodmanLogSpawner,
    ) {
        super(server, name, "", [], cwd);
        this.followers = followers;
        this.spawner = spawner;
    }

    public override start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.startMaintenance();

        if (this.followers.length === 0) {
            this.writeData("No containers found for this Compose project.\r\n");
            this.exit({ exitCode: 0 });
            return;
        }

        this.pendingFollowers = this.followers.length;
        for (const follower of this.followers) {
            this.startFollower(follower);
        }
    }

    public override close() {
        if (this.stopping) {
            return;
        }
        this.stopping = true;
        clearInterval(this.keepAliveInterval);

        for (const child of this.children) {
            child.kill("SIGTERM");
        }
        this.finishIfDone();
    }

    private startMaintenance() {
        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            this.keepAliveInterval = setInterval(() => {
                if (Object.keys(this.socketList).length === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                }
            }, 60 * 1000);
        }
    }

    private startFollower(follower: PodmanLogFollower) {
        const write = this.createPrefixedWriter(describePodmanLogSource(follower.container));
        let settled = false;
        let child : PodmanLogChild | undefined;
        const settle = (code: number | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (child) {
                this.children.delete(child);
            }
            if (!this.stopping && code !== null && code !== 0 && this.exitCode === 0) {
                this.exitCode = code;
            }
            this.pendingFollowers--;
            this.finishIfDone();
        };

        try {
            const env = commandEnvironment(follower.command);
            child = this.spawner(follower.command.file, follower.command.args, {
                cwd: this.cwd,
                ...(env === undefined ? {} : { env }),
            });
            this.children.add(child);
            child.stdout?.on("data", (data: Buffer | string) => write(data.toString()));
            child.stderr?.on("data", (data: Buffer | string) => write(data.toString()));
            child.once("error", () => {
                write("Log follower failed to start.\r\n");
                settle(1);
            });
            child.once("close", (code) => settle(code));
        } catch (error) {
            log.error("PodmanCombinedLogsTerminal", error);
            write("Log follower failed to start.\r\n");
            settle(1);
        }
    }

    private createPrefixedWriter(source: string): (data: string) => void {
        const prefix = `${source} | `;
        let atLineStart = true;

        return (data: string) => {
            let formatted = "";
            for (const line of data.split(/(?<=\n)/)) {
                if (!line) {
                    continue;
                }
                if (atLineStart) {
                    formatted += prefix;
                }
                formatted += line;
                atLineStart = line.endsWith("\n");
            }
            if (formatted) {
                this.writeData(formatted);
            }
        };
    }

    private finishIfDone() {
        if (this.pendingFollowers === 0) {
            this.exit({ exitCode: this.stopping ? 0 : this.exitCode });
        }
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    constructor(server : DockgeServer, name : string) {
        let shell;

        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir);
    }

    public write(input : string) {
        super.write(input);
    }
}
