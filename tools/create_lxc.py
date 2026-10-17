#!/usr/bin/env python3
"""Create a new unprivileged Proxmox VE 9 container and install the dashboard.

Run from a reviewed repository checkout on the target Proxmox node as root.
Only a newly created container is provisioned. Existing guests, host network
configuration and firewall rules are never modified. --dry-run reads inventory
and the existing template catalogue without downloading or changing anything.
"""

from __future__ import annotations

import sys

# The inspection path must not create __pycache__ files in the checkout.
sys.dont_write_bytecode = True

import argparse
from dataclasses import dataclass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid

from render_config import ConfigError, load_config


ROOT = Path(__file__).resolve().parents[1]
BUNDLE_FILES = (
    "index.html", "LICENSE", "tools/render_config.py",
    "tools/install_lxc_guest.sh", "lxc/nginx.conf", "lxc/dobbelt-pi-hole.service",
)
STORAGE_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
INTERFACE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,14}\Z")
DNS_LABEL = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z")
TEMPLATE = re.compile(r"debian-13-standard_[0-9][A-Za-z0-9.+~_-]*_amd64\.tar\.(?:zst|gz|xz)\Z")
TOOLS = ("pveversion", "pvesh", "pveam", "pvesm", "pct")
NETWORK_WAIT_SECONDS = 180
# Only fixed installation endpoints occur in this guest-side Bash program.
# It works before Python/curl are installed and never interpolates user input.
NETWORK_PROBE = """set -e
/usr/bin/getent ahostsv4 deb.debian.org >/dev/null
/usr/bin/getent ahostsv4 raw.githubusercontent.com >/dev/null
exec 3<>/dev/tcp/cdnjs.cloudflare.com/443
"""


class InstallError(RuntimeError):
    """A provisioning failure that can be reported without a Python traceback."""


class Runner:
    """Execute argument arrays with bounded timeouts, never through a shell."""

    def run(self, arguments, *, timeout=60, capture=True, check=True):
        command = [str(argument) for argument in arguments]
        print("+ " + shlex.join(command), flush=True)
        environment = os.environ.copy()
        environment.update(LC_ALL="C", LANG="C")
        try:
            result = subprocess.run(
                command, text=True, capture_output=capture, timeout=timeout,
                env=environment, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise InstallError(f"Command could not complete: {command[0]}: {error}") from None
        if check and result.returncode:
            detail = ((result.stderr or "") + (result.stdout or ""))[-3000:].strip()
            raise InstallError(f"Command failed ({result.returncode}): {shlex.join(command)}\n{detail}")
        return result

    def get(self, path, *arguments):
        result = self.run(["pvesh", "get", path, *arguments, "--output-format", "json"])
        try:
            return json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError):
            raise InstallError(f"Proxmox returned invalid JSON for {path}") from None


@dataclass(frozen=True)
class Plan:
    """An inspected local node, free guest ID and exact template volume."""

    node: str
    ctid: int
    template: str
    download: bool
    marker: str


def parser():
    """Describe the host installer; all environment-specific settings are options."""
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--config", type=Path, required=True, help="canonical instance JSON to copy into the new CT")
    result.add_argument("--storage", required=True, help="active rootdir storage for the new CT disk")
    result.add_argument("--template-storage", default="local", help="active vztmpl storage (default: local)")
    result.add_argument("--template", help="existing Debian 13 amd64 standard template volume; default: select from PVE catalogue")
    result.add_argument("--bridge", default="vmbr0", help="existing active Linux/OVS bridge (default: vmbr0)")
    result.add_argument("--ctid", type=int, help="unused cluster-wide VM/CT ID; default: next free ID")
    result.add_argument("--hostname", default="dobbelt-pi-hole")
    result.add_argument("--ipv4", default="dhcp", help="dhcp or static IPv4/CIDR")
    result.add_argument("--gateway", help="IPv4 gateway; valid only with a static IPv4 address")
    result.add_argument("--vlan", type=int, help="optional VLAN tag, 1–4094")
    result.add_argument("--nameserver", action="append", default=[], help="DNS server IP; repeat for multiple servers")
    result.add_argument("--cores", type=int, default=1)
    result.add_argument("--memory", type=int, default=512, help="RAM in MiB (default: 512)")
    result.add_argument("--swap", type=int, default=0, help="swap limit in MiB (default: 0)")
    result.add_argument("--disk", type=int, default=4, help="root disk in GiB (default: 4)")
    result.add_argument("--dry-run", action="store_true", help="read-only inspection and plan; no downloads or changes")
    return result


def validate_arguments(arguments):
    """Reject malformed network/storage input before any Proxmox command runs."""
    for key in ("storage", "template_storage"):
        if not STORAGE_ID.fullmatch(getattr(arguments, key)):
            raise InstallError(f"--{key.replace('_', '-')} is not a valid Proxmox storage ID")
    if not INTERFACE.fullmatch(arguments.bridge):
        raise InstallError("--bridge is not a valid Linux interface name")
    if len(arguments.hostname) > 253 or not all(DNS_LABEL.fullmatch(label) for label in arguments.hostname.split(".")):
        raise InstallError("--hostname must be a DNS hostname")
    for key, minimum, maximum in (
        ("ctid", 100, 999999999), ("cores", 1, 128), ("memory", 256, 1048576),
        ("swap", 0, 1048576), ("disk", 2, 65536), ("vlan", 1, 4094),
    ):
        value = getattr(arguments, key)
        if value is not None and not minimum <= value <= maximum:
            raise InstallError(f"--{key} must be between {minimum} and {maximum}")
    if arguments.ipv4 == "dhcp":
        if arguments.gateway:
            raise InstallError("--gateway requires a static --ipv4 address")
    else:
        try:
            if "/" not in arguments.ipv4:
                raise ValueError()
            address = ipaddress.IPv4Interface(arguments.ipv4)
            if address.ip.is_unspecified or address.ip.is_multicast or address.ip.is_loopback:
                raise ValueError()
            if address.network.prefixlen < 31 and address.ip in (address.network.network_address, address.network.broadcast_address):
                raise ValueError()
        except ValueError:
            raise InstallError("--ipv4 must be dhcp or a usable static IPv4 address with CIDR prefix") from None
        arguments.ipv4 = str(address)
        if arguments.gateway:
            try:
                gateway = ipaddress.IPv4Address(arguments.gateway)
                if gateway.is_unspecified or gateway.is_multicast or gateway.is_loopback or gateway == address.ip:
                    raise ValueError()
            except ValueError:
                raise InstallError("--gateway must be a usable IPv4 router address") from None
            arguments.gateway = str(gateway)
    for index, value in enumerate(arguments.nameserver):
        try:
            address = ipaddress.ip_address(value)
            if "%" in value or address.is_unspecified or address.is_multicast or address.is_loopback:
                raise ValueError()
        except ValueError:
            raise InstallError("--nameserver must be a DNS server IP reachable from the CT") from None
        arguments.nameserver[index] = str(address)
    if arguments.template:
        prefix = arguments.template_storage + ":vztmpl/"
        if not arguments.template.startswith(prefix) or not TEMPLATE.fullmatch(arguments.template[len(prefix):]):
            raise InstallError("--template must be a Debian 13 standard amd64 volume on --template-storage")


def snapshot_source(root=ROOT):
    """Read only the installation allowlist, excluding Git state and private files."""
    result = {}
    for name in BUNDLE_FILES:
        source = root / name
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise InstallError(f"Missing or unsafe installation source: {source}")
        content = source.read_bytes()
        if len(content) > 5 * 1024 * 1024:
            raise InstallError(f"Unexpectedly large installation source: {source}")
        result[name] = content
    return result


def ensure_host(runner):
    """Require the supported host architecture, root and Proxmox CLI tools."""
    if os.geteuid() != 0:
        raise InstallError("Run this installer as root on the target Proxmox VE node")
    if platform.machine() not in {"x86_64", "amd64"}:
        raise InstallError("This installer supports amd64 Proxmox VE hosts")
    missing = [name for name in TOOLS if not shutil.which(name)]
    if missing:
        raise InstallError("Required Proxmox tools are missing: " + ", ".join(missing))
    version = runner.run(["pveversion"]).stdout.strip()
    if not re.search(r"\bpve-manager/9\.", version):
        raise InstallError("This installer supports Proxmox VE 9; detected: " + version)


def inventory_plan(arguments, runner):
    """Inspect the local node, storage, bridge and ID before any guest mutation."""
    status = runner.get("/cluster/status")
    if not isinstance(status, list):
        raise InstallError("Invalid cluster status response")
    if any(item.get("type") == "cluster" and not item.get("quorate") for item in status):
        raise InstallError("The Proxmox cluster has no quorum")
    nodes = [item["name"] for item in status if item.get("type") == "node" and item.get("local") == 1]
    if len(nodes) != 1 or not DNS_LABEL.fullmatch(nodes[0]):
        raise InstallError("Could not identify exactly one local Proxmox node")
    node = nodes[0]
    storages = runner.get(f"/nodes/{node}/storage", "--enabled", "1")
    for identifier, content in ((arguments.storage, "rootdir"), (arguments.template_storage, "vztmpl")):
        matches = [item for item in storages if item.get("storage") == identifier]
        if len(matches) != 1 or not matches[0].get("active") or not matches[0].get("enabled", 1):
            raise InstallError(f"Storage {identifier} is not active and enabled on {node}")
        if content not in str(matches[0].get("content", "")).split(","):
            raise InstallError(f"Storage {identifier} does not support {content}")
        if content == "rootdir" and int(matches[0].get("avail", 0)) < arguments.disk * 1024**3:
            raise InstallError(f"Storage {identifier} has less free space than the requested root disk")
    networks = runner.get(f"/nodes/{node}/network")
    if not any(item.get("iface") == arguments.bridge and item.get("active")
               and item.get("type") in {"bridge", "OVSBridge"} for item in networks):
        raise InstallError(f"Bridge {arguments.bridge} is not an active Linux/OVS bridge on {node}")
    guests = runner.get("/cluster/resources", "--type", "vm")
    ctid = arguments.ctid
    if ctid is None:
        ctid = runner.get("/cluster/nextid")
    if type(ctid) is not int or not 100 <= ctid <= 999999999:
        raise InstallError("Proxmox did not provide a valid free CT ID")
    if any(int(item["vmid"]) == ctid for item in guests):
        raise InstallError(f"ID {ctid} is already used by a VM or CT; existing guests are never modified")
    # nextid checks the current cluster-wide state but does not reserve the ID.
    # pct create remains the authoritative race-safe allocation, without --force.
    runner.get("/cluster/nextid", "--vmid", str(ctid))
    if arguments.template:
        volume = arguments.template
    else:
        if not arguments.dry_run:
            runner.run(["pveam", "update"], timeout=180, capture=False)
        catalogue = runner.get(f"/nodes/{node}/aplinfo")
        candidates = [item["template"] for item in catalogue
                      if isinstance(item.get("template"), str) and TEMPLATE.fullmatch(item["template"])
                      and item.get("section", "system") == "system"
                      and item.get("architecture", "amd64") == "amd64"]
        if not candidates:
            raise InstallError("No Debian 13 standard amd64 template is available in the PVE catalogue; check pveam update")
        name = max(candidates, key=lambda value: (tuple(map(int, re.findall(r"\d+", value))), value))
        volume = arguments.template_storage + ":vztmpl/" + name
    cached = runner.get(f"/nodes/{node}/storage/{arguments.template_storage}/content", "--content", "vztmpl")
    download = not any(item.get("volid") == volume for item in cached)
    if arguments.template and download:
        raise InstallError(f"The explicitly requested template does not exist: {volume}")
    return Plan(node, ctid, volume, download, "dobbelt-pi-hole-install:" + uuid.uuid4().hex)


def create_command(arguments, plan):
    """Build pct create with an unprivileged fresh rootfs and bounded resources."""
    network = f"name=eth0,bridge={arguments.bridge},ip={arguments.ipv4},ip6=manual,firewall=1,type=veth"
    if arguments.gateway:
        network += ",gw=" + arguments.gateway
    if arguments.vlan is not None:
        network += ",tag=" + str(arguments.vlan)
    result = [
        "pct", "create", str(plan.ctid), plan.template,
        "--unprivileged", "1", "--ostype", "debian", "--arch", "amd64",
        "--hostname", arguments.hostname, "--cores", str(arguments.cores),
        "--memory", str(arguments.memory), "--swap", str(arguments.swap),
        "--rootfs", f"{arguments.storage}:{arguments.disk}", "--net0", network,
        "--onboot", "0", "--start", "0", "--protection", "1", "--description", plan.marker,
    ]
    if arguments.nameserver:
        result.extend(["--nameserver", " ".join(arguments.nameserver)])
    return result


def owns_container(runner, plan):
    """Check a per-installation marker before acting on an already created ID."""
    current = runner.get(f"/nodes/{plan.node}/lxc/{plan.ctid}/config")
    return isinstance(current, dict) and current.get("description", "").strip() == plan.marker


def guest_command(plan, *arguments):
    """Execute inside the fresh guest without inheriting the host environment."""
    return ["pct", "exec", str(plan.ctid), "--keep-env", "0", "--", *map(str, arguments)]


def run_owned(runner, plan, arguments, **options):
    """Recheck identity before each CT operation, including after long downloads.

    pct has no conditional exec/push API. Protection prevents ordinary deletion;
    the marker additionally detects a CT replaced by an administrator who has
    deliberately cleared protection. Never continue into that replacement.
    """
    if not owns_container(runner, plan):
        raise InstallError(f"CT {plan.ctid} ownership changed; refusing further guest operations")
    return runner.run(arguments, **options)


def wait_guest_network(arguments, plan, runner):
    """Wait for the configured IPv4 address and download networking before apt.

    A working pct exec alone says nothing about DHCP or DNS readiness. Inspect
    eth0, then resolve the package/license hosts and connect to the Chart.js
    HTTPS endpoint. Individual guest probes and the retry window are bounded.
    """
    deadline = time.monotonic() + NETWORK_WAIT_SECONDS
    expected_ip = None if arguments.ipv4 == "dhcp" else str(ipaddress.IPv4Interface(arguments.ipv4).ip)
    print(f"Waiting up to {NETWORK_WAIT_SECONDS} seconds for guest IPv4, DNS and download connectivity.", flush=True)
    reason = "eth0 has no usable IPv4 address"
    while time.monotonic() < deadline:
        addresses = run_owned(runner, plan, guest_command(
            plan, "/usr/sbin/ip", "-j", "-4", "address", "show", "dev", "eth0",
        ), timeout=10, check=False)
        usable = []
        if addresses.returncode == 0:
            try:
                for interface in json.loads(addresses.stdout):
                    for entry in interface.get("addr_info", []):
                        address = ipaddress.IPv4Address(entry.get("local", ""))
                        if (entry.get("scope") == "global" and not address.is_unspecified
                                and not address.is_loopback and not address.is_link_local
                                and not address.is_multicast
                                and (expected_ip is None or str(address) == expected_ip)):
                            usable.append(address)
            except (TypeError, ValueError, AttributeError):
                usable = []
        remaining = deadline - time.monotonic()
        if usable and remaining >= 1:
            # timeout runs inside the CT, so a slow DNS/TCP probe cannot linger
            # in the guest after the host's command wrapper has returned.
            seconds = max(1, min(8, int(remaining)))
            probe = run_owned(runner, plan, guest_command(
                plan, "/usr/bin/timeout", str(seconds), "/bin/bash", "-c", NETWORK_PROBE,
            ), timeout=seconds + 5, check=False)
            if probe.returncode == 0:
                return
            reason = "installation DNS or the Chart.js HTTPS endpoint is not reachable"
        else:
            reason = "eth0 has no usable configured IPv4 address"
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise InstallError(f"Guest networking did not become ready within {NETWORK_WAIT_SECONDS} seconds: {reason}")


def provision(arguments, plan, files, config, runner):
    """Create, populate and health-check a new CT; never delete it on failure."""
    created = False
    create_attempted = False
    try:
        if plan.download:
            runner.run(["pveam", "download", arguments.template_storage, plan.template.split("/", 1)[1]],
                       timeout=900, capture=False)
            cached = runner.get(f"/nodes/{plan.node}/storage/{arguments.template_storage}/content", "--content", "vztmpl")
            if not any(item.get("volid") == plan.template for item in cached):
                raise InstallError("The downloaded template volume is missing from storage")
        create_attempted = True
        runner.run(create_command(arguments, plan), timeout=900, capture=False)
        # Do not mark a failed/racing create as ours, even if the ID now exists.
        created = True
        if not owns_container(runner, plan):
            created = False
            raise InstallError("The created CT no longer has this installation's ownership marker; stopping without further actions")
        current = runner.get(f"/nodes/{plan.node}/lxc/{plan.ctid}/config")
        if (current.get("unprivileged") != 1 or current.get("ostype") != "debian"
                or current.get("onboot", 0) != 0 or current.get("protection") != 1):
            raise InstallError("The created CT does not match the required unprivileged Debian/onboot/protection configuration")
        run_owned(runner, plan, ["pct", "start", str(plan.ctid)], timeout=120, capture=False)
        deadline = time.monotonic() + 90
        while True:
            ready = run_owned(runner, plan, guest_command(plan, "/bin/true"), timeout=10, check=False)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise InstallError("The new CT did not become ready for guest commands within 90 seconds")
            time.sleep(2)
        wait_guest_network(arguments, plan, runner)
        guest_root = "/root/" + plan.marker.replace(":", "-")
        directories = sorted({guest_root, *(guest_root + "/" + str(Path(name).parent) for name in files)})
        run_owned(runner, plan, guest_command(plan, "/usr/bin/install", "-d", "-m", "0700", *directories))
        with tempfile.TemporaryDirectory(prefix="dobbelt-lxc-") as temporary:
            local_root = Path(temporary)
            payload = dict(files)
            payload["config.json"] = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            for name, content in payload.items():
                source = local_root / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_bytes(content)
                source.chmod(0o600)
                run_owned(runner, plan, ["pct", "push", str(plan.ctid), str(source), guest_root + "/" + name,
                                        "--user", "0", "--group", "0", "--perms", "0600"], timeout=60)
        run_owned(runner, plan, guest_command(
            plan, "/bin/bash", guest_root + "/tools/install_lxc_guest.sh",
            "--source-dir", guest_root, "--config", guest_root + "/config.json",
            "--listen-address", "0.0.0.0", "--listen-port", "8080",
        ), timeout=1800, capture=False)
        run_owned(runner, plan, guest_command(plan, "/usr/bin/systemctl", "is-active", "--quiet", "dobbelt-pi-hole.service"))
        check = (
            "import json,sys,urllib.request; "
            "assert urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=5).read() == b'ok\\n'; "
            "c=json.load(urllib.request.urlopen('http://127.0.0.1:8080/config.json', timeout=5)); "
            "assert c['version'] == 1 and len(c['servers']) == int(sys.argv[1])"
        )
        run_owned(runner, plan, guest_command(plan, "/usr/bin/python3", "-c", check, str(len(config["servers"]))))
        if not owns_container(runner, plan):
            created = False
            raise InstallError("CT ownership changed during installation; no further actions were taken")
        run_owned(runner, plan, ["pct", "set", str(plan.ctid), "--onboot", "1"], timeout=60)
        print(f"Installation succeeded. CT {plan.ctid} ({arguments.hostname}) starts automatically with the node.")
        print("Configuration inside the CT: /etc/dobbelt-pi-hole/config.json")
        print(f"Apply configuration changes: pct exec {plan.ctid} -- systemctl restart dobbelt-pi-hole")
        try:
            result = run_owned(runner, plan, guest_command(plan, "/usr/sbin/ip", "-j", "-4", "address", "show", "dev", "eth0"))
            addresses = [item["local"] for interface in json.loads(result.stdout)
                         for item in interface.get("addr_info", []) if item.get("scope") == "global"]
            for address in addresses:
                print(f"HTTP backend: http://{ipaddress.IPv4Address(address)}:8080 (configure your HTTPS reverse proxy for browser access)")
        except (InstallError, ValueError, KeyError, TypeError):
            print(f"Inspect the CT address with: pct exec {plan.ctid} -- ip -4 address show eth0")
    except (InstallError, OSError, KeyboardInterrupt):
        if created:
            try:
                if owns_container(runner, plan):
                    disable = run_owned(runner, plan, ["pct", "set", str(plan.ctid), "--onboot", "0"], timeout=30, check=False)
                    stop = run_owned(runner, plan, ["pct", "stop", str(plan.ctid)], timeout=60, check=False)
                    print(f"Installation failed. Newly created CT {plan.ctid} was retained for diagnosis; nothing was deleted.", file=sys.stderr)
                    if disable.returncode or stop.returncode:
                        print("Stopping the CT or disabling autostart did not complete successfully; inspect its current status.", file=sys.stderr)
                    else:
                        print("The CT is stopped and autostart is disabled.", file=sys.stderr)
            except InstallError:
                print(f"Could not confirm or stop CT {plan.ctid}; inspect its status manually. Nothing was deleted.", file=sys.stderr)
        elif create_attempted:
            print(f"Inspect CT ID {plan.ctid} after the failed or unconfirmed create. No existing or unverified guest was changed or deleted.", file=sys.stderr)
        raise


def main(argv=None, *, runner=None, root=ROOT):
    """Validate the requested deployment, print its plan and optionally create it."""
    arguments = parser().parse_args(argv)
    runner = runner or Runner()
    try:
        validate_arguments(arguments)
        config = load_config(arguments.config)
        files = snapshot_source(root)
        ensure_host(runner)
        plan = inventory_plan(arguments, runner)
        print(json.dumps({
            "mode": "dry-run" if arguments.dry_run else "install", "node": plan.node,
            "ctid": plan.ctid, "hostname": arguments.hostname, "template": plan.template,
            "template_download_needed": plan.download, "create_command": create_command(arguments, plan),
            "instance_count": len(config["servers"]),
            "source_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()},
        }, indent=2))
        if arguments.dry_run:
            print("Read-only plan complete. No files were downloaded and no host or CT settings were changed.")
            return 0
        provision(arguments, plan, files, config, runner)
    except (ConfigError, InstallError, OSError) as error:
        print(f"Installation error: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Installation interrupted. Check the reported CT ID; no container was deleted.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
