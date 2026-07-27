import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, callbackResult, checkLogin, DockgeSocket } from "../util-server";
import { LooseObject } from "../../common/util-common";
import { AgentCredentials } from "../agent-manager";
import { MAX_AGENT_SERVICE_TOKEN_BYTES, MIN_AGENT_SERVICE_TOKEN_BYTES } from "../agent-service-token";
import { ValidationError } from "../validation-error";

interface AgentRequest {
    url: string;
    name: string;
    credentials: AgentCredentials;
}

function parseAgentRequest(requestData: unknown): AgentRequest {
    if (!requestData || typeof requestData !== "object" || Array.isArray(requestData)) {
        throw new ValidationError("Agent data must be an object.");
    }

    const data = requestData as LooseObject;
    if (typeof data.url !== "string" || data.url.length === 0 || data.url.length > 2048) {
        throw new ValidationError("Agent URL must be a non-empty URL.");
    }

    try {
        const url = new URL(data.url);
        if (!url.host || (url.protocol !== "http:" && url.protocol !== "https:")) {
            throw new Error("unsupported protocol");
        }
    } catch {
        throw new ValidationError("Agent URL must use http or https and include a host.");
    }

    if (data.name !== undefined && (typeof data.name !== "string" || data.name.length > 255)) {
        throw new ValidationError("Agent friendly name must be at most 255 characters.");
    }

    const name = data.name ?? "";
    const authMode = data.authMode === undefined ? "password" : data.authMode;
    if (authMode === "password") {
        if (typeof data.username !== "string" || data.username.length === 0 || data.username.length > 255) {
            throw new ValidationError("Agent username must be between 1 and 255 characters.");
        }
        if (typeof data.password !== "string" || data.password.length === 0 || data.password.length > 255) {
            throw new ValidationError("Agent password must be between 1 and 255 characters.");
        }
        return {
            url: data.url,
            name,
            credentials: {
                authMode,
                username: data.username,
                password: data.password,
            },
        };
    }

    if (authMode === "token") {
        const tokenBytes = typeof data.token === "string" ? Buffer.byteLength(data.token, "utf8") : 0;
        if (typeof data.token !== "string" || tokenBytes < MIN_AGENT_SERVICE_TOKEN_BYTES || tokenBytes > MAX_AGENT_SERVICE_TOKEN_BYTES) {
            throw new ValidationError(`Agent service token must be between ${MIN_AGENT_SERVICE_TOKEN_BYTES} and ${MAX_AGENT_SERVICE_TOKEN_BYTES} bytes.`);
        }
        return {
            url: data.url,
            name,
            credentials: {
                authMode,
                token: data.token,
            },
        };
    }

    throw new ValidationError("Agent authentication mode must be password or token.");
}

export class ManageAgentSocketHandler extends SocketHandler {

    create(socket : DockgeSocket, server : DockgeServer) {
        // addAgent
        socket.on("addAgent", async (requestData : unknown, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "addAgent");
                checkLogin(socket);

                const data = parseAgentRequest(requestData);
                let manager = socket.instanceManager;
                await manager.test(data.url, data.credentials);
                await manager.add(data.url, data.credentials, data.name);

                // connect to the agent
                manager.connect(data.url, data.credentials);

                // Refresh another sockets
                // It is a bit difficult to control another browser sessions to connect/disconnect agents, so force them to refresh the page will be easier.
                server.disconnectAllSocketClients(undefined, socket.id);
                manager.sendAgentList();

                callbackResult({
                    ok: true,
                    msg: "agentAddedSuccessfully",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // removeAgent
        socket.on("removeAgent", async (url : unknown, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "removeAgent");
                checkLogin(socket);

                if (typeof(url) !== "string") {
                    throw new Error("URL must be a string");
                }

                let manager = socket.instanceManager;
                await manager.remove(url);

                server.disconnectAllSocketClients(undefined, socket.id);
                manager.sendAgentList();

                callbackResult({
                    ok: true,
                    msg: "agentRemovedSuccessfully",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateAgent
        socket.on("updateAgent", async (name : string, updatedName : string, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "updateAgent");
                checkLogin(socket);

                let manager = socket.instanceManager;
                await manager.update(name, updatedName);

                server.disconnectAllSocketClients(undefined, socket.id);
                manager.sendAgentList();

                callbackResult({
                    ok: true,
                    msg: "agentUpdatedSuccessfully",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
