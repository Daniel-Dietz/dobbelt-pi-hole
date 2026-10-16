# Double Pi-hole dashboard

**English** | [Dansk](README.DA.md)


A lightweight dashboard for managing two, three or four Pi-hole v6 instances from one
interface. The solution consists of a single self-contained `index.html` with
no backend, database or build process. The browser communicates directly with
the active Pi-hole REST APIs through an nginx reverse proxy.

The dashboard includes:

- Combined statistics and charts
- A combined query log with filtering and sorting
- Management of allowed and blocked domains
- Local DNS records with differences between the instances clearly shown
- Known clients and suggestions for unknown devices
- Adlist management
- Gravity updates on each instance, including the time of the last update
- Actions that can be applied to one or all active instances
- Danish and English user interfaces

The Pi-hole instances remain independent DNS servers. This project does not
provide failover, a virtual IP address, a primary or secondary server, or
automatic background replication. Its purpose is to make it easy to maintain
the relevant settings consistently from a single dashboard.

![Pi-hole dashboard](images/dashboard.png)

## Lightweight by design

The dashboard is deliberately simple:

- One HTML file containing HTML, CSS and JavaScript
- No backend
- No database
- No build process
- No Node.js, PHP or Python
- Server count and global names is configured in the HTML file; custom names and interface preferences stored locally in the browser
- Direct communication with the Pi-hole v6 APIs through nginx

Chart.js is loaded as a separate local file and is only used for charts.

## Requirements

- Two to four Pi-hole **v6** instances with the REST API. The dashboard does not work
  with the old Pi-hole v5 PHP API.
- nginx or a similar reverse proxy in front of the dashboard. Requests to
  `/api1/...` and `/api2/...`, plus `/api3/...` and `/api4/...` when used,
  must be forwarded to their corresponding Pi-hole instances. This avoids CORS issues.
- An app password for each Pi-hole. Create it under **Settings → API** in each
  Pi-hole administration interface.

## Setup

1. Copy `index.html` to the directory served by nginx, for example
   `/srv/web/pihole-dashboard/index.html`.
2. Download Chart.js to the same directory:

   ```bash
   cd /srv/web/pihole-dashboard
   curl -o chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
   ```

3. Copy `nginx.conf.example` to your nginx configuration.
4. Adjust the domain, Pi-hole addresses, certificate paths and web root.
   Set `DEFAULT_SERVER_COUNT` in `index.html` to `2`, `3` or `4`. The nginx
   example enables `/api1/` and `/api2/` by default. Uncomment and adjust the
   `/api3/` block for three instances, and both `/api3/` and `/api4/` for four.
5. Test and reload nginx:

   ```bash
   nginx -t && systemctl reload nginx
   ```

6. Open the dashboard URL and log in to each active Pi-hole instance with their app
   passwords.

## Server count and names

The number of active Pi-hole instances is set **only in `index.html`**:

```js
const DEFAULT_SERVER_COUNT = 2; // 2, 3 or 4
```

The first two, three or four entries in `DEFAULT_SERVERS` are used. The API
paths are `/api1`, `/api2`, `/api3` and `/api4`; configure nginx for each active
instance. Actual Pi-hole host names or IP addresses belong in nginx, not in
the browser settings.

Default display names for all clients are set using `label` in `DEFAULT_SERVERS`:

```js
const DEFAULT_SERVERS = [
    { id: "1", label: "Pi-hole 1", base: "/api1", color: "c-1", chip: "s1" },
    { id: "2", label: "Pi-hole 2", base: "/api2", color: "c-2", chip: "s2" },
    { id: "3", label: "Pi-hole 3", base: "/api3", color: "c-3", chip: "s3" },
    { id: "4", label: "Pi-hole 4", base: "/api4", color: "c-4", chip: "s4" },
];
```

Server colours are blue, yellow, purple and orange, respectively. The layout
adapts to the configured number and the screen width, up to a maximum page
width of 1900 px.

Names can also be changed under **Settings** for the active instances. These
names are saved in the browser's `localStorage` and override the file's default
names in that browser. The server count and API paths cannot be changed under
Settings. Changing the defaults in the file does not overwrite locally saved
names.

## Languages

The user interface is available in Danish and English. On first use, the
language is selected automatically from the browser language. It can then be
changed at the top of the dashboard, and the selection is stored locally in
the browser.

## Security

- The dashboard is intended for personal use or for people you trust. Anyone
  who can log in receives administrative access to the connected Pi-hole
  instances.
- Login sessions are stored in the browser's `sessionStorage` and disappear
  when the tab is closed. Passwords are not stored.
- Untrusted values such as client names, domains and comments are escaped
  before being displayed.
- JavaScript is embedded directly in the HTML file. This limits how restrictive
  a Content Security Policy can be. See the comment in
  `nginx.conf.example`.
- When hosting the dashboard on a Synology NAS, a DSM access control profile
  can restrict access to selected IP addresses or local networks.

The dashboard should not be exposed directly to the internet without suitable
access control in front of it.

## Roadmap

- **v1.1.005:** Complete Danish and English interfaces and documentation
- **v1.2.006:** Support for two, three or four Pi-hole instances
- **v1.3.xxx:** Additional languages
- **v1.4.xxx:** Docker image and simplified installation

The dashboard supports two to four active instances. Additional instances
require both the matching server count in `index.html` and a proxy route in nginx.

## Contributing

Issues and pull requests are welcome. Contributions may include bug fixes,
suggestions and, in future versions, translations into additional languages.

## License

Copyright © 2023–2026 Christian Kragh Jessen  
https://christiankragh.dk

The project was originally developed for Pi-hole v5 in 2023 and updated for
Pi-hole v6 in 2026.

The project is released under the MIT License and may be used, copied, modified
and redistributed in accordance with the terms of the license. See `LICENSE`.

Chart.js is not included and must be downloaded separately as described in the
setup instructions. Chart.js is an independent third-party project with its
own license.
