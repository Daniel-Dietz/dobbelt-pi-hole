# Double Pi-hole dashboard

**English** | [Dansk](README.DA.md) | [Deutsch](README.DE.md)

A lightweight dashboard for managing two, three or four Pi-hole v6 instances from one
interface. The browser loads `index.html`, an external JSON configuration and
a local Chart.js file. There is no application backend, database or frontend
build process. One central JSON file configures the instances; a small Python
tool generates the public browser configuration and nginx proxy routes from
it. Docker and the native Proxmox LXC service run this tool automatically at startup.

The dashboard includes:

- Combined statistics and charts
- A combined query log with filtering and sorting
- Management of allowed and blocked domains
- Local DNS records with differences between the instances clearly shown
- Known clients and suggestions for unknown devices
- Adlist management
- Gravity updates on each instance, including the time of the last update
- Actions that can be applied to one or all active instances
- Danish, English and German user interfaces

The Pi-hole instances remain independent DNS servers. This project does not
provide failover, a virtual IP address, a primary or secondary server, or
automatic background replication. Its purpose is to make it easy to maintain
the relevant settings consistently from a single dashboard.

![Pi-hole dashboard](images/dashboard.png)

## Current status and documentation

**Reviewed on 2026-10-18:** the current application version is **1.5.009**.
External configuration, Docker deployment, the native LXC installer and
API/login redirect protection are implemented on `main`. The
[development tracker #6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6)
records the remaining work and its acceptance criteria; the
[roadmap below](#roadmap) summarizes the same sequence.

Installation currently uses a source checkout and, for Docker, a locally built
image. Versioned release artifacts and published images are planned in
[#17](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/17).
Real Proxmox installation and recovery acceptance remains open in
[#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24).

| Guide | Contents |
| --- | --- |
| This README | Features, [Docker](#docker-setup), [Proxmox LXC](#automated-proxmox-lxc-setup), [manual nginx](#manual-nginx-setup), current limits and roadmap |
| [Configuration](docs/CONFIGURATION.md) | JSON fields, API permissions, generated routes, TLS, configuration changes and migration |
| [LXC installation and operations](docs/LXC.md) | Host prerequisites, CLI options, service commands, troubleshooting, backup and recovery |
| [Translations and frontend checks](docs/I18N.md) | Language catalogs, adding languages, unit and browser tests |
| [Development](docs/DEVELOPMENT.md) | Source layout, readable code, English function documentation and test groups |

The detailed guides under `docs/` are in English; all three READMEs cover
installation, current status and the issue roadmap in their respective language.

## Architecture and deployment

The dashboard is deliberately simple:

- One HTML file containing HTML, CSS and JavaScript
- No application backend
- No database
- No frontend build process
- Python manages installation and generates configuration at deployment or service startup
- Server addresses, count, default names and default language configured in one external JSON file
- Custom names and interface preferences stored locally in the browser
- Direct communication with the Pi-hole v6 APIs through nginx

Chart.js is loaded as a separate local file and is only used for charts.

**nginx is the web server and Pi-hole API proxy in all three deployment modes.**
You open the dashboard in your own browser; no browser runs in Docker or LXC.
Python handles provisioning and configuration generation. Node.js and
Playwright are development tools used for tests.

| Deployment | Application service | Default dashboard address |
| --- | --- | --- |
| Docker Compose | nginx in the container, image built from this checkout | Docker host `127.0.0.1:8080` |
| Native Proxmox LXC | nginx under `dobbelt-pi-hole.service` in a Debian 13 CT | CT IPv4 address, port `8080` |
| Manual nginx | Your nginx service with the generated configuration | `127.0.0.1:8080` with the example command below |

The dashboard installation manages existing Pi-hole instances. It does not
install Pi-hole or change the DNS servers advertised to your network clients.

## Requirements

- Two to four Pi-hole **v6** instances with the REST API. The dashboard does not work
  with the old Pi-hole v5 PHP API.
- Docker with Compose, **Proxmox VE 9 on amd64** for the automated LXC installer,
  or nginx and Python 3.10 or later for a manual installation.
- Network access from the dashboard's nginx to each configured Pi-hole API.
- An app password for each Pi-hole. Create it under **Settings → API** in each
  Pi-hole administration interface.

A successful app-password login does not authorize every change. Local DNS
edits depend on Pi-hole's `webserver.api.app_sudo` setting; review the
[API permissions](docs/CONFIGURATION.md#pi-hole-api-permissions) before changing
privileges.

## Docker setup

Obtain a source checkout, then prepare the configuration:

```bash
git clone https://github.com/Daniel-Dietz/dobbelt-pi-hole.git
cd dobbelt-pi-hole
cp config/config.example.json config/config.json
```

Edit `config/config.json` with the labels and API URLs of your two to four
instances, then start the dashboard:

```bash
docker compose up --build -d
docker compose logs dashboard
```

Open **http://localhost:8080** and log in to each active Pi-hole with its app
password. Compose binds to the Docker host's loopback address by default.
Use an HTTPS reverse proxy on that host, or deliberately change the port binding
in `compose.yaml` if the dashboard should be reachable on your LAN.
[nginx.conf.example](nginx.conf.example) is an optional HTTPS front proxy.

The `./config` directory is mounted read-only at `/config`. At startup, the
container validates `/config/config.json`, generates both configurations and
checks nginx before starting it. A missing or invalid configuration stops
startup. Chart.js is bundled in the image; startup requires no asset download.

After editing the configuration, apply it and reload the dashboard tab:

```bash
docker compose restart dashboard
```

## Automated Proxmox LXC setup

The installer creates a new **unprivileged Debian 13 LXC** and installs nginx,
Python, the dashboard and verified Chart.js files directly inside it. Run it
as **root on the Proxmox VE 9 host**, from a complete local checkout:

```bash
cd /root/dobbelt-pi-hole
cp config/config.example.json config/config.json
# Edit config/config.json with your own Pi-hole instances.
python3 tools/create_lxc.py \
  --config /root/dobbelt-pi-hole/config/config.json \
  --storage local-lvm \
  --template-storage local \
  --bridge vmbr0 \
  --hostname dobbelt-pi-hole
```

Use storage and bridge names that exist on your node. By default, the installer
chooses a free cluster-wide CT ID, the newest Debian 13 standard amd64 template
from the Proxmox catalog and DHCP. Add `--dry-run` to validate local input and
inspect the planned commands without downloads or changes. For a fixed address,
add, for example, `--ipv4 192.168.1.50/24 --gateway 192.168.1.1`.

The native service listens on the **CT's address, port 8080**. Put an HTTPS
reverse proxy in front of it and restrict access using your existing firewall
or proxy controls. The installer enables the CT NIC's firewall flag; it does
not create firewall rules or change the host's network. In the supplied nginx
front-proxy example, replace `127.0.0.1:8080` with the CT's address when that
proxy runs on a different machine.

The configuration is copied into the CT at `/etc/dobbelt-pi-hole/config.json`.
After editing that copy, apply it from the Proxmox host (replace `123` with
the reported CT ID):

```bash
pct exec 123 -- systemctl restart dobbelt-pi-hole
```

Then reload the dashboard tab. The installer creates fresh CTs only; it is not
an updater for an existing installation. On installation failure it keeps the
new CT for diagnosis, with automatic boot disabled. The
[LXC guide](docs/LXC.md) covers all options, logs, updates, backup and recovery.

## Manual nginx setup

1. Copy `index.html` to your web directory, for example
   `/srv/web/pihole-dashboard/index.html`, and download Chart.js beside it:

   ```bash
   curl --fail --location -o /srv/web/pihole-dashboard/chart.umd.min.js \
     https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

2. Copy [config/config.example.json](config/config.example.json) to a private
   location such as `/etc/dobbelt-pi-hole/config.json` and edit its instance
   labels and API URLs. Keep this source file outside the web directory.
3. Generate the public configuration and nginx routes from that same file:

   ```bash
   python3 tools/render_config.py \
     --config /etc/dobbelt-pi-hole/config.json \
     --output-dir /etc/nginx/dobbelt-pi-hole \
     --web-root /srv/web/pihole-dashboard \
     --listen-address 127.0.0.1
   ```

4. Add `include /etc/nginx/dobbelt-pi-hole/nginx.conf;` inside nginx's existing
   `http` block. The generated server listens on `127.0.0.1:8080`. Use
   [nginx.conf.example](nginx.conf.example) for an optional HTTPS front proxy,
   adjusting its domain and certificate paths.
5. Test and reload nginx, then open the dashboard and log in:

   ```bash
   nginx -t && systemctl reload nginx
   ```

Run the generator and reload nginx again after changing the JSON file or
`index.html`; the generated Content Security Policy hashes the embedded scripts.
The [configuration guide](docs/CONFIGURATION.md) explains all fields, TLS,
file permissions and migration from earlier versions.

## Server count and names

**`config.json` is the single source of instance configuration.** The `servers`
array contains two, three or four objects, each with a stable `id` (`"1"` to
`"4"`), `label` and `apiUrl`. Its length determines the server count and its
order determines the display order. `verifyTls` defaults to `true` for HTTPS
upstreams. See the [example](config/config.example.json) and
[JSON schema](config/config.schema.json).

Set `apiUrl` to the direct, final Pi-hole v6 API base URL, with the correct
scheme (`http` or `https`), hostname, port and API path. Login and API requests
deliberately do not follow HTTP redirects. A request that needs a redirect
fails; correct the URL in the configuration and apply the change before trying
again.

Server colours remain tied to their IDs: blue, yellow, purple and orange.
The layout adapts to the configured number and the screen width, up to a
maximum page width of 1900 px. API routes are generated automatically;
there is no second list of Pi-hole addresses to maintain in nginx or HTML.

Names can also be changed under **Settings**. These names are saved in the
browser's `localStorage` and override the configured names in that browser.
Use **Reset names to defaults** to restore the current file's defaults.
Instance count and addresses are managed in the JSON file. A web interface for
local JSON import, editing and export is planned in
[#19](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/19). Protected saving
and applying on the server is a separate later step,
[#20](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/20).

When upgrading from v1.3.007 or earlier, move your HTML and nginx instance
settings into the JSON file and replace the old API proxy blocks with the
generated configuration. Existing browser display names are migrated, but each
instance requires a **one-time login** because sessions are now tied to the
configured API destination. If an API URL changes later, an old tab receives a
configuration-change message and must reload before sending further requests.
Renaming or reordering the same instances does not change their API identities.

## Languages

The user interface is available in **English**, **Dansk** and **Deutsch**.
The language selector at the top of the dashboard changes the interface
immediately, including dialog text, dynamic messages, tables and charts.
Numbers, percentages, dates and times follow the selected language.

The initial language is selected in this order:

1. A supported language previously selected and saved in the browser's
   `localStorage`.
2. The configured `defaultLanguage`, if set to `da`, `en` or `de`. The default
   `auto` continues to browser preferences.
3. The first supported language in the browser's ordered language preferences.
   Regional variants such as `de-DE`, `de-AT`, `en-GB` and `da-DK` are supported.
4. English if no supported language is found.

Translations use stable message keys and named parameters in complete
`en`, `da` and `de` catalogs embedded in `index.html`. Adding a language does
not require a backend, a build step or an additional runtime dependency.
Server names, domains, client names, comments and other values supplied by
users or the Pi-hole APIs remain unchanged when the interface language changes.

The READMEs provide setup instructions in all three languages. Comments and
function documentation in source code, snippets and nginx examples are always
in English. The nginx example files below have identical contents; their
existing filenames remain available for documentation links.

| Language | Documentation | nginx example |
| --- | --- | --- |
| English | [README.md](README.md) | [nginx.conf.example](nginx.conf.example) |
| Dansk | [README.DA.md](README.DA.md) | [nginx.conf.DA.example](nginx.conf.DA.example) |
| Deutsch | [README.DE.md](README.DE.md) | [nginx.conf.DE.example](nginx.conf.DE.example) |

## Current operational limits

- **Actions across instances:** requests are independent and there is no
  cross-instance transaction or automatic rollback. Domain, local DNS, client
  and list management now distinguish confirmed changes, rejected changes,
  disconnected targets and unknown write outcomes. They check each target's
  current state before sending a requested write; a failed read is never
  treated as proof that an entry is missing. Keep the submitted values when
  an outcome is incomplete. After a lost response, inspect the state before
  explicitly retrying; no mutation is automatically replayed.
  These safeguards are tracked in
  [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8).
- **Requests and browser state:** normal Pi-hole requests, login and logout
  have a 15-second browser deadline; restored-session checks use 10 seconds.
  Gravity starts within the normal deadline, with a separate two-minute
  stream-idle limit and 30-minute overall stream limit. Healthy Pi-hole
  summaries and query rows are shown while other instances are still loading,
  and combined data is explicitly marked partial when a target is missing.
  Changing a query range or leaving its tab cancels obsolete query/cursor
  reads; late results cannot overwrite the selected range. HTTP 401 invalidates
  the original session only. A transient connection failure leaves its SID
  unverified for explicit retry, while logout clears the local SID immediately
  and reports whether remote revocation was confirmed. See the
  [request and session guide](docs/CONFIGURATION.md#browser-request-limits-and-session-state).
  More specific API permissions remain in
  [#10](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/10); draft
  preservation, keyboard improvements and broader browser/mobile checks
  remain in [#11](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/11).
- **Configuration changes:** startup validates the JSON, but a restart with
  invalid input can leave the service unavailable. Keep a working copy of the
  private configuration. Staged validation, coordinated activation and
  automatic recovery are planned in
  [#12](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/12).
- **Monitoring:** `/healthz` confirms that nginx responds; it does not test
  Pi-hole reachability or API authentication. A diagnostic command is planned
  in [#13](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/13). Combined
  statistics can be incomplete when an instance is unavailable; explicit data
  age/completeness and optional automatic refresh are planned in
  [#22](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/22).
  External Nebula Sync status is not yet displayed; monitoring is planned in
  [#27](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/27).
- **Updates and recovery:** the LXC installer creates new CTs only. Keep the
  current installation and backups when preparing a replacement. See the
  [current update and backup guidance](docs/LXC.md#updates-backup-and-recovery);
  rehearsed Docker/LXC recovery is tracked in
  [#18](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/18), with real
  Proxmox acceptance separately in
  [#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24).

## Security

- The dashboard is intended for personal use or for people you trust. Anyone
  who can log in can use the actions permitted by that Pi-hole session. The
  dashboard has no separate user accounts or role management.
- Login sessions are stored in the browser's `sessionStorage` and disappear
  when the tab is closed. Passwords are not stored.
- Untrusted values such as client names, domains and comments are escaped
  before being displayed.
- nginx permits embedded application scripts through SHA-256 Content Security
  Policy hashes and loads Chart.js locally. Generated responses also include
  cache and framing restrictions and `nosniff` headers.
- Compose and the native LXC service run nginx without root privileges or
  capabilities and prevent privilege escalation. The API proxy strips browser
  `Authorization` and `Cookie` headers before forwarding requests to Pi-hole;
  HTTPS upstream certificate verification is enabled by default.
- When hosting the dashboard on a Synology NAS, a DSM access control profile
  can restrict access to selected IP addresses or local networks.

HTTPS at the front proxy protects the browser connection. An HTTP connection
from that proxy to a remote LXC backend remains unencrypted; HTTPS verification
for nginx's Pi-hole connections is another separate setting. Restrict direct
backend access as described in the [LXC network guide](docs/LXC.md#access-and-firewall-placement).
A tested protected deployment profile is tracked in
[#15](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/15). Log retention and
reduced access-log detail are tracked in
[#14](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/14); current logging
follows the Docker host's logging settings, the CT's journal/syslog settings,
or the existing nginx logging configuration for manual installations.

The dashboard should not be exposed directly to the internet without suitable
access control in front of it.

## Implemented milestones

These versions describe implemented source milestones, not a catalog of
published release artifacts.

- **v1.1.005:** Complete Danish and English interfaces and documentation
- **v1.2.006:** Support for two, three or four Pi-hole instances
- **v1.3.007:** Key-based Danish, English and German localization and regression checks — [PR #1](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/1)
- **v1.4.008:** External JSON configuration, generated API routes and a locally buildable Docker image — [PR #3](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/3)
- **v1.5.009:** Automated native Proxmox LXC installation and stronger nginx isolation and CSP — [PR #5](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/5)
- **Subsequent fix on `main`:** API and login redirects rejected — [#7](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/7), merged in [PR #25](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/25)
- **Per-instance reliability on `main`:** Verified per-Pi-hole read/write outcomes, safe retry behavior and client-suggestion drafts — [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8), merged in [PR #29](https://github.com/Daniel-Dietz/dobbelt-pi-hole/pull/29).

## Roadmap

[Tracker #6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6) is the
authoritative progress record. **Snapshot: 2026-10-18 — 2 of 19 work packages
completed; 17 open. Next: #9.** The table follows its recommended working order.
Only the prerequisites column expresses technical dependencies within this
roadmap; an earlier row is not automatically a prerequisite. The issues define
scope and acceptance criteria. Future version numbers and delivery dates have
not been assigned.

Nebula Sync monitoring (#27) was added as step **16a**, after #22 and before
#23. The original step numbers remain stable; #27 does not add a prerequisite
for #23 or #24.

| Order | Issue and scope | Status | Prerequisites |
| --- | --- | --- | --- |
| 01 | [#7](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/7) — Reject API/login redirects to other instance routes | Completed | None |
| 02 | [#8](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/8) — Per-instance read/write outcomes, partial failures and unknown data states | Completed | #7 |
| 03 | [#9](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/9) — Request limits, query-load race protection and distinct session/connection states | Open — next | #7, #8 |
| 04 | [#10](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/10) — API compatibility, permissions and failed/unknown blocking states | Open | #9 |
| 05 | [#11](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/11) — Preserve drafts; improve keyboard, browser and mobile coverage | Open | #8, #9 |
| 06 | [#12](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/12) — Configuration preflight, coordinated activation and rollback | Open | None |
| 07 | [#13](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/13) — Read-only configuration, service and connection diagnostics | Open | #12 |
| 08 | [#14](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/14) — Log retention and less sensitive nginx access logs | Open | None |
| 09 | [#15](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/15) — Protected network/TLS deployment for remote LXC backends | Open | #13 |
| 10 | [#16](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/16) — Central dependency metadata, pinned CI references and update checks | Open | #7 |
| 11 | [#17](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/17) — Reviewed releases, Docker images, native artifacts and version identity | Open | #12, #13, #16 |
| 12 | [#18](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/18) — Rehearsed Docker/LXC update, rollback and portable restoration | Open | #12, #13, #17 |
| 13 | [#19](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/19) — Multilingual local JSON configuration assistant with import/export | Open | #10, #11, #12 |
| 14 | [#20](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/20) — Protected server-side save/apply for central configuration | Open | #12, #13, #15, #18, #19 |
| 15 | [#21](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/21) — Temporary blocking pause with a Pi-hole-side timer | Open | #8, #9, #10 |
| 16 | [#22](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/22) — Data age/completeness and economical optional automatic refresh | Open | #8, #9, #10, #21 |
| 16a | [#27](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/27) — Optional read-only Nebula Sync monitoring with confirmed run and replica outcomes | Open | #12, #13, #22 |
| 17 | [#23](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/23) — Instance comparison, reconciliation preview and selected changes | Open | #8, #9, #10, #22 |
| 18 | [#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24) — Installation and recovery acceptance on a real Proxmox test host | Open | #12, #13, #15, #17, #18 |

The local assistant in #19 will export JSON; server-side administration is
separately scoped in #20. Neither exists in the current Settings page.
Instance reconciliation in #23 remains an explicit user action; unattended
replication and DNS failover are outside the planned scope.

Nebula Sync monitoring in #27 is planned as a read-only integration for a
separately installed, configured and enabled service. It will also require
complete dashboard configuration and explicit opt-in. Disabled by default,
it will make no status requests until enabled. The last confirmed completed
success, data age and per-replica results will be shown only where the status
source provides evidence; missing information stays unknown. Failures after
activation will remain visible. It will not start syncs, change configuration
or provide failover.

## Verification

The [i18n workflow](.github/workflows/i18n.yml) covers translation behavior,
Chromium browser fixtures, generated configuration and Docker integration,
plus Proxmox CLI fixtures and installation in a Debian 13 systemd test container.
These checks do not establish real Proxmox installation or restore acceptance.
Firefox, WebKit and a targeted mobile smoke matrix remain in #11.

From the repository root, the dependency-free checks use Node.js 24 and Python:

```bash
node --test tests/i18n.test.cjs
python3 -m unittest discover -s tests -p 'test_render_config.py' -v
python3 -m unittest discover -s tests -p 'test_create_lxc.py' -v
```

See [browser test setup](docs/I18N.md#verification),
[Docker integration checks](docs/CONFIGURATION.md#upgrading-and-checks) and
[native guest checks](docs/LXC.md#verification-scope) for their dependencies and
commands. Node.js, npm and Playwright are not required on a deployed dashboard.

## Contributing

Issues and pull requests are welcome. Contributions may include bug fixes,
suggestions and translations into additional languages. Keep message keys and
named parameters consistent across all language catalogs, and include
translations for static text, dynamic states and accessibility labels.
See the [translation guide](docs/I18N.md) for the message helpers, adding
languages and running the automated checks.

Keep maintained source readable, with descriptive names and clear control flow.
Document every function, including nested callbacks and test fixtures, with a
helpful English description at its definition. The [development guide](docs/DEVELOPMENT.md)
explains the documentation conventions, source layout and verification steps.

Before starting a tracked work package, refresh `main`, its issue, dependencies
and existing PRs. Follow the workflow in
[#6](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/6): one implementation
PR at a time, relevant tests and DA/EN/DE updates, Codex review of the final PR
head and successful CI before merge, then main-CI evidence before closing the
issue. Keep all three README roadmaps aligned with the tracker when work is
completed. A documentation update alone does not complete a feature issue.

## License

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

The project was originally developed for Pi-hole v5 in 2023 and updated for
Pi-hole v6 in 2026.

The project is released under the MIT License and may be used, copied, modified
and redistributed in accordance with the terms of the license. See `LICENSE`.

The Docker image bundles Chart.js 4.4.1 and its MIT license at
`/usr/share/licenses/chart.js/LICENSE`. The LXC installer also downloads and
verifies the chart library and its license automatically. Manual installations
download Chart.js separately as described above. Chart.js is an independent
third-party project.
