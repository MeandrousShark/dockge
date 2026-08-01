/** Shared, read-only Quadlet view. No source contents or caller-supplied host paths cross this boundary. */
export type QuadletRootID = "admin" | "runtime" | "distribution";
export type QuadletResourceType = "container" | "network" | "volume" | "unsupported";
export type QuadletFileKind = "regular" | "symlink" | "directory" | "irregular";

export interface QuadletResourceSelector {
    readonly root: QuadletRootID;
    readonly sourceName: string;
}

/** Every Gate 5 resource is discovered externally and cannot be mutated by Dockge. */
export interface QuadletResource extends QuadletResourceSelector {
    readonly resourceType: QuadletResourceType;
    readonly fileKind: QuadletFileKind;
    readonly size?: number;
    readonly sha256?: string;
    readonly unitId?: string;
    readonly shadowedBy?: QuadletRootID;
    readonly ownership: "external";
    readonly readOnly: true;
}

export interface QuadletSystemdProperties {
    readonly Id?: string;
    readonly Description?: string;
    readonly LoadState?: string;
    readonly ActiveState?: string;
    readonly SubState?: string;
    readonly UnitFileState?: string;
    readonly FragmentPath?: string;
    readonly SourcePath?: string;
    readonly Result?: string;
    readonly ExecMainCode?: string;
    readonly ExecMainStatus?: string;
    readonly ActiveEnterTimestamp?: string;
    readonly InactiveEnterTimestamp?: string;
}

export interface QuadletStatus {
    readonly resource: QuadletResource;
    readonly properties: QuadletSystemdProperties;
}

export interface QuadletJournalOptions {
    readonly lines: number;
    readonly follow?: boolean;
    readonly since?: string;
    readonly until?: string;
    readonly signal?: AbortSignal;
}

export interface QuadletRequestOptions {
    readonly signal?: AbortSignal;
}

export interface QuadletJournalRecord {
    readonly message: string;
    readonly truncated: boolean;
}

export type QuadletJournalEvent =
    | { readonly type: "record"; readonly sequence: number; readonly data: QuadletJournalRecord }
    | { readonly type: "heartbeat"; readonly sequence: number; readonly data: Record<never, never> }
    | { readonly type: "complete"; readonly records: number; readonly complete: true };

/** Purely normalize the helper's fixed systemd fields for browser-safe shared use. */
export function normalizeQuadletStatus(resource: QuadletResource, properties: QuadletSystemdProperties): QuadletStatus {
    return Object.freeze({
        resource: Object.freeze({ ...resource }),
        properties: Object.freeze({ ...properties }),
    });
}
