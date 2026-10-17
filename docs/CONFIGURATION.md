# Deployment configuration

Maintain one private JSON file outside `index.html`; `tools/render_config.py`
validates it and generates both the
browser configuration and nginx API routes. The renderer uses Python's standard
library and does not run a web backend. Version 1.5.009 supports Docker, automated
native Proxmox LXC installation and manual nginx deployments.

## Canonical file

Start with [config/config.example.json](../config/config.example.json):

```json
{
  "version": 1,
  "defaultLanguage": "auto",
  "servers": [
    {"id": "1", "label": "Pi-hole 1", "apiUrl": "https://pihole1.example.com/api"},
    {"id": "2", "label": "Pi-hole 2", "apiUrl": "https://pihole2.example.com/api"}
  ]
}
```

| Field | Meaning |
| --- | --- |
| `version` | Required integer `1`; identifies the configuration format. |
| `defaultLanguage` | Optional `auto` (default), `da`, `en` or `de`. A saved browser selection takes precedence; `auto` uses browser preferences, then English. |
| `servers` | Two to four instances, in display order. Its length determines the server count. |
| `servers[].id` | Unique string `"1"`, `"2"`, `"3"` or `"4"`. Keep this ID stable when renaming or reordering an instance. Colours are tied to IDs. |
| `servers[].label` | Nonblank display name, at most 120 Unicode code points after trimming. Control characters and unpaired Unicode surrogates are rejected. |
| `servers[].apiUrl` | Direct, final HTTP(S) Pi-hole v6 API base URL, such as `http://192.168.1.10:8080/api` or `https://dns.example.com/proxy/api`. |
| `servers[].verifyTls` | Optional boolean, default `true`. Controls certificate verification for HTTPS upstreams. |

The [JSON schema](../config/config.schema.json) describes the document structure.
The renderer also rejects unknown fields, duplicate JSON keys, repeated IDs and
duplicate normalized API URLs. Source files are limited to 128 KiB. No passwords
or session IDs belong in this file; enter app passwords in the dashboard.

API URLs must have a host and a nonempty absolute path of safe ASCII segments
using letters, digits, `.`, `_`, `~` and `-`. Credentials, query strings,
fragments, whitespace, control characters, percent escapes and `.`/`..` path
segments are rejected. Scheme and host case, internationalized host names,
IP addresses, default ports and a trailing slash are normalized before use.
For example, `HTTPS://DNS.EXAMPLE.COM:443/api/` becomes
`https://dns.example.com/api`. IPv6 literals use brackets in the source URL.

Login and API requests deliberately do not follow HTTP redirects. Set `apiUrl`
to the final scheme (`http` or `https`), hostname, port and API path directly;
this includes using HTTPS when the HTTP address would redirect to HTTPS.
A redirected login or API request fails without retrying at the redirect
target. Correct `apiUrl`, apply the configuration using the instructions for
your deployment below, and reload the dashboard before trying again.

## Docker

From the repository root:

```bash
cp config/config.example.json config/config.json
# Edit config/config.json with your own instances.
docker compose up --build -d
docker compose logs dashboard
```

Open `http://localhost:8080`. Compose binds the port to the host's loopback
address; use a host reverse proxy for HTTPS or deliberately change the binding
for LAN access. [nginx.conf.example](../nginx.conf.example) is an optional
HTTPS front proxy and contains no duplicate instance definitions.

Compose mounts the entire `./config` directory read-only at `/config`. Keep
`config.json` readable by container UID 101 and its directory traversable.
Mounting the directory also supports editors that save by replacing the file.
The local `config/config.json` is ignored by Git and excluded from image builds.

Startup validates `/config/config.json`, writes generated files under
`/run/dobbelt-pi-hole`, runs `nginx -t`, and then starts nginx on port 8080.
Missing or invalid input stops startup; no example targets are substituted.
The container runs as UID/GID 101 with a read-only root filesystem under Compose;
only its temporary directories are writable. `/healthz` checks that the
dashboard serves requests, independently of Pi-hole availability.

After editing the source, apply the change and reload open dashboard tabs:

```bash
docker compose restart dashboard
```

There is no file watcher or configuration-write API. The source stays read-only
inside the running container. A future configuration editor can use this
versioned format and validator; that web interface is not part of this release.

The image uses the pinned official nginx base in [Dockerfile](../Dockerfile).
Chart.js 4.4.1 and its license are downloaded with SHA-256 verification at build
time and served locally. Runtime startup does not download assets. The Chart.js
license is included at `/usr/share/licenses/chart.js/LICENSE`.

## Native Proxmox LXC

The [LXC installer and operations guide](LXC.md) describes creating a new
unprivileged Debian 13 CT from a Proxmox VE 9 amd64 host. The installer transfers
the checked local project files and canonical JSON, installs nginx and Python
natively, and downloads Chart.js and its license with SHA-256 verification.
The application's configuration format is the same as Docker's.

| Setting | Docker Compose | Native LXC |
| --- | --- | --- |
| Canonical JSON | Host `./config/config.json`, mounted at `/config/config.json` | `/etc/dobbelt-pi-hole/config.json` inside the CT |
| Generated files | `/run/dobbelt-pi-hole` | `/run/dobbelt-pi-hole` |
| Web files | `/usr/share/nginx/html` | `/usr/share/dobbelt-pi-hole` |
| Runtime account | UID/GID 101 | User/group `dobbelt-pi-hole` |
| Apply edited JSON | `docker compose restart dashboard` on the Docker host | `systemctl restart dobbelt-pi-hole` inside the CT |
| Logs | `docker compose logs dashboard` | `journalctl -u dobbelt-pi-hole` |
| Default network access | Docker host `127.0.0.1:8080` | CT `0.0.0.0:8080` |

The native canonical file is owned by root, readable by the service group and
outside the web directory. The host's installation-time JSON is copied into the
CT, not mounted or automatically synchronized. Edit the CT copy for subsequent
changes. Both deployment types regenerate the public JSON, nginx routes and CSP
at service startup and reject invalid configuration before nginx starts.

The native service runs without root privileges or capabilities and with
`NoNewPrivileges`. Runtime directories are recreated after boot. Its systemd
hardening does not require extra namespace features or nesting in the CT.
The installation is for fresh CTs only; use the [LXC update and backup guidance](LXC.md#updates-backup-and-recovery)
for later dashboard releases.

Unlike Docker's host-loopback publication, the native CT backend is reachable
on its own network address. Place an HTTPS proxy in front and restrict access
with your existing Proxmox firewall or proxy policy. The CT NIC's firewall flag
does not create firewall rules. For a front proxy outside the CT, change only
the example's `proxy_pass` target to `http://<CT-IP>:8080`, without a URI suffix.
Individual Pi-hole addresses remain in the canonical JSON.

## Manual nginx installation

Use nginx and Python 3.10 or later. Run installation commands with the permissions
needed for your chosen directories:

```bash
mkdir -p /srv/web/pihole-dashboard /etc/dobbelt-pi-hole
cp index.html /srv/web/pihole-dashboard/index.html
cp config/config.example.json /etc/dobbelt-pi-hole/config.json
# Edit /etc/dobbelt-pi-hole/config.json with your own instances.
curl --fail --location -o /srv/web/pihole-dashboard/chart.umd.min.js \
  https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
```

The expected SHA-256 of that Chart.js file is
`81ffafe13c37e1b25793b020d446f4d9739b949dadb7f9f79d709a0cad781c2f`.
Retain its [MIT license](https://github.com/chartjs/Chart.js/blob/v4.4.1/LICENSE.md)
with the installation.

Generate both outputs from the private source:

```bash
python3 tools/render_config.py \
  --config /etc/dobbelt-pi-hole/config.json \
  --output-dir /etc/nginx/dobbelt-pi-hole \
  --web-root /srv/web/pihole-dashboard \
  --listen-address 127.0.0.1
```

Add this include **inside the existing nginx `http` block**:

```nginx
include /etc/nginx/dobbelt-pi-hole/nginx.conf;
```

The command binds the generated server to `127.0.0.1:8080`, so a front proxy
can control access without a second network-facing listener. For intentional
direct LAN access, choose that interface address with `--listen-address`.
The `/config.json` location serves
the generated public file via an explicit alias; the private source remains
outside the web root. Ensure nginx can read the generated files and traverse
their parent directories. Add the optional HTTPS front proxy if needed, then
check and reload:

```bash
nginx -t && systemctl reload nginx
```

Repeat generation, validation and reload after changing the source or the
installed `index.html`. The CSP hashes must match the current embedded scripts.
Do not edit
the generated files or retain old hand-written `/api1`–`/api4` proxy blocks.

| Renderer option | Default |
| --- | --- |
| `--config` | `/config/config.json` |
| `--output-dir` | `/run/dobbelt-pi-hole`; creates `config.json` and `nginx.conf` |
| `--web-root` | `/usr/share/nginx/html` |
| `--listen-port` | `8080` |
| `--listen-address` | All interfaces; supply a literal IPv4 or IPv6 address to restrict the listener. |
| `--resolver-file` | `/etc/resolv.conf` |
| `--ca-bundle` | `/etc/ssl/certs/ca-certificates.crt` |

The renderer exits with status 2 and a `Configuration error:` message on invalid
input. It checks the complete source before writing either output and refuses
to overwrite the source with generated files. Each generated file is replaced
atomically. nginx validation and reload remain the manual installer's next step.

## DNS, TLS and API identity

nginx resolves configured hostnames at request time using the nameservers from
`/etc/resolv.conf`. This respects Docker's configured resolver or the native
guest's DNS configuration and allows the dashboard to start while a Pi-hole
hostname is temporarily unavailable. No Pi-hole connection is required during
configuration generation.

HTTPS upstreams use certificate verification, a CA bundle and SNI by default.
For a private CA, provide a CA bundle containing the required trusted roots:
use `--ca-bundle` for a manual install, or bind-mount the bundle read-only over
`/etc/ssl/certs/ca-certificates.crt` in Docker. In a native Debian CT, place each
CA certificate in its own PEM-formatted `.crt` file under
`/usr/local/share/ca-certificates`, run `update-ca-certificates`, then restart
`dobbelt-pi-hole`. See Debian's
[certificate-store documentation](https://manpages.debian.org/trixie/ca-certificates/update-ca-certificates.8.en.html).
Alternatively, an instance can
explicitly set `"verifyTls": false`; that disables verification for that HTTPS
upstream. This setting is separate from HTTPS on the dashboard's own front proxy.

The browser receives only the format version, default language and each
instance's ID, label and generated `base`. Upstream URLs and TLS settings are
not included. A base has this form:

```text
/api<ID>/<SHA256(ID + NUL + normalizedApiUrl)>
```

The full lowercase 64-character hash binds browser session storage and requests
to that configured destination. Changing an API URL creates a new route; old
fingerprints and legacy routes receive HTTP 409 with
`{"error":{"code":"dashboard_config_changed"}}`, without forwarding the request
or its session ID. Reload the dashboard and log in to the new destination.
Changing a label, display order or TLS-verification flag does not change the
route. Encoded API request suffixes and query strings are preserved by the proxy.

## nginx hardening and HTML changes

The generated server serves the application assets, public configuration,
health endpoint and fingerprinted API routes explicitly. Its CSP allows the
embedded application scripts by SHA-256 hash and Chart.js from the same origin;
it does not allow arbitrary inline scripts. Inline styles remain supported for
the dashboard's existing layout. Responses include `no-store`, `nosniff` and
framing restrictions. The API proxy removes incoming `Authorization` and
`Cookie` headers before forwarding to Pi-hole, while preserving the Pi-hole
session header and application request data.

Hash generation reads the deployed `index.html`. Whenever its scripts change,
regenerate configuration before nginx serves the new version: rebuild/recreate
the Docker container for a changed image, restart the native dashboard service
for installed HTML changes, or rerun the renderer and reload nginx for a manual
installation. An outdated CSP can block a legitimate changed script.

## Upgrading and checks

For v1.3.007 and earlier installations, move instance labels and URLs from the
HTML/nginx files into the canonical JSON, install the new dashboard and generate
the matching routes. Previously saved browser names are migrated, while old
sessions require a one-time login. Browser name overrides remain local;
**Settings → Reset names to defaults** restores the current configured labels.

Run renderer checks without additional Python dependencies:

```bash
python3 -m unittest discover -s tests -p 'test_render_config.py' -v
```

Container integration checks require Docker and OpenSSL and use disposable local
Pi-hole API fixtures:

```bash
docker build -t dobbelt-pi-hole:test .
python3 -m unittest discover -s tests -p 'test_container.py' -v
```

See the [translation guide](I18N.md#verification) for frontend unit and browser
checks and the [LXC guide](LXC.md#verification-scope) for native installation
verification. Host command fixtures and Debian systemd checks do not replace
an end-to-end installation on a real Proxmox node.
