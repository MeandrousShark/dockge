#!/usr/bin/env bash
# Repository-local regression coverage for helper/agent lifecycle sequencing.
# It rewrites only temporary packaging copies and replaces host-facing commands,
# so it is safe to run without root, systemd, or a listening helper socket.
set -euo pipefail
IFS=$'\n\t'

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dockge-packaging-lifecycle.XXXXXX")"
trap 'rm -rf -- "${TEMP_DIR}"' EXIT

fail() {
    printf 'lifecycle regression: %s\n' "$*" >&2
    exit 1
}

assert_log_contains() {
    local expected="$1"
    grep -Fqx -- "${expected}" "${MOCK_LOG}" || fail "missing systemctl call: ${expected}"
}

assert_log_lacks() {
    local unexpected="$1"
    if grep -Fqx -- "${unexpected}" "${MOCK_LOG}"; then
        fail "unexpected systemctl call: ${unexpected}"
    fi
}

MOCK_ROOT="${TEMP_DIR}/host"
MOCK_BIN="${TEMP_DIR}/bin"
MOCK_LOG="${TEMP_DIR}/systemctl.log"
MOCK_STATE_DIR="${TEMP_DIR}/state"
export MOCK_ROOT MOCK_LOG MOCK_STATE_DIR
mkdir -p "${MOCK_ROOT}" "${MOCK_BIN}" "${MOCK_STATE_DIR}"
cp -R "${ROOT_DIR}/packaging" "${TEMP_DIR}/packaging"

# Keep the temporary scripts' layout and unit paths entirely below MOCK_ROOT.
for script in \
    "${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/common.sh" \
    "${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/install.sh" \
    "${TEMP_DIR}/packaging/dockge-agent/scripts/install-layout.sh" \
    "${TEMP_DIR}/packaging/dockge-quadlet-helper/systemd/dockge-quadlet-helper.service"; do
    sed -i.bak \
        -e "s|/opt/dockge-quadlet-helper|${MOCK_ROOT}/opt/dockge-quadlet-helper|g" \
        -e "s|/opt/dockge-agent|${MOCK_ROOT}/opt/dockge-agent|g" \
        -e "s|/etc/dockge|${MOCK_ROOT}/etc/dockge|g" \
        -e "s|/etc/systemd/system|${MOCK_ROOT}/etc/systemd/system|g" \
        -e "s|/var/lib/dockge-quadlet-helper|${MOCK_ROOT}/var/lib/dockge-quadlet-helper|g" \
        -e "s|/var/lib/dockge-agent|${MOCK_ROOT}/var/lib/dockge-agent|g" \
        -e "s|/usr/local/bin/node|${MOCK_ROOT}/usr/local/bin/node|g" \
        -e "s|/run/dockge-quadlet-helper.sock|${MOCK_ROOT}/run/dockge-quadlet-helper.sock|g" \
        "${script}"
    rm -f -- "${script}.bak"
done
sed -i.bak '/^require_root() {$/,/^}$/c\
require_root() { :; }' "${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/common.sh"
rm -f -- "${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/common.sh.bak"
sed -i.bak '/^require_root() { \[\[/c\
require_root() { :; }' "${TEMP_DIR}/packaging/dockge-agent/scripts/install-layout.sh"
rm -f -- "${TEMP_DIR}/packaging/dockge-agent/scripts/install-layout.sh.bak"
grep -Fqx 'require_root() { :; }' "${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/common.sh" || fail 'helper root check was not mocked'
grep -Fqx 'require_root() { :; }' "${TEMP_DIR}/packaging/dockge-agent/scripts/install-layout.sh" || fail 'agent root check was not mocked'

make_mock() {
    local name="$1"
    shift
    printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "$@" > "${MOCK_BIN}/${name}"
    chmod 0755 "${MOCK_BIN}/${name}"
}

# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock getent '
case "${1:-}" in
    passwd)
        if [[ "${2:-}" == dockge ]]; then
            printf "dockge:x:1001:1001::/nonexistent:/usr/sbin/nologin\\n"
        else
            printf "dockge:x:1001:1001::/nonexistent:/usr/sbin/nologin\\n"
        fi
        ;;
    group)
        case "${2:-}" in
            dockge-quadlet) printf "dockge-quadlet:x:2001:dockge\\n" ;;
            dockge-podman) printf "dockge-podman:x:2002:dockge\\n" ;;
            *) exit 2 ;;
        esac
        ;;
    *) exit 2 ;;
esac'
# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock id '
case "${1:-}" in
    -u) printf "1001\\n" ;;
    -nG) printf "dockge dockge-quadlet\\n" ;;
    *) exit 2 ;;
esac'
make_mock groupadd 'exit 0'
make_mock usermod 'exit 0'
make_mock runuser 'exit 0'
# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock install '
directory=false
paths=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d) directory=true; shift ;;
        -o|-g|-m) shift 2 ;;
        *) paths+=("$1"); shift ;;
    esac
done
if [[ "${directory}" == true ]]; then
    mkdir -p -- "${paths[@]}"
else
    source_path="${paths[$(( ${#paths[@]} - 2 ))]}"
    destination_path="${paths[$(( ${#paths[@]} - 1 ))]}"
    mkdir -p -- "$(dirname -- "${destination_path}")"
    cp -- "${source_path}" "${destination_path}"
fi'
# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock stat '
format=""
for argument in "$@"; do
    case "${argument}" in
        %U:%G:%a) format="owner_mode" ;;
        %U:%G) format="owner" ;;
        %u:%g:%a) format="numeric_owner_mode" ;;
        %u) format="numeric_owner" ;;
        %a) format="mode" ;;
    esac
done
case "${format}" in
    owner_mode) printf "root:root:600\\n" ;;
    owner) printf "root:root\\n" ;;
    numeric_owner_mode) printf "0:0:755\\n" ;;
    numeric_owner) printf "0\\n" ;;
    mode) printf "755\\n" ;;
    *) /usr/bin/stat "$@" ;;
esac'
# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock systemd-analyze '
printf "systemd-analyze %s\\n" "$*" >> "${MOCK_LOG}"
if [[ "${MOCK_ASSERT_HELPER_CURRENT:-false}" == true ]]; then
    [[ -L "${MOCK_ROOT}/opt/dockge-quadlet-helper/current" ]] || exit 1
    [[ "$(readlink -- "${MOCK_ROOT}/opt/dockge-quadlet-helper/current")" == "releases/helper-v1" ]] || exit 1
fi'
# shellcheck disable=SC2016 # This single-quoted body is emitted as a mock script.
make_mock systemctl '
command="$*"
printf "%s\\n" "${command}" >> "${MOCK_LOG}"
if [[ -n "${MOCK_FAIL_MATCH:-}" && "${command}" == "${MOCK_FAIL_MATCH}" && ! -e "${MOCK_STATE_DIR}/failure-consumed" ]]; then
    : > "${MOCK_STATE_DIR}/failure-consumed"
    exit 1
fi
unit="${!#}"
case "${1:-}" in
    show) printf "dockge\\n" ;;
    daemon-reload) ;;
    is-active)
        [[ -e "${MOCK_STATE_DIR}/active-${unit}" ]]
        ;;
    is-enabled)
        [[ -e "${MOCK_STATE_DIR}/enabled-${unit}" ]]
        ;;
    enable)
        : > "${MOCK_STATE_DIR}/enabled-${unit}"
        if [[ "${2:-}" == --now ]]; then : > "${MOCK_STATE_DIR}/active-${unit}"; fi
        ;;
    disable)
        rm -f -- "${MOCK_STATE_DIR}/enabled-${unit}"
        ;;
    restart)
        : > "${MOCK_STATE_DIR}/active-${unit}"
        ;;
    stop)
        rm -f -- "${MOCK_STATE_DIR}/active-${unit}"
        ;;
    *) exit 2 ;;
esac'

export PATH="${MOCK_BIN}:${PATH}"

helper_root="${MOCK_ROOT}/opt/dockge-quadlet-helper"
agent_root="${MOCK_ROOT}/opt/dockge-agent"
mkdir -p "${TEMP_DIR}/artifacts" "${MOCK_ROOT}/usr/local/bin" "${MOCK_ROOT}/etc/dockge"
case "$(uname -m)" in
    x86_64) helper_arch='amd64' ;;
    aarch64|arm64) helper_arch='arm64' ;;
    *) fail "unsupported test host architecture: $(uname -m)" ;;
esac
helper_artifact="${TEMP_DIR}/artifacts/helper-linux-${helper_arch}"
printf '#!/bin/sh\nexit 0\n' > "${helper_artifact}"
chmod 0755 "${helper_artifact}"
checksum="$(sha256sum "${helper_artifact}" | awk '{print $1}')"
printf '%s  helper-linux-%s\n' "${checksum}" "${helper_arch}" > "${TEMP_DIR}/artifacts/SHA256SUMS"

# A first helper install must link current before systemd unit verification.
: > "${MOCK_LOG}"
export MOCK_ASSERT_HELPER_CURRENT=true
"${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/install.sh" \
    --artifact "${helper_artifact}" \
    --checksum "${TEMP_DIR}/artifacts/SHA256SUMS" \
    --release-id helper-v1
[[ -L "${helper_root}/current" ]] || fail 'helper first install did not create current'
[[ "$(readlink -- "${helper_root}/current")" == releases/helper-v1 ]] || fail 'helper first install linked the wrong release'

# Verification observes health but must not consume service StartLimitBurst.
: > "${MOCK_LOG}"
"${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/verify-install.sh"
"${TEMP_DIR}/packaging/dockge-quadlet-helper/scripts/verify-install.sh"
assert_log_lacks 'restart dockge-quadlet-helper.service'

prepare_agent() {
    local release_id="$1"
    mkdir -p "${agent_root}/releases/${release_id}"
    printf 'release %s\n' "${release_id}" > "${agent_root}/releases/${release_id}/marker"
}

write_agent_environment() {
    printf '%s\n' \
        'DOCKGE_AGENT_ONLY=true' \
        'DOCKGE_ENABLE_CONSOLE=false' \
        'DOCKGE_AGENT_TOKEN_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
        'DOCKGE_AGENT_ENDPOINT_ID=agent.example:5001' \
        > "${MOCK_ROOT}/etc/dockge/agent.env"
}

prepare_agent agent-old
prepare_agent agent-new
prepare_agent agent-failed
prepare_agent agent-inactive
prepare_agent agent-inactive-failed
printf '#!/bin/sh\nexit 0\n' > "${MOCK_ROOT}/usr/local/bin/node"
chmod 0755 "${MOCK_ROOT}/usr/local/bin/node"
write_agent_environment

set_agent_state() {
    local active="$1"
    local enabled="$2"
    rm -f -- "${MOCK_STATE_DIR}/active-dockge-agent.service" "${MOCK_STATE_DIR}/enabled-dockge-agent.service" "${MOCK_STATE_DIR}/failure-consumed"
    if [[ "${active}" == true ]]; then
        : > "${MOCK_STATE_DIR}/active-dockge-agent.service"
    fi
    if [[ "${enabled}" == true ]]; then
        : > "${MOCK_STATE_DIR}/enabled-dockge-agent.service"
    fi
}

set_agent_current() {
    local release_id="$1"
    mkdir -p "${agent_root}"
    ln -sfn "releases/${release_id}" "${agent_root}/current"
}

agent_install="${TEMP_DIR}/packaging/dockge-agent/scripts/install-layout.sh"

# Active activation enables then restarts, so the switched release is used.
set_agent_state true false
set_agent_current agent-old
: > "${MOCK_LOG}"
MOCK_FAIL_MATCH=''
"${agent_install}" --release-id agent-new --activate
[[ "$(readlink -- "${agent_root}/current")" == releases/agent-new ]] || fail 'active activation did not switch current'
assert_log_contains 'enable dockge-agent.service'
assert_log_contains 'restart dockge-agent.service'
assert_log_lacks 'enable --now dockge-agent.service'

# An inactive endpoint is enabled and started in a single call.
set_agent_state false false
set_agent_current agent-old
: > "${MOCK_LOG}"
"${agent_install}" --release-id agent-inactive --activate
[[ "$(readlink -- "${agent_root}/current")" == releases/agent-inactive ]] || fail 'inactive activation did not switch current'
assert_log_contains 'enable --now dockge-agent.service'
[[ -e "${MOCK_STATE_DIR}/active-dockge-agent.service" ]] || fail 'inactive activation did not start the service'
[[ -e "${MOCK_STATE_DIR}/enabled-dockge-agent.service" ]] || fail 'inactive activation did not enable the service'

# Failed activation restores the old link and the prior active/enabled state.
set_agent_state true true
set_agent_current agent-old
: > "${MOCK_LOG}"
export MOCK_FAIL_MATCH='restart dockge-agent.service'
if "${agent_install}" --release-id agent-failed --activate; then
    fail 'active activation unexpectedly succeeded despite injected restart failure'
fi
unset MOCK_FAIL_MATCH
[[ "$(readlink -- "${agent_root}/current")" == releases/agent-old ]] || fail 'active rollback did not restore current'
[[ -e "${MOCK_STATE_DIR}/active-dockge-agent.service" ]] || fail 'active rollback did not restore service activity'
[[ -e "${MOCK_STATE_DIR}/enabled-dockge-agent.service" ]] || fail 'active rollback did not restore enablement'

# The same rollback preserves a previously inactive and disabled endpoint.
set_agent_state false false
set_agent_current agent-old
: > "${MOCK_LOG}"
export MOCK_FAIL_MATCH='enable --now dockge-agent.service'
if "${agent_install}" --release-id agent-inactive-failed --activate; then
    fail 'inactive activation unexpectedly succeeded despite injected enable failure'
fi
unset MOCK_FAIL_MATCH
[[ "$(readlink -- "${agent_root}/current")" == releases/agent-old ]] || fail 'inactive rollback did not restore current'
[[ ! -e "${MOCK_STATE_DIR}/active-dockge-agent.service" ]] || fail 'inactive rollback unexpectedly left the service active'
[[ ! -e "${MOCK_STATE_DIR}/enabled-dockge-agent.service" ]] || fail 'inactive rollback unexpectedly left the service enabled'

printf 'packaging lifecycle regression: ok\n'
