import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ContainerEngineConfigError,
    createContainerEngine,
    detectContainerEngineCapabilities,
    parseContainerEngineConfig,
    parseVersion,
} from "../container-engine/container-engine";
import type { EngineCommand, EngineCommandResult, EngineCommandRunner } from "../container-engine/container-engine";

class FakeCommandRunner implements EngineCommandRunner {
    readonly commands: EngineCommand[] = [];

    constructor(private readonly results: EngineCommandResult[]) {
    }

    async run(command: EngineCommand): Promise<EngineCommandResult> {
        this.commands.push(command);
        const result = this.results.shift();
        if (!result) {
            throw new Error("Unexpected engine probe");
        }
        return result;
    }
}

test("container engine configuration defaults to Docker-compatible auto mode", () => {
    const config = parseContainerEngineConfig({});

    assert.deepEqual(config, {
        engine: "auto",
        binary: undefined,
        socket: undefined,
        composeProvider: "auto",
    });
    assert.ok(Object.isFrozen(config));

    const engine = createContainerEngine(config);
    assert.equal(engine.kind, "docker");
    assert.deepEqual(engine.compose("up", "-d"), {
        file: "docker",
        args: [ "compose", "up", "-d" ],
    });
});

test("container engine configuration accepts documented selection, binary, socket, and provider overrides", () => {
    const config = parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_CONTAINER_ENGINE_BINARY: "/usr/local/bin/podman",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/podman/podman.sock",
        DOCKGE_COMPOSE_PROVIDER: "podman-compose",
    });

    assert.deepEqual(config, {
        engine: "podman",
        binary: "/usr/local/bin/podman",
        socket: "unix:///run/podman/podman.sock",
        composeProvider: "podman-compose",
    });
});

test("container engine configuration retains all supported Compose provider preferences", () => {
    for (const composeProvider of [ "auto", "docker-compose", "podman-compose" ]) {
        assert.equal(
            parseContainerEngineConfig({ DOCKGE_COMPOSE_PROVIDER: composeProvider }).composeProvider,
            composeProvider,
        );
    }
});

test("empty container engine settings use the documented defaults", () => {
    assert.deepEqual(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "",
        DOCKGE_CONTAINER_ENGINE_BINARY: "",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "",
        DOCKGE_COMPOSE_PROVIDER: "",
    }), {
        engine: "auto",
        binary: undefined,
        socket: undefined,
        composeProvider: "auto",
    });
});

test("container engine configuration rejects invalid and unsafe environment values", () => {
    for (const env of [
        { DOCKGE_CONTAINER_ENGINE: "containerd" },
        { DOCKGE_COMPOSE_PROVIDER: "compose" },
        { DOCKGE_CONTAINER_ENGINE_BINARY: " docker" },
        { DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/docker.sock\n--debug" },
    ]) {
        assert.throws(() => parseContainerEngineConfig(env), ContainerEngineConfigError);
    }
});

test("Docker engine preserves the legacy command contract exactly", () => {
    const engine = createContainerEngine(parseContainerEngineConfig({ DOCKGE_CONTAINER_ENGINE: "docker" }));

    assert.equal(engine.kind, "docker");
    assert.deepEqual(engine.compose("up", "-d", "--remove-orphans"), {
        file: "docker",
        args: [ "compose", "up", "-d", "--remove-orphans" ],
    });
    assert.deepEqual(engine.composeList(), {
        file: "docker",
        args: [ "compose", "ls", "--all", "--format", "json" ],
    });
    assert.deepEqual(engine.containerStatus("example-stack"), {
        file: "docker",
        args: [ "ps", "-a", "--filter", "label=com.docker.compose.project=example-stack", "--format", "json" ],
    });
    assert.deepEqual(engine.networkList(), {
        file: "docker",
        args: [ "network", "ls", "--format", "{{.Name}}" ],
    });
    assert.deepEqual(engine.stats(), {
        file: "docker",
        args: [ "stats", "--format", "json", "--no-stream" ],
    });
});

test("Docker binary and remote socket are global argv prefixes", () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "docker",
        DOCKGE_CONTAINER_ENGINE_BINARY: "/usr/bin/docker",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///var/run/docker.sock",
        DOCKGE_COMPOSE_PROVIDER: "docker-compose",
    }));

    assert.deepEqual(engine.compose("ps", "--format", "json"), {
        file: "/usr/bin/docker",
        args: [ "--host", "unix:///var/run/docker.sock", "compose", "ps", "--format", "json" ],
    });
    assert.equal(engine.config.composeProvider, "docker-compose");
});

test("raw Compose commands preserve global environment-file ordering", () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/podman/podman.sock",
    }));
    const composeArgs = [ "compose", "--env-file", "../global.env", "--env-file", "./.env", "up", "-d" ];

    assert.deepEqual(engine.composeCommand(composeArgs), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", ...composeArgs ],
    });
    assert.deepEqual(composeArgs, [ "compose", "--env-file", "../global.env", "--env-file", "./.env", "up", "-d" ]);
    assert.throws(() => engine.composeCommand([ "up", "-d" ]), Error);
});

test("Podman builds the same normalized operations with Podman's remote socket flag", () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/podman/podman.sock",
        DOCKGE_COMPOSE_PROVIDER: "podman-compose",
    }));

    assert.equal(engine.kind, "podman");
    assert.deepEqual(engine.compose("restart", "web"), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "compose", "restart", "web" ],
    });
    assert.deepEqual(engine.composeList(), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "compose", "ls", "--all", "--format", "json" ],
    });
    assert.deepEqual(engine.containerStatus("example-stack"), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "ps", "-a", "--filter", "label=com.docker.compose.project=example-stack", "--format", "json" ],
    });
    assert.deepEqual(engine.networkList(), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "network", "ls", "--format", "{{.Name}}" ],
    });
    assert.deepEqual(engine.stats(), {
        file: "podman",
        args: [ "--url", "unix:///run/podman/podman.sock", "stats", "--format", "json", "--no-stream" ],
    });
    assert.ok(Object.isFrozen(engine.stats().args));
});

test("resolved commands and their argv are immutable snapshots", () => {
    const engine = createContainerEngine(parseContainerEngineConfig({ DOCKGE_CONTAINER_ENGINE: "docker" }));
    const command = engine.compose("logs", "-f");

    assert.ok(Object.isFrozen(command));
    assert.ok(Object.isFrozen(command.args));
    assert.throws(() => Object.defineProperty(command.args, "0", { value: "changed" }), TypeError);
    assert.deepEqual(command, {
        file: "docker",
        args: [ "compose", "logs", "-f" ],
    });
});

test("capability detection reports selected engine and Compose provider versions", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({
        DOCKGE_CONTAINER_ENGINE: "podman",
        DOCKGE_CONTAINER_ENGINE_SOCKET: "unix:///run/podman/podman.sock",
    }));
    const runner = new FakeCommandRunner([
        { exitCode: 0,
            stdout: "5.4.2\n",
            stderr: "" },
        { exitCode: 0,
            stdout: "podman-compose version 1.3.0\n",
            stderr: "" },
    ]);

    assert.deepEqual(await detectContainerEngineCapabilities(engine, runner), {
        engineVersion: "5.4.2",
        composeProvider: "podman-compose",
        composeProviderVersion: "1.3.0",
        warnings: [],
    });
    assert.deepEqual(runner.commands, [
        { file: "podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "version", "--format", "{{.Client.Version}}" ] },
        { file: "podman",
            args: [ "--url", "unix:///run/podman/podman.sock", "compose", "version" ] },
    ]);
});

test("capability detection keeps Docker selected and reports failed probes as warnings", async () => {
    const engine = createContainerEngine(parseContainerEngineConfig({}));
    const runner = new FakeCommandRunner([
        { exitCode: 1,
            stdout: "",
            stderr: "unavailable" },
        { exitCode: 1,
            stdout: "",
            stderr: "unavailable" },
    ]);

    const capabilities = await detectContainerEngineCapabilities(engine, runner);
    assert.equal(engine.kind, "docker");
    assert.equal(capabilities.engineVersion, undefined);
    assert.equal(capabilities.composeProvider, "docker-compose");
    assert.equal(capabilities.composeProviderVersion, undefined);
    assert.deepEqual(capabilities.warnings, [
        "Unable to determine docker engine version",
        "Unable to determine Compose provider version",
    ]);
});

test("version parsing accepts Docker and Podman version formats without retaining output", () => {
    assert.equal(parseVersion("Docker version 27.5.1, build 9f9e405"), "27.5.1");
    assert.equal(parseVersion("Client: Podman Engine\nVersion: 5.4.2\n"), "5.4.2");
    assert.equal(parseVersion("unknown"), undefined);
});
