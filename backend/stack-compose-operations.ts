import { getComposeOptions } from "./compose-options";

/**
 * Fixed Compose command shapes used by Stack lifecycle, status, and terminal
 * operations. Keep this dependency-free so every Stack callsite can share one
 * regression-tested contract without loading terminal infrastructure.
 */
const stackComposeOperationArguments = {
    "stack-ps": [ "ps", "--format", "json" ],
    deploy: [ "up", "-d", "--remove-orphans" ],
    delete: [ "down", "--remove-orphans" ],
    "force-delete": [ "down", "-v", "--remove-orphans" ],
    start: [ "up", "-d", "--remove-orphans" ],
    stop: [ "stop" ],
    restart: [ "restart" ],
    down: [ "down" ],
    "update-pull": [ "pull" ],
    "update-redeploy": [ "up", "-d", "--remove-orphans" ],
    "combined-logs": [ "logs", "-f", "--tail", "100" ],
    "container-exec": [ "exec" ],
    "service-status": [ "ps", "--format", "json" ],
    "start-service": [ "up", "-d" ],
    "stop-service": [ "stop" ],
    "restart-service": [ "restart" ],
} as const satisfies Record<string, readonly string[]>;

export type StackComposeOperation = keyof typeof stackComposeOperationArguments;

/** Build full Compose arguments for one Stack operation and environment state. */
export function getStackComposeOptions(
    operation: StackComposeOperation,
    operationArguments: readonly string[],
    hasGlobalEnv: boolean,
    hasLocalEnv: boolean,
) : string[] {
    const [ command, ...fixedArguments ] = stackComposeOperationArguments[operation];
    return getComposeOptions(command, [ ...fixedArguments, ...operationArguments ], hasGlobalEnv, hasLocalEnv);
}
