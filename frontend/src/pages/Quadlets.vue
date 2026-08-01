<template>
    <div class="container-fluid">
        <h1 class="mb-3">{{ $t("Quadlets") }}</h1>

        <div class="shadow-box big-padding mb-4">
            <div class="row g-3 align-items-end">
                <div class="col-md-4">
                    <label class="form-label" for="quadlet-endpoint">{{ $t("Endpoint") }}</label>
                    <select id="quadlet-endpoint" v-model="endpoint" class="form-select">
                        <option v-for="candidate in endpoints" :key="candidate.endpoint" :value="candidate.endpoint">
                            {{ candidate.name }} — {{ endpointState(candidate) }}
                        </option>
                    </select>
                </div>
                <div class="col-md-4">
                    <label class="form-label" for="quadlet-search">{{ $t("Filter Quadlets") }}</label>
                    <input id="quadlet-search" v-model.trim="search" class="form-control" type="search" :placeholder="$t('Filter Quadlets')">
                </div>
                <div class="col-md-2">
                    <label class="form-label" for="quadlet-type">{{ $t("Type") }}</label>
                    <select id="quadlet-type" v-model="typeFilter" class="form-select">
                        <option value="">{{ $t("All") }}</option>
                        <option v-for="type in types" :key="type" :value="type">{{ type }}</option>
                    </select>
                </div>
                <div class="col-md-2">
                    <label class="form-label" for="quadlet-root">{{ $t("Root") }}</label>
                    <select id="quadlet-root" v-model="rootFilter" class="form-select">
                        <option value="">{{ $t("All") }}</option>
                        <option v-for="root in roots" :key="root" :value="root">{{ root }}</option>
                    </select>
                </div>
            </div>
        </div>

        <div v-if="!selectedEndpoint.readOnly" class="alert alert-secondary" role="status">
            {{ unavailableMessage }}
        </div>

        <template v-else>
            <div v-if="loading" class="text-center py-4"><font-awesome-icon icon="spinner" spin /> {{ $t("Loading") }}</div>
            <div v-else-if="loadError" class="alert alert-warning" role="alert">{{ loadError }}</div>
            <div v-else-if="filteredResources.length === 0" class="alert alert-secondary" role="status">{{ $t("No Quadlets Found") }}</div>

            <div v-else class="row g-4">
                <div class="col-lg-5">
                    <div class="shadow-box resource-list">
                        <button
                            v-for="resource in filteredResources"
                            :key="resourceKey(resource)"
                            class="resource-row text-start"
                            :class="{ selected: selectedResource && resourceKey(resource) === resourceKey(selectedResource) }"
                            type="button"
                            @click="selectResource(resource)"
                        >
                            <div class="d-flex justify-content-between gap-3">
                                <strong class="text-break">{{ resource.sourceName }}</strong>
                                <span class="badge bg-secondary">{{ resourceType(resource) }}</span>
                            </div>
                            <div class="small text-muted mt-1">{{ resource.root }}<template v-if="resource.unitId"> · {{ resource.unitId }}</template></div>
                            <div v-if="resourceWarning(resource)" class="small text-warning mt-1">{{ resourceWarning(resource) }}</div>
                            <div v-else class="small text-muted mt-1">{{ $t("External (read-only)") }}</div>
                        </button>
                    </div>
                </div>

                <div class="col-lg-7">
                    <div v-if="!selectedResource" class="shadow-box big-padding text-muted">{{ $t("Select a Quadlet") }}</div>
                    <template v-else>
                        <div class="shadow-box big-padding mb-4">
                            <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
                                <div>
                                    <h2 class="h4 mb-1 text-break">{{ selectedResource.sourceName }}</h2>
                                    <div class="text-muted small">{{ selectedResource.root }}<template v-if="selectedResource.unitId"> · {{ selectedResource.unitId }}</template></div>
                                </div>
                                <span class="badge bg-secondary">{{ resourceType(selectedResource) }}</span>
                            </div>
                            <div v-if="resourceWarning(selectedResource)" class="alert alert-warning py-2 mb-0">{{ resourceWarning(selectedResource) }}</div>
                            <template v-else>
                                <span class="badge mb-3" :class="statusBadgeClass">{{ statusState }}</span>
                                <div v-if="statusLoading" class="small text-muted"><font-awesome-icon icon="spinner" spin /> {{ $t("Loading") }}</div>
                                <div v-else-if="statusError" class="alert alert-warning py-2 mb-0">{{ statusError }}</div>
                                <dl v-else class="row mb-0 small">
                                    <template v-for="property in statusProperties" :key="property">
                                        <dt class="col-sm-5">{{ property }}</dt>
                                        <dd class="col-sm-7 text-break">{{ status.properties[property] || $t("notAvailableShort") }}</dd>
                                    </template>
                                </dl>
                            </template>
                        </div>

                        <div v-if="isInspectable(selectedResource)" class="shadow-box big-padding">
                            <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                                <h2 class="h4 mb-0">{{ $t("Journal") }}</h2>
                                <div class="d-flex gap-2">
                                    <button class="btn btn-normal btn-sm" :disabled="journalLoading || following" @click="loadJournal(false)">
                                        <font-awesome-icon icon="rotate" /> {{ $t("Load History") }}
                                    </button>
                                    <button v-if="!following" class="btn btn-primary btn-sm" :disabled="journalLoading" @click="loadJournal(true)">
                                        <font-awesome-icon icon="play" /> {{ $t("Follow") }}
                                    </button>
                                    <button v-else class="btn btn-outline-secondary btn-sm" @click="stopJournal">
                                        <font-awesome-icon icon="stop" /> {{ $t("Stop Following") }}
                                    </button>
                                </div>
                            </div>
                            <div v-if="journalError" class="alert alert-warning py-2">{{ journalError }}</div>
                            <div v-if="journalLoading" class="small text-muted mb-2"><font-awesome-icon icon="spinner" spin /> {{ $t("Loading") }}</div>
                            <div v-if="journalRecords.length" class="journal-output mb-0">
                                <div v-for="(record, index) in journalRecords" :key="index">{{ record.message }}<span v-if="record.truncated" class="text-warning"> {{ $t("(truncated)") }}</span></div>
                            </div>
                            <p v-else-if="!journalLoading" class="text-muted mb-0">{{ $t("No journal records") }}</p>
                        </div>
                    </template>
                </div>
            </div>
        </template>
    </div>
</template>

<script>
const STATUS_PROPERTIES = [ "Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "Result", "ExecMainCode", "ExecMainStatus", "ActiveEnterTimestamp", "InactiveEnterTimestamp" ];
const JOURNAL_HISTORY_LINES = 200;
const MAX_FRONTEND_JOURNAL_RECORDS = 1000;

export default {
    data() {
        return {
            endpoint: "",
            search: "",
            typeFilter: "",
            rootFilter: "",
            resources: [],
            selectedResource: null,
            status: { properties: {} },
            loading: false,
            statusLoading: false,
            journalLoading: false,
            following: false,
            loadError: "",
            statusError: "",
            journalError: "",
            journalRecords: [],
            journalRequestId: "",
            journalEndpoint: "",
            removeJournalListener: null,
            inventoryRequest: 0,
            statusRequest: 0,
            journalRequest: 0,
            pendingJournalEvents: new Map(),
        };
    },
    computed: {
        endpoints() {
            const entries = [{
                endpoint: "",
                name: this.$t("currentEndpoint"),
                status: this.$root.agentStatusList[""] || "offline",
                helper: this.$root.info.quadletHelper,
                readOnly: this.$root.agentStatusList[""] === "online" && this.$root.info.quadletHelper?.state === "read-only",
            }];
            const known = new Set(Object.keys(this.$root.agentList || {}));
            for (const endpoint of Object.keys(this.$root.agentInfo || {})) {
                known.add(endpoint);
            }
            for (const endpoint of known) {
                if (!endpoint) {
                    continue;
                }
                const info = this.$root.agentInfo[endpoint] || {};
                entries.push({
                    endpoint,
                    name: this.$root.endpointDisplayFunction(endpoint) || endpoint,
                    status: this.$root.agentStatusList[endpoint] || "offline",
                    helper: info.quadletHelper,
                    readOnly: this.$root.agentStatusList[endpoint] === "online" && info.quadletHelper?.state === "read-only",
                });
            }
            return entries;
        },
        selectedEndpoint() {
            return this.endpoints.find((candidate) => candidate.endpoint === this.endpoint) || this.endpoints[0];
        },
        types() {
            return [ ...new Set(this.resources.map((resource) => this.resourceType(resource)).filter(Boolean)) ].sort();
        },
        roots() {
            return [ ...new Set(this.resources.map((resource) => resource.root).filter(Boolean)) ].sort();
        },
        filteredResources() {
            const needle = this.search.toLowerCase();
            return this.resources.filter((resource) => {
                const matchesSearch = !needle || [ resource.sourceName, resource.root, resource.unitId ].some((value) => String(value || "").toLowerCase().includes(needle));
                return matchesSearch
                    && (!this.typeFilter || this.resourceType(resource) === this.typeFilter)
                    && (!this.rootFilter || resource.root === this.rootFilter);
            });
        },
        statusProperties() {
            return STATUS_PROPERTIES.filter((property) => Object.prototype.hasOwnProperty.call(this.status.properties || {}, property));
        },
        statusState() {
            return this.status.properties?.ActiveState || this.$t("notAvailableShort");
        },
        statusBadgeClass() {
            if (this.status.properties?.ActiveState === "active") {
                return "bg-primary";
            }
            if (this.status.properties?.ActiveState === "failed") {
                return "bg-danger";
            }
            return "bg-secondary";
        },
        unavailableMessage() {
            const candidate = this.selectedEndpoint;
            if (candidate.status !== "online") {
                return this.$t("Quadlet Endpoint Offline");
            }
            if (!candidate.helper || candidate.helper.state === "disabled") {
                return this.$t("Quadlet Helper Disabled");
            }
            if (candidate.helper.state === "incompatible") {
                return this.$t("Quadlet Helper Incompatible");
            }
            return this.$t("Quadlet Helper Unavailable");
        },
    },
    watch: {
        selectedResource() {
            this.stopJournal();
        },
        selectedEndpoint() {
            this.loadResources();
        },
        "$root.socketIO.connected"(connected) {
            this.stopJournal();
            if (connected) {
                this.loadResources();
            }
        },
    },
    mounted() {
        this.removeJournalListener = this.$root.addQuadletJournalListener(this.onJournalEvent);
        this.loadResources();
    },
    beforeUnmount() {
        this.stopJournal();
        if (this.removeJournalListener) {
            this.removeJournalListener();
        }
    },
    methods: {
        endpointState(candidate) {
            if (candidate.status !== "online") {
                return this.$t("agentOffline");
            }
            return candidate.readOnly ? this.$t("Quadlet Helper Read-Only") : this.$t("notAvailableShort");
        },
        resourceKey(resource) {
            return `${resource.root}/${resource.sourceName}`;
        },
        resourceType(resource) {
            return resource.resourceType || this.$t("notAvailableShort");
        },
        resourceWarning(resource) {
            if (!resource.readOnly || resource.resourceType === "unsupported") {
                return this.$t("Unsupported Quadlet Resource");
            }
            if (resource.fileKind !== "regular") {
                return this.$t("Quadlet Irregular File");
            }
            if (resource.shadowedBy) {
                return `${this.$t("Quadlet Shadowed By")}: ${resource.shadowedBy}`;
            }
            if (!resource.unitId) {
                return this.$t("Quadlet Unit Not Mapped");
            }
            return "";
        },
        isInspectable(resource) {
            return resource && resource.readOnly === true && resource.resourceType !== "unsupported" && resource.fileKind === "regular" && Boolean(resource.unitId) && !resource.shadowedBy;
        },
        loadResources() {
            const request = ++this.inventoryRequest;
            const requestedEndpoint = this.endpoint;
            ++this.statusRequest;
            this.stopJournal();
            this.resources = [];
            this.selectedResource = null;
            this.status = { properties: {} };
            this.loadError = "";
            if (!this.selectedEndpoint.readOnly) {
                const firstReadOnlyAgent = this.endpoint === "" ? this.endpoints.find((candidate) => candidate.endpoint && candidate.readOnly) : undefined;
                if (firstReadOnlyAgent) {
                    this.endpoint = firstReadOnlyAgent.endpoint;
                    return;
                }
                this.loading = false;
                this.statusLoading = false;
                return;
            }
            this.loading = true;
            this.$root.emitAgent(this.endpoint, "quadletList", (res) => {
                if (request !== this.inventoryRequest || requestedEndpoint !== this.endpoint) {
                    return;
                }
                this.loading = false;
                if (!res || !res.ok) {
                    this.loadError = (res && res.msg) || this.$t("Unable to load Quadlets");
                    return;
                }
                this.resources = Array.isArray(res.resources) ? res.resources : [];
            });
        },
        selectResource(resource) {
            const request = ++this.statusRequest;
            this.selectedResource = resource;
            this.status = { properties: {} };
            this.statusError = "";
            this.statusLoading = false;
            if (!this.isInspectable(resource)) {
                return;
            }
            const requestedEndpoint = this.endpoint;
            const requestedResource = this.resourceKey(resource);
            this.statusLoading = true;
            this.$root.emitAgent(this.endpoint, "quadletStatus", { root: resource.root,
                sourceName: resource.sourceName }, (res) => {
                if (request !== this.statusRequest || requestedEndpoint !== this.endpoint || !this.selectedResource || this.resourceKey(this.selectedResource) !== requestedResource) {
                    return;
                }
                this.statusLoading = false;
                if (!res || !res.ok) {
                    this.statusError = (res && res.msg) || this.$t("Unable to load Quadlet status");
                    return;
                }
                this.status = res.status || { properties: {} };
            });
        },
        loadJournal(follow) {
            if (!this.isInspectable(this.selectedResource)) {
                return;
            }
            this.stopJournal();
            const request = ++this.journalRequest;
            const requestedEndpoint = this.endpoint;
            const requestedResource = this.resourceKey(this.selectedResource);
            this.journalRecords = [];
            this.journalError = "";
            this.journalLoading = true;
            this.journalEndpoint = requestedEndpoint;
            this.$root.emitAgent(this.endpoint, "quadletJournalStart", {
                root: this.selectedResource.root,
                sourceName: this.selectedResource.sourceName,
            }, {
                lines: JOURNAL_HISTORY_LINES,
                follow,
            }, (res) => {
                if (request !== this.journalRequest || requestedEndpoint !== this.endpoint || !this.selectedResource || this.resourceKey(this.selectedResource) !== requestedResource) {
                    if (res?.ok && res.sessionId) {
                        this.$root.emitAgent(requestedEndpoint, "quadletJournalStop", res.sessionId, () => {});
                    }
                    return;
                }
                this.journalLoading = false;
                if (!res || !res.ok) {
                    this.journalEndpoint = "";
                    this.journalError = (res && res.msg) || this.$t("Unable to load Quadlet journal");
                    return;
                }
                this.journalRequestId = res.sessionId || "";
                this.following = follow && Boolean(this.journalRequestId);
                const pending = this.pendingJournalEvents.get(this.journalRequestId) || [];
                this.pendingJournalEvents.delete(this.journalRequestId);
                for (const event of pending) {
                    this.consumeJournalEvent(event);
                }
            });
        },
        stopJournal() {
            ++this.journalRequest;
            if (this.journalRequestId) {
                this.$root.emitAgent(this.journalEndpoint || this.endpoint, "quadletJournalStop", this.journalRequestId, () => {});
            }
            this.journalRequestId = "";
            this.journalEndpoint = "";
            this.following = false;
            this.journalLoading = false;
            this.pendingJournalEvents.clear();
        },
        onJournalEvent(event) {
            if (!event || !event.sessionId || !event.event) {
                return;
            }
            if (event.endpoint !== this.journalEndpoint) {
                return;
            }
            if (event.sessionId !== this.journalRequestId) {
                if (this.journalLoading) {
                    const pending = this.pendingJournalEvents.get(event.sessionId) || [];
                    if (pending.length < MAX_FRONTEND_JOURNAL_RECORDS + 2) {
                        pending.push(event);
                        this.pendingJournalEvents.set(event.sessionId, pending);
                    }
                }
                return;
            }
            this.consumeJournalEvent(event);
        },
        consumeJournalEvent(event) {
            const journalEvent = event.event;
            if (journalEvent.type === "record" && journalEvent.data) {
                this.journalRecords.push(journalEvent.data);
                if (this.journalRecords.length > MAX_FRONTEND_JOURNAL_RECORDS) {
                    this.journalRecords.splice(0, this.journalRecords.length - MAX_FRONTEND_JOURNAL_RECORDS);
                }
            }
            if (journalEvent.type === "complete" || journalEvent.type === "error") {
                this.following = false;
                this.journalRequestId = "";
                this.journalEndpoint = "";
                if (journalEvent.type === "error") {
                    this.journalError = journalEvent.message || this.$t("Unable to load Quadlet journal");
                }
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.resource-list {
    max-height: 68vh;
    overflow-y: auto;
}

.resource-row {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--bs-border-color);
    color: inherit;
    display: block;
    padding: 1rem;
    width: 100%;

    &:hover, &.selected {
        background: rgba(var(--bs-primary-rgb), 0.08);
    }
}

.resource-row:last-child {
    border-bottom: 0;
}

.journal-output {
    background: var(--bs-tertiary-bg);
    border-radius: 0.375rem;
    max-height: 32rem;
    overflow: auto;
    padding: 1rem;
    font-family: "JetBrains Mono", monospace;
    white-space: pre-wrap;
    word-break: break-word;
}
</style>
