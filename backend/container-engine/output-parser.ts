/** The Compose project fields currently consumed by Stack status handling. */
export interface ComposeListOutput {
    Name: string;
    Status: string;
    ConfigFiles?: string;
    [key: string]: unknown;
}

/** The valid project-name subset Dockge can safely map back to a stack. */
const stackNamePattern = /^[a-z0-9_-]+$/;

/** The Compose service fields currently sent to the stack UI. */
export interface ComposePsOutput {
    Service: string;
    State: string;
    Name: string;
    Health?: string;
}

/** The direct container-status fields used for clean-exit status checks. */
export interface ContainerPsOutput {
    ID?: string;
    Image?: string;
    Command?: string;
    CreatedAt?: string;
    RunningFor?: string;
    Status: string;
    Ports?: string;
    Names?: string;
}

/** The non-sensitive Docker-compatible stats fields rendered by the UI. */
export interface ContainerStatsOutput {
    Container?: string;
    ID?: string;
    Name: string;
    CPUPerc?: string;
    MemUsage?: string;
    MemPerc?: string;
    NetIO?: string;
    BlockIO?: string;
    PIDs?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord, field: string): string | undefined {
    const value = record[field];
    return typeof value === "string" ? value : undefined;
}

/**
 * Parse either a JSON array or newline-delimited JSON. Invalid records are
 * deliberately discarded so command output never becomes an error payload.
 */
function parseJsonRecords(stdout: string): JsonRecord[] {
    const output = stdout.trim();
    if (!output) {
        return [];
    }

    if (output.startsWith("[")) {
        try {
            const parsed = JSON.parse(output);
            return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
        } catch {
            return [];
        }
    }

    const records: JsonRecord[] = [];
    for (const line of stdout.split("\n")) {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
            continue;
        }

        try {
            const parsed = JSON.parse(trimmedLine);
            if (isRecord(parsed)) {
                records.push(parsed);
            }
        } catch {
            // Ignore malformed individual lines without logging their content.
        }
    }
    return records;
}

function parseJsonArrayRecords(stdout: string): JsonRecord[] {
    try {
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch {
        return [];
    }
}

/** Parse `compose ls --format json` output into the fields Stack uses. */
export function parseComposeListOutput(stdout: string): ComposeListOutput[] {
    return parseJsonArrayRecords(stdout).flatMap((record) => {
        const Name = stringField(record, "Name");
        const Status = stringField(record, "Status");
        if (!Name || Status === undefined) {
            return [];
        }

        const ConfigFiles = stringField(record, "ConfigFiles");
        return [{
            Name,
            Status,
            ...(ConfigFiles === undefined ? {} : { ConfigFiles }),
        }];
    });
}

/**
 * Build Compose-like project rows from Podman's direct container inventory.
 * podman-compose 1.3.0 has no `compose ls`, while its containers retain the
 * standard project label. Invalid records and labels are ignored so untrusted
 * CLI output cannot become a filesystem-backed stack name.
 */
export function parsePodmanComposeListOutput(stdout: string): ComposeListOutput[] {
    const stateCounts = new Map<string, Map<string, number>>();

    for (const record of parseJsonRecords(stdout)) {
        if (record.IsInfra === true) {
            continue;
        }

        const labels = record.Labels;
        if (!isRecord(labels)) {
            continue;
        }

        const name = labels["com.docker.compose.project"];
        const state = stringField(record, "State")?.toLowerCase();
        if (typeof name !== "string" || !stackNamePattern.test(name) || !state) {
            continue;
        }

        const states = stateCounts.get(name) ?? new Map<string, number>();
        states.set(state, (states.get(state) ?? 0) + 1);
        stateCounts.set(name, states);
    }

    return [ ...stateCounts.entries() ]
        .map(([ Name, states ]) => ({
            Name,
            Status: podmanProjectStatus(states),
        }))
        .sort((left, right) => left.Name.localeCompare(right.Name));
}

function podmanProjectStatus(states: Map<string, number>): string {
    const groups = [
        [ "exited", [ "exited", "stopped", "stopping" ]],
        [ "running", [ "running" ]],
        [ "created", [ "created", "configured", "initialized" ]],
    ] as const;
    const statusParts: string[] = [];
    const handledStates = new Set<string>();

    for (const [ status, matchingStates ] of groups) {
        let count = 0;
        for (const state of matchingStates) {
            handledStates.add(state);
            count += states.get(state) ?? 0;
        }
        if (count > 0) {
            statusParts.push(`${status}(${count})`);
        }
    }

    for (const [ state, count ] of [ ...states.entries() ].sort(([ left ], [ right ]) => left.localeCompare(right))) {
        if (!handledStates.has(state)) {
            statusParts.push(`${state}(${count})`);
        }
    }

    return statusParts.join(", ");
}

/** Parse Compose `ps --format json` array or NDJSON output. */
export function parseComposePsOutput(stdout: string): ComposePsOutput[] {
    return parseJsonRecords(stdout).flatMap((record) => {
        const Service = stringField(record, "Service");
        const State = stringField(record, "State");
        const Name = stringField(record, "Name");
        if (!Service || State === undefined || !Name) {
            return [];
        }

        const Health = stringField(record, "Health");
        return [{
            Service,
            State,
            Name,
            ...(Health === undefined ? {} : { Health }),
        }];
    });
}

/** Parse direct `ps --format json` NDJSON output for stack exit checks. */
export function parseContainerPsOutput(stdout: string): ContainerPsOutput[] {
    return parseJsonRecords(stdout).flatMap((record) => {
        if (record.IsInfra === true) {
            return [];
        }

        const Status = stringField(record, "Status");
        if (Status === undefined) {
            return [];
        }

        const output: ContainerPsOutput = { Status };
        for (const field of [ "ID", "Image", "Command", "CreatedAt", "RunningFor", "Ports", "Names" ]) {
            const value = stringField(record, field);
            if (value !== undefined) {
                output[field as keyof Omit<ContainerPsOutput, "Status">] = value;
            }
        }
        return [ output ];
    });
}

/** Parse and sort newline-delimited network names. */
export function parseNetworkListOutput(stdout: string): string[] {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name !== "")
        .sort((left, right) => left.localeCompare(right));
}

/** Parse safe, UI-rendered fields from Docker-compatible stats NDJSON. */
export function parseStatsOutput(stdout: string): Map<string, ContainerStatsOutput> {
    const stats = new Map<string, ContainerStatsOutput>();
    const fields = [ "Container", "ID", "CPUPerc", "MemUsage", "MemPerc", "NetIO", "BlockIO", "PIDs" ] as const;

    for (const record of parseJsonRecords(stdout)) {
        const Name = stringField(record, "Name");
        if (!Name) {
            continue;
        }

        const output: ContainerStatsOutput = { Name };
        for (const field of fields) {
            const value = stringField(record, field);
            if (value !== undefined) {
                output[field] = value;
            }
        }
        stats.set(Name, output);
    }
    return stats;
}
