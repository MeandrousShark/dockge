import { randomBytes } from "node:crypto";
import { AgentSocket } from "../../common/agent-socket";
import {
    QuadletJournalEvent,
    QuadletJournalOptions,
    QuadletResource,
    QuadletResourceSelector,
    QuadletStatus,
    isMonitorableQuadletResource,
} from "../../common/quadlet";
import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { parseQuadletHelperConfig, QuadletHelperClient, QuadletHelperStatus } from "../quadlet-helper/client";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";

const REQUIRED_OPERATIONS = [ "helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal" ];
const ROOT_IDS = new Set([ "admin", "runtime", "distribution" ]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The narrow typed helper surface used by the authenticated socket API. */
export interface QuadletReadOnlyClient {
    list(): Promise<readonly QuadletResource[]>;
    status(selector: QuadletResourceSelector): Promise<QuadletStatus>;
    journal(selector: QuadletResourceSelector, options: QuadletJournalOptions): AsyncIterable<QuadletJournalEvent>;
}

interface JournalSession {
    readonly controller: AbortController;
}

type QuadletClientFactory = () => QuadletReadOnlyClient;

/**
 * Authenticated, agent-aware read-only Quadlet views. This intentionally has
 * no generic helper proxy: every input is checked against the fixed Gate 5
 * operations before it reaches the helper client.
 */
export class QuadletSocketHandler extends AgentSocketHandler {
    private readonly createClient: QuadletClientFactory;
    private readonly createSessionID: () => string;

    constructor(
        createClient: QuadletClientFactory = () => new QuadletHelperClient(parseQuadletHelperConfig()),
        createSessionID: () => string = makeSessionID,
    ) {
        super();
        this.createClient = createClient;
        this.createSessionID = createSessionID;
    }

    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket): void {
        const sessions = new Map<string, JournalSession>();
        const abortAll = () => {
            for (const session of sessions.values()) {
                session.controller.abort();
            }
            sessions.clear();
        };

        socket.once("disconnect", abortAll);

        agentSocket.on("quadletList", async (callback) => {
            if (!isCallback(callback)) {
                return;
            }
            try {
                checkLogin(socket);
                await this.requireReadOnlyHelper(server);
                const resources = (await this.createClient().list()).filter(isMonitorableQuadletResource);
                callbackResult({ ok: true,
                    resources }, callback);
            } catch (error) {
                callbackError(this.safeHelperError(error), callback);
            }
        });

        agentSocket.on("quadletStatus", async (selector: unknown, callback) => {
            if (!isCallback(callback)) {
                return;
            }
            try {
                checkLogin(socket);
                const status = await this.requireReadOnlyHelper(server);
                const validatedSelector = validateSelector(selector, status);
                const result = await this.createClient().status(validatedSelector);
                callbackResult({ ok: true,
                    status: result }, callback);
            } catch (error) {
                callbackError(this.safeHelperError(error), callback);
            }
        });

        agentSocket.on("quadletJournalStart", async (selector: unknown, options: unknown, callback) => {
            if (!isCallback(callback)) {
                return;
            }
            try {
                checkLogin(socket);
                const status = await this.requireReadOnlyHelper(server);
                const validatedSelector = validateSelector(selector, status);
                const validatedOptions = validateJournalOptions(options, status);
                const sessionID = this.createSessionID();
                if (!SESSION_ID_PATTERN.test(sessionID)) {
                    throw new Error("Could not create a valid journal session");
                }
                if (sessions.has(sessionID)) {
                    throw new ValidationError("A journal session with this ID is already active");
                }

                const session: JournalSession = {
                    controller: new AbortController(),
                };
                sessions.set(sessionID, session);
                const client = this.createClient();
                callbackResult({ ok: true,
                    sessionId: sessionID }, callback);
                // Give the caller its generated ID before any history record
                // can be emitted, including on an in-process agent route.
                queueMicrotask(() => {
                    void this.forwardJournal(socket, sessions, sessionID, session, client, validatedSelector, {
                        ...validatedOptions,
                        signal: session.controller.signal,
                    });
                });
            } catch (error) {
                callbackError(this.safeHelperError(error), callback);
            }
        });

        agentSocket.on("quadletJournalStop", async (sessionID: unknown, callback) => {
            if (!isCallback(callback)) {
                return;
            }
            try {
                checkLogin(socket);
                const validatedSessionID = validateSessionID(sessionID);
                const session = sessions.get(validatedSessionID);
                if (!session) {
                    throw new ValidationError("Journal session is not active for this socket");
                }

                sessions.delete(validatedSessionID);
                session.controller.abort();
                callbackResult({ ok: true,
                    sessionId: validatedSessionID }, callback);
            } catch (error) {
                callbackError(this.safeHelperError(error), callback);
            }
        });
    }

    private async requireReadOnlyHelper(server: DockgeServer): Promise<QuadletHelperStatus> {
        const status = await server.refreshQuadletHelperStatus();
        if (status.state === "disabled") {
            throw new Error("Quadlet helper is disabled");
        }
        if (status.state === "unavailable") {
            throw new Error("Quadlet helper is unavailable");
        }
        if (
            status.state !== "read-only" ||
            status.mode !== "read-only" ||
            !status.operations ||
            !REQUIRED_OPERATIONS.every((operation) => status.operations?.includes(operation))
        ) {
            throw new Error("Quadlet helper is incompatible with read-only Quadlet support");
        }
        return status;
    }

    private async forwardJournal(
        socket: DockgeSocket,
        sessions: Map<string, JournalSession>,
        sessionID: string,
        session: JournalSession,
        client: QuadletReadOnlyClient,
        selector: QuadletResourceSelector,
        options: QuadletJournalOptions,
    ) {
        try {
            for await (const event of client.journal(selector, options)) {
                if (sessions.get(sessionID) !== session || session.controller.signal.aborted) {
                    return;
                }
                socket.emitAgent("quadletJournalEvent", { sessionId: sessionID,
                    event });
            }
        } catch {
            if (sessions.get(sessionID) === session && !session.controller.signal.aborted) {
                socket.emitAgent("quadletJournalEvent", {
                    sessionId: sessionID,
                    event: { type: "error",
                        message: "Quadlet journal stream failed" },
                });
            }
        } finally {
            if (sessions.get(sessionID) === session) {
                sessions.delete(sessionID);
            }
        }
    }

    private safeHelperError(error: unknown): Error {
        if (error instanceof ValidationError) {
            return error;
        }
        if (
            error instanceof Error &&
            [
                "You are not logged in.",
                "Quadlet helper is disabled",
                "Quadlet helper is unavailable",
                "Quadlet helper is incompatible with read-only Quadlet support",
            ].includes(error.message)
        ) {
            return error;
        }
        return new Error("Quadlet helper request failed");
    }
}

function makeSessionID() {
    return `quadlet_journal_${randomBytes(18).toString("base64url")}`;
}

function validateSelector(value: unknown, status: QuadletHelperStatus): QuadletResourceSelector {
    const selector = requiredObject(value, "Quadlet resource selector", [ "root", "sourceName" ]);
    if (typeof selector.root !== "string" || !ROOT_IDS.has(selector.root)) {
        throw new ValidationError("Quadlet root is invalid");
    }
    if (!status.roots?.some((root) => root.id === selector.root && root.available)) {
        throw new ValidationError("Quadlet root is unavailable");
    }
    if (!isSourceName(selector.sourceName)) {
        throw new ValidationError("Quadlet source name is invalid");
    }
    return Object.freeze({ root: selector.root as QuadletResourceSelector["root"],
        sourceName: selector.sourceName });
}

function validateJournalOptions(value: unknown, status: QuadletHelperStatus): QuadletJournalOptions {
    const options = requiredObject(value, "Quadlet journal options", [ "lines", "follow", "since", "until" ]);
    const maximumLines = status.limits?.journalHistoryRecords;
    if (typeof options.lines !== "number" || !Number.isSafeInteger(options.lines) || options.lines < 1 || !maximumLines || options.lines > maximumLines) {
        throw new ValidationError("Quadlet journal line count is invalid");
    }
    if (options.follow !== undefined && typeof options.follow !== "boolean") {
        throw new ValidationError("Quadlet journal follow option is invalid");
    }
    if (!isRFC3339(options.since) || !isRFC3339(options.until)) {
        throw new ValidationError("Quadlet journal time range is invalid");
    }
    if (options.since && options.until && Date.parse(options.since) > Date.parse(options.until)) {
        throw new ValidationError("Quadlet journal time range is invalid");
    }
    return Object.freeze({
        lines: options.lines,
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(options.until === undefined ? {} : { until: options.until }),
    });
}

function validateSessionID(value: unknown) {
    if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
        throw new ValidationError("Quadlet journal session ID is invalid");
    }
    return value;
}

function requiredObject(value: unknown, name: string, allowedKeys: readonly string[]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ValidationError(`${name} must be an object`);
    }
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some((key) => !allowedKeys.includes(key))) {
        throw new ValidationError(`${name} contains unsupported fields`);
    }
    return object;
}

function isSourceName(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".." && !/[\\/\0\x00-\x1F\x7F]/.test(value) && /\.(container|network|volume)$/.test(value);
}

function isRFC3339(value: unknown): value is string | undefined {
    return value === undefined || (typeof value === "string" && RFC3339_PATTERN.test(value) && !Number.isNaN(Date.parse(value)));
}

function isCallback(value: unknown): value is (result: unknown) => void {
    return typeof value === "function";
}
