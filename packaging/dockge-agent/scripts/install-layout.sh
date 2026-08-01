#!/usr/bin/env bash
# Establishes only the administrator-owned endpoint layout. It never downloads
# releases, generates service tokens, modifies firewall rules, or changes a
# live source tree.
set -euo pipefail
IFS=$'\n\t'

readonly AGENT_ROOT='/opt/dockge-agent'
readonly RELEASES_DIR="${AGENT_ROOT}/releases"
readonly CURRENT_LINK="${AGENT_ROOT}/current"
readonly ENV_DIR='/etc/dockge'
readonly ENV_PATH="${ENV_DIR}/agent.env"
readonly DATA_DIR='/var/lib/dockge-agent'
readonly UNIT='dockge-agent.service'

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
require_root() { [[ "${EUID}" -eq 0 ]] || die 'run this script as root'; }
valid_release_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$1" != .* && "$1" != *'..'* ]] || die 'invalid release ID'; }
usage() { printf 'Usage: %s --release-id ID [--activate]\n' "$0"; }

release_id=''
activate=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --release-id) release_id="${2:-}"; shift 2 ;;
        --activate) activate=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
[[ -n "${release_id}" ]] || { usage; exit 2; }
require_root
valid_release_id "${release_id}"
command -v getent >/dev/null || die 'getent is required'
command -v systemctl >/dev/null || die 'systemctl is required'
command -v find >/dev/null || die 'find is required'
command -v ln >/dev/null || die 'ln is required'
command -v mv >/dev/null || die 'mv is required'
command -v readlink >/dev/null || die 'readlink is required'
command -v rm >/dev/null || die 'rm is required'
[[ -f /usr/local/bin/node && ! -L /usr/local/bin/node && -x /usr/local/bin/node ]] || die 'the administrator-installed Node runtime must be a regular non-symlink executable at /usr/local/bin/node'
[[ "$(stat -c '%u' -- /usr/local/bin/node)" == '0' ]] || die 'the Node runtime must be root-owned'
node_mode="$(stat -c '%a' -- /usr/local/bin/node)"
(( (8#${node_mode} & 0022) == 0 )) || die 'the Node runtime must not be writable by group or others'
getent passwd dockge >/dev/null || die 'the dedicated dockge account must exist'
getent group dockge-podman >/dev/null || die 'the explicit rootful Podman socket group dockge-podman must exist'

release_dir="${RELEASES_DIR}/${release_id}"
[[ -d "${release_dir}" && ! -L "${release_dir}" ]] || die "administrator-owned release directory is missing: ${release_dir}"
[[ "$(stat -c '%u:%g:%a' -- "${release_dir}")" == '0:0:755' ]] || die 'release directory must be root:root mode 0755'
release_root="$(readlink -f -- "${release_dir}")"
while IFS= read -r -d '' release_entry; do
    [[ "$(stat -c '%u' -- "${release_entry}")" == '0' ]] || die "release entry is not root-owned: ${release_entry}"
    if [[ -L "${release_entry}" ]]; then
        resolved_entry="$(readlink -f -- "${release_entry}")" || die "release symlink cannot be resolved: ${release_entry}"
        case "${resolved_entry}" in
            "${release_root}"|"${release_root}"/*) ;;
            *) die "release symlink resolves outside its release root: ${release_entry}" ;;
        esac
    elif [[ -f "${release_entry}" || -d "${release_entry}" ]]; then
        entry_mode="$(stat -c '%a' -- "${release_entry}")"
        (( (8#${entry_mode} & 0022) == 0 )) || die "release entry is writable by group or others: ${release_entry}"
    else
        die "release contains an unsupported filesystem entry: ${release_entry}"
    fi
done < <(find -P "${release_dir}" -xdev -print0)

install -d -o root -g root -m 0755 "${AGENT_ROOT}" "${RELEASES_DIR}" "${ENV_DIR}"
install -d -o dockge -g dockge -m 0700 "${DATA_DIR}" "${DATA_DIR}/data" "${DATA_DIR}/stacks"
if [[ ! -e "${ENV_PATH}" ]]; then
    install -o root -g root -m 0600 "$(dirname -- "$0")/../environment/agent.env.example" "${ENV_PATH}"
fi
[[ -f "${ENV_PATH}" && ! -L "${ENV_PATH}" ]] || die 'agent environment must be a regular, non-symlink file'
[[ "$(stat -c '%U:%G:%a' -- "${ENV_PATH}")" == 'root:root:600' ]] || die 'agent environment must be root:root mode 0600'
install -o root -g root -m 0644 "$(dirname -- "$0")/../systemd/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload
systemd-analyze verify "/etc/systemd/system/${UNIT}"

if [[ "${activate}" == true ]]; then
    grep -Eq '^DOCKGE_AGENT_ONLY=true$' "${ENV_PATH}" || die 'agent-only mode must remain enabled'
    grep -Eq '^DOCKGE_ENABLE_CONSOLE=false$' "${ENV_PATH}" || die 'the Dockge console must remain disabled'
    grep -Eq '^DOCKGE_AGENT_TOKEN_SHA256=[0-9a-f]{64}$' "${ENV_PATH}" || die 'agent environment needs a 64-character lowercase SHA-256 digest, never a raw token'
    grep -Eq '^DOCKGE_AGENT_ENDPOINT_ID=[^[:space:]]+:[0-9]+$' "${ENV_PATH}" || die 'agent endpoint identity must include an explicit port'
    service_was_active=false
    if systemctl is-active --quiet "${UNIT}"; then
        service_was_active=true
    fi
    service_was_enabled=false
    if systemctl is-enabled --quiet "${UNIT}"; then
        service_was_enabled=true
    fi
    previous_release=''
    if [[ -L "${CURRENT_LINK}" ]]; then
        current_target="$(readlink -- "${CURRENT_LINK}")"
        [[ "${current_target}" == releases/* ]] || die 'current endpoint release link has an unexpected target'
        previous_release="${current_target#releases/}"
        valid_release_id "${previous_release}"
    fi
    activation_started=false
    restore_on_activation_failure() {
        local status=$?
        trap - ERR
        if [[ "${activation_started}" == true ]]; then
            if [[ -n "${previous_release}" ]]; then
                ln -s "releases/${previous_release}" "${AGENT_ROOT}/.current.${previous_release}.$$"
                mv -Tf -- "${AGENT_ROOT}/.current.${previous_release}.$$" "${CURRENT_LINK}"
            else
                rm -f -- "${CURRENT_LINK}"
            fi
            if [[ "${service_was_enabled}" == true ]]; then
                systemctl enable "${UNIT}" >/dev/null 2>&1 || true
            else
                systemctl disable "${UNIT}" >/dev/null 2>&1 || true
            fi
            if [[ "${service_was_active}" == true ]]; then
                systemctl restart "${UNIT}" >/dev/null 2>&1 || true
            else
                systemctl stop "${UNIT}" >/dev/null 2>&1 || true
            fi
        fi
        exit "${status}"
    }
    trap restore_on_activation_failure ERR
    temporary_link="${AGENT_ROOT}/.current.${release_id}.$$"
    activation_started=true
    ln -s "releases/${release_id}" "${temporary_link}"
    mv -Tf -- "${temporary_link}" "${CURRENT_LINK}"
    if [[ "${service_was_active}" == true ]]; then
        systemctl enable "${UNIT}"
        systemctl restart "${UNIT}"
    else
        systemctl enable --now "${UNIT}"
    fi
    systemctl is-active --quiet "${UNIT}"
    activation_started=false
    trap - ERR
fi

printf 'Endpoint layout is ready. Release, configuration, and unit are administrator-owned; only %s is writable by dockge.\n' "${DATA_DIR}"
