import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_AGENT_SERVICE_TOKEN_BYTES = 32;
export const MAX_AGENT_SERVICE_TOKEN_BYTES = 512;
const ALL_ENDPOINTS = "##ALL_DOCKGE_ENDPOINTS##";

export interface AgentServiceTokenConfig {
    endpoint: string;
    digest: Buffer;
}

export interface AgentServiceTokenPolicy {
    agentOnly: boolean;
    config?: AgentServiceTokenConfig;
}

export function isAgentOnlyMode(env: NodeJS.ProcessEnv = process.env) {
    return env.DOCKGE_AGENT_ONLY === "true";
}

export function isAllowedAgentOnlyEvent(event: unknown) {
    return event === "login" || event === "agent";
}

function isEndpointID(value: string) {
    if (value.length === 0 || value.length > 255 || value.trim() !== value || /[\r\n]/.test(value) || value === ALL_ENDPOINTS) {
        return false;
    }

    try {
        // AgentManager sends URL.host as the endpoint header. Requiring the
        // same canonical value prevents a separate logical ID from drifting
        // away from the route the central instance actually sends.
        return new URL("http://" + value).host === value;
    } catch {
        return false;
    }
}

/**
 * Reads the endpoint-only service-token configuration. Both values are required
 * so a partially configured endpoint never silently accepts token logins.
 */
export function parseAgentServiceTokenConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceTokenConfig | undefined {
    const endpoint = env.DOCKGE_AGENT_ENDPOINT_ID;
    const digest = env.DOCKGE_AGENT_TOKEN_SHA256;

    if (!endpoint || !digest) {
        return undefined;
    }

    if (!isEndpointID(endpoint)) {
        return undefined;
    }

    if (!/^[a-fA-F0-9]{64}$/.test(digest)) {
        return undefined;
    }

    return {
        endpoint,
        digest: Buffer.from(digest, "hex"),
    };
}

export function parseAgentServiceTokenPolicy(env: NodeJS.ProcessEnv = process.env): AgentServiceTokenPolicy {
    const agentOnly = isAgentOnlyMode(env);
    const config = parseAgentServiceTokenConfig(env);
    if (agentOnly && !config) {
        throw new Error("DOCKGE_AGENT_ONLY=true requires a valid DOCKGE_AGENT_ENDPOINT_ID and DOCKGE_AGENT_TOKEN_SHA256.");
    }

    return {
        agentOnly,
        config,
    };
}

export function isConfiguredAgentServiceTokenEndpoint(config: AgentServiceTokenConfig | undefined, endpoint: unknown) {
    return !!config && endpoint === config.endpoint;
}

/**
 * The input is bounded before hashing and the fixed-size SHA-256 digests are
 * compared with timingSafeEqual. This helper deliberately has no logging so a
 * raw service token cannot leak through diagnostics.
 */
export function verifyAgentServiceToken(config: AgentServiceTokenConfig | undefined, endpoint: unknown, token: unknown) {
    if (!config || endpoint !== config.endpoint || typeof token !== "string") {
        return false;
    }

    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (tokenBytes < MIN_AGENT_SERVICE_TOKEN_BYTES || tokenBytes > MAX_AGENT_SERVICE_TOKEN_BYTES) {
        return false;
    }

    const candidate = createHash("sha256").update(token, "utf8").digest();
    return timingSafeEqual(candidate, config.digest);
}

export function isAuthorizedAgentProxyRequest(userID: unknown, agentEndpoint: unknown, endpoint: unknown) {
    if (typeof userID === "number" && userID > 0) {
        return true;
    }

    // A configured agent endpoint can never be empty or the broadcast marker,
    // so strict equality excludes both without special-case route widening.
    return typeof agentEndpoint === "string" && agentEndpoint.length > 0 && endpoint === agentEndpoint;
}
