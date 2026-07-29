import net from "node:net";
import path from "node:path";

const DEFAULT_SOCKET_PATH = "/run/dockge-quadlet-helper.sock";
const SOCKET_ENV = "DOCKGE_QUADLET_HELPER_SOCKET";
const REQUIRED_READ_ONLY_OPERATIONS = [ "helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal" ];
export const QUADLET_HELPER_PROTOCOL_VERSION = 1;
export const MAX_REQUEST_FRAME_BYTES = 64 * 1024;
export const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 5 * 1000;

export interface QuadletHelperConfig {
    readonly socketPath: string;
}

export interface QuadletHelperProtocol {
    readonly min: number;
    readonly max: number;
    readonly active: number;
}

export interface QuadletHelperRoot {
    readonly id: string;
    readonly available: boolean;
}

export interface QuadletHelperLimits {
    readonly requestBytes: number;
    readonly responseBytes: number;
    readonly requestTimeoutSeconds: number;
    readonly maxConnections: number;
    readonly maxJournalStreams: number;
    readonly journalHistoryRecords: number;
    readonly journalHistoryBytes: number;
    readonly journalRecordBytes: number;
    readonly journalFollowSeconds: number;
    readonly heartbeatSeconds: number;
}

interface QuadletHelperSystem {
    readonly generatorPath: string;
    readonly systemctlPath: string;
    readonly journalctlPath: string;
}

export interface QuadletHelperCapabilities {
    readonly helperVersion: string;
    readonly buildID: string;
    readonly protocol: QuadletHelperProtocol;
    readonly mode: string;
    readonly operations: readonly string[];
    readonly resourceTypes: readonly string[];
    readonly roots: readonly QuadletHelperRoot[];
    readonly limits: QuadletHelperLimits;
    readonly system: QuadletHelperSystem;
}

export type QuadletHelperState = "disabled" | "unavailable" | "incompatible" | "read-only";

/** Safe capability fields suitable for the authenticated Socket.IO info event. */
export interface QuadletHelperStatus {
    readonly state: QuadletHelperState;
    readonly helperVersion?: string;
    readonly buildID?: string;
    readonly protocolVersion?: number;
    readonly mode?: string;
    readonly operations?: readonly string[];
    readonly resourceTypes?: readonly string[];
    readonly roots?: readonly QuadletHelperRoot[];
    readonly limits?: QuadletHelperLimits;
}

export class QuadletHelperConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QuadletHelperConfigError";
    }
}

export class QuadletHelperRequestError extends Error {
    readonly kind: "unavailable" | "protocol" | "timeout";

    constructor(kind: "unavailable" | "protocol" | "timeout", message: string) {
        super(message);
        this.name = "QuadletHelperRequestError";
        this.kind = kind;
    }
}

/** Parse only the socket override, keeping Docker-only installations inert. */
export function parseQuadletHelperConfig(env: NodeJS.ProcessEnv = process.env): QuadletHelperConfig {
    const configuredPath = env[SOCKET_ENV];
    const socketPath = configuredPath === undefined || configuredPath === "" ? DEFAULT_SOCKET_PATH : configuredPath;

    if (
        socketPath !== socketPath.trim() ||
        socketPath.includes("\0") ||
        /[\r\n]/.test(socketPath) ||
        !path.isAbsolute(socketPath) ||
        Buffer.byteLength(socketPath, "utf8") > 107
    ) {
        throw new QuadletHelperConfigError(`${SOCKET_ENV} must be an absolute Unix socket path without surrounding whitespace or control characters`);
    }

    return Object.freeze({ socketPath });
}

/**
 * A deliberately one-operation client. Gate 4 only needs capability
 * negotiation; future operations must add their own typed request/response
 * validators rather than exposing a generic helper RPC primitive.
 */
export class QuadletHelperClient {
    readonly config: QuadletHelperConfig;
    readonly requestTimeoutMs: number;

    constructor(config: QuadletHelperConfig, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
        this.config = config;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    async capabilities(): Promise<QuadletHelperCapabilities> {
        const id = "helper_capabilities";
        const response = await this.request({
            version: QUADLET_HELPER_PROTOCOL_VERSION,
            id,
            operation: "helper.capabilities",
            arguments: {},
        });

        return parseCapabilitiesResponse(response, id);
    }

    private request(request: Record<string, unknown>): Promise<unknown> {
        const payload = Buffer.from(JSON.stringify(request), "utf8");
        if (payload.length > MAX_REQUEST_FRAME_BYTES) {
            return Promise.reject(new QuadletHelperRequestError("protocol", "Quadlet helper request exceeds the frame limit"));
        }

        const frame = Buffer.allocUnsafe(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);

        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.config.socketPath);
            let settled = false;
            let received = Buffer.alloc(0);
            const timeout = setTimeout(() => {
                fail(new QuadletHelperRequestError("timeout", "Quadlet helper capability request timed out"));
            }, this.requestTimeoutMs);

            const cleanup = () => {
                clearTimeout(timeout);
                socket.removeAllListeners();
                socket.destroy();
            };
            const fail = (error: QuadletHelperRequestError) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };
            const succeed = (response: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(response);
            };

            socket.once("connect", () => {
                socket.write(frame, (error) => {
                    if (error) {
                        fail(new QuadletHelperRequestError("unavailable", "Unable to write Quadlet helper capability request"));
                    }
                });
            });
            socket.on("data", (chunk: Buffer) => {
                if (settled) {
                    return;
                }
                received = Buffer.concat([ received, chunk ]);

                if (received.length < 4) {
                    return;
                }

                const responseLength = received.readUInt32BE(0);
                if (responseLength === 0 || responseLength > MAX_RESPONSE_FRAME_BYTES) {
                    fail(new QuadletHelperRequestError("protocol", "Quadlet helper response frame is invalid or exceeds the limit"));
                    return;
                }

                if (received.length < responseLength + 4) {
                    return;
                }
                if (received.length !== responseLength + 4) {
                    fail(new QuadletHelperRequestError("protocol", "Quadlet helper sent an unexpected extra response frame"));
                    return;
                }

                try {
                    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(4));
                    succeed(JSON.parse(decoded) as unknown);
                } catch {
                    fail(new QuadletHelperRequestError("protocol", "Quadlet helper response is not valid UTF-8 JSON"));
                }
            });
            socket.once("error", () => {
                fail(new QuadletHelperRequestError("unavailable", "Quadlet helper is unavailable"));
            });
            socket.once("end", () => {
                if (!settled) {
                    fail(new QuadletHelperRequestError("protocol", "Quadlet helper closed before sending a complete response"));
                }
            });
        });
    }
}

/** Probe only Podman endpoints; all probe failures become an informational status. */
export async function detectQuadletHelperStatus(engineKind: string, env: NodeJS.ProcessEnv = process.env): Promise<QuadletHelperStatus> {
    if (engineKind !== "podman") {
        return Object.freeze({ state: "disabled" });
    }

    try {
        const capabilities = await new QuadletHelperClient(parseQuadletHelperConfig(env)).capabilities();
        if (
            capabilities.protocol.min > QUADLET_HELPER_PROTOCOL_VERSION ||
            capabilities.protocol.max < QUADLET_HELPER_PROTOCOL_VERSION ||
            capabilities.protocol.active !== QUADLET_HELPER_PROTOCOL_VERSION ||
            capabilities.mode !== "read-only" ||
            !REQUIRED_READ_ONLY_OPERATIONS.every((operation) => capabilities.operations.includes(operation))
        ) {
            return Object.freeze({ state: "incompatible" });
        }

        return Object.freeze({
            state: "read-only",
            helperVersion: capabilities.helperVersion,
            buildID: capabilities.buildID,
            protocolVersion: capabilities.protocol.active,
            mode: capabilities.mode,
            operations: capabilities.operations,
            resourceTypes: capabilities.resourceTypes,
            roots: capabilities.roots,
            limits: capabilities.limits,
        });
    } catch (error) {
        if (error instanceof QuadletHelperRequestError && error.kind === "protocol") {
            return Object.freeze({ state: "incompatible" });
        }

        return Object.freeze({ state: "unavailable" });
    }
}

function parseCapabilitiesResponse(response: unknown, id: string): QuadletHelperCapabilities {
    if (!isRecord(response)) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper response must be an object");
    }
    if (response.version !== QUADLET_HELPER_PROTOCOL_VERSION) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper response protocol version does not match");
    }
    if (response.id !== id) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper response ID does not match");
    }
    if (response.type !== "result" || response.ok !== true || !isRecord(response.result)) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper capability response has an invalid terminal envelope");
    }

    return parseCapabilities(response.result);
}

function parseCapabilities(result: Record<string, unknown>): QuadletHelperCapabilities {
    const protocol = parseProtocol(result.protocol);
    const limits = parseLimits(result.limits);
    const system = parseSystem(result.system);
    const capabilities: QuadletHelperCapabilities = {
        helperVersion: requiredString(result, "helperVersion"),
        buildID: requiredString(result, "buildID"),
        protocol,
        mode: requiredString(result, "mode"),
        operations: parseStringArray(result.operations, "operations"),
        resourceTypes: parseStringArray(result.resourceTypes, "resourceTypes"),
        roots: parseRoots(result.roots),
        limits,
        system,
    };

    if (
        !capabilities.operations.includes("helper.capabilities") ||
        limits.requestBytes > MAX_REQUEST_FRAME_BYTES ||
        limits.responseBytes > MAX_RESPONSE_FRAME_BYTES ||
        limits.requestTimeoutSeconds > REQUEST_TIMEOUT_MS / 1000
    ) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper advertised unsupported capability limits");
    }

    return freezeCapabilities(capabilities);
}

function parseProtocol(value: unknown): QuadletHelperProtocol {
    const protocol = requiredRecord(value, "protocol");
    const min = requiredPositiveInteger(protocol, "min");
    const max = requiredPositiveInteger(protocol, "max");
    const active = requiredPositiveInteger(protocol, "active");
    if (min > max || active < min || active > max) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper advertised an invalid protocol range");
    }
    return Object.freeze({ min,
        max,
        active });
}

function parseLimits(value: unknown): QuadletHelperLimits {
    const limits = requiredRecord(value, "limits");
    return Object.freeze({
        requestBytes: requiredPositiveInteger(limits, "requestBytes"),
        responseBytes: requiredPositiveInteger(limits, "responseBytes"),
        requestTimeoutSeconds: requiredPositiveInteger(limits, "requestTimeoutSeconds"),
        maxConnections: requiredPositiveInteger(limits, "maxConnections"),
        maxJournalStreams: requiredPositiveInteger(limits, "maxJournalStreams"),
        journalHistoryRecords: requiredPositiveInteger(limits, "journalHistoryRecords"),
        journalHistoryBytes: requiredPositiveInteger(limits, "journalHistoryBytes"),
        journalRecordBytes: requiredPositiveInteger(limits, "journalRecordBytes"),
        journalFollowSeconds: requiredPositiveInteger(limits, "journalFollowSeconds"),
        heartbeatSeconds: requiredPositiveInteger(limits, "heartbeatSeconds"),
    });
}

function parseSystem(value: unknown): QuadletHelperSystem {
    const system = requiredRecord(value, "system");
    return Object.freeze({
        generatorPath: requiredString(system, "generatorPath"),
        systemctlPath: requiredString(system, "systemctlPath"),
        journalctlPath: requiredString(system, "journalctlPath"),
    });
}

function parseRoots(value: unknown): readonly QuadletHelperRoot[] {
    if (!Array.isArray(value)) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper roots must be an array");
    }
    return Object.freeze(value.map((entry) => {
        const root = requiredRecord(entry, "root");
        if (typeof root.available !== "boolean") {
            throw new QuadletHelperRequestError("protocol", "Quadlet helper root availability must be a boolean");
        }
        return Object.freeze({
            id: requiredString(root, "id"),
            available: root.available,
        });
    }));
}

function parseStringArray(value: unknown, name: string): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new QuadletHelperRequestError("protocol", `Quadlet helper ${name} must be an array of strings`);
    }
    return Object.freeze([ ...value ]);
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new QuadletHelperRequestError("protocol", `Quadlet helper ${name} must be an object`);
    }
    return value;
}

function requiredString(record: Record<string, unknown>, name: string): string {
    const value = record[name];
    if (typeof value !== "string" || value.length === 0) {
        throw new QuadletHelperRequestError("protocol", `Quadlet helper ${name} must be a non-empty string`);
    }
    return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, name: string): number {
    const value = record[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new QuadletHelperRequestError("protocol", `Quadlet helper ${name} must be a positive integer`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeCapabilities(capabilities: QuadletHelperCapabilities): QuadletHelperCapabilities {
    return Object.freeze({
        ...capabilities,
        operations: Object.freeze([ ...capabilities.operations ]),
        resourceTypes: Object.freeze([ ...capabilities.resourceTypes ]),
        roots: Object.freeze(capabilities.roots.map((root) => Object.freeze({ ...root }))),
    });
}
