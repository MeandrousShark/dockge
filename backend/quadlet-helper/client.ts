import net from "node:net";
import path from "node:path";
import {
    normalizeQuadletStatus,
    type QuadletFileKind,
    type QuadletJournalEvent,
    type QuadletJournalOptions,
    type QuadletRequestOptions,
    type QuadletResource,
    type QuadletResourceSelector,
    type QuadletResourceType,
    type QuadletRootID,
    type QuadletStatus,
    type QuadletSystemdProperties,
} from "../../common/quadlet";

const DEFAULT_SOCKET_PATH = "/run/dockge-quadlet-helper.sock";
const SOCKET_ENV = "DOCKGE_QUADLET_HELPER_SOCKET";
const REQUIRED_READ_ONLY_OPERATIONS = [ "helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal" ];
const ROOT_IDS = [ "admin", "runtime", "distribution" ] as const;
const FILE_KINDS = [ "regular", "symlink", "directory", "irregular" ] as const;
const SYSTEMD_PROPERTY_NAMES = [ "Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "FragmentPath", "SourcePath", "Result", "ExecMainCode", "ExecMainStatus", "ActiveEnterTimestamp", "InactiveEnterTimestamp" ] as const;
const HELPER_ERROR_CODES = [ "invalid_request", "unauthorized_peer", "unsupported_version", "unsupported_operation", "capability_disabled", "invalid_resource", "not_found", "conflict", "busy", "external_read_only", "ownership_mismatch", "validation_failed", "publish_failed", "reload_failed", "unit_failed", "timeout", "cancelled", "internal" ] as const;
const MAX_JOURNAL_LINES = 1000;

export const QUADLET_HELPER_PROTOCOL_VERSION = 1;
export const MAX_REQUEST_FRAME_BYTES = 64 * 1024;
export const MAX_RESPONSE_FRAME_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 5 * 1000;

export interface QuadletHelperConfig { readonly socketPath: string; }
export interface QuadletHelperProtocol { readonly min: number; readonly max: number; readonly active: number; }
export interface QuadletHelperRoot { readonly id: QuadletRootID; readonly available: boolean; }
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
interface QuadletHelperSystem { readonly generatorPath: string; readonly systemctlPath: string; readonly journalctlPath: string; }
export interface QuadletHelperCapabilities {
    readonly helperVersion: string;
    readonly buildID: string;
    readonly protocol: QuadletHelperProtocol;
    readonly mode: "read-only" | string;
    readonly operations: readonly string[];
    readonly resourceTypes: readonly string[];
    readonly roots: readonly QuadletHelperRoot[];
    readonly limits: QuadletHelperLimits;
    readonly system: QuadletHelperSystem;
}
export type QuadletHelperState = "disabled" | "unavailable" | "incompatible" | "read-only";
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
export type QuadletHelperErrorCode = typeof HELPER_ERROR_CODES[number];

export class QuadletHelperConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QuadletHelperConfigError";
    }
}
export class QuadletHelperRequestError extends Error {
    readonly kind: "unavailable" | "protocol" | "timeout" | "cancelled";
    constructor(kind: "unavailable" | "protocol" | "timeout" | "cancelled", message: string) {
        super(message);
        this.name = "QuadletHelperRequestError";
        this.kind = kind;
    }
}
/** A typed, allowlisted terminal error returned by the helper. */
export class QuadletHelperOperationError extends Error {
    readonly code: QuadletHelperErrorCode;
    readonly retryable: boolean;
    constructor(code: QuadletHelperErrorCode, message: string, retryable: boolean) {
        super(message);
        this.name = "QuadletHelperOperationError";
        this.code = code;
        this.retryable = retryable;
    }
}

export function parseQuadletHelperConfig(env: NodeJS.ProcessEnv = process.env): QuadletHelperConfig {
    const configuredPath = env[SOCKET_ENV];
    const socketPath = configuredPath === undefined || configuredPath === "" ? DEFAULT_SOCKET_PATH : configuredPath;
    if (socketPath !== socketPath.trim() || socketPath.includes("\0") || /[\r\n]/.test(socketPath) || !path.isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > 107) {
        throw new QuadletHelperConfigError(`${SOCKET_ENV} must be an absolute Unix socket path without surrounding whitespace or control characters`);
    }
    return Object.freeze({ socketPath });
}

/** Strict client for the helper's fixed, read-only operation allowlist. */
export class QuadletHelperClient {
    readonly config: QuadletHelperConfig;
    readonly requestTimeoutMs: number;

    constructor(config: QuadletHelperConfig, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
        this.config = config;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    async capabilities(options: QuadletRequestOptions = {}): Promise<QuadletHelperCapabilities> {
        const id = "helper_capabilities";
        return parseCapabilitiesResponse(await this.oneShot(id, "helper.capabilities", {}, options.signal), id);
    }

    async list(options: QuadletRequestOptions = {}): Promise<readonly QuadletResource[]> {
        const id = "quadlet_list";
        return parseListResponse(await this.oneShot(id, "quadlet.list", {}, options.signal), id);
    }

    async status(selector: QuadletResourceSelector, options: QuadletRequestOptions = {}): Promise<QuadletStatus> {
        validateSelector(selector);
        const id = "quadlet_status";
        return parseStatusResponse(await this.oneShot(id, "quadlet.status", selector, options.signal), id);
    }

    async *journal(selector: QuadletResourceSelector, options: QuadletJournalOptions): AsyncGenerator<QuadletJournalEvent> {
        validateSelector(selector);
        validateJournalOptions(options);
        const id = "quadlet_journal";
        const stream = new FramedJournalStream(this.config.socketPath, this.requestTimeoutMs, {
            version: QUADLET_HELPER_PROTOCOL_VERSION,
            id,
            operation: "quadlet.journal",
            arguments: { root: selector.root,
                sourceName: selector.sourceName,
                lines: options.lines,
                follow: options.follow === true,
                ...(options.since === undefined ? {} : { since: options.since }),
                ...(options.until === undefined ? {} : { until: options.until }) },
        }, options.signal);
        let nextSequence = 1;
        try {
            for await (const response of stream) {
                const event = parseJournalFrame(response, id);
                if (event.type === "complete") {
                    yield event;
                    return;
                }
                if (event.sequence !== nextSequence) {
                    throw new QuadletHelperRequestError("protocol", "Quadlet helper journal event sequence is invalid");
                }
                nextSequence += 1;
                yield event;
            }
            throw new QuadletHelperRequestError("protocol", "Quadlet helper closed before journal completion");
        } finally {
            stream.cancel();
        }
    }

    private oneShot(id: string, operation: "helper.capabilities" | "quadlet.list" | "quadlet.status", args: object, signal?: AbortSignal): Promise<unknown> {
        return requestOne(this.config.socketPath, this.requestTimeoutMs, { version: QUADLET_HELPER_PROTOCOL_VERSION,
            id,
            operation,
            arguments: args }, signal);
    }
}

/** Probe only Podman endpoints; all probe failures become informational status. */
export async function detectQuadletHelperStatus(engineKind: string, env: NodeJS.ProcessEnv = process.env): Promise<QuadletHelperStatus> {
    if (engineKind !== "podman") {
        return Object.freeze({ state: "disabled" });
    }
    try {
        const capabilities = await new QuadletHelperClient(parseQuadletHelperConfig(env)).capabilities();
        if (capabilities.protocol.min > QUADLET_HELPER_PROTOCOL_VERSION || capabilities.protocol.max < QUADLET_HELPER_PROTOCOL_VERSION || capabilities.protocol.active !== QUADLET_HELPER_PROTOCOL_VERSION || capabilities.mode !== "read-only" || !REQUIRED_READ_ONLY_OPERATIONS.every((operation) => capabilities.operations.includes(operation))) {
            return Object.freeze({ state: "incompatible" });
        }
        return Object.freeze({ state: "read-only",
            helperVersion: capabilities.helperVersion,
            buildID: capabilities.buildID,
            protocolVersion: capabilities.protocol.active,
            mode: capabilities.mode,
            operations: capabilities.operations,
            resourceTypes: capabilities.resourceTypes,
            roots: capabilities.roots,
            limits: capabilities.limits });
    } catch (error) {
        return Object.freeze({ state: error instanceof QuadletHelperRequestError && error.kind === "protocol" ? "incompatible" : "unavailable" });
    }
}

function requestOne(socketPath: string, timeoutMs: number, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const frame = requestFrame(request);
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let settled = false;
        let received = Buffer.alloc(0);
        const timeout = setTimeout(() => fail(new QuadletHelperRequestError("timeout", "Quadlet helper request timed out")), timeoutMs);
        const abort = () => fail(new QuadletHelperRequestError("cancelled", "Quadlet helper request was cancelled"));
        const cleanup = () => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            socket.removeAllListeners();
            socket.destroy();
        };
        const fail = (error: Error) => {
            if (!settled) {
                settled = true;
                cleanup();
                reject(error);
            }
        };
        const succeed = (response: unknown) => {
            if (!settled) {
                settled = true;
                cleanup();
                resolve(response);
            }
        };
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => socket.write(frame, (error) => {
            if (error) {
                fail(new QuadletHelperRequestError("unavailable", "Unable to write Quadlet helper request"));
            }
        }));
        socket.on("data", (chunk: Buffer) => {
            if (settled) {
                return;
            }
            received = Buffer.concat([ received, chunk ]);
            if (received.length < 4) {
                return;
            }
            const length = received.readUInt32BE(0);
            if (length === 0 || length > MAX_RESPONSE_FRAME_BYTES) {
                return fail(new QuadletHelperRequestError("protocol", "Quadlet helper response frame is invalid or exceeds the limit"));
            }
            if (received.length < length + 4) {
                return;
            }
            if (received.length !== length + 4) {
                return fail(new QuadletHelperRequestError("protocol", "Quadlet helper sent an unexpected extra response frame"));
            }
            try {
                succeed(decodeFrame(received.subarray(4)));
            } catch {
                fail(new QuadletHelperRequestError("protocol", "Quadlet helper response is not valid UTF-8 JSON"));
            }
        });
        socket.once("error", () => fail(new QuadletHelperRequestError("unavailable", "Quadlet helper is unavailable")));
        socket.once("end", () => {
            if (!settled) {
                fail(new QuadletHelperRequestError("protocol", "Quadlet helper closed before sending a complete response"));
            }
        });
    });
}

class FramedJournalStream implements AsyncIterable<unknown> {
    private readonly socket: net.Socket;
    private readonly queue: unknown[] = [];
    private readonly waiters: { resolve: (value: IteratorResult<unknown>) => void; reject: (reason: Error) => void }[] = [];
    private readonly timeout: NodeJS.Timeout;
    private readonly signal?: AbortSignal;
    private ended = false;
    private failure: Error | undefined;
    private received = Buffer.alloc(0);
    private readonly abort: () => void;

    constructor(socketPath: string, timeoutMs: number, request: Record<string, unknown>, signal?: AbortSignal) {
        this.socket = net.createConnection(socketPath);
        this.signal = signal;
        this.abort = () => this.finish(new QuadletHelperRequestError("cancelled", "Quadlet helper journal was cancelled"));
        this.timeout = setTimeout(() => this.finish(new QuadletHelperRequestError("timeout", "Quadlet helper journal timed out before a response")), timeoutMs);
        if (signal?.aborted) {
            this.abort();
            return;
        }
        signal?.addEventListener("abort", this.abort, { once: true });
        this.socket.once("connect", () => this.socket.write(requestFrame(request), (error) => {
            if (error) {
                this.finish(new QuadletHelperRequestError("unavailable", "Unable to write Quadlet helper journal request"));
            }
        }));
        this.socket.on("data", (chunk: Buffer) => this.accept(chunk));
        this.socket.once("error", () => this.finish(new QuadletHelperRequestError("unavailable", "Quadlet helper is unavailable")));
        this.socket.once("end", () => this.finish());
        this.socket.once("close", () => this.finish());
    }

    cancel(): void {
        this.signal?.removeEventListener("abort", this.abort);
        this.finish();
    }

    [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
            next: () => this.next(),
            return: async () => {
                this.cancel();
                return { done: true,
                    value: undefined };
            },
        };
    }

    private next(): Promise<IteratorResult<unknown>> {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        const value = this.queue.shift();
        if (value !== undefined) {
            return Promise.resolve({ done: false,
                value });
        }
        if (this.ended) {
            return Promise.resolve({ done: true,
                value: undefined });
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve,
            reject }));
    }

    private accept(chunk: Buffer): void {
        if (this.ended) {
            return;
        }
        this.received = Buffer.concat([ this.received, chunk ]);
        while (this.received.length >= 4) {
            const length = this.received.readUInt32BE(0);
            if (length === 0 || length > MAX_RESPONSE_FRAME_BYTES) {
                this.finish(new QuadletHelperRequestError("protocol", "Quadlet helper response frame is invalid or exceeds the limit"));
                return;
            }
            if (this.received.length < length + 4) {
                return;
            }
            try {
                this.push(decodeFrame(this.received.subarray(4, length + 4)));
            } catch {
                this.finish(new QuadletHelperRequestError("protocol", "Quadlet helper response is not valid UTF-8 JSON"));
                return;
            }
            this.received = this.received.subarray(length + 4);
        }
    }

    private push(value: unknown): void {
        clearTimeout(this.timeout);
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.resolve({ done: false,
                value });
        } else {
            this.queue.push(value);
        }
    }

    private finish(error?: Error): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        this.failure = error;
        clearTimeout(this.timeout);
        this.socket.removeAllListeners();
        this.socket.destroy();
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            if (waiter) {
                if (error) {
                    waiter.reject(error);
                } else {
                    waiter.resolve({ done: true,
                        value: undefined });
                }
            }
        }
    }
}

function requestFrame(request: Record<string, unknown>): Buffer {
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    if (payload.length > MAX_REQUEST_FRAME_BYTES) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper request exceeds the frame limit");
    }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
}
function decodeFrame(payload: Buffer): unknown {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
}

function parseCapabilitiesResponse(response: unknown, id: string): QuadletHelperCapabilities {
    const result = parseTerminalResult(response, id);
    strictKeys(result, [ "helperVersion", "buildID", "protocol", "mode", "operations", "resourceTypes", "roots", "limits", "system" ], "capability result");
    const capabilities: QuadletHelperCapabilities = { helperVersion: requiredString(result, "helperVersion"),
        buildID: requiredString(result, "buildID"),
        protocol: parseProtocol(result.protocol),
        mode: requiredString(result, "mode"),
        operations: parseStringArray(result.operations, "operations"),
        resourceTypes: parseStringArray(result.resourceTypes, "resourceTypes"),
        roots: parseRoots(result.roots),
        limits: parseLimits(result.limits),
        system: parseSystem(result.system) };
    if (!capabilities.operations.includes("helper.capabilities") || capabilities.limits.requestBytes > MAX_REQUEST_FRAME_BYTES || capabilities.limits.responseBytes > MAX_RESPONSE_FRAME_BYTES || capabilities.limits.requestTimeoutSeconds > REQUEST_TIMEOUT_MS / 1000) {
        throw new QuadletHelperRequestError("protocol", "Quadlet helper advertised unsupported capability limits");
    }
    return freezeCapabilities(capabilities);
}
function parseListResponse(response: unknown, id: string): readonly QuadletResource[] {
    const result = parseTerminalResult(response, id);
    strictKeys(result, [ "resources" ], "list result");
    if (!Array.isArray(result.resources)) {
        throw protocolError("Quadlet helper resources must be an array");
    }
    return Object.freeze(result.resources.map(parseResource));
}
function parseStatusResponse(response: unknown, id: string): QuadletStatus {
    const result = parseTerminalResult(response, id);
    strictKeys(result, [ "resource", "properties" ], "status result");
    return normalizeQuadletStatus(parseResource(result.resource), parseSystemdProperties(result.properties));
}
function parseJournalFrame(response: unknown, id: string): QuadletJournalEvent {
    const frame = requiredRecord(response, "journal response");
    if (frame.version !== QUADLET_HELPER_PROTOCOL_VERSION || frame.id !== id) {
        throw protocolError("Quadlet helper journal response does not correlate");
    }
    if (frame.type === "error") {
        throw parseTerminalError(frame, id);
    }
    if (frame.type === "result") {
        const result = parseTerminalResult(frame, id);
        strictKeys(result, [ "records", "complete" ], "journal completion");
        if (requiredPositiveOrZeroInteger(result, "records") === undefined || result.complete !== true) {
            throw protocolError("Quadlet helper journal completion is invalid");
        }
        return Object.freeze({ type: "complete",
            records: result.records as number,
            complete: true });
    }
    strictKeys(frame, [ "version", "id", "type", "event", "sequence", "data" ], "journal event envelope");
    if (frame.type !== "event") {
        throw protocolError("Quadlet helper journal frame type is invalid");
    }
    const sequence = requiredPositiveInteger(frame, "sequence");
    if (frame.event === "journal.record") {
        return Object.freeze({ type: "record",
            sequence,
            data: parseJournalRecord(frame.data) });
    }
    if (frame.event === "journal.heartbeat") {
        strictKeys(requiredRecord(frame.data, "journal heartbeat"), [], "journal heartbeat");
        return Object.freeze({ type: "heartbeat",
            sequence,
            data: Object.freeze({}) });
    }
    throw protocolError("Quadlet helper journal event is invalid");
}

function parseTerminalResult(response: unknown, id: string): Record<string, unknown> {
    const frame = requiredRecord(response, "response");
    if (frame.type === "error") {
        throw parseTerminalError(frame, id);
    }
    strictKeys(frame, [ "version", "id", "type", "ok", "result" ], "terminal result envelope");
    if (frame.version !== QUADLET_HELPER_PROTOCOL_VERSION || frame.id !== id || frame.type !== "result" || frame.ok !== true) {
        throw protocolError("Quadlet helper terminal response is invalid");
    }
    return requiredRecord(frame.result, "result");
}
function parseTerminalError(frame: Record<string, unknown>, id: string): QuadletHelperOperationError {
    strictKeys(frame, [ "version", "id", "type", "ok", "error" ], "terminal error envelope");
    if (frame.version !== QUADLET_HELPER_PROTOCOL_VERSION || frame.id !== id || frame.type !== "error" || frame.ok !== false) {
        throw protocolError("Quadlet helper terminal error is invalid");
    }
    const error = requiredRecord(frame.error, "error");
    strictKeys(error, [ "code", "message", "retryable" ], "helper error");
    const code = requiredString(error, "code");
    if (!(HELPER_ERROR_CODES as readonly string[]).includes(code) || typeof error.retryable !== "boolean") {
        throw protocolError("Quadlet helper error is invalid");
    }
    return new QuadletHelperOperationError(code as QuadletHelperErrorCode, requiredString(error, "message"), error.retryable);
}
function parseResource(value: unknown): QuadletResource {
    const raw = requiredRecord(value, "resource");
    strictKeys(raw, [ "root", "sourceName", "supported", "fileKind", "size", "sha256", "unitId", "managed", "shadowedBy" ], "resource");
    const root = parseRootID(raw.root, "root");
    const sourceName = requiredString(raw, "sourceName");
    const supported = requiredBoolean(raw, "supported");
    const fileKind = requiredOneOf(raw.fileKind, FILE_KINDS, "fileKind") as QuadletFileKind;
    if (raw.managed !== false) {
        throw protocolError("Gate 5 Quadlet resources must be external");
    }
    const extension = sourceName.slice(sourceName.lastIndexOf("."));
    const resourceType = extension === ".container" ? "container" : extension === ".network" ? "network" : extension === ".volume" ? "volume" : "unsupported";
    if (supported !== (resourceType !== "unsupported")) {
        throw protocolError("Quadlet helper resource support does not match its type");
    }
    const size = optionalPositiveOrZeroInteger(raw, "size");
    const sha256 = optionalString(raw, "sha256");
    const unitId = optionalString(raw, "unitId");
    const shadowedBy = raw.shadowedBy === undefined ? undefined : parseRootID(raw.shadowedBy, "shadowedBy");
    if ((fileKind !== "regular" || !supported) && (sha256 !== undefined || unitId !== undefined)) {
        throw protocolError("Quadlet helper returned metadata for an unsafe resource");
    }
    return Object.freeze({ root,
        sourceName,
        resourceType: resourceType as QuadletResourceType,
        fileKind,
        ...(size === undefined ? {} : { size }),
        ...(sha256 === undefined ? {} : { sha256 }),
        ...(unitId === undefined ? {} : { unitId }),
        ...(shadowedBy === undefined ? {} : { shadowedBy }),
        ownership: "external",
        readOnly: true });
}
function parseSystemdProperties(value: unknown): QuadletSystemdProperties {
    const raw = requiredRecord(value, "systemd properties");
    strictKeys(raw, SYSTEMD_PROPERTY_NAMES, "systemd properties");
    for (const [ name, property ] of Object.entries(raw)) {
        if (typeof property !== "string") {
            throw protocolError(`Quadlet helper property ${name} must be a string`);
        }
    }
    return Object.freeze({ ...raw }) as QuadletSystemdProperties;
}
function parseJournalRecord(value: unknown) {
    const raw = requiredRecord(value, "journal record");
    strictKeys(raw, [ "message", "truncated" ], "journal record");
    return Object.freeze({ message: requiredString(raw, "message"),
        truncated: raw.truncated === true });
}
function parseProtocol(value: unknown): QuadletHelperProtocol {
    const raw = requiredRecord(value, "protocol");
    strictKeys(raw, [ "min", "max", "active" ], "protocol");
    const min = requiredPositiveInteger(raw, "min");
    const max = requiredPositiveInteger(raw, "max");
    const active = requiredPositiveInteger(raw, "active");
    if (min > max || active < min || active > max) {
        throw protocolError("Quadlet helper advertised an invalid protocol range");
    }
    return Object.freeze({ min,
        max,
        active });
}
function parseLimits(value: unknown): QuadletHelperLimits {
    const raw = requiredRecord(value, "limits");
    const keys = [ "requestBytes", "responseBytes", "requestTimeoutSeconds", "maxConnections", "maxJournalStreams", "journalHistoryRecords", "journalHistoryBytes", "journalRecordBytes", "journalFollowSeconds", "heartbeatSeconds" ];
    strictKeys(raw, keys, "limits");
    return Object.freeze({ requestBytes: requiredPositiveInteger(raw, "requestBytes"),
        responseBytes: requiredPositiveInteger(raw, "responseBytes"),
        requestTimeoutSeconds: requiredPositiveInteger(raw, "requestTimeoutSeconds"),
        maxConnections: requiredPositiveInteger(raw, "maxConnections"),
        maxJournalStreams: requiredPositiveInteger(raw, "maxJournalStreams"),
        journalHistoryRecords: requiredPositiveInteger(raw, "journalHistoryRecords"),
        journalHistoryBytes: requiredPositiveInteger(raw, "journalHistoryBytes"),
        journalRecordBytes: requiredPositiveInteger(raw, "journalRecordBytes"),
        journalFollowSeconds: requiredPositiveInteger(raw, "journalFollowSeconds"),
        heartbeatSeconds: requiredPositiveInteger(raw, "heartbeatSeconds") });
}
function parseSystem(value: unknown): QuadletHelperSystem {
    const raw = requiredRecord(value, "system");
    strictKeys(raw, [ "generatorPath", "systemctlPath", "journalctlPath" ], "system");
    return Object.freeze({ generatorPath: requiredString(raw, "generatorPath"),
        systemctlPath: requiredString(raw, "systemctlPath"),
        journalctlPath: requiredString(raw, "journalctlPath") });
}
function parseRoots(value: unknown): readonly QuadletHelperRoot[] {
    if (!Array.isArray(value)) {
        throw protocolError("Quadlet helper roots must be an array");
    }
    return Object.freeze(value.map((entry) => {
        const raw = requiredRecord(entry, "root");
        strictKeys(raw, [ "id", "available" ], "root");
        return Object.freeze({ id: parseRootID(raw.id, "id"),
            available: requiredBoolean(raw, "available") });
    }));
}
function parseStringArray(value: unknown, name: string): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw protocolError(`Quadlet helper ${name} must be an array of strings`);
    }
    return Object.freeze([ ...value ]);
}
function validateSelector(selector: QuadletResourceSelector): void {
    if (!isRecord(selector) || !hasOnlyKeys(selector, [ "root", "sourceName" ]) || !isRootID(selector.root) || typeof selector.sourceName !== "string" || Buffer.byteLength(selector.sourceName, "utf8") > 128 || selector.sourceName === "" || selector.sourceName === "." || selector.sourceName === ".." || /[\\/\0\x00-\x1f\x7f]/.test(selector.sourceName) || !/\.(container|network|volume)$/.test(selector.sourceName)) {
        throw new QuadletHelperRequestError("protocol", "Quadlet resource selector is invalid");
    }
}
function validateJournalOptions(options: QuadletJournalOptions): void {
    if (!isRecord(options) || !hasOnlyKeys(options, [ "lines", "follow", "since", "until", "signal" ]) || !Number.isSafeInteger(options.lines) || options.lines < 1 || options.lines > MAX_JOURNAL_LINES || (options.follow !== undefined && typeof options.follow !== "boolean") || (options.since !== undefined && !isRFC3339(options.since)) || (options.until !== undefined && !isRFC3339(options.until)) || (options.since !== undefined && options.until !== undefined && Date.parse(options.since) > Date.parse(options.until))) {
        throw new QuadletHelperRequestError("protocol", "Quadlet journal arguments are invalid");
    }
}
function isRFC3339(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}
function strictKeys(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
    if (Object.keys(record).some((key) => !allowed.includes(key))) {
        throw protocolError(`Quadlet helper ${name} contains an unknown field`);
    }
}
function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
    return !Object.keys(record).some((key) => !allowed.includes(key));
}
function requiredRecord(value: unknown, name: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw protocolError(`Quadlet helper ${name} must be an object`);
    }
    return value;
}
function requiredString(record: Record<string, unknown>, name: string): string {
    const value = record[name];
    if (typeof value !== "string" || value.length === 0) {
        throw protocolError(`Quadlet helper ${name} must be a non-empty string`);
    }
    return value;
}
function optionalString(record: Record<string, unknown>, name: string): string | undefined {
    const value = record[name];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
        throw protocolError(`Quadlet helper ${name} must be a non-empty string`);
    }
    return value;
}
function requiredPositiveInteger(record: Record<string, unknown>, name: string): number {
    const value = record[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw protocolError(`Quadlet helper ${name} must be a positive integer`);
    }
    return value;
}
function requiredPositiveOrZeroInteger(record: Record<string, unknown>, name: string): number | undefined {
    const value = record[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw protocolError(`Quadlet helper ${name} must be a non-negative integer`);
    }
    return value;
}
function optionalPositiveOrZeroInteger(record: Record<string, unknown>, name: string): number | undefined {
    if (record[name] === undefined) {
        return undefined;
    }
    return requiredPositiveOrZeroInteger(record, name);
}
function requiredBoolean(record: Record<string, unknown>, name: string): boolean {
    if (typeof record[name] !== "boolean") {
        throw protocolError(`Quadlet helper ${name} must be a boolean`);
    }
    return record[name] as boolean;
}
function requiredOneOf(value: unknown, allowed: readonly string[], name: string): string {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw protocolError(`Quadlet helper ${name} is invalid`);
    }
    return value;
}
function parseRootID(value: unknown, name: string): QuadletRootID {
    if (!isRootID(value)) {
        throw protocolError(`Quadlet helper ${name} is invalid`);
    }
    return value;
}
function isRootID(value: unknown): value is QuadletRootID {
    return typeof value === "string" && (ROOT_IDS as readonly string[]).includes(value);
}
function protocolError(message: string): QuadletHelperRequestError {
    return new QuadletHelperRequestError("protocol", message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function freezeCapabilities(capabilities: QuadletHelperCapabilities): QuadletHelperCapabilities {
    return Object.freeze({ ...capabilities,
        operations: Object.freeze([ ...capabilities.operations ]),
        resourceTypes: Object.freeze([ ...capabilities.resourceTypes ]),
        roots: Object.freeze(capabilities.roots.map((root) => Object.freeze({ ...root }))) });
}
