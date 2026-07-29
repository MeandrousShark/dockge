import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Terminal, PodmanCombinedLogsTerminal } from "../terminal";
import type { EngineCommand } from "../container-engine/types";
import type { PodmanLogContainer } from "../container-engine/output-parser";
import type { DockgeServer } from "../dockge-server";
import type { PodmanLogChild, PodmanLogSpawner } from "../terminal";
import type { DockgeSocket } from "../util-server";

class FakePodmanLogChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killCalls.push(signal);
        return true;
    }

    close(code: number | null) {
        this.emit("close", code, null);
    }

    fail() {
        this.emit("error", new Error("spawn failed"));
    }
}

interface SpawnCall {
    file: string;
    args: readonly string[];
    options: { cwd: string; env?: NodeJS.ProcessEnv };
}

function createSpawner() {
    const calls: SpawnCall[] = [];
    const children: FakePodmanLogChild[] = [];
    const spawner: PodmanLogSpawner = (file, args, options) => {
        calls.push({ file,
            args,
            options });
        const child = new FakePodmanLogChild();
        children.push(child);
        return child as unknown as PodmanLogChild;
    };
    return { calls,
        children,
        spawner };
}

interface SocketEmission {
    event: string;
    args: unknown[];
}

function createSocket() {
    const emissions: SocketEmission[] = [];
    const socket = {
        id: "test-socket",
        connected: true,
        emitAgent(event: string, ...args: unknown[]) {
            emissions.push({ event,
                args });
        },
    } as unknown as DockgeSocket;
    return { emissions,
        socket };
}

function follower(id: string, service: string, name: string) {
    const container: PodmanLogContainer = { id,
        service,
        name };
    const command: EngineCommand = {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "logs", "-f", "--tail", "100", id ],
    };
    return { container,
        command };
}

test("Podman combined terminal starts one direct follower per container and retains sibling output", () => {
    const fixture = createSpawner();
    const socketFixture = createSocket();
    const terminalName = "podman-fanout-output";
    const terminal = new PodmanCombinedLogsTerminal(
        {} as DockgeServer,
        terminalName,
        "/tmp/demo",
        [
            follower("api-id", "api", "demo-api-1"),
            follower("worker-id", "worker", "demo-worker-1"),
        ],
        fixture.spawner,
    );
    terminal.join(socketFixture.socket);
    terminal.start();

    assert.deepEqual(fixture.calls, [
        {
            file: "podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "logs", "-f", "--tail", "100", "api-id" ],
            options: { cwd: "/tmp/demo" },
        },
        {
            file: "podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "logs", "-f", "--tail", "100", "worker-id" ],
            options: { cwd: "/tmp/demo" },
        },
    ]);

    fixture.children[0].stdout.write("ready\n");
    fixture.children[1].stderr.write("failed\n");
    fixture.children[0].close(0);

    assert.equal(Terminal.getTerminal(terminalName), terminal);
    assert.deepEqual(socketFixture.emissions, [
        { event: "terminalWrite",
            args: [ terminalName, "api/demo-api-1 | ready\n" ] },
        { event: "terminalWrite",
            args: [ terminalName, "worker/demo-worker-1 | failed\n" ] },
    ]);

    fixture.children[1].close(0);

    assert.equal(Terminal.getTerminal(terminalName), undefined);
    assert.deepEqual(socketFixture.emissions.at(-1), {
        event: "terminalExit",
        args: [ terminalName, 0 ],
    });
});

test("Podman combined terminal preserves a follower failure until remaining followers finish", () => {
    const fixture = createSpawner();
    const socketFixture = createSocket();
    const terminalName = "podman-fanout-failure";
    const terminal = new PodmanCombinedLogsTerminal(
        {} as DockgeServer,
        terminalName,
        "/tmp/demo",
        [
            follower("api-id", "api", "demo-api-1"),
            follower("worker-id", "worker", "demo-worker-1"),
        ],
        fixture.spawner,
    );
    terminal.join(socketFixture.socket);
    terminal.start();

    fixture.children[0].fail();
    fixture.children[1].stdout.write("still following\n");

    assert.equal(Terminal.getTerminal(terminalName), terminal);
    assert.deepEqual(socketFixture.emissions.slice(0, 2), [
        { event: "terminalWrite",
            args: [ terminalName, "api/demo-api-1 | Log follower failed to start.\r\n" ] },
        { event: "terminalWrite",
            args: [ terminalName, "worker/demo-worker-1 | still following\n" ] },
    ]);

    fixture.children[1].close(0);

    assert.deepEqual(socketFixture.emissions.at(-1), {
        event: "terminalExit",
        args: [ terminalName, 1 ],
    });
});

test("Podman combined terminal stops every follower and exits only after all close", () => {
    const fixture = createSpawner();
    const socketFixture = createSocket();
    const terminalName = "podman-fanout-close";
    const terminal = new PodmanCombinedLogsTerminal(
        {} as DockgeServer,
        terminalName,
        "/tmp/demo",
        [
            follower("api-id", "api", "demo-api-1"),
            follower("worker-id", "worker", "demo-worker-1"),
        ],
        fixture.spawner,
    );
    terminal.join(socketFixture.socket);
    terminal.start();
    terminal.close();

    assert.deepEqual(fixture.children.map((child) => child.killCalls), [[ "SIGTERM" ], [ "SIGTERM" ]]);
    fixture.children[0].close(1);
    assert.equal(Terminal.getTerminal(terminalName), terminal);

    fixture.children[1].close(1);

    assert.equal(Terminal.getTerminal(terminalName), undefined);
    assert.deepEqual(socketFixture.emissions, [
        { event: "terminalExit",
            args: [ terminalName, 0 ] },
    ]);
});
