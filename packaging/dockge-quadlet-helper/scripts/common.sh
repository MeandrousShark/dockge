#!/usr/bin/env bash
# Shared safeguards for administrator-run Quadlet helper lifecycle scripts.
set -euo pipefail
IFS=$'\n\t'

readonly HELPER_NAME='dockge-quadlet-helper'
readonly HELPER_ROOT='/opt/dockge-quadlet-helper'
readonly RELEASES_DIR="${HELPER_ROOT}/releases"
readonly CURRENT_LINK="${HELPER_ROOT}/current"
readonly CONFIG_DIR='/etc/dockge'
readonly CONFIG_PATH="${CONFIG_DIR}/quadlet-helper.json"
# shellcheck disable=SC2034 # Used by remove.sh after sourcing this shared file.
readonly STATE_DIR='/var/lib/dockge-quadlet-helper'
readonly SERVICE_UNIT='dockge-quadlet-helper.service'
readonly SOCKET_UNIT='dockge-quadlet-helper.socket'

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_root() {
    [[ "${EUID}" -eq 0 ]] || die 'run this script as root'
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

validate_release_id() {
    [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die 'release ID must contain only letters, digits, dot, underscore, or dash'
    [[ "$1" != .* && "$1" != *'..'* ]] || die 'release ID must not begin with dot or contain ..'
}

host_arch() {
    case "$(uname -m)" in
        x86_64) printf 'amd64\n' ;;
        aarch64|arm64) printf 'arm64\n' ;;
        *) die "unsupported host architecture: $(uname -m)" ;;
    esac
}

canonical_regular_file() {
    local candidate
    candidate="$(readlink -f -- "$1")" || die "cannot resolve file: $1"
    [[ -f "${candidate}" && ! -L "${candidate}" ]] || die "must be a regular, non-symlink file: $1"
    printf '%s\n' "${candidate}"
}

release_binary() {
    printf '%s/%s/%s\n' "${RELEASES_DIR}" "$1" "${HELPER_NAME}"
}

current_release_id() {
    [[ -L "${CURRENT_LINK}" ]] || return 1
    local target
    target="$(readlink -- "${CURRENT_LINK}")" || return 1
    [[ "${target}" == releases/* ]] || return 1
    target="${target#releases/}"
    validate_release_id "${target}"
    printf '%s\n' "${target}"
}

verify_unit_files() {
    systemd-analyze verify "/etc/systemd/system/${SOCKET_UNIT}" "/etc/systemd/system/${SERVICE_UNIT}"
}

verify_release() {
    local release_id="$1"
    local binary
    binary="$(release_binary "${release_id}")"
    [[ -f "${binary}" && ! -L "${binary}" ]] || die "release binary is missing: ${binary}"
    [[ "$(stat -c '%U:%G' -- "${binary}")" == 'root:root' ]] || die 'release binary must be owned by root:root'
    [[ "$(stat -c '%a' -- "${binary}")" == '755' ]] || die 'release binary mode must be 0755'
    "${binary}" self-test --config "${CONFIG_PATH}"
}

switch_current_release() {
    local release_id="$1"
    local temporary_link="${HELPER_ROOT}/.current.${release_id}.$$"
    ln -s "releases/${release_id}" "${temporary_link}"
    mv -Tf -- "${temporary_link}" "${CURRENT_LINK}"
}
