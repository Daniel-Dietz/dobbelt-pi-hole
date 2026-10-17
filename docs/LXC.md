# Native Proxmox LXC installation

The installer creates a new unprivileged Debian 13 container on **Proxmox VE 9
amd64** and installs the dashboard directly inside it. nginx serves the HTML,
generated public configuration and local Chart.js file and proxies the Pi-hole
APIs. Python prepares configuration at service startup; there is no Python web
backend, Docker daemon or browser running in the CT.

For a detailed German quickstart, see
[Automatische Installation in Proxmox LXC](../README.DE.md#automatische-installation-in-proxmox-lxc).

## Before you start

Run the host installer as **root in a shell on the Proxmox node that will host
the CT**. It requires a complete local checkout of this project, an active local
bridge and accessible storage for both container disks and templates. The
`rootdir` and `vztmpl` storage content types serve different purposes; choose
storage names from your own Proxmox installation.

The host needs access to the Proxmox template catalog and downloads. The guest
needs working networking and DNS to install Debian packages and download the
pinned Chart.js files. After installation, it must reach the configured Pi-hole
APIs. Supported Pi-hole configuration remains two to four v6 instances with an
app password for each, entered later in the dashboard.

The installer checks the Proxmox version and architecture, the local source
files, canonical JSON, network bridge and storage before creating the CT. It
does not modify host networking or firewall rules, install the application on
the Proxmox host, or reuse an existing CT.
The guest installer also refuses existing nginx packages, service units, masks
or configuration before making changes. It does not take over another web server;
use a fresh Debian 13 standard template.

## Quickstart on the Proxmox host

Copy a complete checkout to `/root/dobbelt-pi-hole`. With Git available:

```bash
git clone https://github.com/Daniel-Dietz/dobbelt-pi-hole.git /root/dobbelt-pi-hole
cd /root/dobbelt-pi-hole
cp config/config.example.json config/config.json
```

Edit `config/config.json` with the actual labels and API URLs of your instances.
The [configuration guide](CONFIGURATION.md) documents the format and TLS options.
This private source contains no Pi-hole passwords or session IDs.

Preview the installation, replacing the storage and bridge names as needed:

```bash
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole \
  --dry-run
```

The dry run reads local files and the Proxmox inventory and displays planned
commands. It makes **no changes and performs no downloads**. Automatic template
selection uses the existing local Proxmox catalog in this mode. If the catalog
is empty, run `pveam update` separately and repeat the preview.

Create and install the CT by running the same command without `--dry-run`:

```bash
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole
```

The default configuration uses DHCP, a free cluster-wide CT ID, one CPU core,
512 MiB RAM, no swap and a 4 GiB root disk. During an actual installation the
installer refreshes the Proxmox catalog, selects its newest Debian 13 standard
amd64 template and downloads it only when it is not already cached.

Once guest commands work, the host waits up to **180 seconds** for a usable IPv4
address on `eth0` (the requested address for static configuration), IPv4 DNS
resolution of `deb.debian.org` and `raw.githubusercontent.com`, and a TCP
connection to `cdnjs.cloudflare.com:443`. File upload and package installation
start only after these checks succeed. A network timeout keeps the newly created
CT for diagnosis, with automatic boot disabled and a stop attempt, as described
under [recovery](#updates-backup-and-recovery).

The installer transfers the checked local project files and configuration into
the new CT, installs native Debian packages, downloads and verifies Chart.js
4.4.1 and its license, and starts `dobbelt-pi-hole.service`. Automatic CT boot
is enabled only after installation succeeds. The final output identifies the
CT and its access address.

The CT is created with Proxmox deletion protection enabled (`protection=1`).
It remains enabled after success or failure to prevent accidental removal of
the CT or its disks. The installer never deletes a CT automatically.

## Host CLI options

Run `python3 tools/create_lxc.py --help` for the command's full help.

| Option | Purpose/default |
| --- | --- |
| `--config PATH` | Required canonical JSON file on the Proxmox host. The installer copies it into the new CT. |
| `--storage NAME` | Required active storage supporting the CT's `rootdir` content. |
| `--template-storage NAME` | Storage for `vztmpl` downloads; default `local`. |
| `--bridge NAME` | Existing active local Linux or OVS bridge; default `vmbr0`. |
| `--hostname NAME` | CT hostname; default `dobbelt-pi-hole`. |
| `--ctid ID` | Specific unused CT ID. Otherwise a free cluster-wide ID is selected. |
| `--ipv4 ADDRESS` | `dhcp` by default, or a static address in CIDR notation. |
| `--gateway ADDRESS` | Optional IPv4 gateway; valid only with a static `--ipv4` address. |
| `--vlan TAG` | Optional VLAN tag from 1 to 4094 on the CT interface. |
| `--nameserver ADDRESS` | Optional reachable DNS server IP; repeat this option for multiple servers. |
| `--cores COUNT` | CPU cores; default `1`. |
| `--memory MIB` | RAM in MiB; default `512`. |
| `--swap MIB` | Swap in MiB; default `0`. |
| `--disk GIB` | Root disk in GiB; default `4`. |
| `--template VOLUME_ID` | An existing Debian 13 standard amd64 template on `--template-storage`, identified by its full Proxmox volume ID. |
| `--dry-run` | Validate and display the plan without changing the host or creating a CT. |

For a fixed address, add
`--ipv4 192.168.1.50/24 --gateway 192.168.1.1` to the installation command.
Add `--vlan 123` only when that VLAN is configured for the selected bridge and
network. The script does not configure the bridge, physical switch or DHCP server.
It configures IPv4; automatic IPv6 configuration is not enabled by this installer.

For an already downloaded template, get its exact volume ID with
`pveam list local` (use your template storage name), then supply that value to
`--template`. Template identifiers include the storage prefix and `vztmpl/`
path; use the actual catalog name rather than guessing a versioned filename.

## Access and firewall placement

The native service binds to **`0.0.0.0:8080` inside the CT**. A CT with address
`192.168.1.50` serves the dashboard at `http://192.168.1.50:8080`.
It does not install a TLS certificate or create a DNS record for that address.

Use an HTTPS reverse proxy and restrict access to trusted clients. The existing
[nginx example](../nginx.conf.example) targets Docker or a backend on the same
machine at `127.0.0.1:8080`. When your front proxy is outside the CT, change its
single `proxy_pass` target to the CT address, for example:

```nginx
proxy_pass http://192.168.1.50:8080;
```

Keep this target without a URI suffix or rewrite so encoded API paths and query
strings reach the generated routes unchanged. Domain and certificate paths in
the example also need your deployment values.

**The enabled firewall flag on the CT NIC is not a firewall ruleset.** The
installer does not add allow/deny rules or change existing Proxmox firewall
policies. Restrict inbound CT port 8080 to the front proxy or intended trusted
clients in your existing firewall. Proxy-only access controls do not restrict
clients that can still connect directly to the CT backend port.

The CT is unprivileged and does not need nesting, FUSE, `keyctl` or additional
container privileges. nginx runs under the dedicated `dobbelt-pi-hole` account,
without Linux capabilities and with privilege escalation disabled. Its service
hardening does not depend on enabling extra namespace features in Proxmox.
The generated proxy uses script hashes in CSP, local assets, cache/framing
restrictions and upstream TLS verification. Browser `Authorization` and
`Cookie` headers are stripped before requests reach Pi-hole.

## Files and routine operation

| Inside the CT | Purpose |
| --- | --- |
| `/etc/dobbelt-pi-hole/config.json` | Canonical configuration to edit and back up. |
| `/etc/dobbelt-pi-hole/listen.env` | Native listener settings, separate from the instance definitions. |
| `/etc/dobbelt-pi-hole/nginx.conf` | Dedicated nginx main configuration; the distribution's default nginx service is not used. |
| `/run/dobbelt-pi-hole` | Generated public configuration and nginx routes; recreated at service startup. |
| `/usr/share/dobbelt-pi-hole` | Dashboard HTML and local Chart.js file. |
| `/opt/dobbelt-pi-hole/render_config.py` | Configuration renderer used by service startup. |
| `/usr/share/licenses/chart.js/LICENSE` | License for the installed Chart.js bundle. |
| `dobbelt-pi-hole.service` | Dedicated systemd service for the dashboard. |

The host's original JSON is a deployment input, **not a live bind mount**.
Editing that host copy later does not change the installed CT. The canonical
copy lives on the CT root filesystem and is separate from the web directory.
Names edited in the dashboard remain browser-local overrides.

The following commands run on the Proxmox host; replace `123` with your CT ID:

```bash
pct enter 123
```

Inside the CT, edit `/etc/dobbelt-pi-hole/config.json` and apply it with:

```bash
systemctl restart dobbelt-pi-hole
systemctl status dobbelt-pi-hole --no-pager
journalctl -u dobbelt-pi-hole -n 100 --no-pager
```

You can also restart and inspect the service directly from the Proxmox host:

```bash
pct exec 123 -- systemctl restart dobbelt-pi-hole
pct exec 123 -- journalctl -u dobbelt-pi-hole -n 100 --no-pager
```

Reload the browser tab after applying configuration. A changed API destination
requires login for that destination; renaming or reordering instances keeps
their generated identity. Invalid configuration prevents service startup.
Fix the source and restart again; do not edit the generated files under `/run`.

`/healthz` checks whether nginx is serving the dashboard. It does not prove that
Pi-hole APIs are available or that the browser has authenticated sessions.
Chart.js is installed locally once, with SHA-256 verification; ordinary service
starts do not download assets.

## Updates, backup and recovery

This release's installer is **for new CTs only**. It does not update or overwrite
an existing dashboard installation. Debian package maintenance remains normal
guest administration. For a new dashboard release, keep the current CT and its
backup, create a new CT from the desired project version using a copy of the
canonical JSON, verify it, then change the front proxy to the new CT address.
The same Pi-hole targets and IDs preserve their generated API identities.

Back up the CT with your existing Proxmox backup procedure. The installed
canonical JSON is on the CT root filesystem; it is not a separate host bind
mount omitted from the container backup. Keep any custom CA certificates and
external HTTPS proxy configuration in your corresponding backup procedures.
Generated `/run` files need no separate backup because service startup recreates
them. Browser language/name preferences and session storage are outside the CT.

If installation fails after creating a CT, the installer leaves that new CT in
place, disables automatic boot and attempts to stop it. It reports the failure
rather than deleting the CT or reusing another one. Inspect its status first;
start it deliberately if you need guest logs. For example, on the Proxmox host:

```bash
pct status 123
# Start the retained CT if it is stopped and you want to inspect the guest.
pct start 123
pct exec 123 -- journalctl -u dobbelt-pi-hole -n 100 --no-pager
```

A retry of the creation command requires a new unused ID; it is not an in-place
repair or update command. Remove a failed CT only after reviewing its identity
and deciding it is no longer needed. Deletion protection remains active; if you
deliberately want to remove that CT, first disable protection on the confirmed
ID from the Proxmox host, then remove it through your normal Proxmox workflow:

```bash
# Only for a CT you have explicitly decided to remove; replace 123 with its ID.
pct set 123 --protection 0
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Preflight rejects the host | Run as root on Proxmox VE 9 amd64, using a complete local project checkout. |
| Storage or bridge rejected | Use existing, active resources on this node. Disk storage needs `rootdir`; template storage needs `vztmpl`. |
| Dry run cannot select a template | Refresh the local catalog with `pveam update`, then repeat the dry run, or select an existing supported template explicitly. |
| Network readiness times out after three minutes | Check DHCP or the configured static address on `eth0`, gateway and DNS. The guest must resolve `deb.debian.org` and `raw.githubusercontent.com` and connect to `cdnjs.cloudflare.com:443`; existing firewall rules can block these checks. No application files or packages are installed before this phase succeeds. |
| Guest installer rejects existing nginx | Use a fresh Debian 13 standard template. Existing nginx packages, units, masks or configuration are intentionally preserved rather than adopted. |
| Guest package or Chart.js download fails | Check the CT's address, gateway, DNS and outbound access; existing firewall policy can prevent downloads. |
| Dashboard URL is unreachable | Check CT status, assigned IP, `dobbelt-pi-hole.service`, listener port 8080 and existing firewall rules. The Proxmox host's localhost is not the CT's localhost. |
| Service fails after editing configuration | Read the journal, correct `/etc/dobbelt-pi-hole/config.json`, and restart. |
| Dashboard loads but a Pi-hole is unavailable | Check that API URL from the CT, DNS, network access and certificate trust. See [TLS configuration](CONFIGURATION.md#dns-tls-and-api-identity). |
| Scripts are blocked after manually editing HTML | Regenerate configuration and restart the dedicated service so CSP hashes match the installed script content. |

## Verification scope

The `Native Debian 13 guest installation` CI job tests the host CLI with
controlled Proxmox command fixtures in `tests/test_create_lxc.py`. Its
`tests/test_lxc_guest.py` suite runs the actual guest installer in a disposable
Debian 13 Docker test container with systemd as PID 1 and a private cgroup
namespace. It checks the native service, file permissions, real HTTP/proxy
requests, asset checksums, CSP and configuration/restart behavior.

These checks do not constitute an end-to-end installation on a real Proxmox
host. No real CT is created by the host-fixture tests. Proxmox `pct`, LXC ID
mapping, AppArmor, template extraction, storage and bridge behavior are outside
that test environment; deployment-specific networking and firewall behavior
must be checked on the target node.

Host-fixture checks need Python but no Proxmox host:

```bash
python3 -m unittest discover -s tests -p 'test_create_lxc.py' -v
```

The native guest suite requires a Linux Docker Engine with cgroup v2. It uses a
disposable privileged systemd test container without mounting the host's
cgroup filesystem, Docker socket or network; this test setup is separate from
the unprivileged Proxmox CT created for deployment:

```bash
docker build -f tests/Dockerfile.lxc-guest -t dobbelt-pi-hole:lxc-guest-test .
python3 -m unittest discover -s tests -p 'test_lxc_guest.py' -v
```

The implementation lives in [tools/create_lxc.py](../tools/create_lxc.py).
For the underlying Proxmox commands and configuration, see the official
[container documentation](https://pve.proxmox.com/pve-docs/chapter-pct.html) and
[storage documentation](https://pve.proxmox.com/pve-docs/chapter-pvesm.html).
