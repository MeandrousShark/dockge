<template>
    <div class="d-flex justify-content-center align-items-center">
        <div class="logo d-flex flex-column justify-content-center align-items-center">
            <object class="my-4" width="200" height="200" data="/icon.svg" />
            <div class="fs-4 fw-bold">Dockge</div>
            <div>{{ $t("Version") }}: {{ $root.info.version }}</div>
            <div class="frontend-version">{{ $t("Frontend Version") }}: {{ $root.frontendVersion }}</div>

            <div v-if="engineInfoEntries.length" class="engine-info text-start mt-4">
                <div v-for="entry in engineInfoEntries" :key="entry.endpoint" class="engine-info-entry">
                    <div class="fw-bold mb-2">{{ entry.name }}</div>
                    <dl class="row mb-0 small">
                        <dt class="col-sm-5">{{ $t("Container Engine") }}</dt>
                        <dd class="col-sm-7">{{ engineName(entry.info.kind) }}</dd>
                        <dt class="col-sm-5">{{ $t("Engine Version") }}</dt>
                        <dd class="col-sm-7">{{ entry.info.version || $t("notAvailableShort") }}</dd>
                        <dt class="col-sm-5">{{ $t("Compose Provider") }}</dt>
                        <dd class="col-sm-7">{{ entry.info.composeProvider || $t("notAvailableShort") }}</dd>
                        <dt class="col-sm-5">{{ $t("Compose Provider Version") }}</dt>
                        <dd class="col-sm-7">{{ entry.info.composeProviderVersion || $t("notAvailableShort") }}</dd>
                        <template v-if="entry.quadletHelper && entry.quadletHelper.state !== 'disabled'">
                            <dt class="col-sm-5">{{ $t("Quadlet Helper") }}</dt>
                            <dd class="col-sm-7">{{ quadletHelperStatus(entry.quadletHelper.state) }}</dd>
                        </template>
                    </dl>
                    <div v-if="entry.info.warnings && entry.info.warnings.length" class="alert alert-warning py-2 mb-0 small" role="alert">
                        <div class="fw-bold">{{ $t("Capability Warnings") }}</div>
                        <ul class="mb-0 ps-3">
                            <li v-for="warning in entry.info.warnings" :key="warning">{{ warning }}</li>
                        </ul>
                    </div>
                </div>
            </div>

            <div v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning mt-4" role="alert">
                ⚠️ {{ $t("Frontend Version do not match backend version!") }}
            </div>

            <div class="my-3 update-link"><a href="https://github.com/louislam/dockge/releases" target="_blank" rel="noopener">{{ $t("Check Update On GitHub") }}</a></div>

            <div class="mt-1">
                <div class="form-check">
                    <label><input v-model="settings.checkUpdate" type="checkbox" @change="saveSettings()" /> {{ $t("Show update if available") }}</label>
                </div>

                <div class="form-check">
                    <label><input v-model="settings.checkBeta" type="checkbox" :disabled="!settings.checkUpdate" @change="saveSettings()" /> {{ $t("Also check beta release") }}</label>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        engineInfoEntries() {
            const entries = [];
            const current = this.$root.info.containerEngine;

            if (current) {
                entries.push({
                    endpoint: "",
                    name: this.$t("currentEndpoint"),
                    info: current,
                    quadletHelper: this.$root.info.quadletHelper,
                });
            }

            for (const [ endpoint, info ] of Object.entries(this.$root.agentInfo)) {
                if (info && info.containerEngine) {
                    entries.push({
                        endpoint,
                        name: this.$root.endpointDisplayFunction(endpoint) || endpoint,
                        info: info.containerEngine,
                        quadletHelper: info.quadletHelper,
                    });
                }
            }

            return entries;
        },
    },

    methods: {
        engineName(kind) {
            if (typeof kind !== "string" || kind.length === 0) {
                return this.$t("notAvailableShort");
            }

            return kind.charAt(0).toUpperCase() + kind.slice(1);
        },
        quadletHelperStatus(state) {
            if (state === "read-only") {
                return this.$t("Quadlet Helper Read-Only");
            }
            if (state === "incompatible") {
                return this.$t("Quadlet Helper Incompatible");
            }

            return this.$t("Quadlet Helper Unavailable");
        },
    },
};
</script>

<style lang="scss" scoped>
.logo {
    margin: 4em 1em;
}

.update-link {
    font-size: 0.8em;
}

.frontend-version {
    font-size: 0.9em;
    color: #cccccc;

    .dark & {
        color: #333333;
    }
}

.engine-info {
    width: min(100%, 32rem);
}

.engine-info-entry + .engine-info-entry {
    border-top: 1px solid var(--bs-border-color);
    margin-top: 1rem;
    padding-top: 1rem;
}

</style>
