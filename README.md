# Double Pi-hole dashboard

**English** | [Dansk](README.DA.md)


A lightweight dashboard for managing two Pi-hole v6 instances from one
interface. The solution consists of a single self-contained `index.html` with
no backend, database or build process. The browser communicates directly with
both Pi-hole REST APIs through an nginx reverse proxy.

The dashboard includes:

- Combined statistics and charts
- A combined query log with filtering and sorting
- Management of allowed and blocked domains
- Local DNS records with differences between the instances clearly shown
- Known clients and suggestions for unknown devices
- Adlist management
- Gravity updates on each instance
- Actions that can be applied to one or both instances
- Danish and English user interfaces

The two Pi-hole instances remain independent DNS servers. This project does not
provide failover, a virtual IP address, a primary or secondary server, or
automatic background replication. Its purpose is to make it easy to maintain
the relevant settings consistently from a single dashboard.

## Lightweight by design

The dashboard is deliberately simple:

- One HTML file containing HTML, CSS and JavaScript
- No backend
- No database
- No build process
- No Node.js, PHP or Python
- Settings stored locally in the browser
- Direct communication with the Pi-hole v6 APIs through nginx

Chart.js is loaded as a separate local file and is only used for charts.

## Requirements

- Two Pi-hole **v6** instances with the REST API. The dashboard does not work
  with the old Pi-hole v5 PHP API.
- nginx or a similar reverse proxy in front of the dashboard. Requests to
  `/api1/...` and `/api2/...` must be forwarded to the two actual Pi-hole
  instances. This avoids CORS issues.
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
5. Test and reload nginx:

   ```bash
   nginx -t && systemctl reload nginx
   ```

6. Open the dashboard URL and log in to both Pi-hole instances with their app
   passwords.

The dashboard expects the fixed relative API paths `/api1` and `/api2`. The
nginx example forwards these paths to the actual Pi-hole instances. You do not
need to edit `index.html` to enter their addresses.

The displayed server names can be changed under **Settings**. The names are
stored in the browser's `localStorage`, while the API paths remain `/api1` and
`/api2`.

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
- **v1.2.xxx:** Support for up to four Pi-hole instances
- **v1.3.xxx:** Additional languages
- **v1.4.xxx:** Docker image and simplified installation

The implementation for multiple instances will be dynamic, while a maximum of
four instances will be the officially supported and tested layout.

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
