import { command, ContainerEngine } from "./container-engine";
import type { ContainerEngineConfig, EngineCommand } from "./types";
import { parse as parseDotenv } from "dotenv";
import fs from "node:fs";
import path from "node:path";

interface ComposeEnvironmentFile {
    readonly index: number;
    readonly path: string;
}

/** Merge Compose environment files in their documented left-to-right order. */
function mergeComposeEnvironmentFiles(contents: readonly string[]): Readonly<Record<string, string>> {
    return Object.freeze(Object.assign({}, ...contents.map((content) => parseDotenv(content))));
}

function composeEnvironmentFiles(args: readonly string[]): readonly ComposeEnvironmentFile[] {
    const files: ComposeEnvironmentFile[] = [];

    for (let index = 0; index < args.length - 1; index++) {
        if (args[index] === "--env-file") {
            files.push({
                index,
                path: args[index + 1],
            });
            index++;
        }
    }

    return files;
}

function keepLastComposeEnvironmentFile(args: readonly string[], files: readonly ComposeEnvironmentFile[]): readonly string[] {
    if (files.length < 2) {
        return args;
    }

    const lastFileIndex = files[files.length - 1].index;
    return args.filter((_, index) => {
        return !files.some((file) => file.index !== lastFileIndex && (index === file.index || index === file.index + 1));
    });
}

/**
 * Podman command construction. `podman compose` remains the stable argv
 * boundary while provider-specific compatibility stays inside this adapter.
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

    composeCommand(args: readonly string[], workingDirectory?: string): EngineCommand {
        if (args[0] !== "compose") {
            throw new Error("Compose commands must begin with the compose subcommand");
        }

        const environmentFiles = composeEnvironmentFiles(args);
        const canMergeEnvironmentFiles = environmentFiles.length > 0 && workingDirectory !== undefined;
        const composeEnvironment = !canMergeEnvironmentFiles
            ? {}
            : mergeComposeEnvironmentFiles(environmentFiles.map((file) => fs.readFileSync(path.resolve(workingDirectory, file.path), "utf-8")));

        // `podman compose` delegates to an external provider. The Podman CLI's
        // --url flag is not inherited by podman-compose, so pass the configured
        // remote endpoint through the provider's documented environment.
        // podman-compose 1.3.0 accepts only one --env-file. Passing merged
        // values as defaults preserves global/local file precedence while
        // retaining Docker Compose's inherited-shell-env precedence. The
        // configured rootful socket remains a required provider override.
        const env = this.config.socket === undefined ? undefined : {
            CONTAINER_HOST: this.config.socket,
        };
        return this.build(
            canMergeEnvironmentFiles ? keepLastComposeEnvironmentFile(args, environmentFiles) : args,
            env,
            Object.keys(composeEnvironment).length === 0 ? undefined : composeEnvironment,
        );
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

    /**
     * Follow one container at a time. Remote Podman rejects multi-container
     * log requests, so Stack fans these commands out for combined logs.
     */
    containerLogs(containerId: string): EngineCommand {
        return this.build([ "logs", "-f", "--tail", "100", containerId ]);
    }

    networkList(): EngineCommand {
        return this.build([ "network", "ls", "--format", "{{.Name}}" ]);
    }

    stats(): EngineCommand {
        return this.build([ "stats", "--format", "json", "--no-stream" ]);
    }

    private build(
        args: readonly string[],
        env?: Readonly<Record<string, string>>,
        envDefaults?: Readonly<Record<string, string>>,
    ): EngineCommand {
        return command(this.binary, [ ...this.globalArgs, ...args ], env, envDefaults);
    }
}
