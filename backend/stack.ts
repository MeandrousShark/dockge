import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    acceptedComposeOverrideFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    PROGRESS_TERMINAL_ROWS,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { getStackComposeOptions } from "./stack-compose-operations";
import type { StackComposeOperation } from "./stack-compose-operations";
import { commandEnvironment } from "./container-engine/container-engine";
import type { EngineCommand } from "./container-engine/types";
import {
    resolveStackPath,
    validateExistingStackPath,
    validateStackFile,
    validateStackName,
} from "./stack-filesystem";
import { ValidationError } from "./validation-error";
import {
    ContainerPsOutput,
    parseComposeListOutput,
    parseComposePsOutput,
    parseContainerPsOutput,
    parsePodmanComposeListOutput,
} from "./container-engine/output-parser";

function engineSpawnOptions(command: EngineCommand): { env?: NodeJS.ProcessEnv } {
    const env = commandEnvironment(command);
    return env === undefined ? {} : { env };
}

// For getSingleComposeStatus and general compose stack objects
export interface ComposeStack {
    Name: string;
    Status: string;
    ConfigFiles?: string;
    [key: string]: unknown; // Allows for other dynamic properties
}

// For docker ps --format json output
export type DockerContainerStatus = ContainerPsOutput;

export interface DeleteOptions {
    deleteStackFiles: boolean
}

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _composeOverrideYAML?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected _composeOverrideFileName: string = "compose.override.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, composeOverrideYAML? : string, skipFSOperations = false) {
        validateStackName(name);
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;
        this._composeOverrideYAML = composeOverrideYAML;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (validateStackFile(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }

            // Check if override file exists and determine its name
            for (const filename of acceptedComposeOverrideFileNames) {
                if (validateStackFile(path.join(this.path, filename))) {
                    this._composeOverrideFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            composeOverrideYAML: this.composeOverrideYAML,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            composeOverrideFileName: this._composeOverrideFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        const command = this.getComposeCommandFor("stack-ps");
        let res = await childProcessAsync.spawn(command.file, [ ...command.args ], {
            cwd: this.path,
            encoding: "utf-8",
            ...engineSpawnOptions(command),
        });
        if (!res.stdout) {
            return {};
        }
        return parseComposePsOutput(res.stdout.toString());
    }

    get isManagedByDockge() : boolean {
        if (!fs.existsSync(this.path)) {
            return false;
        }

        const stat = fs.lstatSync(this.path);
        return !stat.isSymbolicLink() && stat.isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        validateStackName(this.name);

        // Check YAML format
        yaml.parse(this.composeYAML);

        // Check override YAML format if it exists
        if (this.composeOverrideYAML && this.composeOverrideYAML.trim() !== "") {
            yaml.parse(this.composeOverrideYAML);
        }

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            const composePath = path.join(this.path, this._composeFileName);
            if (validateStackFile(composePath)) {
                this._composeYAML = fs.readFileSync(composePath, "utf-8");
            } else {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            const envPath = path.join(this.path, ".env");
            if (validateStackFile(envPath)) {
                this._composeENV = fs.readFileSync(envPath, "utf-8");
            } else {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get composeOverrideYAML() : string {
        if (this._composeOverrideYAML === undefined) {
            const overridePath = path.join(this.path, this._composeOverrideFileName);
            if (validateStackFile(overridePath)) {
                this._composeOverrideYAML = fs.readFileSync(overridePath, "utf-8");
            } else {
                this._composeOverrideYAML = "";
            }
        }
        return this._composeOverrideYAML;
    }

    // Expose the chosen override file name to any server-side consumer if needed
    get composeOverrideFileName() : string {
        return this._composeOverrideFileName;
    }

    get path() : string {
        return resolveStackPath(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
            await validateExistingStackPath(this.server.stacksDir, dir);
        }

        // Write or overwrite the compose.yaml
        const composePath = path.join(dir, this._composeFileName);
        validateStackFile(composePath);
        await fsAsync.writeFile(composePath, this.composeYAML);

        const envPath = path.join(dir, ".env");

        // Write or overwrite the .env
        // If .env is not existing and the composeENV is empty, we don't need to write it
        if (validateStackFile(envPath) || this.composeENV.trim() !== "") {
            await fsAsync.writeFile(envPath, this.composeENV);
        }

        const overridePath = path.join(dir, this._composeOverrideFileName);

        // Write or overwrite the compose override file
        // If override file is not existing and the composeOverrideYAML is empty, we don't need to write it
        if (validateStackFile(overridePath) || this.composeOverrideYAML.trim() !== "") {
            await fsAsync.writeFile(overridePath, this.composeOverrideYAML);
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("deploy");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async delete(socket: DockgeSocket, options: DeleteOptions) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("delete");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error(`Failed to delete ${this.name}, please check the terminal output for more information.`);
        }

        if (options.deleteStackFiles) {
            // Remove the stack folder
            await fsAsync.rm(this.path, {
                recursive: true,
                force: true
            });
        }

        return exitCode;
    }

    async forceDelete(socket: DockgeSocket): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("force-delete");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList(this.server);
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = resolveStackPath(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (validateStackFile(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.lstat(path.join(stacksDir, filename));
                    if (stat.isSymbolicLink() || !stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        const composeList = await this.getComposeList(server);

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            stack._status = await this.statusConvert(server, composeStack);
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList(server: DockgeServer) : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        const composeList = await this.getComposeList(server);

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, await this.statusConvert(server, composeStack));
        }

        return statusList;
    }

    /**
     * Docker lists Compose projects through `compose ls`; Podman lists the
     * labelled containers directly because podman-compose 1.3.0 has no `ls`.
     * A failed inventory must not reject the periodic agent status poll.
     */
    private static async getComposeList(server: DockgeServer): Promise<ComposeStack[]> {
        try {
            const command = server.containerEngine.composeList();
            const res = await childProcessAsync.spawn(command.file, [ ...command.args ], {
                encoding: "utf-8",
                ...engineSpawnOptions(command),
            });

            if (!res.stdout) {
                return [];
            }

            const stdout = res.stdout.toString();
            return server.containerEngine.kind === "podman"
                ? parsePodmanComposeListOutput(stdout)
                : parseComposeListOutput(stdout);
        } catch (error) {
            const message = error instanceof Error ? error.message : "unknown error";
            log.warn("getComposeList", `Failed to get Compose project list: ${message}`);
            return [];
        }
    }

    /**
     * Get the detailed status of a single compose stack, listing every container in the stack
     */

    static async getSingleComposeStatus(server: DockgeServer, composeName : string) : Promise<DockerContainerStatus[] | null> {
        const command = server.containerEngine.containerStatus(composeName);
        let res = await childProcessAsync.spawn(command.file, [ ...command.args ], {
            encoding: "utf-8",
            ...engineSpawnOptions(command),
        });

        if (!res.stdout) {
            return null;
        }

        const statusList = parseContainerPsOutput(res.stdout.toString());
        return statusList.length > 0 ? statusList : null;
    }

    /**
     * Check if the compose stack is exited cleanly
     * First, we need to get the number of containers that are in the exited state
     * Then read all the containers and check if they are exited with status 0 (OK) or something else (Not OK)
     */

    static async isComposeExitClean(server: DockgeServer, composeStack : ComposeStack) : Promise<number> {
        // Safer parsing with regex to avoid crashes on unexpected status strings
        const match = composeStack.Status.match(/\((\d+)\)/);
        const expectedContainersExited = match ? parseInt(match[1]) : 0;

        let cleanlyExitedContainerCount = 0;
        const composeStatus = await this.getSingleComposeStatus(server, composeStack.Name);

        if (!composeStatus) {
            return EXITED;
        }

        const statusArray = Array.isArray(composeStatus) ? composeStatus : [ composeStatus ];

        for (const containerStatus of statusArray) {
            const status = containerStatus.Status.toLowerCase(); // case-insensitive
            if (status.includes("exited")) {
                if (status.includes("exited (0)")) {
                    cleanlyExitedContainerCount++;
                } else {
                    return EXITED; // Non-zero exit code found
                }
            }
        }
        return (cleanlyExitedContainerCount === expectedContainersExited) ? RUNNING : EXITED;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static async statusConvert(server: DockgeServer, composeStack : ComposeStack) : Promise<number> {
        if (composeStack.Status.startsWith("created")) {
            return CREATED_STACK;
        } else if (composeStack.Status.includes("exited")) {
            return await this.isComposeExitClean(server, composeStack);
        } else if (composeStack.Status.startsWith("running")) {
            // If there is no exited services, there should be only running services
            return RUNNING;
        } else {
            return UNKNOWN;
        }
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = resolveStackPath(server.stacksDir, stackName);

        if (await fileExists(dir)) {
            await validateExistingStackPath(server.stacksDir, dir);
        }

        if (!skipFSOperations) {
            if (!await fileExists(dir)) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    getComposeCommandFor(operation: StackComposeOperation, ...operationArguments: string[]) {
        const hasGlobalEnv = validateStackFile(path.join(this.server.stacksDir, "global.env"));
        const hasLocalEnv = validateStackFile(path.join(this.path, ".env"));
        const options = getStackComposeOptions(operation, operationArguments, hasGlobalEnv, hasLocalEnv);
        return this.server.containerEngine.composeCommand(options);
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("start");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("stop");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("restart");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("down");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let command = this.getComposeCommandFor("update-pull");
        let exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return exitCode;
        }

        command = this.getComposeCommandFor("update-redeploy");
        exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }

        return exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("combined-logs");
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, command.file, [ ...command.args ], this.path, command.env);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            const command = this.getComposeCommandFor("container-exec", serviceName, shell);
            terminal = new InteractiveTerminal(this.server, terminalName, command.file, [ ...command.args ], this.path, command.env);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList() {
        let statusList = new Map<string, Array<object>>();

        try {
            const command = this.getComposeCommandFor("service-status");
            let res = await childProcessAsync.spawn(command.file, [ ...command.args ], {
                cwd: this.path,
                encoding: "utf-8",
                ...engineSpawnOptions(command),
            });

            if (!res.stdout) {
                return statusList;
            }

            const addLine = (obj: { Service: string, State: string, Name: string, Health?: string }) => {
                if (!statusList.has(obj.Service)) {
                    statusList.set(obj.Service, []);
                }
                statusList.get(obj.Service)?.push({
                    status: obj.Health || obj.State,
                    name: obj.Name
                });
            };

            for (const serviceStatus of parseComposePsOutput(res.stdout.toString())) {
                addLine(serviceStatus);
            }

            return statusList;
        } catch (e) {
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("start-service", serviceName);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("stop-service", serviceName);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const command = this.getComposeCommandFor("restart-service", serviceName);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, command.file, [ ...command.args ], this.path, command.env);
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }
}
