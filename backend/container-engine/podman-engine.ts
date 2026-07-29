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
        // `podman compose` delegates to an external provider. The Podman CLI's
        // --url flag is not inherited by podman-compose, so pass the configured
        // remote endpoint through the provider's documented environment.
        return this.build(args, this.config.socket === undefined ? undefined : {
            CONTAINER_HOST: this.config.socket,
        });
    }

    composeList(): EngineCommand {
        // podman-compose 1.3.0 does not implement `compose ls`. Compose
        // containers carry this label, so the Podman API can provide the same
        // project inventory without depending on a provider-specific command.
        return this.build([ "ps", "-a", "--filter", "label=com.docker.compose.project", "--format", "json" ]);
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

    private build(args: readonly string[], env?: Readonly<Record<string, string>>): EngineCommand {
        return command(this.binary, [ ...this.globalArgs, ...args ], env);
    }
}
