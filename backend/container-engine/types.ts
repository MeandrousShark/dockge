/**
 * Requested container-engine selection. `auto` is retained in configuration;
 * the factory resolves it to Docker for this Docker-compatible first slice.
 */
export type ContainerEngineKind = "auto" | "docker" | "podman";

/** A concrete engine selected for command construction. */
export type ResolvedContainerEngineKind = Exclude<ContainerEngineKind, "auto">;

/**
 * Compose provider preference. Provider discovery and compatibility probing
 * are deliberately deferred until the Podman parity gate.
 */
export type ComposeProvider = "auto" | "docker-compose" | "podman-compose";

/** Parsed, untrusted environment configuration for the engine boundary. */
export interface ContainerEngineConfig {
    engine: ContainerEngineKind;
    binary?: string;
    socket?: string;
    composeProvider: ComposeProvider;
}

/** A process invocation with argv already separated from the executable. */
export interface EngineCommand {
    readonly file: string;
    readonly args: readonly string[];
}

/** Facts observed from the selected engine during startup probing. */
export interface ContainerEngineCapabilities {
    readonly engineVersion?: string;
    readonly composeProvider: ComposeProvider;
    readonly composeProviderVersion?: string;
    readonly warnings: readonly string[];
}

/** Minimal process result used by the capability probe. */
export interface EngineCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** Injectable command runner keeps capability detection independent of spawn(). */
export interface EngineCommandRunner {
    run(command: EngineCommand): Promise<EngineCommandResult>;
}
