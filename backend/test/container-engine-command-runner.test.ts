import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_CONTAINER_ENGINE_PROBE_TIMEOUT_MS,
    SpawnCommandRunner,
} from "../container-engine/command-runner";
import type { CommandSpawner, SpawnedCommandResult } from "../container-engine/command-runner";

const command = {
    file: "docker",
    args: [ "version" ],
};

interface SpawnCall {
    file: string;
    args: readonly string[];
    options: { encoding: "utf-8"; timeout: number };
}

function createSpawner(outcome: SpawnedCommandResult | Error) {
    const calls: SpawnCall[] = [];
    const spawn: CommandSpawner = async (file, args, options) => {
        calls.push({
            file,
            args,
            options,
        });
        if (outcome instanceof Error) {
            throw outcome;
        }
        return outcome;
    };
    return {
        calls,
        spawn,
    };
}

test("command runner returns successful probe output", async () => {
    const fixture = createSpawner({
        code: 0,
        stdout: "27.2.1\n",
        stderr: "",
    });

    const result = await new SpawnCommandRunner({ spawn: fixture.spawn }).run(command);

    assert.deepEqual(result, {
        exitCode: 0,
        stdout: "27.2.1\n",
        stderr: "",
    });
    assert.deepEqual(fixture.calls, [{
        file: "docker",
        args: [ "version" ],
        options: {
            encoding: "utf-8",
            timeout: DEFAULT_CONTAINER_ENGINE_PROBE_TIMEOUT_MS,
        },
    }]);
});

test("command runner preserves a nonzero probe exit code", async () => {
    const failure = Object.assign(new Error("probe failed"), {
        code: 125,
        stdout: "",
        stderr: "cannot connect",
    });
    const fixture = createSpawner(failure);

    const result = await new SpawnCommandRunner({ spawn: fixture.spawn }).run(command);

    assert.deepEqual(result, {
        exitCode: 125,
        stdout: "",
        stderr: "cannot connect",
    });
});

test("command runner converts a thrown spawn failure to a nonzero result", async () => {
    const fixture = createSpawner(new Error("spawn failed"));

    const result = await new SpawnCommandRunner({ spawn: fixture.spawn }).run(command);

    assert.deepEqual(result, {
        exitCode: 1,
        stdout: "",
        stderr: "",
    });
});

test("command runner treats timeout signal termination as failure without waiting", async () => {
    const fixture = createSpawner({
        code: null,
        signal: "SIGTERM",
        stdout: "partial output",
        stderr: "",
    });

    const result = await new SpawnCommandRunner({
        timeoutMs: 25,
        spawn: fixture.spawn,
    }).run(command);

    assert.deepEqual(result, {
        exitCode: 1,
        stdout: "partial output",
        stderr: "",
    });
    assert.equal(fixture.calls[0].options.timeout, 25);
});
