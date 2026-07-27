import { DockerEngine } from "./docker-engine";
import { PodmanEngine } from "./podman-engine";
import type {
    ComposeProvider,
    ContainerEngineConfig,
    ContainerEngineKind,
    ContainerEngineCapabilities,
    EngineCommandRunner,
    EngineCommand,
    ResolvedContainerEngineKind,
} from "./types";

export type { ComposeProvider, ContainerEngineCapabilities, ContainerEngineConfig, ContainerEngineKind, EngineCommand, EngineCommandRunner, EngineCommandResult, ResolvedContainerEngineKind } from "./types";

const ENGINE_ENV = "DOCKGE_CONTAINER_ENGINE";
const BINARY_ENV = "DOCKGE_CONTAINER_ENGINE_BINARY";
const SOCKET_ENV = "DOCKGE_CONTAINER_ENGINE_SOCKET";
const COMPOSE_PROVIDER_ENV = "DOCKGE_COMPOSE_PROVIDER";

/** Raised when a container-engine environment value is not safe to use. */
export class ContainerEngineConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContainerEngineConfigError";
    }
}

/**
 * The intentionally small command boundary used by existing Compose callers.
 * It contains no process execution so its contracts can be tested without the
 * terminal-dependent backend graph.
 */
export interface ContainerEngine {
    readonly kind: ResolvedContainerEngineKind;
    readonly config: Readonly<ContainerEngineConfig>;

    version(): EngineCommand;
    compose(command: string, ...args: string[]): EngineCommand;
    composeCommand(args: readonly string[]): EngineCommand;
    composeList(): EngineCommand;
    containerStatus(projectName: string): EngineCommand;
    networkList(): EngineCommand;
    stats(): EngineCommand;
}

/**
 * Probe the selected engine and its Compose provider without changing engine
 * selection. Failures become capability warnings so a transient probe cannot
 * prevent the server from starting.
 */
export async function detectContainerEngineCapabilities(engine: ContainerEngine, runner: EngineCommandRunner): Promise<ContainerEngineCapabilities> {
    const warnings: string[] = [];
    let engineVersion: string | undefined;
    let composeProviderVersion: string | undefined;

    try {
        const result = await runner.run(engine.version());
        engineVersion = parseVersion(result.stdout);
        if (result.exitCode !== 0 || !engineVersion) {
            warnings.push(`Unable to determine ${engine.kind} engine version`);
        }
    } catch {
        warnings.push(`Unable to run ${engine.kind} engine version probe`);
    }

    try {
        const result = await runner.run(engine.compose("version"));
        composeProviderVersion = parseVersion(result.stdout);
        if (result.exitCode !== 0 || !composeProviderVersion) {
            warnings.push("Unable to determine Compose provider version");
        }
    } catch {
        warnings.push("Unable to run Compose provider version probe");
    }

    const composeProvider = engine.config.composeProvider === "auto"
        ? (engine.kind === "docker" ? "docker-compose" : "podman-compose")
        : engine.config.composeProvider;

    return Object.freeze({
        ...(engineVersion === undefined ? {} : { engineVersion }),
        composeProvider,
        ...(composeProviderVersion === undefined ? {} : { composeProviderVersion }),
        warnings: Object.freeze(warnings),
    });
}

/** Extract the first conventional dotted version, with an optional v prefix. */
export function parseVersion(stdout: string): string | undefined {
    return stdout.match(/(?:\bv)?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

function parseEnum<T extends string>(name: string, value: string | undefined, allowed: readonly T[], defaultValue: T): T {
    if (value === undefined || value === "") {
        return defaultValue;
    }

    if ((allowed as readonly string[]).includes(value)) {
        return value as T;
    }

    throw new ContainerEngineConfigError(`${name} must be one of: ${allowed.join(", ")}`);
}

function parseOptionalCommandValue(name: string, value: string | undefined): string | undefined {
    if (value === undefined || value === "") {
        return undefined;
    }

    if (value !== value.trim() || value.includes("\0") || /[\r\n]/.test(value)) {
        throw new ContainerEngineConfigError(`${name} must be a non-empty command or socket value without surrounding whitespace or control characters`);
    }

    return value;
}

/**
 * Parse only documented environment settings. Empty values mean "use the
 * default"; all other values are validated before they can reach spawn().
 */
export function parseContainerEngineConfig(env: NodeJS.ProcessEnv = process.env): ContainerEngineConfig {
    return Object.freeze({
        engine: parseEnum<ContainerEngineKind>(ENGINE_ENV, env[ENGINE_ENV], [ "auto", "docker", "podman" ], "auto"),
        binary: parseOptionalCommandValue(BINARY_ENV, env[BINARY_ENV]),
        socket: parseOptionalCommandValue(SOCKET_ENV, env[SOCKET_ENV]),
        composeProvider: parseEnum<ComposeProvider>(COMPOSE_PROVIDER_ENV, env[COMPOSE_PROVIDER_ENV], [ "auto", "docker-compose", "podman-compose" ], "auto"),
    });
}

/**
 * Resolve an engine once. Auto intentionally stays Docker-first until the
 * later capability-detection gate proves a Podman endpoint is usable.
 */
export function createContainerEngine(config: ContainerEngineConfig): ContainerEngine {
    if (config.engine === "podman") {
        return new PodmanEngine(config);
    }

    return new DockerEngine(config);
}

/** Build an immutable command result without exposing mutable argv arrays. */
export function command(file: string, args: readonly string[]): EngineCommand {
    return Object.freeze({
        file,
        args: Object.freeze([ ...args ]),
    });
}
