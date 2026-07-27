import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    MAX_AGENT_SERVICE_TOKEN_BYTES,
    MIN_AGENT_SERVICE_TOKEN_BYTES,
    isAgentOnlyMode,
    isAllowedAgentOnlyEvent,
    isAuthorizedAgentProxyRequest,
    parseAgentServiceTokenConfig,
    parseAgentServiceTokenPolicy,
    verifyAgentServiceToken,
} from "../agent-service-token";

function digest(token: string) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

const serviceToken = "correct horse battery staple, at least 32 bytes";

test("agent service token requires a complete valid endpoint configuration", () => {
    assert.equal(parseAgentServiceTokenConfig({}), undefined);
    assert.equal(parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "sapporo.example.test",
    }), undefined);
    assert.equal(parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "sapporo.example.test",
        DOCKGE_AGENT_TOKEN_SHA256: "not-a-digest",
    }), undefined);
    assert.equal(parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "sapporo\n.example.test",
        DOCKGE_AGENT_TOKEN_SHA256: digest(serviceToken),
    }), undefined);
    assert.equal(parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "##ALL_DOCKGE_ENDPOINTS##",
        DOCKGE_AGENT_TOKEN_SHA256: digest(serviceToken),
    }), undefined);
    assert.equal(parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "100.64.0.5:5001",
        DOCKGE_AGENT_TOKEN_SHA256: digest(serviceToken),
    })?.endpoint, "100.64.0.5:5001");
});

test("agent service token only authorizes its configured endpoint and digest", () => {
    const config = parseAgentServiceTokenConfig({
        DOCKGE_AGENT_ENDPOINT_ID: "sapporo.example.test:5001",
        DOCKGE_AGENT_TOKEN_SHA256: digest(serviceToken),
    });

    assert.equal(verifyAgentServiceToken(config, "sapporo.example.test:5001", serviceToken), true);
    assert.equal(verifyAgentServiceToken(config, "other.example.test:5001", serviceToken), false);
    assert.equal(verifyAgentServiceToken(config, "sapporo.example.test:5001", "x".repeat(MIN_AGENT_SERVICE_TOKEN_BYTES - 1)), false);
    assert.equal(verifyAgentServiceToken(config, "sapporo.example.test:5001", "x".repeat(MAX_AGENT_SERVICE_TOKEN_BYTES + 1)), false);
});

test("agent-only mode accepts only token login and agent proxy events", () => {
    assert.equal(isAgentOnlyMode({ DOCKGE_AGENT_ONLY: "true" }), true);
    assert.equal(isAgentOnlyMode({ DOCKGE_AGENT_ONLY: "false" }), false);
    assert.equal(isAllowedAgentOnlyEvent("login"), true);
    assert.equal(isAllowedAgentOnlyEvent("agent"), true);
    assert.equal(isAllowedAgentOnlyEvent("loginByToken"), false);
    assert.equal(isAllowedAgentOnlyEvent("setup"), false);
    assert.equal(isAllowedAgentOnlyEvent("getSettings"), false);
    assert.throws(() => parseAgentServiceTokenPolicy({ DOCKGE_AGENT_ONLY: "true" }), /requires a valid/);
    assert.deepEqual(parseAgentServiceTokenPolicy({ DOCKGE_AGENT_ONLY: "false" }), {
        agentOnly: false,
        config: undefined,
    });
});

test("agent service-token capability only permits its exact agent proxy route", () => {
    const endpoint = "100.64.0.5:5001";

    assert.equal(isAuthorizedAgentProxyRequest(undefined, endpoint, endpoint), true);
    assert.equal(isAuthorizedAgentProxyRequest(undefined, endpoint, ""), false);
    assert.equal(isAuthorizedAgentProxyRequest(undefined, endpoint, "##ALL_DOCKGE_ENDPOINTS##"), false);
    assert.equal(isAuthorizedAgentProxyRequest(undefined, endpoint, "other.example.test:5001"), false);

    // A regular user retains the existing all-endpoints behavior. A service
    // token has no user ID and therefore cannot become a user session.
    assert.equal(isAuthorizedAgentProxyRequest(1, undefined, "##ALL_DOCKGE_ENDPOINTS##"), true);
    assert.equal(isAuthorizedAgentProxyRequest(undefined, undefined, endpoint), false);
});
