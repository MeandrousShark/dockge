import { Socket } from "socket.io";
import { Terminal } from "./terminal";
import { randomBytes } from "crypto";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import { R } from "redbean-node";
import { verifyPassword } from "./password-hash";
import fs from "fs";
import { AgentManager } from "./agent-manager";
import { ValidationError } from "./validation-error";
import { isAuthorizedAgentProxyRequest } from "./agent-service-token";

export { ValidationError } from "./validation-error";

export interface JWTDecoded {
    username : string;
    h? : string;
}

export interface DockgeSocket extends Socket {
    userID: number;
    /**
     * Set only after a successful scoped agent service-token login. It is
     * intentionally distinct from userID so the socket never gains a user
     * session or access to ordinary authenticated handlers.
     */
    agentEndpoint?: string;
    /** Set only while AgentProxy invokes an agent handler for a token socket. */
    agentProxyEndpoint?: string;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    emitAgent : (eventName : string, ...args : unknown[]) => void;
}

// For command line arguments, so they are nullable
export interface Arguments {
    sslKey? : string;
    sslCert? : string;
    sslKeyPassphrase? : string;
    port? : number;
    hostname? : string;
    dataDir? : string;
    stacksDir? : string;
    enableConsole? : boolean;
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;
}

export function checkLogin(socket : DockgeSocket) {
    if (socket.userID) {
        return;
    }

    // A service-token socket receives this temporary marker only from
    // AgentProxy while it invokes a registered agent handler. It does not make
    // regular socket handlers authenticated.
    if (socket.agentEndpoint && socket.agentProxyEndpoint === socket.agentEndpoint) {
        return;
    }

    throw new Error("You are not logged in.");
}

export function checkAgentProxyLogin(socket : DockgeSocket, endpoint: string) {
    if (isAuthorizedAgentProxyRequest(socket.userID, socket.agentEndpoint, endpoint)) {
        return;
    }

    throw new Error("You are not authorized to use the agent proxy.");
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    if (error instanceof Error) {
        callback({
            ok: false,
            msg: error.message,
            msgi18n: true,
        });
    } else if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: error.message,
            msgi18n: true,
        });
    } else {
        log.debug("console", "Unknown error: " + error);
    }
}

export function callbackResult(result : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

export async function doubleCheckPassword(socket : DockgeSocket, currentPassword : unknown) {
    if (typeof currentPassword !== "string") {
        throw new Error("Wrong data type?");
    }

    let user = await R.findOne("user", " id = ? AND active = 1 ", [
        socket.userID,
    ]);

    if (!user || !verifyPassword(currentPassword, user.password)) {
        throw new Error("Incorrect current password");
    }

    return user;
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}
