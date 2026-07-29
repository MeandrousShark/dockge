#!/usr/bin/env bash
# Runs the non-destructive Gate 4 installation checks. It never sends a
# Quadlet mutation and restarts the endpoint only with explicit approval.
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# shellcheck disable=SC1091 # Source path is resolved from this script's directory.
source "${SCRIPT_DIR}/common.sh"

restart_endpoint=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --restart-endpoint) restart_endpoint=true; shift ;;
        -h|--help) printf 'Usage: %s [--restart-endpoint]\n' "$0"; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done

require_root
require_command id
require_command python3
require_command runuser
require_command systemctl
verify_release "$(current_release_id)"
systemctl is-active --quiet "${SOCKET_UNIT}"
systemctl restart "${SERVICE_UNIT}"
systemctl is-active --quiet "${SERVICE_UNIT}"
id -nG dockge | tr ' ' '\n' | grep -Fx 'dockge-quadlet' >/dev/null || die 'dockge has not refreshed into dockge-quadlet; re-login or restart dockge-agent.service'

read -r -d '' capability_smoke <<'PY' || true
import json
import socket
import struct

def recv_exact(connection, count):
    chunks = []
    remaining = count
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise SystemExit("helper response ended early")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

request = {"version": 1, "id": "packagecheck", "operation": "helper.capabilities", "arguments": {}}
encoded = json.dumps(request, separators=(",", ":")).encode("utf-8")
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(5)
    connection.connect("/run/dockge-quadlet-helper.sock")
    connection.sendall(struct.pack(">I", len(encoded)) + encoded)
    header = recv_exact(connection, 4)
    size = struct.unpack(">I", header)[0]
    payload = recv_exact(connection, size)
response = json.loads(payload.decode("utf-8"))
if response.get("type") != "result" or response.get("ok") is not True:
    raise SystemExit("helper capability request failed")
result = response.get("result", {})
protocol = result.get("protocol", {})
operations = set(result.get("operations", []))
required_operations = {"helper.capabilities", "quadlet.list", "quadlet.status", "quadlet.journal"}
if (
    result.get("mode") != "read-only"
    or protocol.get("active") != 1
    or not isinstance(protocol.get("min"), int)
    or not isinstance(protocol.get("max"), int)
    or not protocol["min"] <= 1 <= protocol["max"]
    or not required_operations.issubset(operations)
):
    raise SystemExit("helper is not the compatible read-only protocol deployment")
print("helper capability smoke: ok")
PY
runuser -u dockge -- python3 -c "${capability_smoke}"

if [[ "${restart_endpoint}" == true ]]; then
    systemctl restart dockge-agent.service
    systemctl is-active --quiet dockge-agent.service
else
    printf 'dockge group membership is visible to new sessions; run %s --restart-endpoint after a planned endpoint restart.\n' "$0"
fi
