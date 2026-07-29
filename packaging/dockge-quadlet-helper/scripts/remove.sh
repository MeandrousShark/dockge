#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck disable=SC1091 # Source path is resolved from this script's directory.
source "${SCRIPT_DIR}/common.sh"

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
    printf 'Usage: %s\n' "$0"
    exit 0
fi
[[ $# -eq 0 ]] || die 'remove.sh accepts no arguments'
require_root
require_command gpasswd
require_command systemctl

systemctl disable --now "${SOCKET_UNIT}" "${SERVICE_UNIT}" 2>/dev/null || true
rm -f -- "/etc/systemd/system/${SOCKET_UNIT}" "/etc/systemd/system/${SERVICE_UNIT}"
systemctl daemon-reload
gpasswd -d dockge dockge-quadlet >/dev/null 2>&1 || true

printf '%s removed. Retained: %s, %s, and every live/external Quadlet source.\n' \
    "${HELPER_NAME}" "${HELPER_ROOT}/releases" "${STATE_DIR}"
