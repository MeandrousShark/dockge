import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import type {
    QuadletJournalEvent,
    QuadletJournalOptions,
    QuadletResource,
    QuadletResourceSelector,
    QuadletStatus,
} from "../../common/quadlet";
import { QuadletSocketHandler, QuadletReadOnlyClient } from "../agent-socket-handlers/quadlet-socket-handler";
import type { DockgeServer } from "../dockge-server";
import type { QuadletHelperState, QuadletHelperStatus } from "../quadlet-helper/client";
import type { DockgeSocket } from "../util-server";

const selector = { root: "admin",
    sourceName: "caddy.container" } as const;
const resource: QuadletResource = {
    ...selector,
    resourceType: "container",
    fileKind: "regular",
    unitId: "caddy.service",
    ownership: "external",
    readOnly: true,
};
const helperStatus = (state: QuadletHelperState = "read-only"): QuadletHelperStatus => state === "read-only" ? {
    state,
    mode: "read-only",
    operations: [ "helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal" ],
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
} : { state };

class FakeSocket extends EventEmitter {
    userID?: number;
    agentEndpoint?: string;
    agentProxyEndpoint?: string;
    readonly emissions: Array<{ event: string; args: unknown[] }> = [];

    emitAgent(event: string, ...args: unknown[]) {
        this.emissions.push({ event,
            args });
    }
}

class FakeClient implements QuadletReadOnlyClient {
    listCalls = 0;
    resources: readonly QuadletResource[] = [ resource ];
    statusCalls: QuadletResourceSelector[] = [];
    journalCalls: Array<{ selector: QuadletResourceSelector; options: QuadletJournalOptions }> = [];
    journalEvents: readonly QuadletJournalEvent[] = [];
    waitForAbort = false;

    async list() {
        this.listCalls += 1;
        return this.resources;
    }

    async status(value: QuadletResourceSelector): Promise<QuadletStatus> {
        this.statusCalls.push(value);
        return { resource,
            properties: { ActiveState: "active" } };
    }

    journal(value: QuadletResourceSelector, options: QuadletJournalOptions): AsyncIterable<QuadletJournalEvent> {
        this.journalCalls.push({ selector: value,
            options });
        const events = this.journalEvents;
        const waitForAbort = this.waitForAbort;
        return (async function* () {
            for (const event of events) {
                if (options.signal?.aborted) {
                    return;
                }
                yield event;
            }
            if (waitForAbort) {
                await new Promise<void>((resolve) => {
                    if (options.signal?.aborted) {
                        resolve();
                    } else {
                        options.signal?.addEventListener("abort", () => resolve(), { once: true });
                    }
                });
            }
        })();
    }
}

function createFixture(options: {
    readonly state?: QuadletHelperStatus;
    readonly client?: FakeClient;
    readonly sessionID?: () => string;
    readonly userID?: number;
    readonly proxiedEndpoint?: string;
} = {}) {
    const socket = new FakeSocket();
    socket.userID = options.userID;
    if (options.proxiedEndpoint) {
        socket.agentEndpoint = options.proxiedEndpoint;
        socket.agentProxyEndpoint = options.proxiedEndpoint;
    }
    let refreshes = 0;
    const server = {
        async refreshQuadletHelperStatus() {
            refreshes += 1;
            return options.state ?? helperStatus();
        },
    } as DockgeServer;
    const client = options.client ?? new FakeClient();
    const agentSocket = new AgentSocket();
    new QuadletSocketHandler(() => client, options.sessionID).create(socket as unknown as DockgeSocket, server, agentSocket);
    return { agentSocket,
        client,
        getRefreshes: () => refreshes,
        socket };
}

async function invoke(agentSocket: AgentSocket, event: string, ...args: unknown[]) {
    const results: unknown[] = [];
    await agentSocket.call(event, ...args, (result: unknown) => results.push(result));
    assert.equal(results.length, 1, `${event} callback must be invoked exactly once`);
    return results[0] as { ok: boolean; msg?: string; sessionId?: string; resources?: readonly QuadletResource[]; status?: QuadletStatus };
}

async function flushJournal() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Quadlet socket events require a user login or the scoped agent-proxy marker", async () => {
    const unauthenticated = createFixture();
    const denied = await invoke(unauthenticated.agentSocket, "quadletList");
    assert.equal(denied.ok, false);
    assert.equal(denied.msg, "You are not logged in.");
    assert.equal(unauthenticated.client.listCalls, 0);

    const tokenWithoutProxy = createFixture();
    tokenWithoutProxy.socket.agentEndpoint = "sapporo.example.test:5001";
    const tokenWithoutProxyResult = await invoke(tokenWithoutProxy.agentSocket, "quadletList");
    assert.equal(tokenWithoutProxyResult.ok, false);
    assert.equal(tokenWithoutProxy.client.listCalls, 0);

    const mismatchedProxy = createFixture();
    mismatchedProxy.socket.agentEndpoint = "sapporo.example.test:5001";
    mismatchedProxy.socket.agentProxyEndpoint = "other.example.test:5001";
    const mismatchedProxyResult = await invoke(mismatchedProxy.agentSocket, "quadletList");
    assert.equal(mismatchedProxyResult.ok, false);
    assert.equal(mismatchedProxy.client.listCalls, 0);

    const direct = createFixture({ userID: 1 });
    const directResult = await invoke(direct.agentSocket, "quadletList");
    assert.deepEqual(directResult, { ok: true,
        resources: [ resource ] });

    const proxied = createFixture({ proxiedEndpoint: "sapporo.example.test:5001" });
    const proxiedResult = await invoke(proxied.agentSocket, "quadletList");
    assert.equal(proxiedResult.ok, true);
    assert.equal(proxied.client.listCalls, 1);
});

test("Quadlet socket events refresh and require the complete read-only helper capability", async () => {
    for (const state of [ "disabled", "unavailable", "incompatible" ] as const) {
        const fixture = createFixture({ state: helperStatus(state),
            userID: 1 });
        const result = await invoke(fixture.agentSocket, "quadletList");
        assert.equal(result.ok, false);
        assert.match(result.msg ?? "", new RegExp(state === "incompatible" ? "incompatible" : state));
        assert.equal(fixture.client.listCalls, 0);
    }

    const missingOperation = helperStatus();
    const incomplete = createFixture({
        state: { ...missingOperation,
            operations: [ "quadlet.list", "quadlet.status", "quadlet.journal" ] },
        userID: 1,
    });
    const result = await invoke(incomplete.agentSocket, "quadletList");
    assert.equal(result.ok, false);
    assert.match(result.msg ?? "", /incompatible/);

    const fresh = createFixture({ userID: 1 });
    await invoke(fresh.agentSocket, "quadletList");
    await invoke(fresh.agentSocket, "quadletStatus", selector);
    assert.equal(fresh.getRefreshes(), 2);
});

test("Quadlet list exposes only monitorable external source units to the browser", async () => {
    const client = new FakeClient();
    const network: QuadletResource = {
        root: "runtime",
        sourceName: "edge.network",
        resourceType: "network",
        fileKind: "regular",
        unitId: "edge-network.service",
        ownership: "external",
        readOnly: true,
    };
    const volume: QuadletResource = {
        root: "distribution",
        sourceName: "state.volume",
        resourceType: "volume",
        fileKind: "regular",
        unitId: "state-volume.service",
        ownership: "external",
        readOnly: true,
    };
    const nonExternal = {
        ...resource,
        sourceName: "non-external.container",
        ownership: "managed",
    } as unknown as QuadletResource;
    const writable = {
        ...network,
        sourceName: "writable.network",
        readOnly: false,
    } as unknown as QuadletResource;
    client.resources = [
        resource,
        network,
        volume,
        { ...resource,
            sourceName: "caddy.env",
            resourceType: "unsupported",
            unitId: undefined },
        { ...resource,
            sourceName: "tls.key",
            resourceType: "unsupported",
            unitId: undefined },
        { ...resource,
            sourceName: "ignored.container",
            fileKind: "directory",
            unitId: undefined },
        { ...network,
            sourceName: "alias.network",
            fileKind: "symlink",
            unitId: undefined },
        { ...volume,
            sourceName: "socket.volume",
            fileKind: "irregular",
            unitId: undefined },
        { ...resource,
            sourceName: "unmapped.container",
            unitId: undefined },
        { ...network,
            sourceName: "empty.network",
            unitId: "" },
        { ...volume,
            sourceName: "shadowed.volume",
            shadowedBy: "admin" },
        nonExternal,
        writable,
    ];

    const fixture = createFixture({ client,
        userID: 1 });
    const result = await invoke(fixture.agentSocket, "quadletList");
    assert.deepEqual(result, { ok: true,
        resources: [ resource, network, volume ] });
});

test("Quadlet status validates fixed logical resource selectors", async () => {
    const fixture = createFixture({ userID: 1 });
    const invalidRoot = await invoke(fixture.agentSocket, "quadletStatus", { root: "../../etc",
        sourceName: selector.sourceName });
    assert.equal(invalidRoot.ok, false);
    assert.match(invalidRoot.msg ?? "", /root is invalid/);

    const invalidSource = await invoke(fixture.agentSocket, "quadletStatus", { root: "admin",
        sourceName: "../secret.container" });
    assert.equal(invalidSource.ok, false);
    assert.match(invalidSource.msg ?? "", /source name is invalid/);

    const unsupportedSource = await invoke(fixture.agentSocket, "quadletStatus", { root: "admin",
        sourceName: "notes.txt" });
    assert.equal(unsupportedSource.ok, false);
    assert.match(unsupportedSource.msg ?? "", /source name is invalid/);

    const result = await invoke(fixture.agentSocket, "quadletStatus", selector);
    assert.equal(result.status?.properties.ActiveState, "active");
    assert.deepEqual(fixture.client.statusCalls, [ selector ]);
});

test("Quadlet journal does not start without an acknowledgement callback", async () => {
    const client = new FakeClient();
    const fixture = createFixture({ client,
        userID: 1 });
    await fixture.agentSocket.call("quadletJournalStart", selector, { lines: 1 });
    await flushJournal();
    assert.equal(client.journalCalls.length, 0);
});

test("Quadlet journal sessions are server generated, scoped, and cancelled on stop or disconnect", async () => {
    const client = new FakeClient();
    client.journalEvents = [
        { type: "record",
            sequence: 1,
            data: { message: "first",
                truncated: false } },
        { type: "complete",
            records: 1,
            complete: true },
    ];
    const sessionIDs = [ "quadlet_journal_a", "quadlet_journal_b" ];
    const fixture = createFixture({ client,
        sessionID: () => sessionIDs.shift() ?? "quadlet_journal_z",
        userID: 1 });
    const start = await invoke(fixture.agentSocket, "quadletJournalStart", selector, { lines: 10,
        follow: true });
    assert.deepEqual(start, { ok: true,
        sessionId: "quadlet_journal_a" });
    await flushJournal();
    assert.deepEqual(fixture.socket.emissions, [
        { event: "quadletJournalEvent",
            args: [{ sessionId: "quadlet_journal_a",
                event: client.journalEvents[0] }] },
        { event: "quadletJournalEvent",
            args: [{ sessionId: "quadlet_journal_a",
                event: client.journalEvents[1] }] },
    ]);
    assert.equal(client.journalCalls[0]?.options.signal?.aborted, false);

    const foreign = createFixture({ userID: 1 });
    const foreignStop = await invoke(foreign.agentSocket, "quadletJournalStop", "quadlet_journal_a");
    assert.equal(foreignStop.ok, false);
    assert.match(foreignStop.msg ?? "", /not active for this socket/);

    const cancellableClient = new FakeClient();
    cancellableClient.waitForAbort = true;
    const cancellable = createFixture({ client: cancellableClient,
        sessionID: () => "quadlet_journal_cancel",
        userID: 1 });
    const cancellableStart = await invoke(cancellable.agentSocket, "quadletJournalStart", selector, { lines: 1 });
    await flushJournal();
    const duplicateStart = await invoke(cancellable.agentSocket, "quadletJournalStart", selector, { lines: 1 });
    assert.equal(duplicateStart.ok, false);
    assert.match(duplicateStart.msg ?? "", /already active/);
    const invalidStop = await invoke(cancellable.agentSocket, "quadletJournalStop", "../quadlet_journal_cancel");
    assert.equal(invalidStop.ok, false);
    assert.match(invalidStop.msg ?? "", /session ID is invalid/);
    const stop = await invoke(cancellable.agentSocket, "quadletJournalStop", cancellableStart.sessionId);
    assert.deepEqual(stop, { ok: true,
        sessionId: "quadlet_journal_cancel" });
    assert.equal(cancellable.client.journalCalls[0]?.options.signal?.aborted, true);
    const duplicateStop = await invoke(cancellable.agentSocket, "quadletJournalStop", cancellableStart.sessionId);
    assert.equal(duplicateStop.ok, false);

    const disconnectedClient = new FakeClient();
    disconnectedClient.waitForAbort = true;
    const disconnected = createFixture({ client: disconnectedClient,
        sessionID: () => "quadlet_journal_disconnect",
        userID: 1 });
    await invoke(disconnected.agentSocket, "quadletJournalStart", selector, { lines: 1 });
    await flushJournal();
    disconnected.socket.emit("disconnect");
    assert.equal(disconnected.client.journalCalls[0]?.options.signal?.aborted, true);
});

test("Quadlet socket handler exposes only the four read-only Gate 5 events", () => {
    const fixture = createFixture({ userID: 1 });
    assert.deepEqual([ ...fixture.agentSocket.eventList.keys() ].sort(), [
        "quadletJournalStart",
        "quadletJournalStop",
        "quadletList",
        "quadletStatus",
    ]);
});
