'use strict';

// Run with `node --test tests/browser.test.cjs` after installing Playwright and
// Chromium. An existing compatible browser can be selected with
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Every page/API request is intercepted;
// these tests never contact a Pi-hole or any other live service.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const HTML_PATH = join(__dirname, '..', 'index.html');
const ORIGIN = 'https://dashboard.test';
const RAW_TEXT = 'Tillad Domæner {server} <img src=x onerror="window.__xss=1"> & "Behold"';
const DOMAIN = 'Tillad.Domæner.example';
const LIST_URL = 'https://lists.example/Tillad-Domæner.txt';
const TIMESTAMP = 1700000000;
const TABS = ['dashboard', 'queries', 'domains', 'hosts', 'clients', 'lists', 'gravity', 'settings'];
const LABELS_KEY = 'ph_combo_labels_v1';
const SESSION_PREFIX = 'ph_sid_v2:';
function publicConfig(count = 2, defaultLanguage = 'auto') {
  return { version: 1, defaultLanguage, servers: Array.from({ length: count }, (_, index) => {
    const id = String(index + 1);
    return { id, label: 'Configured Pi-hole ' + id, base: '/api' + id + '/' + id.repeat(64) };
  }) };
}

function deferred(t) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  return { promise, release };
}

const EXPECTED = {
  da: {
    locale: 'da-DK', tabs: ['Dashboard', 'Forespørgsler', 'Domæner', 'Lokal DNS', 'Klienter', 'Lister', 'Gravity', 'Indstillinger'],
    language: 'Sprog', both: 'Begge', all: 'Alle', blocked: 'Blokeret', ready: 'Klar.', done: 'Færdig',
    headings: { domains: 'Tilføj domæne', hosts: 'Tilføj lokalt DNS-opslag', clients: 'Tilføj kendt klient', lists: 'Tilføj blokliste / tilladelsesliste' },
    placeholder: 'fx netflix.com eller 192.168...', delete: /^Slet domænet /u, domainAdded: 'domæne tilføjet',
  },
  en: {
    locale: 'en-GB', tabs: ['Dashboard', 'Queries', 'Domains', 'Local DNS', 'Clients', 'Lists', 'Gravity', 'Settings'],
    language: 'Language', both: 'Both', all: 'All', blocked: 'Blocked', ready: 'Ready.', done: 'Done',
    headings: { domains: 'Add domain', hosts: 'Add local DNS record', clients: 'Add known client', lists: 'Add blocklist / allowlist' },
    placeholder: 'e.g. netflix.com or 192.168...', delete: /^Delete the domain /u, domainAdded: 'domain added',
  },
  de: {
    locale: 'de-DE', tabs: ['Übersicht', 'Anfragen', 'Domains', 'Lokales DNS', 'Clients', 'Listen', 'Gravity', 'Einstellungen'],
    language: 'Sprache', both: 'Beide', all: 'Alle', blocked: 'Blockiert', ready: 'Bereit.', done: 'Fertig',
    headings: { domains: 'Domain hinzufügen', hosts: 'Lokalen DNS-Eintrag hinzufügen', clients: 'Bekannten Client hinzufügen', lists: 'Sperrliste / Zulassungsliste hinzufügen' },
    placeholder: 'z. B. netflix.com oder 192.168...', delete: /^Die Domain /u, domainAdded: 'Domain hinzugefügt',
  },
};

// Chart.js is an optional, separately installed asset in production. The fixture
// captures chart configuration while keeping CI independent of a CDN. Set
// CHART_JS_PATH to the documented Chart.js bundle to exercise actual canvas
// rendering with the same tests; both forms expose Chart.instances.
const CHART_FIXTURE = `window.Chart = class Chart {
  static instances = {};
  static sequence = 0;
  constructor(canvas, config) {
    this.id = ++Chart.sequence;
    this.canvas = canvas;
    this.config = config;
    this.options = config.options;
    this.data = config.data;
    Chart.instances[this.id] = this;
  }
  destroy() { delete Chart.instances[this.id]; }
};`;

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
});
after(async () => { await browser?.close(); });

/** Isolate storage, API state and network interception for one browser scenario. */
async function openDashboard(t, options = {}) {
  const { language = 'da', browserLanguages = ['en-US'], count = 2, connected = true,
    storageUnavailable = false, hash = 'dashboard', missingCharts = false, streamingGravity = false,
    paginatedQueries = false, savedQueryFilters = null, authResponseGate = null,
    runtimeConfig = publicConfig(count), configStatus = 200, configText = null, configResponseGate = null,
    waitForReady = true, fakeClock = false, holdInitialSessions = false, contentSecurityPolicy = null,
    labelOverrides, localStorageEntries = {}, sessionStorageEntries = {} } = options;
  const context = await browser.newContext({ locale: browserLanguages[0], timezoneId: 'UTC', viewport: { width: 1600, height: 1100 } });
  t.after(() => context.close());
  const requests = [], configRequests = [], unexpected = [], errors = [], readGates = new Map();
  const configuration = { body: runtimeConfig, status: configStatus, text: configText, gate: configResponseGate };
  const initialServers = (Array.isArray(runtimeConfig?.servers) ? runtimeConfig.servers : [])
    .filter(server => typeof server?.id === 'string' && typeof server.base === 'string');
  const apiTargets = new Map();
  function registerTargets(config) {
    for (const server of Array.isArray(config?.servers) ? config.servers : []) {
      if (typeof server?.id === 'string' && typeof server.base === 'string') apiTargets.set(server.base, server.id);
    }
  }
  registerTargets(runtimeConfig);
  let observeConfigRequest;
  const configObserved = new Promise(resolve => { observeConfigRequest = resolve; });
  t.after(() => { for (const gate of readGates.values()) gate.release(); });
  function pauseReads(endpoint, serverId = null) {
    const key = serverId === null ? endpoint : serverId + ':' + endpoint;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const gate = { arrived: 0, promise, release() { readGates.delete(key); release(); } };
    readGates.set(key, gate);
    return gate;
  }
  const initialSessionGate = holdInitialSessions
    ? pauseReads('/dns/blocking', typeof holdInitialSessions === 'string' ? holdInitialSessions : null) : null;
  const serverData = Object.fromEntries([1, 2, 3, 4].map(id => [String(id), {
    blocking: true,
    domains: [{ domain: DOMAIN, type: 'deny', kind: 'exact', enabled: true, comment: RAW_TEXT, groups: [0] }],
    clients: [{ client: '192.168.1.10', comment: RAW_TEXT, groups: [0] }],
    hosts: ['192.168.1.20 Tillad.example'],
    suggestions: [{ hwaddr: 'AA:BB:CC:DD:EE:01', names: RAW_TEXT, macVendor: 'Example Vendor', addresses: '192.168.1.55' }],
    lists: [{ address: LIST_URL, type: 'block', enabled: true, comment: RAW_TEXT, groups: [0] }],
  }]));
  const initialLabels = labelOverrides === undefined
    ? { overrides: Object.fromEntries(initialServers.map(server => [server.base, RAW_TEXT + ' ' + server.id])) }
    : labelOverrides;
  await context.addInitScript(({ language, browserLanguages, connected, storageUnavailable, streamingGravity, savedQueryFilters,
    initialServers, initialLabels, localStorageEntries, sessionStorageEntries }) => {
    Object.defineProperty(navigator, 'languages', { get: () => browserLanguages });
    Object.defineProperty(navigator, 'language', { get: () => browserLanguages[0] });
    window.__xss = 0;
    // A reload must see the real results of prior app writes. In particular,
    // configuration changes must not reseed sessions or personal labels.
    if (sessionStorage.getItem('__fixture_initialized') !== 'yes') {
      if (initialLabels !== null) localStorage.setItem('ph_combo_labels_v1', JSON.stringify(initialLabels));
      if (language !== null) localStorage.setItem('ph_combo_language', language);
      if (savedQueryFilters) localStorage.setItem('ph_combo_ui_v1', JSON.stringify({ queries: savedQueryFilters }));
      for (const server of initialServers) if (connected) sessionStorage.setItem('ph_sid_v2:' + server.base, 'fixture-sid-' + server.id);
      for (const [key, value] of Object.entries(localStorageEntries)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(sessionStorageEntries)) sessionStorage.setItem(key, value);
      sessionStorage.setItem('__fixture_initialized', 'yes');
    }
    if (storageUnavailable) {
      for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = function () {
        throw new DOMException('Storage is disabled in this test', 'SecurityError');
      };
    }
    if (streamingGravity) {
      const originalFetch = window.fetch;
      window.__gravityRequests = [];
      window.fetch = (input, init) => {
        if (String(input).includes('/action/gravity?')) {
          window.__gravityRequests.push({ input: String(input), method: init.method, headers: init.headers });
          return Promise.resolve(new Response(new ReadableStream({ start(controller) { window.__gravityStream = controller; } }), { status: 200 }));
        }
        return originalFetch(input, init);
      };
    }
  }, { language, browserLanguages, connected, storageUnavailable, streamingGravity, savedQueryFilters,
    initialServers, initialLabels, localStorageEntries, sessionStorageEntries });
  const html = readFileSync(HTML_PATH, 'utf8');
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: html,
      headers: contentSecurityPolicy ? { 'Content-Security-Policy': contentSecurityPolicy } : {} });
    if (url.pathname === '/chart.umd.min.js') {
      if (missingCharts) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'text/javascript', body: process.env.CHART_JS_PATH ? readFileSync(process.env.CHART_JS_PATH, 'utf8') : CHART_FIXTURE });
    }
    if (url.pathname === '/config.json') {
      configRequests.push({ method: request.method(), headers: request.headers() });
      observeConfigRequest();
      if (configuration.gate) await configuration.gate;
      registerTargets(configuration.body);
      return route.fulfill({ status: configuration.status, contentType: 'application/json',
        body: configuration.text === null ? JSON.stringify(configuration.body) : configuration.text });
    }
    const target = [...apiTargets].find(([base]) => url.pathname.startsWith(base + '/'));
    if (!target) { unexpected.push(request.url()); return route.abort(); }
    const [base, id] = target, endpoint = url.pathname.slice(base.length), data = serverData[id], method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    requests.push({ id, base, method, path: endpoint + url.search, body, sid: request.headers()['x-ftl-sid'] });
    const endpointGate = url.searchParams.has('cursor') && readGates.has(endpoint + ':cursor') ? endpoint + ':cursor' : endpoint;
    const gateKey = readGates.has(id + ':' + endpointGate) ? id + ':' + endpointGate : endpointGate;
    if (method === 'GET' && readGates.has(gateKey)) {
      const gate = readGates.get(gateKey);
      gate.arrived++;
      await gate.promise;
    }
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (endpoint === '/auth') {
      if (method === 'POST') {
        if (authResponseGate) await authResponseGate;
        return json({ session: { sid: 'fixture-login-' + id } });
      }
      return route.fulfill({ status: 204 });
    }
    if (endpoint === '/dns/blocking') { if (method === 'POST') data.blocking = body.blocking; return json({ blocking: data.blocking ? 'enabled' : 'disabled' }); }
    if (method !== 'GET') {
      if (endpoint.startsWith('/domains/') && method === 'POST') data.domains.push(...body.domain.map(domain => ({ ...body, domain, enabled: true })));
      else if (endpoint.startsWith('/domains/') && method === 'PUT') {
        const domain = decodeURIComponent(endpoint.split('/').slice(3).join('/'));
        Object.assign(data.domains.find(row => row.domain === domain) || {}, body);
      } else if (endpoint.startsWith('/domains/') && method === 'DELETE') data.domains = data.domains.filter(row => row.domain !== decodeURIComponent(endpoint.split('/').slice(4).join('/')));
      else if (endpoint === '/clients' && method === 'POST') data.clients.push(...body.client.map(client => ({ ...body, client })));
      else if (endpoint.startsWith('/clients/') && method === 'DELETE') data.clients = data.clients.filter(row => row.client !== decodeURIComponent(endpoint.slice('/clients/'.length)));
      else if (endpoint.startsWith('/config/dns/hosts/') && method === 'PUT') data.hosts.push(decodeURIComponent(endpoint.slice('/config/dns/hosts/'.length)));
      else if (endpoint.startsWith('/config/dns/hosts/') && method === 'DELETE') data.hosts = data.hosts.filter(row => row !== decodeURIComponent(endpoint.slice('/config/dns/hosts/'.length)));
      else if (endpoint === '/lists' && method === 'POST') data.lists.push(...body.address.map(address => ({ ...body, address, type: url.searchParams.get('type'), enabled: true })));
      else if (endpoint.startsWith('/lists/') && method === 'DELETE') data.lists = data.lists.filter(row => row.address !== decodeURIComponent(endpoint.slice('/lists/'.length)));
      else { unexpected.push(method + ' ' + request.url()); return json({ error: { message: 'Unexpected fixture mutation' } }); }
      return json({});
    }
    if (endpoint === '/clients') return json({ clients: data.clients });
    if (endpoint === '/clients/_suggestions') return json({ clients: data.suggestions });
    if (endpoint === '/domains') return json({ domains: data.domains });
    if (endpoint === '/config/dns/hosts') return json({ config: { dns: { hosts: data.hosts } } });
    if (endpoint === '/lists') return json({ lists: data.lists });
    if (endpoint === '/stats/summary') return json({ queries: { total: 12345, blocked: 2345, percent_blocked: 19 }, clients: { active: 1, total: 10 }, gravity: { domains_being_blocked: 123456, last_update: TIMESTAMP } });
    if (endpoint === '/stats/top_domains') return json(url.searchParams.has('blocked') ? { blocked_queries: 2345, domains: [{ domain: DOMAIN, count: 2345 }] } : { total_queries: 12345, domains: [{ domain: DOMAIN, count: 10000 }] });
    if (endpoint === '/stats/top_clients') return json({ total_queries: 12345, clients: [{ ip: '192.168.1.10', name: RAW_TEXT, count: 10000 }] });
    if (endpoint === '/stats/query_types') return json({ types: { A: 12000, AAAA: 345 } });
    if (endpoint === '/stats/upstreams') return json({ upstreams: [{ name: 'cache', count: 1234 }, { ip: '1.1.1.1', port: 53, count: 11111 }] });
    if (endpoint === '/history') return json({ history: [{ timestamp: TIMESTAMP, total: 12345, blocked: 2345, cached: 1000, forwarded: 9000 }] });
    if (endpoint === '/history/clients') return json({ clients: Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['192.168.1.' + i, { name: i === 0 ? RAW_TEXT : 'Client ' + i }])), history: [{ timestamp: TIMESTAMP, data: Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['192.168.1.' + i, 1000 + i])) }] });
    if (endpoint === '/queries') {
      if (paginatedQueries && url.searchParams.has('cursor')) return json({ queries: [{ time: TIMESTAMP + 1, domain: 'second.example', type: 'A', status: 'FORWARDED', client: { ip: '192.168.1.20', name: 'Second client' } }] });
      return json({ queries: [{ time: TIMESTAMP, domain: DOMAIN, type: 'AAAA', status: 'GRAVITY', client: { ip: '192.168.1.10', name: RAW_TEXT } }], ...(paginatedQueries ? { cursor: 'next-page' } : {}) });
    }
    unexpected.push(method + ' ' + request.url());
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unhandled fixture endpoint' } }) });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  if (fakeClock) await page.clock.install();
  await Promise.all([
    page.waitForRequest(request => new URL(request.url()).pathname === '/config.json'),
    ...(holdInitialSessions ? initialServers.map(server => page.waitForRequest(request =>
      new URL(request.url()).pathname === server.base + '/dns/blocking')) : []),
    ...(typeof holdInitialSessions === 'string' ? initialServers.filter(server => server.id !== holdInitialSessions)
      .map(server => page.waitForResponse(response => new URL(response.url()).pathname === server.base + '/dns/blocking')
        .then(response => response.finished())) : []),
    page.goto(ORIGIN + '/#' + hash),
  ]);
  await configObserved;
  await page.locator('#languageSelect option[value="de"]').waitFor({ state: 'attached' });
  if (waitForReady) {
    if (connected && !storageUnavailable) await waitTab(page, hash);
    else await page.locator('[data-loginform="1"]').waitFor();
  }
  return { page, context, requests, configRequests, configuration, unexpected, errors, serverData, pauseReads, initialSessionGate };
}

async function waitTab(page, tab) {
  const ready = {
    dashboard: '#dashGrid .big-num', queries: '#qStatus', domains: '#domArea tbody',
    hosts: '#hostArea tbody', clients: '#suggArea tbody', lists: '#listArea tbody',
    gravity: '#gravLast1', settings: '#settingsForm',
  };
  await page.locator(ready[tab]).first().waitFor();
  if (tab === 'queries' || tab === 'gravity') await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim().length > 0, ready[tab]);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}
async function visit(page, tab) { await page.locator(`[data-tab="${tab}"]`).click(); await waitTab(page, tab); }
async function language(page, code, tab) {
  await page.locator('#languageSelect').selectOption(code);
  await page.waitForFunction(code => document.documentElement.lang === code, code);
  await waitTab(page, tab);
}
async function assertNoCorruption(fixture) {
  assert.deepEqual(fixture.errors, [], 'The page must not emit uncaught JavaScript errors');
  assert.deepEqual(fixture.unexpected, [], 'All network requests must match explicit local fixtures');
  assert.equal(await fixture.page.evaluate(() => window.__xss), 0, 'Text must never become executable HTML');
  assert.equal(await fixture.page.locator('#tabContent img, #serverPills img').count(), 0);
}

test('the generated CSP allows the dashboard and charts but blocks foreign inline scripts and handlers', async t => {
  // The HTTP integration tests independently verify the renderer's hash against
  // served bytes. This test exercises that real policy in Chromium.
  const policy = execFileSync('python3', ['-c',
    'import sys; from tools.render_config import content_security_policy; print(content_security_policy(sys.argv[1]))', HTML_PATH,
  ], { cwd: join(__dirname, '..'), encoding: 'utf8' }).trim();
  const fixture = await openDashboard(t, { language: 'de', contentSecurityPolicy: policy }), { page } = fixture;
  assert.deepEqual(await page.locator('#tabs button').allTextContents(), EXPECTED.de.tabs);
  await page.waitForFunction(() => Object.values(Chart.instances).length === 8);
  assert.ok(await page.evaluate(() => Object.values(Chart.instances).every(chart => chart.options.locale === 'de-DE')));
  assert.equal(await page.locator('#dashGrid').evaluate(element => getComputedStyle(element).display), 'grid',
    'The existing inline stylesheet must remain usable');
  if (process.env.CHART_JS_PATH) {
    assert.equal(await page.evaluate(() => Chart.version), '4.4.1');
    assert.ok(await page.evaluate(() => Object.values(Chart.instances).every(chart => {
      const pixels = chart.ctx.getImageData(0, 0, chart.canvas.width, chart.canvas.height).data;
      return chart.width > 0 && chart.height > 0 && pixels.some((value, index) => index % 4 === 3 && value > 0);
    })), 'The real Chart.js bundle must paint each canvas under the deployed policy');
  }

  // DOM insertion must trigger the browser's policy. Executing the probe body
  // through page.evaluate itself would bypass CSP and would not test this.
  await page.evaluate(() => {
    window.__blockedScriptRan = 0;
    window.__blockedHandlerRan = 0;
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition });
    });
    const script = document.createElement('script');
    script.textContent = 'window.__blockedScriptRan += 1;';
    document.body.append(script);
    const button = document.createElement('button');
    button.id = 'cspProbeButton';
    button.textContent = 'CSP test probe';
    button.setAttribute('onclick', 'window.__blockedHandlerRan += 1;');
    document.body.append(button);
  });
  await page.locator('#cspProbeButton').click();
  await page.waitForFunction(() => ['script-src-elem', 'script-src-attr'].every(directive =>
    window.__cspViolations.some(event => event.directive === directive && event.blocked === 'inline' && event.disposition === 'enforce')));
  assert.deepEqual(await page.evaluate(() => [window.__blockedScriptRan, window.__blockedHandlerRan]), [0, 0]);
  await visit(page, 'domains');
  await language(page, 'en', 'domains');
  assert.equal(await page.locator('#tabContent h2').first().textContent(), EXPECTED.en.headings.domains,
    'Ordinary app event listeners must continue working under CSP');
  await assertNoCorruption(fixture);
});

test('configuration loading blocks API calls while language, theme and navigation change', async t => {
  const gate = deferred(t);
  const fixture = await openDashboard(t, { language: null, browserLanguages: ['de-AT'],
    configResponseGate: gate.promise, waitForReady: false }), { page } = fixture;
  await page.locator('#configLoading').waitFor();
  assert.match(await page.locator('#configLoading').textContent(), /Konfiguration/u);
  assert.equal(fixture.configRequests.length, 1);
  assert.equal(fixture.configRequests[0].headers['x-ftl-sid'], undefined, 'Configuration is public and must not receive a Pi-hole SID');
  assert.deepEqual(fixture.requests, []);
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#themeToggle').click();
  await page.evaluate(() => { location.hash = 'clients'; });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.locator('#configLoading').waitFor();
  assert.match(await page.locator('#configLoading').textContent(), /configuration/iu);
  assert.deepEqual(fixture.requests, [], 'Shell controls must not start a tab before targets have been validated');
  gate.release();
  await waitTab(page, 'clients');
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  assert.equal(await page.locator('#tabs [data-tab="clients"]').getAttribute('class'), 'active');
  assert.ok(fixture.requests.length > 0);
  await assertNoCorruption(fixture);
});

test('initial session checks finish before forms become interactive and preserve startup choices', async t => {
  const fixture = await openDashboard(t, { holdInitialSessions: true, waitForReady: false }), { page, initialSessionGate } = fixture;
  assert.equal(initialSessionGate.arrived, 2);
  await page.locator('#configLoading').waitFor();
  assert.equal(await page.locator('#tabs button, #tabContent form').count(), 0);
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#themeToggle').click();
  await page.evaluate(() => { location.hash = 'domains'; });
  await page.locator('#languageSelect').selectOption('de');
  await page.evaluate(() => { location.hash = 'clients'; });
  assert.equal(await page.locator('#tabs button, #tabContent form').count(), 0, 'Pending authentication must not expose an operational form');
  assert.ok(fixture.requests.every(request => request.path === '/dns/blocking'), 'Only the initial session checks may run at this stage');
  const clientGate = fixture.pauseReads('/clients');
  initialSessionGate.release();
  await page.locator('#cClient').fill('192.168.1.98');
  await page.locator('#cComment').fill('Draft typed as soon as the form became available');
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await page.locator('#tabs [data-tab="clients"]').getAttribute('class'), 'active');
  assert.ok(clientGate.arrived > 0);
  clientGate.release();
  await waitTab(page, 'clients');
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#cClient').inputValue(), '192.168.1.98');
  assert.equal(await page.locator('#cComment').inputValue(), 'Draft typed as soon as the form became available');
  assert.equal(fixture.requests.filter(request => request.path === '/clients').length, 2, 'Startup must render the final operational tab only once');
  assert.equal(fixture.requests.filter(request => request.method !== 'GET').length, 0);
  await assertNoCorruption(fixture);
});

test('a stalled initial session times out while a healthy peer loads and cannot reconnect late', async t => {
  const fixture = await openDashboard(t, { language: 'de', holdInitialSessions: '2', waitForReady: false, fakeClock: true }),
    { page, initialSessionGate } = fixture;
  assert.equal(initialSessionGate.arrived, 1);
  await page.locator('#configLoading').waitFor();
  assert.match(await page.locator('#configLoading').textContent(), /Pi-hole-Sitzungen/u);
  assert.equal(await page.locator('#tabs button, #tabContent form').count(), 0);
  await page.clock.runFor(10001);
  await page.clock.resume();
  await page.locator('[data-loginform="2"]').waitFor();
  await waitTab(page, 'dashboard');
  assert.equal(await page.locator('#configLoading').count(), 0);
  assert.deepEqual(await page.locator('#serverPills .pill.on b').allTextContents(), [RAW_TEXT + ' 1']);
  assert.equal(await page.locator('#dashGrid .big-num').first().textContent(), (12345).toLocaleString('de-DE'));
  const timedOutBase = fixture.configuration.body.servers[1].base;
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), SESSION_PREFIX + timedOutBase), null);
  assert.equal(fixture.requests.filter(request => request.id === '2').length, 1, 'The timed-out peer must not receive operational reads');
  initialSessionGate.release();
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await page.locator('#serverPills .pill.on b').allTextContents(), [RAW_TEXT + ' 1'], 'A late session response must not reconnect the timed-out peer');
  assert.equal(await page.locator('[data-loginform="2"]').count(), 1);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), SESSION_PREFIX + timedOutBase), null);
  await assertNoCorruption(fixture);
});

for (const scenario of [
  { name: 'missing file', language: 'da', configStatus: 404 },
  { name: 'malformed JSON', language: 'en', configText: '<img src=x onerror="window.__xss=1">' },
  { name: 'invalid targets', language: 'de', runtimeConfig: { ...publicConfig(), version: 99 } },
]) test(`configuration ${scenario.name} fails closed and can be retried`, async t => {
  const fixture = await openDashboard(t, { ...scenario, waitForReady: false }), { page } = fixture;
  const error = page.locator('#configError[role="alert"]');
  await error.waitFor();
  assert.match(await error.textContent(), /konfiguration|configuration/iu);
  assert.deepEqual(fixture.requests, [], 'An unusable file must not fall back to hardcoded or browser-stored targets');
  assert.equal(await page.locator('#serverPills .pill').count(), 0);
  await page.locator('#languageSelect').selectOption('en');
  await error.waitFor();
  assert.match(await error.textContent(), /configuration/iu);
  fixture.configuration.status = 200;
  fixture.configuration.text = null;
  fixture.configuration.body = publicConfig();
  await page.locator('#configRetry').click();
  await waitTab(page, 'dashboard');
  assert.equal(fixture.configRequests.length, 2);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('#configError').count(), 0);
  await assertNoCorruption(fixture);
});

test('a stalled configuration request times out without API calls and retry recovers', async t => {
  const gate = deferred(t);
  const fixture = await openDashboard(t, { language: 'de', configResponseGate: gate.promise,
    waitForReady: false, fakeClock: true }), { page } = fixture;
  await page.locator('#configLoading').waitFor();
  await page.clock.runFor(10001);
  await page.locator('#configError[role="alert"]').waitFor();
  assert.deepEqual(fixture.requests, []);
  fixture.configuration.gate = null;
  await page.locator('#configRetry').click();
  // The aborted first request must not install a late configuration after the
  // successful retry has started.
  gate.release();
  await page.clock.resume();
  await waitTab(page, 'dashboard');
  assert.equal(fixture.configRequests.length, 2);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  await assertNoCorruption(fixture);
});

test('configured labels and server order remain literal text in tabs and forms', async t => {
  const config = publicConfig(3);
  config.servers = [config.servers[2], config.servers[0], config.servers[1]]
    .map(server => ({ ...server, label: RAW_TEXT + ' ' + server.id }));
  const fixture = await openDashboard(t, { runtimeConfig: config, labelOverrides: null, hash: 'settings' }), { page } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(server => server.label));
  assert.deepEqual(await page.locator('#settingsForm [data-label]').evaluateAll(inputs => inputs.map(input => input.value)), config.servers.map(server => server.label));
  await visit(page, 'domains');
  assert.deepEqual(await page.locator('#targetDomain option').allTextContents(), [
    'Alle (' + config.servers.map(server => server.label).join(' + ') + ')',
    ...config.servers.map(server => server.label),
  ]);
  await assertNoCorruption(fixture);
});

test('personal labels store only differences, survive file renames and reorder, and reset to the file', async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, { runtimeConfig: config, labelOverrides: null, hash: 'settings' }), { page } = fixture;
  await page.locator('[data-label="1"]').fill(RAW_TEXT);
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(label => document.querySelector('#serverPills b')?.textContent === label, RAW_TEXT);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), {
    overrides: { [config.servers[0].base]: RAW_TEXT },
  });
  const beforeReload = fixture.requests.length;
  fixture.configuration.body = { ...config, servers: [
    { ...config.servers[1], label: 'Renamed second Pi-hole' },
    { ...config.servers[0], label: 'Renamed first Pi-hole' },
  ] };
  await page.reload();
  await waitTab(page, 'settings');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Renamed second Pi-hole', RAW_TEXT]);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  assert.ok(fixture.requests.slice(beforeReload).every(request => request.sid === 'fixture-sid-' + request.id), 'Unchanged targets keep their original scoped sessions');
  assert.equal(await page.locator('[data-label="1"]').inputValue(), RAW_TEXT);
  assert.equal(await page.locator('[data-label="2"]').inputValue(), 'Renamed second Pi-hole');
  await page.locator('#resetLabels').click();
  await page.waitForFunction(() => document.querySelector('[data-label="1"]')?.value === 'Renamed first Pi-hole');
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), { overrides: {} });
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Renamed second Pi-hole', 'Renamed first Pi-hole']);
  assert.equal(fixture.requests.filter(request => request.method !== 'GET').length, 0, 'Personal labels never mutate Pi-hole configuration');
  await assertNoCorruption(fixture);
});

test('Settings accepts 120 Unicode characters and visibly rejects an overlong label without saving', async t => {
  const config = publicConfig();
  config.servers[0].label = '😀'.repeat(120);
  const fixture = await openDashboard(t, { language: 'de', runtimeConfig: config, labelOverrides: null, hash: 'settings' }), { page } = fixture;
  const label = page.locator('[data-label="1"]');
  assert.equal(await label.inputValue(), config.servers[0].label);
  const edited = '🦊'.repeat(120);
  await label.fill(edited);
  assert.equal(await label.inputValue(), edited, 'Editing must not truncate surrogate pairs to a 120-code-unit maxlength');
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(value => document.querySelector('#serverPills b')?.textContent === value, edited);
  const saved = { overrides: { [config.servers[0].base]: edited } };
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), saved);
  await label.fill('x'.repeat(121));
  await page.locator('#settingsForm button[type="submit"]').click();
  assert.equal(await label.evaluate(input => input.validity.valid), false);
  assert.match(await label.evaluate(input => input.validationMessage), /120/u);
  assert.equal(await label.inputValue(), 'x'.repeat(121), 'Invalid text remains available for correction');
  assert.equal(await page.locator('#serverPills b').first().textContent(), edited);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), saved, 'Validation failure must not replace the saved label');
  assert.equal(fixture.requests.filter(request => request.method !== 'GET').length, 0);
  await assertNoCorruption(fixture);
});

test('changing a target fingerprint never reuses the previous target session or personal label', async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, { runtimeConfig: config }), { page } = fixture;
  const changed = { ...config.servers[0], base: '/api1/' + 'a'.repeat(64), label: 'Replacement Pi-hole' };
  fixture.configuration.body = { ...config, servers: [changed, config.servers[1]] };
  const beforeReload = fixture.requests.length;
  await page.reload();
  await page.locator('[data-loginform="1"]').waitFor();
  await waitTab(page, 'dashboard');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Replacement Pi-hole', RAW_TEXT + ' 2']);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 1);
  assert.equal(fixture.requests.slice(beforeReload).filter(request => request.id === '1').length, 0, 'The replacement stays logged out until explicitly authenticated');
  assert.ok(fixture.requests.slice(beforeReload).filter(request => request.id === '2').every(request => request.sid === 'fixture-sid-2'));
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), SESSION_PREFIX + changed.base), null);
  await page.locator('[data-loginpw="1"]').fill('replacement-fixture-password');
  await page.locator('[data-loginform="1"] button').click();
  await page.waitForFunction(() => document.querySelectorAll('#serverPills .pill.on').length === 2);
  const auth = fixture.requests.slice(beforeReload).find(request => request.id === '1' && request.method === 'POST');
  assert.equal(auth?.base, changed.base);
  assert.equal(auth.path, '/auth');
  assert.equal(auth.sid, undefined, 'The old target SID must not be sent to the replacement');
  assert.deepEqual(auth.body, { password: 'replacement-fixture-password' });
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), SESSION_PREFIX + changed.base), 'fixture-login-1');
  await assertNoCorruption(fixture);
});

test('legacy labels migrate once by ID while legacy targets, count and sessions are ignored', async t => {
  const config = publicConfig();
  const legacy = { count: 4, servers: [
    { id: '1', label: RAW_TEXT, base: 'https://untrusted.invalid/api' },
    { id: '2', label: ' ' }, { id: '3', label: 'Hidden legacy third' }, { id: '4', label: 'Hidden legacy fourth' },
  ] };
  const fixture = await openDashboard(t, { runtimeConfig: config, connected: false, labelOverrides: null,
    localStorageEntries: { ph_combo_cfg_v2: JSON.stringify(legacy) },
    sessionStorageEntries: Object.fromEntries([1, 2, 3, 4].map(id => ['ph_sid_' + id, 'legacy-session-' + id])),
  }), { page } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), [RAW_TEXT, config.servers[1].label]);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await page.evaluate(() => [1, 2, 3, 4].map(id => sessionStorage.getItem('ph_sid_' + id))), [null, null, null, null]);
  assert.equal(await page.evaluate(() => localStorage.getItem('ph_combo_cfg_v2')), null);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), { overrides: { [config.servers[0].base]: RAW_TEXT } });
  await visit(page, 'settings');
  await page.locator('#resetLabels').click();
  await page.evaluate(value => localStorage.setItem('ph_combo_cfg_v2', value), JSON.stringify(legacy));
  await page.reload();
  await waitTab(page, 'settings');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(server => server.label));
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), { overrides: {} }, 'An existing empty override document prevents remigration');
  assert.deepEqual(fixture.requests, []);
  await assertNoCorruption(fixture);
});

test('invalid personal labels do not override valid configured labels', async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, { runtimeConfig: config, labelOverrides: { overrides: {
    [config.servers[0].base]: ' ', [config.servers[1].base]: 'x'.repeat(121),
  } } }), { page } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(server => server.label));
  await assertNoCorruption(fixture);
});

for (const code of ['da', 'en', 'de']) for (const count of [2, 3, 4]) {
  test(`${code}: every tab, localized charts and intact data with ${count} Pi-holes`, async t => {
    const fixture = await openDashboard(t, { language: code, count }), { page } = fixture, expected = EXPECTED[code];
    assert.deepEqual(await page.locator('#tabs button').allTextContents(), expected.tabs);
    assert.equal(await page.locator('#languageSelect').getAttribute('aria-label'), expected.language);
    assert.equal(await page.locator('#serverPills .pill').count(), count);
    assert.equal(await page.locator('#serverPills b').first().textContent(), RAW_TEXT + ' 1');
    assert.equal(await page.locator('#dashGrid .big-num').first().textContent(), (12345).toLocaleString(expected.locale));
    assert.equal(await page.locator('#dashGrid .big-num').last().textContent(), (12345 * count).toLocaleString(expected.locale));
    const chartData = await page.evaluate(() => Object.values(Chart.instances).map(chart => ({ locale: chart.options.locale, labels: chart.data.labels, series: chart.data.datasets.map(dataset => dataset.label) })));
    assert.equal(chartData.length, count * 4);
    assert.ok(chartData.every(chart => chart.locale === expected.locale));
    assert.equal(chartData[0].series[0], expected.blocked);
    assert.equal(chartData[0].labels[0], new Date(TIMESTAMP * 1000).toLocaleTimeString(expected.locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }));
    for (const tab of TABS.slice(1)) {
      await visit(page, tab);
      if (expected.headings[tab]) assert.equal(await page.locator('#tabContent h2').first().textContent(), expected.headings[tab]);
      if (['domains', 'hosts', 'clients', 'lists'].includes(tab)) {
        assert.ok((await page.locator('.target-select').first().locator('option[value="all"]').textContent()).startsWith(count === 2 ? expected.both : expected.all));
      }
      if (tab === 'queries') {
        assert.equal(await page.locator('#qFilter').getAttribute('placeholder'), expected.placeholder);
        const row = page.locator('#qArea tbody tr').first();
        assert.equal(await row.locator('td').nth(4).textContent(), DOMAIN);
        assert.equal(await row.locator('td').nth(5).textContent(), RAW_TEXT);
        assert.equal(await row.locator('td').nth(2).textContent(), 'GRAVITY');
        assert.equal(await row.locator('td').first().textContent(), new Date(TIMESTAMP * 1000).toLocaleString(expected.locale, { timeZone: 'UTC' }));
      }
      if (tab === 'domains' || tab === 'clients' || tab === 'lists') assert.ok((await page.locator('#tabContent').textContent()).includes(RAW_TEXT));
      if (tab === 'gravity') assert.equal(await page.locator('#gravLog1').textContent(), expected.ready);
      if (tab === 'settings') assert.equal(await page.locator('[data-label="1"]').inputValue(), RAW_TEXT + ' 1');
      await assertNoCorruption(fixture);
    }
  });
}

for (const scenario of [
  { language: 'de', browserLanguages: ['da-DK'], runtimeConfig: publicConfig(2, 'en'), expected: 'de' },
  { language: null, browserLanguages: ['de-AT', 'en-US'], expected: 'de' },
  { language: 'unsupported', browserLanguages: ['fr-FR', 'da-DK'], expected: 'da' },
  { language: 'EN_gb', browserLanguages: ['de-DE'], expected: 'en' },
  { language: null, browserLanguages: ['fr-FR', 'nl-NL'], expected: 'en' },
  { language: null, browserLanguages: ['de-AT'], runtimeConfig: publicConfig(2, 'da'), expected: 'da' },
  { language: 'unsupported', browserLanguages: ['de-DE'], runtimeConfig: publicConfig(2, 'en'), expected: 'en' },
]) test(`language preference ${JSON.stringify(scenario)} resolves correctly`, async t => {
  const fixture = await openDashboard(t, scenario);
  assert.equal(await fixture.page.locator('html').getAttribute('lang'), scenario.expected);
  assert.equal(await fixture.page.locator('#languageSelect').inputValue(), scenario.expected);
  await assertNoCorruption(fixture);
});

test('da → en → de → da preserves every unfinished form and query filter', async t => {
  const fixture = await openDashboard(t), { page } = fixture;
  const scenarios = [
    { tab: 'domains', fields: { '#dDomain': '^Tillad\\.example$', '#dComment': RAW_TEXT }, selects: { '#dType': 'allow', '#dKind': 'regex', '#targetDomain': '2' } },
    { tab: 'hosts', fields: { '#hIp': '192.168.1.88', '#hName': 'Tillad.example' }, selects: { '#targetHost': '2' } },
    { tab: 'clients', fields: { '#cClient': '192.168.1.88', '#cComment': RAW_TEXT, '.sugg-name': RAW_TEXT + ' suggestion' }, selects: { '#targetClient': '2', '#targetSugg0': '2' } },
    { tab: 'lists', fields: { '#lUrl': LIST_URL, '#lComment': RAW_TEXT }, selects: { '#lType': 'allow', '#targetList': '2' } },
    { tab: 'settings', fields: { '[data-label="1"]': RAW_TEXT + ' pending' }, selects: {} },
    { tab: 'queries', fields: { '#qFilter': DOMAIN }, selects: { '#qRange': '24', '#qTypeFilter': 'AAAA', '#qPageSize': '100' } },
  ];
  for (const scenario of scenarios) {
    await visit(page, scenario.tab);
    if (scenario.tab === 'settings') await page.locator('details.help summary').click();
    for (const [selector, value] of Object.entries(scenario.fields)) await page.locator(selector).fill(value);
    for (const [selector, value] of Object.entries(scenario.selects)) await page.locator(selector).selectOption(value);
    for (const code of ['en', 'de', 'da']) {
      await language(page, code, scenario.tab);
      for (const [selector, value] of Object.entries({ ...scenario.fields, ...scenario.selects })) {
        assert.equal(await page.locator(selector).inputValue(), value, `${scenario.tab}: ${selector} must survive switching to ${code}`);
      }
      if (scenario.tab === 'settings') assert.equal(await page.locator('details.help').getAttribute('open'), '');
      assert.equal(await page.evaluate(() => localStorage.getItem('ph_combo_language')), code);
      await assertNoCorruption(fixture);
    }
  }
  assert.equal(fixture.requests.filter(request => request.method !== 'GET').length, 0, 'Changing language must not submit unfinished forms');
});

for (const code of ['da', 'en', 'de']) test(`${code}: CRUD payloads, confirmation dialogs and toast data remain correct`, async t => {
  const fixture = await openDashboard(t, { language: code }), { page, requests } = fixture;
  await visit(page, 'domains');
  await page.locator('#dDomain').fill('^Tillad\\.example$');
  await page.locator('#dComment').fill(RAW_TEXT);
  await page.locator('#dType').selectOption('allow');
  await page.locator('#dKind').selectOption('regex');
  await page.locator('#targetDomain').selectOption('1');
  await page.locator('#domainForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#dDomain').value === '');
  const created = requests.find(request => request.method === 'POST' && request.path === '/domains/allow/regex');
  assert.deepEqual(created?.body, { domain: ['^Tillad\\.example$'], comment: RAW_TEXT, type: 'allow', kind: 'regex', groups: [0] });
  assert.equal(created.sid, 'fixture-sid-1');
  assert.ok((await page.locator('#toastArea').textContent()).includes(RAW_TEXT + ' 1'));
  assert.ok((await page.locator('#toastArea').textContent()).includes(EXPECTED[code].domainAdded));
  await page.locator('#domArea tbody').waitFor();
  const row = page.locator('#domArea tbody tr').filter({ hasText: DOMAIN });
  const dialogPromise = page.waitForEvent('dialog');
  const clicking = row.locator('[data-del-domain-row]').click();
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'confirm');
  assert.match(dialog.message(), EXPECTED[code].delete);
  assert.ok(dialog.message().includes(DOMAIN));
  assert.ok(dialog.message().includes(RAW_TEXT + ' 1'));
  assert.ok(dialog.message().includes('{server}'), 'Interpolated data must not be interpolated a second time');
  await dialog.accept(); await clicking;
  await page.waitForFunction(domain => ![...document.querySelectorAll('#domArea td.mono')].some(td => td.textContent === domain), DOMAIN);
  assert.equal(requests.filter(request => request.method === 'DELETE' && request.path === '/domains/deny/exact/' + encodeURIComponent(DOMAIN)).length, 2);
  await visit(page, 'hosts');
  await page.locator('#hIp').fill('192.168.1.99'); await page.locator('#hName').fill('Tillad.example'); await page.locator('#targetHost').selectOption('1');
  await page.locator('#hostForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#hIp').value === '');
  assert.ok(requests.some(request => request.method === 'PUT' && request.path === '/config/dns/hosts/' + encodeURIComponent('192.168.1.99 Tillad.example') && request.body === undefined));
  await visit(page, 'clients');
  await page.locator('#cClient').fill('192.168.1.99'); await page.locator('#cComment').fill(RAW_TEXT); await page.locator('#targetClient').selectOption('1');
  await page.locator('#clientForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#cClient').value === '');
  assert.deepEqual(requests.find(request => request.method === 'POST' && request.path === '/clients')?.body, { client: ['192.168.1.99'], comment: RAW_TEXT, groups: [0] });
  await visit(page, 'lists');
  await page.locator('#lUrl').fill('https://lists.example/Tillad-new.txt'); await page.locator('#lComment').fill(RAW_TEXT); await page.locator('#lType').selectOption('allow'); await page.locator('#targetList').selectOption('1');
  await page.locator('#listForm button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#lUrl').value === '');
  assert.deepEqual(requests.find(request => request.method === 'POST' && request.path === '/lists?type=allow')?.body, { address: ['https://lists.example/Tillad-new.txt'], comment: RAW_TEXT, groups: [0] });
  await assertNoCorruption(fixture);
});

test('restricted browser storage keeps login and language switching usable', async t => {
  let releaseAuth;
  const authResponseGate = new Promise(resolve => { releaseAuth = resolve; });
  t.after(() => releaseAuth());
  const fixture = await openDashboard(t, { language: null, browserLanguages: ['de-CH'], connected: false, storageUnavailable: true, authResponseGate }), { page } = fixture;
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  await page.locator('[data-loginpw="1"]').fill('fixture-password-Only');
  await page.locator('#languageSelect').selectOption('en');
  await page.waitForFunction(() => document.querySelector('[data-loginpw="1"]')?.value === 'fixture-password-Only');
  const authRequested = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === fixture.configuration.body.servers[0].base + '/auth');
  await page.locator('[data-loginform="1"] button').click();
  const authRequest = await authRequested;
  // The combined total card exists before login completes. Switching language
  // while the auth response is held must not be mistaken for a completed login.
  await language(page, 'de', 'dashboard');
  assert.equal(await page.locator('#serverPills .pill.on').count(), 0);
  releaseAuth();
  await page.locator('#serverPills .pill.on').waitFor();
  assert.deepEqual(authRequest.postDataJSON(), { password: 'fixture-password-Only' });
  await language(page, 'en', 'dashboard');
  assert.equal(await page.locator('#serverPills .pill.on').count(), 1);
  await assertNoCorruption(fixture);
});

test('active Gravity output survives language changes and tab navigation without restarting the update', async t => {
  const fixture = await openDashboard(t, { streamingGravity: true }), { page } = fixture;
  await visit(page, 'gravity');
  await page.locator('#gravBtn1').click();
  await page.waitForFunction(() => !!window.__gravityStream);
  const rawLog = '\u001b[32m' + RAW_TEXT + '\u001b[0m\nGrüße vom Server\n';
  await page.evaluate(text => window.__gravityStream.enqueue(new TextEncoder().encode(text)), rawLog);
  await page.waitForFunction(text => document.querySelector('#gravLog1').textContent.includes(text), RAW_TEXT);
  for (const code of ['en', 'de', 'da']) {
    await language(page, code, 'gravity');
    assert.equal(await page.locator('#gravBtn1').isDisabled(), true);
    assert.ok((await page.locator('#gravLog1').textContent()).includes(RAW_TEXT));
  }
  await visit(page, 'settings');
  await page.evaluate(() => window.__gravityStream.enqueue(new TextEncoder().encode('Tillad Domæner — still raw\n')));
  await visit(page, 'gravity');
  assert.ok((await page.locator('#gravLog1').textContent()).includes('Tillad Domæner — still raw'));
  await page.evaluate(() => window.__gravityStream.close());
  await page.waitForFunction(() => !document.querySelector('#gravBtn1').disabled);
  for (const code of ['de', 'en', 'da']) {
    await language(page, code, 'gravity');
    assert.ok((await page.locator('#gravLog1').textContent()).includes('--- ' + EXPECTED[code].done + ' ---'));
    assert.ok((await page.locator('#gravLog1').textContent()).includes(RAW_TEXT));
  }
  assert.equal(await page.evaluate(() => window.__gravityRequests.length), 1);
  await assertNoCorruption(fixture);
});

test('missing optional Chart.js displays a localized diagnostic and leaves the dashboard usable', async t => {
  const fixture = await openDashboard(t, { language: 'de', missingCharts: true }), { page } = fixture;
  assert.ok((await page.locator('#dashChartArea').textContent()).includes('Diagrammbibliothek'));
  assert.ok((await page.locator('#dashChartArea').textContent()).includes('chart.umd.min.js'));
  assert.equal(await page.locator('#dashGrid .big-num').count(), 3);
  await assertNoCorruption(fixture);
});


test('rapid language changes retain the latest typing and follow reordered client suggestions', async t => {
  const fixture = await openDashboard(t), { page } = fixture;
  await visit(page, 'clients');
  const suggestion = '[data-suggestion-name="AA:BB:CC:DD:EE:01"]';
  const target = '[data-form-state-key="suggestion-target:AA:BB:CC:DD:EE:01"]';
  await page.locator('#cClient').fill('192.168.1.99');
  await page.locator('#cComment').fill('original draft');
  await page.locator(suggestion).fill(RAW_TEXT + ' original device');
  await page.locator(target).selectOption('2');
  // A newly discovered device sorts before the edited suggestion on reload.
  fixture.serverData['1'].suggestions.unshift({ hwaddr: '00:00:00:00:00:01', names: 'New earlier device' });
  const gate = fixture.pauseReads('/clients/_suggestions');
  for (const code of ['en', 'de', 'da']) {
    await page.locator('#languageSelect').selectOption(code);
    await page.waitForFunction(() => document.querySelector('#cClient')?.value === '192.168.1.99');
    await page.locator('#cComment').fill('typed during ' + code);
  }
  assert.ok(gate.arrived > 0, 'The language changes must overlap pending API requests');
  gate.release();
  await page.locator('[data-suggestion-name="00:00:00:00:00:01"]').waitFor();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#cComment').inputValue(), 'typed during da', 'A late render must not overwrite newer typing');
  assert.equal(await page.locator(suggestion).inputValue(), RAW_TEXT + ' original device');
  assert.equal(await page.locator(target).inputValue(), '2', 'Target server must follow device identity instead of its old row position');
  assert.equal(await page.locator('[data-suggestion-name="00:00:00:00:00:01"]').inputValue(), '');
  assert.equal(await page.locator('[data-form-state-key="suggestion-target:00:00:00:00:00:01"]').inputValue(), 'all');
  assert.equal(await page.locator('html').getAttribute('lang'), 'da');
  await assertNoCorruption(fixture);
});

test('query filters edited during slow client-name loading survive the language render', async t => {
  const fixture = await openDashboard(t), { page } = fixture;
  await visit(page, 'queries');
  await page.locator('#qFilter').fill(DOMAIN);
  await page.locator('#qRange').selectOption('24');
  await waitTab(page, 'queries');
  const gate = fixture.pauseReads('/clients');
  await page.locator('#languageSelect').selectOption('en');
  await page.waitForFunction(domain => document.querySelector('#qFilter')?.value === domain, DOMAIN);
  await page.locator('#qFilter').fill('new filter typed during loading');
  await page.locator('#qRange').selectOption('72');
  gate.release();
  await waitTab(page, 'queries');
  assert.equal(await page.locator('#qFilter').inputValue(), 'new filter typed during loading');
  assert.equal(await page.locator('#qRange').inputValue(), '72');
  assert.ok((await page.locator('#qArea').textContent()).includes('No queries found'));
  await assertNoCorruption(fixture);
});


test('new client and type selections made while query cursor pages load override the old language snapshot', async t => {
  const fixture = await openDashboard(t, {
    hash: 'queries', paginatedQueries: true,
    savedQueryFilters: { client: 'ip:192.168.1.20', type: 'A' },
  }), { page } = fixture;
  await page.waitForFunction(() => document.querySelector('#qClientFilter')?.value === 'ip:192.168.1.20' && document.querySelector('#qTypeFilter')?.value === 'A');
  const gate = fixture.pauseReads('/queries:cursor');
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#qClientFilter option[value="ip:192.168.1.10"]').waitFor({ state: 'attached' });
  await page.locator('#qTypeFilter option[value="AAAA"]').waitFor({ state: 'attached' });
  await page.locator('#qClientFilter').selectOption('ip:192.168.1.10');
  await page.locator('#qTypeFilter').selectOption('AAAA');
  assert.ok(gate.arrived > 0, 'A cursor page must remain pending while the user makes new selections');
  gate.release();
  await page.waitForFunction(() => document.querySelector('#qStatus')?.textContent.includes('4 queries in total'));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#qClientFilter').inputValue(), 'ip:192.168.1.10');
  assert.equal(await page.locator('#qTypeFilter').inputValue(), 'AAAA');
  assert.deepEqual(await page.evaluate(() => ({ client: uiState.queries.client, type: uiState.queries.type })), { client: 'ip:192.168.1.10', type: 'AAAA' });
  assert.equal(await page.locator('#qArea tbody tr').count(), 2);
  await assertNoCorruption(fixture);
});

// A completed submission clears its inputs programmatically. Those clears emit
// no input/change events, so late language renders must respect the existing DOM
// controls instead of replaying the pre-submit draft. Keep API reads pending to
// exercise the deferred restoration pass after a successful POST/PUT.
const SUBMISSION_DURING_LANGUAGE_RENDER = [
  { tab: 'domains', form: '#domainForm', endpoint: '/domains', target: '#targetDomain',
    fields: { '#dDomain': 'submitted-domain.example', '#dComment': RAW_TEXT },
    method: 'POST', mutation: '/domains/deny/exact' },
  { tab: 'hosts', form: '#hostForm', endpoint: '/config/dns/hosts', target: '#targetHost',
    fields: { '#hIp': '192.168.1.89', '#hName': 'submitted-host.example' },
    method: 'PUT', mutation: '/config/dns/hosts/' + encodeURIComponent('192.168.1.89 submitted-host.example') },
  { tab: 'clients', form: '#clientForm', endpoint: '/clients', target: '#targetClient',
    fields: { '#cClient': '192.168.1.89', '#cComment': RAW_TEXT },
    method: 'POST', mutation: '/clients' },
  { tab: 'lists', form: '#listForm', endpoint: '/lists', target: '#targetList',
    fields: { '#lUrl': 'https://lists.example/submitted-list.txt', '#lComment': RAW_TEXT },
    method: 'POST', mutation: '/lists?type=block' },
];
for (const scenario of SUBMISSION_DURING_LANGUAGE_RENDER) for (const overlap of [false, true]) {
  test(`${scenario.tab}: a successful submission stays cleared after ${overlap ? 'overlapping language renders' : 'a pending language render'}`, async t => {
    const fixture = await openDashboard(t, { hash: scenario.tab }), { page } = fixture;
    for (const [selector, value] of Object.entries(scenario.fields)) await page.locator(selector).fill(value);
    await page.locator(scenario.target).selectOption('1');
    const gate = fixture.pauseReads(scenario.endpoint);
    await page.locator('#languageSelect').selectOption('en');
    for (const [selector, value] of Object.entries(scenario.fields)) {
      assert.equal(await page.locator(selector).inputValue(), value, 'The synchronous language render must restore the draft before submission');
    }
    await page.locator(`${scenario.form} button[type="submit"]`).click();
    await page.waitForFunction(selectors => selectors.every(selector => document.querySelector(selector)?.value === ''), Object.keys(scenario.fields));
    assert.ok(gate.arrived > 0, 'The language-render GET must still be pending when submission clears the form');
    assert.equal(fixture.requests.filter(request => request.method === scenario.method && request.path === scenario.mutation).length, 1);
    if (overlap) {
      // A second language switch must carry the cleared form, even while the
      // first language render and the submission's table reload are pending.
      await page.locator('#languageSelect').selectOption('de');
      for (const selector of Object.keys(scenario.fields)) assert.equal(await page.locator(selector).inputValue(), '');
    }
    gate.release();
    await waitTab(page, scenario.tab);
    await page.waitForLoadState('networkidle');
    for (const selector of Object.keys(scenario.fields)) {
      assert.equal(await page.locator(selector).inputValue(), '', 'Deferred language restoration must not repopulate successfully submitted values');
    }
    assert.equal(fixture.requests.filter(request => request.method === scenario.method && request.path === scenario.mutation).length, 1, 'Language rendering must not repeat the write');
    await assertNoCorruption(fixture);
  });
}
