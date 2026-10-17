#!/bin/bash
# Install the dashboard into a fresh, dedicated Debian 13 container.
# This script never creates containers and must not run on the Proxmox host.
set -Eeuo pipefail
umask 0077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONDONTWRITEBYTECODE=1

usage() {
    cat <<'USAGE'
Usage: install_lxc_guest.sh --source-dir ABS_REPO --config ABS_JSON [options]

Install natively in a fresh Debian 13 container with systemd running as PID 1.
Run as root inside the dedicated container; never on the Proxmox host.

  --source-dir PATH       Absolute path to the dashboard source bundle
  --config PATH           Absolute path to a validated canonical config.json
  --listen-address IP     Literal IPv4/IPv6 address (default: 0.0.0.0)
  --listen-port PORT      Unprivileged port 1024..65535 (default: 8080)
  --help                  Show this help

Existing dashboard installations are refused. An existing canonical config is
preserved when it is equivalent to --config; conflicting configurations fail.
The HTTP listener is a backend for a trusted LAN or a protected HTTPS proxy.
USAGE
}

fail() {
    printf 'Installation error: %s\n' "$*" >&2
    exit 2
}

source_dir=
config_input=
listen_address=0.0.0.0
listen_port=8080
staging_dir=
apt_refreshed=false
declare -A seen_flags=()

while (($#)); do
    case "$1" in
        --help) usage; exit 0 ;;
        --source-dir|--config|--listen-address|--listen-port)
            (($# >= 2)) || fail "$1 requires a value"
            [[ -z ${seen_flags[$1]:-} ]] || fail "$1 was specified more than once"
            seen_flags[$1]=1
            case "$1" in
                --source-dir) source_dir=$2 ;;
                --config) config_input=$2 ;;
                --listen-address) listen_address=$2 ;;
                --listen-port) listen_port=$2 ;;
            esac
            shift 2
            ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[[ $source_dir = /* && $config_input = /* ]] || fail "--source-dir and --config must be absolute paths"
((EUID == 0)) || fail "run as root inside the dedicated Debian 13 container"
[[ -r /etc/os-release ]] || fail "cannot identify the guest operating system"
# This is the operating system's root-owned metadata, never the supplied JSON.
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} == 13 ]] || fail "only a fresh Debian 13 container is supported"
command -v systemd-detect-virt >/dev/null || fail "systemd-detect-virt is required"
systemd-detect-virt --container >/dev/null || fail "refusing to install outside a container; do not run on the Proxmox host"
[[ $(cat /proc/1/comm) == systemd ]] || fail "the container must run systemd as PID 1"
systemctl show-environment >/dev/null || fail "the container's systemd manager is unavailable"

source_dir=$(readlink -e -- "$source_dir") || fail "source directory does not exist"
config_input=$(readlink -e -- "$config_input") || fail "configuration file does not exist"
[[ -d $source_dir && -f $config_input ]] || fail "source must be a directory and configuration must be a regular file"
for asset in index.html LICENSE tools/render_config.py lxc/nginx.conf lxc/dobbelt-pi-hole.service; do
    [[ -f $source_dir/$asset && ! -L $source_dir/$asset ]] || fail "source bundle is missing a regular $asset"
done

for installed in /opt/dobbelt-pi-hole /usr/share/dobbelt-pi-hole \
    /etc/systemd/system/dobbelt-pi-hole.service /etc/dobbelt-pi-hole/nginx.conf \
    /etc/dobbelt-pi-hole/listen.env /usr/share/licenses/dobbelt-pi-hole; do
    [[ ! -e $installed && ! -L $installed ]] || fail "existing installation at $installed; this installer supports fresh guests only"
done
if getent passwd dobbelt-pi-hole >/dev/null || getent group dobbelt-pi-hole >/dev/null \
    || systemctl cat dobbelt-pi-hole.service >/dev/null 2>&1; then
    fail "the dashboard user, group or service already exists; this installer supports fresh guests only"
fi

canonical=/etc/dobbelt-pi-hole/config.json
[[ ! -L /etc/dobbelt-pi-hole && ! -L $canonical ]] || fail "configuration directory/file must not be symbolic links"
[[ ! -e /etc/dobbelt-pi-hole || -d /etc/dobbelt-pi-hole ]] || fail "configuration directory is not a directory"
[[ ! -e $canonical || -f $canonical ]] || fail "existing configuration is not a regular file"

cleanup() {
    if [[ -n $staging_dir ]]; then
        rm -rf -- "$staging_dir"
    fi
}
on_error() {
    local status=$?
    printf 'Installation failed (exit %s). No existing configuration was replaced. Review the preceding error before retrying.\n' "$status" >&2
    exit "$status"
}
trap cleanup EXIT
trap on_error ERR

install_packages() {
    if [[ $apt_refreshed == false ]]; then
        apt-get update
        apt_refreshed=true
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "$@"
}

# Minimal Debian templates need Python before the source can be validated.
# OS/container/fresh-install guards above always run before any package action.
if ! command -v python3 >/dev/null; then
    install_packages python3
fi

validated_listen=$(python3 - "$source_dir" "$config_input" "$canonical" "$listen_address" "$listen_port" <<'PY'
import importlib.util
import ipaddress
from pathlib import Path
import re
import sys

source, supplied, canonical, address, port = sys.argv[1:]
spec = importlib.util.spec_from_file_location("dashboard_render_config", Path(source) / "tools/render_config.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
try:
    config = renderer.load_config(supplied)
    if Path(canonical).exists() and renderer.load_config(canonical) != config:
        raise renderer.ConfigError("existing canonical configuration differs from --config; refusing to replace or silently ignore it")
    if "%" in address:
        raise renderer.ConfigError("listen address must not include an IPv6 zone identifier")
    address = ipaddress.ip_address(address).compressed
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1024 <= int(port) <= 65535:
        raise renderer.ConfigError("listen port must be between 1024 and 65535 for the unprivileged service")
    port = int(port)
    renderer.render_nginx(config, "/run/dobbelt-pi-hole/config.json", source,
                          renderer.read_resolvers("/etc/resolv.conf"), port, listen_address=address)
except (renderer.ConfigError, ValueError) as error:
    print(f"Installation error: {error}", file=sys.stderr)
    sys.exit(2)
print(address, port)
PY
)
read -r listen_address listen_port <<< "$validated_listen"

install_packages curl ca-certificates
staging_dir=$(mktemp -d /tmp/dobbelt-pi-hole-install.XXXXXXXX)
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 120 --retry 3 \
    --output "$staging_dir/chart.umd.min.js" \
    https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 120 --retry 3 \
    --output "$staging_dir/chart-LICENSE" \
    https://raw.githubusercontent.com/chartjs/Chart.js/v4.4.1/LICENSE.md
printf '81ffafe13c37e1b25793b020d446f4d9739b949dadb7f9f79d709a0cad781c2f  %s\n' \
    "$staging_dir/chart.umd.min.js" | sha256sum --check --status
printf '5a0877ad6d818529be4f33009d0942cdf7e2ed7656156f4aba7308459a546030  %s\n' \
    "$staging_dir/chart-LICENSE" | sha256sum --check --status

# Only the dedicated guest reaches this point. Prevent the package's default
# nginx site from starting during installation; the dashboard has its own unit.
systemctl mask --now nginx.service
install_packages nginx
systemctl disable nginx.service
systemctl mask --now nginx.service

useradd --system --user-group --home-dir /nonexistent --no-create-home \
    --shell /usr/sbin/nologin dobbelt-pi-hole
install -d -o root -g root -m 0755 /opt/dobbelt-pi-hole /usr/share/dobbelt-pi-hole \
    /usr/share/licenses/dobbelt-pi-hole /usr/share/licenses/chart.js
install -d -o root -g dobbelt-pi-hole -m 0750 /etc/dobbelt-pi-hole
install -o root -g root -m 0644 "$source_dir/tools/render_config.py" /opt/dobbelt-pi-hole/render_config.py
install -o root -g root -m 0644 "$source_dir/index.html" /usr/share/dobbelt-pi-hole/index.html
install -o root -g root -m 0644 "$staging_dir/chart.umd.min.js" /usr/share/dobbelt-pi-hole/chart.umd.min.js
install -o root -g root -m 0644 "$source_dir/LICENSE" /usr/share/licenses/dobbelt-pi-hole/LICENSE
install -o root -g root -m 0644 "$staging_dir/chart-LICENSE" /usr/share/licenses/chart.js/LICENSE
install -o root -g dobbelt-pi-hole -m 0640 "$source_dir/lxc/nginx.conf" /etc/dobbelt-pi-hole/nginx.conf
if [[ -f $canonical ]]; then
    chown root:dobbelt-pi-hole "$canonical"
    chmod 0640 "$canonical"
    printf 'Retained existing canonical configuration without changing its contents.\n'
else
    install -o root -g dobbelt-pi-hole -m 0640 "$config_input" "$canonical"
fi
printf 'DASHBOARD_LISTEN_ADDRESS=%s\nDASHBOARD_LISTEN_PORT=%s\n' \
    "$listen_address" "$listen_port" > "$staging_dir/listen.env"
install -o root -g dobbelt-pi-hole -m 0640 "$staging_dir/listen.env" /etc/dobbelt-pi-hole/listen.env
install -o root -g root -m 0644 "$source_dir/lxc/dobbelt-pi-hole.service" /etc/systemd/system/dobbelt-pi-hole.service

systemctl daemon-reload
systemctl enable --now dobbelt-pi-hole.service
health_address=$listen_address
[[ $health_address != 0.0.0.0 ]] || health_address=127.0.0.1
[[ $health_address != :: ]] || health_address=::1
[[ $health_address != *:* ]] || health_address="[$health_address]"
# Type=exec reports the execve, before nginx has necessarily bound the socket.
health_response=$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    --retry 10 --retry-connrefused --retry-delay 1 --retry-max-time 15 \
    "http://$health_address:$listen_port/healthz") || fail "the dashboard health check could not connect successfully"
[[ $health_response == ok ]] || fail "the dashboard health check did not return ok"
systemctl is-active --quiet dobbelt-pi-hole.service
printf 'Dashboard installed. Service: dobbelt-pi-hole.service; HTTP backend: %s:%s.\n' "$listen_address" "$listen_port"
printf 'Configuration: /etc/dobbelt-pi-hole/config.json. Protect network access with your HTTPS proxy/firewall.\n'
