/**
 * Build Docker Compose arguments from already-validated environment-file state.
 * Keeping this pure makes command behavior independently testable.
 */
export function getComposeOptions(command : string, extraOptions : string[], hasGlobalEnv : boolean, hasLocalEnv : boolean) : string[] {
    const options = [ "compose", command, ...extraOptions ];

    if (hasGlobalEnv) {
        // Docker Compose processes later --env-file values last, so a stack's
        // local .env intentionally overrides the global defaults.
        options.splice(1, 0, "--env-file", "../global.env");
        if (hasLocalEnv) {
            options.splice(3, 0, "--env-file", "./.env");
        }
    }

    return options;
}
