import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    detectQuadletHelperStatus,
    MAX_RESPONSE_FRAME_BYTES,
    parseQuadletHelperConfig,
    QuadletHelperClient,
    QuadletHelperConfigError,
    QuadletHelperRequestError,
} from "../quadlet-helper/client";

const capabilities = {
    helperVersion: "1.0.0",
    buildID: "test-build",
    protocol: { min: 1,
        max: 1,
        active: 1 },
    mode: "read-only",
    operations: [ "helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal" ],
    resourceTypes: [ ".container", ".network", ".volume" ],
    roots: [{ id: "admin",
        available: true }],
    limits: {
        requestBytes: 64 * 1024,
        responseBytes: 1024 * 1024,
        requestTimeoutSeconds: 5,
        maxConnections: 16,
        maxJournalStreams: 4,
        journalHistoryRecords: 1000,
        journalHistoryBytes: 1024 * 1024,
        journalRecordBytes: 64 * 1024,
        journalFollowSeconds: 3600,
        heartbeatSeconds: 15,
    },
    system: {
        generatorPath: "/usr/lib/systemd/system-generators/podman-system-generator",
        systemctlPath: "/usr/bin/systemctl",
        journalctlPath: "/usr/bin/journalctl",
    },
};

async function withHelper(handler: (socket: net.Socket) => void, callback: (socketPath: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-quadlet-"));
    const socketPath = path.join(directory, "helper.sock");
    const server = net.createServer(handler);
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    try {
        await callback(socketPath);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true,
            force: true });
    }
}

function frame(value: unknown): Buffer {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const result = Buffer.allocUnsafe(4 + payload.length);
    result.writeUInt32BE(payload.length, 0);
    payload.copy(result, 4);
    return result;
}

function validResponse(overrides: Record<string, unknown> = {}) {
    return {
        version: 1,
        id: "helper_capabilities",
        type: "result",
        ok: true,
        result: capabilities,
        ...overrides,
    };
}

test("Quadlet helper client negotiates framed read-only capabilities", async () => {
    await withHelper((socket) => {
        socket.once("data", () => socket.end(frame(validResponse())));
    }, async (socketPath) => {
        const result = await new QuadletHelperClient({ socketPath }).capabilities();

        assert.equal(result.helperVersion, "1.0.0");
        assert.equal(result.protocol.active, 1);
        assert.deepEqual(result.roots, [{ id: "admin",
            available: true }]);
        assert.ok(Object.isFrozen(result));

        const status = await detectQuadletHelperStatus("podman", {
            DOCKGE_QUADLET_HELPER_SOCKET: socketPath,
        });
        assert.equal(status.state, "read-only");
        assert.equal(status.mode, "read-only");
        assert.equal("system" in status, false);
    });
});

test("Quadlet helper probe remains unavailable when the socket is absent", async () => {
    const status = await detectQuadletHelperStatus("podman", {
        DOCKGE_QUADLET_HELPER_SOCKET: "/tmp/dockge-quadlet-helper-missing.sock",
    });

    assert.deepEqual(status, { state: "unavailable" });
});

test("Quadlet helper probe requires the complete Gate 4 read-only operation set", async () => {
    await withHelper((socket) => {
        socket.once("data", () => socket.end(frame(validResponse({
            result: {
                ...capabilities,
                operations: [ "helper.capabilities", "quadlet.list" ],
            },
        }))));
    }, async (socketPath) => {
        const status = await detectQuadletHelperStatus("podman", {
            DOCKGE_QUADLET_HELPER_SOCKET: socketPath,
        });

        assert.deepEqual(status, { state: "incompatible" });
    });
});

test("Quadlet helper status is re-probed after a helper restart", async () => {
    let requestCount = 0;
    await withHelper((socket) => {
        socket.once("data", () => {
            requestCount += 1;
            socket.end(frame(validResponse({
                result: requestCount === 1 ? {
                    ...capabilities,
                    operations: [ "helper.capabilities", "quadlet.list" ],
                } : capabilities,
            })));
        });
    }, async (socketPath) => {
        const environment = { DOCKGE_QUADLET_HELPER_SOCKET: socketPath };
        assert.deepEqual(await detectQuadletHelperStatus("podman", environment), { state: "incompatible" });
        assert.equal((await detectQuadletHelperStatus("podman", environment)).state, "read-only");
        assert.equal(requestCount, 2);
    });
});

test("Quadlet helper client rejects malformed and oversized response frames", async (t) => {
    await t.test("malformed JSON", async () => {
        await withHelper((socket) => {
            const payload = Buffer.from("{not json", "utf8");
            const response = Buffer.allocUnsafe(4 + payload.length);
            response.writeUInt32BE(payload.length, 0);
            payload.copy(response, 4);
            socket.once("data", () => socket.end(response));
        }, async (socketPath) => {
            await assert.rejects(
                new QuadletHelperClient({ socketPath }).capabilities(),
                (error: unknown) => error instanceof QuadletHelperRequestError && error.kind === "protocol",
            );
        });
    });

    await t.test("oversized frame", async () => {
        await withHelper((socket) => {
            const response = Buffer.allocUnsafe(4);
            response.writeUInt32BE(MAX_RESPONSE_FRAME_BYTES + 1, 0);
            socket.once("data", () => socket.end(response));
        }, async (socketPath) => {
            await assert.rejects(
                new QuadletHelperClient({ socketPath }).capabilities(),
                (error: unknown) => error instanceof QuadletHelperRequestError && error.kind === "protocol",
            );
        });
    });
});

test("Quadlet helper client rejects response IDs and versions that do not correlate", async (t) => {
    await t.test("mismatched ID", async () => {
        await withHelper((socket) => {
            socket.once("data", () => socket.end(frame(validResponse({ id: "other" }))));
        }, async (socketPath) => {
            await assert.rejects(new QuadletHelperClient({ socketPath }).capabilities(), QuadletHelperRequestError);
        });
    });

    await t.test("mismatched version", async () => {
        await withHelper((socket) => {
            socket.once("data", () => socket.end(frame(validResponse({ version: 2 }))));
        }, async (socketPath) => {
            await assert.rejects(new QuadletHelperClient({ socketPath }).capabilities(), QuadletHelperRequestError);
        });
    });
});

test("Quadlet helper client times out and cancels a non-responsive connection", async () => {
    await withHelper((socket) => {
        socket.once("data", () => undefined);
    }, async (socketPath) => {
        await assert.rejects(
            new QuadletHelperClient({ socketPath }, 20).capabilities(),
            (error: unknown) => error instanceof QuadletHelperRequestError && error.kind === "timeout",
        );
    });
});

test("helper startup probe is quiet for Docker and does not fail on invalid Podman configuration", async () => {
    assert.deepEqual(await detectQuadletHelperStatus("docker", {
        DOCKGE_QUADLET_HELPER_SOCKET: "not-an-absolute-path",
    }), { state: "disabled" });
    assert.deepEqual(await detectQuadletHelperStatus("podman", {
        DOCKGE_QUADLET_HELPER_SOCKET: "not-an-absolute-path",
    }), { state: "unavailable" });
    assert.throws(() => parseQuadletHelperConfig({
        DOCKGE_QUADLET_HELPER_SOCKET: "not-an-absolute-path",
    }), QuadletHelperConfigError);
});
