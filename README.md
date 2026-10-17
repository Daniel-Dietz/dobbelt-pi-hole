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

## Lightweight by design

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

## Requirements

- Two to four Pi-hole **v6** instances with the REST API. The dashboard does not work
  with the old Pi-hole v5 PHP API.
- Docker with Compose, **Proxmox VE 9 on amd64** for the automated LXC installer,
  or nginx and Python 3.10 or later for a manual installation.
- Network access from the dashboard's nginx to each configured Pi-hole API.
- An app password for each Pi-hole. Create it under **Settings → API** in each
  Pi-hole administration interface.

## Docker setup

From a checkout of this repository:

```bash
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

Server colours remain tied to their IDs: blue, yellow, purple and orange.
The layout adapts to the configured number and the screen width, up to a
maximum page width of 1900 px. API routes are generated automatically;
there is no second list of Pi-hole addresses to maintain in nginx or HTML.

Names can also be changed under **Settings**. These names are saved in the
browser's `localStorage` and override the configured names in that browser.
Use **Reset names to defaults** to restore the current file's defaults.
Instance count and addresses are managed in the JSON file. A web interface for
editing that central configuration is planned for a later release.

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

Setup documentation and nginx examples are also available in all three
languages:

| Language | Documentation | nginx example |
| --- | --- | --- |
| English | [README.md](README.md) | [nginx.conf.example](nginx.conf.example) |
| Dansk | [README.DA.md](README.DA.md) | [nginx.conf.DA.example](nginx.conf.DA.example) |
| Deutsch | [README.DE.md](README.DE.md) | [nginx.conf.DE.example](nginx.conf.DE.example) |

## Security

- The dashboard is intended for personal use or for people you trust. Anyone
  who can log in receives administrative access to the connected Pi-hole
  instances.
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

The dashboard should not be exposed directly to the internet without suitable
access control in front of it.

## Roadmap

- **v1.1.005:** Complete Danish and English interfaces and documentation
- **v1.2.006:** Support for two, three or four Pi-hole instances
- **v1.3.007:** Key-based multilingual support with complete Danish, English and German interfaces and documentation
- **v1.4.008:** External JSON configuration, generated API routes and a Docker image
- **v1.5.009:** Automated native Proxmox LXC installation and stronger nginx isolation and CSP
- **Planned:** Web interface for editing the central instance configuration

## Contributing

Issues and pull requests are welcome. Contributions may include bug fixes,
suggestions and translations into additional languages. Keep message keys and
named parameters consistent across all language catalogs, and include
translations for static text, dynamic states and accessibility labels.
See the [translation guide](docs/I18N.md) for the message helpers, adding
languages and running the automated checks.

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
