#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck disable=SC1091 # Source path is resolved from this script's directory.
source "${SCRIPT_DIR}/common.sh"

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
previous_release="$(current_release_id)" || die 'no current helper release is installed; use install.sh first'
[[ "${previous_release}" != "${release_id}" ]] || die 'requested release is already current'

"${SCRIPT_DIR}/install.sh" --artifact "${artifact}" --checksum "${checksum_file}" --release-id "${release_id}"
printf 'Upgraded %s from %s to %s. The socket path and persistent state were retained.\n' "${HELPER_NAME}" "${previous_release}" "${release_id}"
