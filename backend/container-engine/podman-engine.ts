import { command, ContainerEngine } from "./container-engine";
import type { ContainerEngineConfig, EngineCommand } from "./types";

/**
 * Podman command construction. Compose-provider selection is represented in
 * configuration but is not executed here: `podman compose` remains the stable
 * argv boundary until provider discovery is added in the parity gate.
 */
export class PodmanEngine implements ContainerEngine {
    readonly kind = "podman" as const;
    readonly config: Readonly<ContainerEngineConfig>;
    private readonly binary: string;
    private readonly globalArgs: readonly string[];

    constructor(config: ContainerEngineConfig) {
        this.config = Object.freeze({ ...config });
        this.binary = config.binary ?? "podman";
        this.globalArgs = Object.freeze(config.socket ? [ "--url", config.socket ] : []);
    }

    version(): EngineCommand {
        return this.build([ "version", "--format", "{{.Client.Version}}" ]);
    }

    compose(subcommand: string, ...args: string[]): EngineCommand {
        return this.composeCommand([ "compose", subcommand, ...args ]);
    }

    composeCommand(args: readonly string[]): EngineCommand {
        if (args[0] !== "compose") {
            throw new Error("Compose commands must begin with the compose subcommand");
        }
        return this.build(args);
    }

    composeList(): EngineCommand {
        return this.compose("ls", "--all", "--format", "json");
    }

    containerStatus(projectName: string): EngineCommand {
        return this.build([ "ps", "-a", "--filter", `label=com.docker.compose.project=${projectName}`, "--format", "json" ]);
    }

    networkList(): EngineCommand {
        return this.build([ "network", "ls", "--format", "{{.Name}}" ]);
    }

    stats(): EngineCommand {
        return this.build([ "stats", "--format", "json", "--no-stream" ]);
    }

    private build(args: readonly string[]): EngineCommand {
        return command(this.binary, [ ...this.globalArgs, ...args ]);
    }
}
