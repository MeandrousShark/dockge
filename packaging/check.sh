#!/usr/bin/env bash
# Fast repository-local packaging checks; safe to run without root or systemd.
set -euo pipefail
IFS=$'\n\t'

ROOT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)"
scripts=(
    "${ROOT_DIR}/packaging/dockge-quadlet-helper/scripts/"*.sh
    "${ROOT_DIR}/packaging/dockge-agent/scripts/"*.sh
)

bash -n "${scripts[@]}"
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "${scripts[@]}"
else
    printf 'shellcheck is not installed; bash syntax checks completed\n' >&2
fi

python3 - "${ROOT_DIR}/packaging/dockge-quadlet-helper/config/quadlet-helper.json.example" <<'PY'
import json
import pathlib
import sys

template = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
config = json.loads(template.replace("__DOCKGE_UID__", "1001"))
assert config["allowedPeerUid"] == 1001
assert set(config["roots"]) == {"admin", "runtime", "distribution"}
PY
