# Development guide

The checked-in [`index.html`](../index.html) is both the maintained frontend
source and the deployed page. It contains the HTML, CSS, JavaScript and language
catalogs. Edit it directly as readable source; the project has no frontend build
or minification step. Node.js and Playwright are development dependencies used
for tests.

## Source layout

| Area | Maintained source and responsibility |
| --- | --- |
| Browser application | [`index.html`](../index.html): interface, language catalogs, browser state, Pi-hole requests and rendering |
| Deployment configuration | [`config/config.example.json`](../config/config.example.json) and [`config/config.schema.json`](../config/config.schema.json): example input and supported fields |
| Configuration renderer | [`tools/render_config.py`](../tools/render_config.py): validates the private JSON and generates the public browser configuration, nginx API routes and CSP hashes |
| Docker deployment | [`Dockerfile`](../Dockerfile), [`compose.yaml`](../compose.yaml) and [`container/`](../container/): package the assets, render configuration at startup and run nginx |
| Native Proxmox deployment | [`tools/create_lxc.py`](../tools/create_lxc.py): host CLI for a fresh CT; [`tools/install_lxc_guest.sh`](../tools/install_lxc_guest.sh) and [`lxc/`](../lxc/): install and run the native service |
| Frontend tests | [`tests/i18n.test.cjs`](../tests/i18n.test.cjs) and [`tests/browser.test.cjs`](../tests/browser.test.cjs): isolated language checks and Chromium behavior with controlled API responses |
| Deployment tests | [`tests/test_render_config.py`](../tests/test_render_config.py), [`tests/test_container.py`](../tests/test_container.py), [`tests/test_create_lxc.py`](../tests/test_create_lxc.py) and [`tests/test_lxc_guest.py`](../tests/test_lxc_guest.py): renderer, Docker, host-command and native guest coverage |
| Shared deployment fixture | [`tests/fixtures/fake_pihole.py`](../tests/fixtures/fake_pihole.py): local HTTP/HTTPS responses for proxy and integration tests |
| CI | [`.github/workflows/i18n.yml`](../.github/workflows/i18n.yml): the automated checks run on pushes and pull requests |

nginx serves the page and proxies requests to the configured Pi-hole instances.
The renderer uses Python's standard library and runs during deployment or service
startup. The private configuration contains upstream addresses and TLS choices;
the browser receives public settings and generated proxy routes. Read the
[configuration guide](CONFIGURATION.md) before changing that boundary or the
generated nginx configuration. The [LXC guide](LXC.md) covers host and guest
installation behavior.

## Readable source and English code documentation

All project-owned code comments and docstrings must be in English. This includes
HTML and CSS comments, embedded JavaScript, shell scripts, configuration
examples, test fixtures and code blocks in every README or guide. The user
interface and README prose remain translated into Danish, English and German;
user-facing messages belong in the language catalogs described in the
[translation guide](I18N.md).

Document every function at its definition, including methods, anonymous
functions, nested callbacks, event handlers and functions inside evaluated test
fixtures or embedded code examples. Use JSDoc for JavaScript helpers and Python
docstrings for Python functions. An adjacent English comment is sufficient for a
simple callback when it clearly explains that callback's role.

A useful description explains what the function achieves and why its caller
needs it. Include the meaning of inputs and results, error or fallback behavior,
and side effects when they matter. For example, a reader should learn whether a
helper changes browser state, sends an API request, writes a file or starts a
service. Explain significant constraints and non-obvious decisions. Avoid
comments that only repeat the function name or narrate each statement.

Test documentation should explain the behavior or regression being protected.
Describe what a fixture simulates and why a callback deliberately delays,
rejects or alters a response. Keep these descriptions accurate when assertions
or production behavior change.

Keep maintained code unminified and consistently formatted. Use descriptive
names and straightforward control flow so the code and its documentation can be
read together. The separately downloaded Chart.js bundle is an upstream vendor
artifact and may remain minified. Preserve its pinned version, checksum and
license when packaging it; do not reformat or annotate that bundle as project
source.

## Editing the embedded application

The unit harness reads declarations before the exact
`// Start the dashboard.` marker in `index.html` and evaluates them without
starting the dashboard. Preserve that marker and keep startup calls after it.
See the [translation test description](I18N.md#verification) for the harness
boundaries.

Changes to embedded scripts, including comments or formatting, change the CSP
hashes generated from the installed HTML. Follow
[nginx hardening and HTML changes](CONFIGURATION.md#nginx-hardening-and-html-changes)
to regenerate configuration when deploying changed HTML. Docker images need to
be rebuilt and recreated; installed native HTML needs a service restart; manual
nginx deployments need the renderer and an nginx reload.

## Running checks

Run commands from the repository root. CI uses Node.js 24 for JavaScript checks.
The Python suites use the standard library, with external tools required for
the integration groups below.

The checks without extra package dependencies are:

```bash
node --test tests/i18n.test.cjs
python3 -m unittest discover -s tests -p 'test_render_config.py' -v
python3 -m unittest discover -s tests -p 'test_create_lxc.py' -v
```

Install the browser test dependencies and Chromium to run both frontend suites:

```bash
npm ci
npx playwright install chromium
npm test
```

`npm run test:unit` and `npm run test:browser` run those suites separately.
Browser tests use a deterministic Chart.js fixture by default; CI supplies the
checksum-verified Chart.js 4.4.1 bundle through `CHART_JS_PATH`. The
[frontend verification guide](I18N.md#verification) explains that option and how
to select an existing Chromium executable. CI installs Chromium's Linux system
dependencies with `npx playwright install --with-deps chromium` and runs two
independent smoke jobs using `PLAYWRIGHT_BROWSER=firefox` and
`PLAYWRIGHT_BROWSER=webkit` with their matching browser dependencies.
The smoke subset is selected with `--test-name-pattern='Issue #11 smoke:'`;
it covers login, charts, keyboard sorting, DA/EN/DE drafts and a narrow mobile
viewport without running the entire Chromium-only regression suite three times.

| Test group | Environment and instructions |
| --- | --- |
| Translation unit tests | Node.js 24; isolated VM with storage and DOM fixtures, without dashboard startup or real Pi-hole access |
| Browser tests | Node.js 24 and pinned Playwright; full Chromium regressions with actual Chart.js, plus targeted Firefox/WebKit smoke and a 390-pixel German mobile layout |
| Renderer tests | Python standard library; configuration validation and generated files |
| Docker integration | Docker and OpenSSL; build the deployment image, then run local backend fixtures as described in [configuration checks](CONFIGURATION.md#upgrading-and-checks) |
| Proxmox host CLI tests | Python standard library; controlled host-command fixtures that do not create a real CT |
| Native guest integration | Linux Docker Engine with cgroup v2; actual installer and systemd in a disposable Debian 13 test container, following [native guest checks](LXC.md#verification-scope) |

The Docker and native guest suites exercise real services against isolated local
fixtures. Their evidence does not establish end-to-end installation or recovery
on a real Proxmox node; that acceptance remains tracked in
[#24](https://github.com/Daniel-Dietz/dobbelt-pi-hole/issues/24).

Choose checks that cover the behavior your change can affect. For a documentation
or readability refactor, preserve behavior and keep the application version
unchanged. Update the relevant tests when behavior changes, and follow the
[contribution workflow](../README.md#contributing) before merging tracked work.
