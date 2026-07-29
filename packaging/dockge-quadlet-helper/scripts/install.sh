#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck disable=SC1091 # Source path is resolved from this script's directory.
source "${SCRIPT_DIR}/common.sh"
umask 0077

usage() {
    printf 'Usage: %s --artifact PATH --checksum PATH --release-id ID\n' "$0"
}

artifact=''
checksum_file=''
release_id=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --artifact) artifact="${2:-}"; shift 2 ;;
        --checksum) checksum_file="${2:-}"; shift 2 ;;
        --release-id) release_id="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done

[[ -n "${artifact}" && -n "${checksum_file}" && -n "${release_id}" ]] || { usage; exit 2; }
require_root
require_command getent
require_command groupadd
require_command id
require_command install
require_command ln
require_command mv
require_command readlink
require_command rm
require_command sha256sum
require_command stat
require_command systemctl
require_command systemd-analyze
require_command usermod
require_command python3
validate_release_id "${release_id}"

artifact="$(canonical_regular_file "${artifact}")"
checksum_file="$(canonical_regular_file "${checksum_file}")"
arch="$(host_arch)"
case "$(basename -- "${artifact}")" in
    *"linux-${arch}"*|*"${arch}"*) ;;
    *) die "artifact name does not identify the target architecture (${arch})" ;;
esac

expected_checksum="$(awk -v name="$(basename -- "${artifact}")" '$2 == name || $2 == "*" name { print $1; exit }' "${checksum_file}")"
[[ "${expected_checksum}" =~ ^[A-Fa-f0-9]{64}$ ]] || die 'checksum file has no SHA-256 entry for the artifact basename'
actual_checksum="$(sha256sum -- "${artifact}" | awk '{print $1}')"
[[ "${actual_checksum}" == "${expected_checksum,,}" ]] || die 'artifact checksum does not match'

getent passwd dockge >/dev/null || die 'required dockge account does not exist'
if ! getent group dockge-quadlet >/dev/null; then
    groupadd --system dockge-quadlet
fi
group_members="$(getent group dockge-quadlet | awk -F: '{print $4}')"
if [[ -n "${group_members}" && "${group_members}" != 'dockge' ]]; then
    die 'dockge-quadlet already has members other than dockge; refuse to broaden helper access'
fi
group_gid="$(getent group dockge-quadlet | awk -F: '{print $3}')"
other_primary_members="$(getent passwd | awk -F: -v gid="${group_gid}" '$4 == gid && $1 != "dockge" { print $1 }')"
[[ -z "${other_primary_members}" ]] || die 'dockge-quadlet is a primary group for another account; refuse to broaden helper access'
usermod -a -G dockge-quadlet dockge
dockge_uid="$(id -u dockge)"
[[ "${dockge_uid}" =~ ^[1-9][0-9]*$ ]] || die 'dockge must be a non-root account'

endpoint_user="$(systemctl show --property=User --value dockge-agent.service 2>/dev/null || true)"
[[ "${endpoint_user}" == 'dockge' ]] || die 'dockge-agent.service must be installed with User=dockge before helper installation'

install -d -o root -g root -m 0755 "${HELPER_ROOT}" "${RELEASES_DIR}"
release_dir="${RELEASES_DIR}/${release_id}"
[[ ! -e "${release_dir}" ]] || die "release already exists: ${release_dir}"
install -d -o root -g root -m 0755 "${release_dir}"
install -o root -g root -m 0755 "${artifact}" "${release_dir}/${HELPER_NAME}"
install -d -o root -g root -m 0700 "${STATE_DIR}"
install -d -o root -g root -m 0755 "${CONFIG_DIR}"

if [[ ! -e "${CONFIG_PATH}" ]]; then
    tmp_config="${CONFIG_DIR}/.quadlet-helper.json.$$"
    sed "s/__DOCKGE_UID__/${dockge_uid}/g" "${SCRIPT_DIR}/../config/quadlet-helper.json.example" > "${tmp_config}"
    install -o root -g root -m 0600 "${tmp_config}" "${CONFIG_PATH}"
    rm -f -- "${tmp_config}"
fi
[[ -f "${CONFIG_PATH}" && ! -L "${CONFIG_PATH}" ]] || die 'helper configuration must be a regular, non-symlink file'
[[ "$(stat -c '%U:%G:%a' -- "${CONFIG_PATH}")" == 'root:root:600' ]] || die 'helper configuration must be root:root mode 0600'
configured_uid="$(python3 - "${CONFIG_PATH}" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as config_file:
    value = json.load(config_file).get("allowedPeerUid")
if not isinstance(value, int) or isinstance(value, bool):
    raise SystemExit("allowedPeerUid is not an integer")
print(value)
PY
)" || die 'helper configuration is not valid JSON with an integer allowedPeerUid'
[[ "${configured_uid}" == "${dockge_uid}" ]] || die 'allowedPeerUid must exactly match the current dockge account UID'

install -o root -g root -m 0644 "${SCRIPT_DIR}/../systemd/${SOCKET_UNIT}" "/etc/systemd/system/${SOCKET_UNIT}"
install -o root -g root -m 0644 "${SCRIPT_DIR}/../systemd/${SERVICE_UNIT}" "/etc/systemd/system/${SERVICE_UNIT}"
verify_release "${release_id}"
systemctl daemon-reload
verify_unit_files
previous_release=''
if current_release_id >/dev/null 2>&1; then
    previous_release="$(current_release_id)"
fi
activation_started=false
restore_on_activation_failure() {
    local status=$?
    trap - ERR
    if [[ "${activation_started}" == true ]]; then
        if [[ -n "${previous_release}" ]]; then
            switch_current_release "${previous_release}"
        else
            rm -f -- "${CURRENT_LINK}"
        fi
        systemctl restart "${SERVICE_UNIT}" >/dev/null 2>&1 || true
    fi
    exit "${status}"
}
trap restore_on_activation_failure ERR
activation_started=true
switch_current_release "${release_id}"
systemctl enable --now "${SOCKET_UNIT}"
systemctl is-active --quiet "${SOCKET_UNIT}"
systemctl restart "${SERVICE_UNIT}"
systemctl is-active --quiet "${SERVICE_UNIT}"
activation_started=false
trap - ERR
printf 'Installed %s release %s for linux/%s. Re-log dockge to apply its new group membership.\n' "${HELPER_NAME}" "${release_id}" "${arch}"
