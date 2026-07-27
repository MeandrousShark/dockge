import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createContainerEngine,
    detectContainerEngineCapabilities,
    parseContainerEngineConfig,
    parseVersion,
} from "../container-engine/container-engine";
import type { EngineCommand, EngineCommandResult, EngineCommandRunner } from "../container-engine/types";

class FakeCommandRunner implements EngineCommandRunner {
    readonly commands: EngineCommand[] = [];

    constructor(private readonly outcomes: readonly (EngineCommandResult | Error)[]) {}

    async run(command: EngineCommand): Promise<EngineCommandResult> {
        this.commands.push(command);
        const outcome = this.outcomes[this.commands.length - 1];

        if (outcome instanceof Error) {
            throw outcome;
        }

        if (!outcome) {
            throw new Error("Unexpected engine capability probe");
        }

        return outcome;
    }
}

function commandResult(stdout: string, exitCode = 0, stderr = ""): EngineCommandResult {
    return {
        exitCode,
        stdout,
        stderr,
    };
}

test("Docker capability detection parses engine and Compose versions through the configured remote endpoint", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "docker",
        DOCKGE_CONTAINER_ENGINE_BINARY: "/usr/local/bin/docker",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///var/run/docker.sock",
    }));
    const runner = new FakeCommandRunner([
        commandResult("27.2.1\n"),
        commandResult("Docker Compose version v2.29.7\n"),
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);

    assert.deepEqual(capabilities, {
        engineVersion: "27.2.1",
        composeProvider: "docker-compose",
        composeProviderVersion: "2.29.7",
        warnings: [],
    });
    assert.deepEqual(runner.commands, [
        {
            file: "/usr/local/bin/docker",
            args: [ "--host", "unix:///var/run/docker.sock", "version", "--format", "{{.Client.Version}}" ],
        },
        {
            file: "/usr/local/bin/docker",
            args: [ "--host", "unix:///var/run/docker.sock", "compose", "version" ],
        },
    ]);
    assert.ok(Object.isFrozen(capabilities));
    assert.ok(Object.isFrozen(capabilities.warnings));
});

test("Podman capability detection parses JSON-style version output and retains the configured provider", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_CONTAINER_ENGINE_BINARY: "/usr/bin/podman",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/podman/podman.sock",
        DOCKGE_COMPOSE_PROVIDER: "podman-compose",
    }));
    const runner = new FakeCommandRunner([
        commandResult("{ \"Client\": { \"Version\": \"5.4.2\" } }\n"),
        commandResult("podman-compose version 1.3.0\n"),
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);

    assert.deepEqual(capabilities, {
        engineVersion: "5.4.2",
        composeProvider: "podman-compose",
        composeProviderVersion: "1.3.0",
        warnings: [],
    });
    assert.deepEqual(runner.commands, [
        {
            file: "/usr/bin/podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "version", "--format", "{{.Client.Version}}" ],
        },
        {
            file: "/usr/bin/podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "compose", "version" ],
        },
    ]);
});

test("Podman Compose provider detection ignores the engine version in multiline provider output", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_COMPOSE_PROVIDER: "podman-compose",
    }));
    const runner = new FakeCommandRunner([
        commandResult("5.4.2\n"),
        commandResult("podman version 5.4.2\npodman-compose version 1.3.0\n"),
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);

    assert.deepEqual(capabilities, {
        engineVersion: "5.4.2",
        composeProvider: "podman-compose",
        composeProviderVersion: "1.3.0",
        warnings: [],
    });
});

test("capability detection reports unavailable probes independently without preventing startup", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_COMPOSE_PROVIDER: "docker-compose",
    }));
    const runner = new FakeCommandRunner([
        commandResult("podman version 5.4.2\n", 125, "cannot connect to Podman socket"),
        new Error("podman-compose not found"),
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);

    assert.deepEqual(capabilities, {
        engineVersion: "5.4.2",
        composeProvider: "docker-compose",
        warnings: [
            "Unable to determine podman engine version",
            "Unable to run Compose provider version probe",
        ],
    });
    assert.deepEqual(runner.commands, [
        {
            file: "podman",
            args: [ "version", "--format", "{{.Client.Version}}" ],
        },
        {
            file: "podman",
            args: [ "compose", "version" ],
        },
    ]);
});

test("capability detection warns for malformed and empty version output", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({ DOCKGE_CONTAINER_ENGINE: "docker" }));
    const runner = new FakeCommandRunner([
        commandResult("Docker version latest\n"),
        commandResult("\n"),
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);

    assert.deepEqual(capabilities, {
        composeProvider: "docker-compose",
        warnings: [
            "Unable to determine docker engine version",
            "Unable to determine Compose provider version",
        ],
    });
});

test("version parsing accepts Docker and Podman output variants while rejecting unversioned output", () => {
    assert.equal(parseVersion("27.2.1\n"), "27.2.1");
    assert.equal(parseVersion("Docker version 26.1.4, build 5650f9b\n"), "26.1.4");
    assert.equal(parseVersion("Docker Compose version v2.29.7\n"), "2.29.7");
    assert.equal(parseVersion("{ \"Client\": { \"Version\": \"5.4.2\" } }"), "5.4.2");
    assert.equal(parseVersion("podman-compose version 1.3.0-2\n"), "1.3.0-2");
    assert.equal(parseVersion("Docker Compose version v2\n"), undefined);
    assert.equal(parseVersion("not installed\n"), undefined);
});
