import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { checkAgentProxyLogin, DockgeSocket } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import { ALL_ENDPOINTS } from "../../common/util-common";

export class AgentProxySocketHandler extends SocketHandler {

    create2(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Agent - proxying requests if needed
        socket.on("agent", async (endpoint : unknown, eventName : unknown, ...args : unknown[]) => {
            try {
                // Check Type
                if (typeof(endpoint) !== "string") {
                    throw new Error("Endpoint must be a string: " + endpoint);
                }
                if (typeof(eventName) !== "string") {
                    throw new Error("Event name must be a string");
                }

                checkAgentProxyLogin(socket, endpoint);

                // Service-token authentication grants a capability for this
                // one endpoint's AgentSocket handlers only. Keep the marker
                // scoped to the awaited dispatch so ordinary handlers never
                // observe an authenticated user session.
                if (socket.agentEndpoint) {
                    socket.agentProxyEndpoint = endpoint;
                    try {
                        await agentSocket.call(eventName, ...args);
                    } finally {
                        delete socket.agentProxyEndpoint;
                    }
                    return;
                }

                if (endpoint === ALL_ENDPOINTS) {      // Send to all endpoints
                    log.debug("agent", "Sending to all endpoints: " + eventName);
                    socket.instanceManager.emitToAllEndpoints(eventName, ...args);

                } else if (!endpoint || endpoint === socket.endpoint) {      // Direct connection or matching endpoint
                    log.debug("agent", "Matched endpoint: " + eventName);
                    await agentSocket.call(eventName, ...args);

                } else {
                    log.debug("agent", "Proxying request to " + endpoint + " for " + eventName);
                    await socket.instanceManager.emitToEndpoint(endpoint, eventName, ...args);
                }
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("agent", e.message);
                }
            }
        });
    }

    create(socket : DockgeSocket, server : DockgeServer) {
        throw new Error("Method not implemented. Please use create2 instead.");
    }
}
