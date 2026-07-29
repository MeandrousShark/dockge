#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck disable=SC1091 # Source path is resolved from this script's directory.
source "${SCRIPT_DIR}/common.sh"

usage() {
    printf 'Usage: %s --release-id ID\n' "$0"
}

release_id=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release-id) release_id="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
[[ -n "${release_id}" ]] || { usage; exit 2; }
require_root
validate_release_id "${release_id}"
previous_release="$(current_release_id)" || die 'no current helper release is installed'
[[ "${previous_release}" != "${release_id}" ]] || die 'requested release is already current'
verify_release "${release_id}"
switch_current_release "${release_id}"
if ! systemctl restart "${SERVICE_UNIT}"; then
    printf 'error: rollback service restart failed; restoring %s\n' "${previous_release}" >&2
    switch_current_release "${previous_release}"
    systemctl restart "${SERVICE_UNIT}" || true
    exit 1
fi
printf 'Rolled back %s from %s to %s. State and all Quadlet sources were left untouched.\n' "${HELPER_NAME}" "${previous_release}" "${release_id}"
