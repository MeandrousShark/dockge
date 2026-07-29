import childProcessAsync from "promisify-child-process";
import { commandEnvironment } from "./container-engine";
import type { EngineCommand, EngineCommandResult, EngineCommandRunner } from "./types";

/** A fixed upper bound prevents startup version probes from blocking indefinitely. */
export const DEFAULT_CONTAINER_ENGINE_PROBE_TIMEOUT_MS = 10_000;

export interface SpawnedCommandResult {
    readonly code?: number | null;
    readonly signal?: string | null;
    readonly stdout?: Buffer | string | null;
    readonly stderr?: Buffer | string | null;
}

export type CommandSpawner = (
    file: string,
    args: readonly string[],
    options: { encoding: "utf-8"; timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<SpawnedCommandResult>;

export interface SpawnCommandRunnerOptions {
    readonly timeoutMs?: number;
    readonly spawn?: CommandSpawner;
}

const defaultSpawn: CommandSpawner = async (file, args, options) => {
    return await childProcessAsync.spawn(file, [ ...args ], options);
};

function resultFromProcess(result: SpawnedCommandResult): EngineCommandResult {
    return {
        exitCode: result.signal || result.code === null || result.code === undefined ? 1 : result.code,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
    };
}

/** Production process runner for bounded, argv-only engine probes. */
export class SpawnCommandRunner implements EngineCommandRunner {
    private readonly timeoutMs: number;
    private readonly spawn: CommandSpawner;

    constructor(options: SpawnCommandRunnerOptions = {}) {
        this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTAINER_ENGINE_PROBE_TIMEOUT_MS;
        this.spawn = options.spawn ?? defaultSpawn;
    }

    async run(command: EngineCommand): Promise<EngineCommandResult> {
        try {
            const env = commandEnvironment(command);
            const result = await this.spawn(command.file, command.args, {
                encoding: "utf-8",
                timeout: this.timeoutMs,
                ...(env === undefined ? {} : { env }),
            });
            return resultFromProcess(result);
        } catch (error) {
            return resultFromProcess(error as SpawnedCommandResult);
        }
    }
}
