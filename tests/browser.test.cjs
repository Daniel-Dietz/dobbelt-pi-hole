'use strict';

// Run with `node --test tests/browser.test.cjs` after installing Playwright and
// Chromium. An existing compatible browser can be selected with
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Every page/API request is intercepted;
// these tests never contact a Pi-hole or any other live service.
const assert = require('node:assert/strict');
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
    paginatedQueries = false, savedQueryFilters = null, authResponseGate = null } = options;
  const context = await browser.newContext({ locale: browserLanguages[0], timezoneId: 'UTC', viewport: { width: 1600, height: 1100 } });
  t.after(() => context.close());
  const requests = [], unexpected = [], errors = [], readGates = new Map();
  t.after(() => { for (const gate of readGates.values()) gate.release(); });
  function pauseReads(endpoint) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const gate = { arrived: 0, promise, release() { readGates.delete(endpoint); release(); } };
    readGates.set(endpoint, gate);
    return gate;
  }
  const serverData = Object.fromEntries([1, 2, 3, 4].map(id => [String(id), {
    blocking: true,
    domains: [{ domain: DOMAIN, type: 'deny', kind: 'exact', enabled: true, comment: RAW_TEXT, groups: [0] }],
    clients: [{ client: '192.168.1.10', comment: RAW_TEXT, groups: [0] }],
    hosts: ['192.168.1.20 Tillad.example'],
    suggestions: [{ hwaddr: 'AA:BB:CC:DD:EE:01', names: RAW_TEXT, macVendor: 'Example Vendor', addresses: '192.168.1.55' }],
    lists: [{ address: LIST_URL, type: 'block', enabled: true, comment: RAW_TEXT, groups: [0] }],
  }]));
  await context.addInitScript(({ language, browserLanguages, connected, storageUnavailable, rawText, streamingGravity, savedQueryFilters }) => {
    Object.defineProperty(navigator, 'languages', { get: () => browserLanguages });
    Object.defineProperty(navigator, 'language', { get: () => browserLanguages[0] });
    window.__xss = 0;
    localStorage.setItem('ph_combo_cfg_v2', JSON.stringify({ servers: [1, 2, 3, 4].map(id => ({ id: String(id), label: rawText + ' ' + id })) }));
    if (language !== null) localStorage.setItem('ph_combo_language', language);
    if (savedQueryFilters) localStorage.setItem('ph_combo_ui_v1', JSON.stringify({ queries: savedQueryFilters }));
    for (let id = 1; id <= 4; id++) if (connected) sessionStorage.setItem('ph_sid_' + id, 'fixture-sid-' + id);
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
  }, { language, browserLanguages, connected, storageUnavailable, rawText: RAW_TEXT, streamingGravity, savedQueryFilters });
  let html = readFileSync(HTML_PATH, 'utf8');
  if (count !== 2) {
    assert.match(html, /const DEFAULT_SERVER_COUNT\s*=\s*2\s*;/u, 'The supported instance-count configuration must be present');
    html = html.replace(/const DEFAULT_SERVER_COUNT\s*=\s*2\s*;/u, `const DEFAULT_SERVER_COUNT = ${count};`);
  }
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/chart.umd.min.js') {
      if (missingCharts) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'text/javascript', body: process.env.CHART_JS_PATH ? readFileSync(process.env.CHART_JS_PATH, 'utf8') : CHART_FIXTURE });
    }
    const match = url.pathname.match(/^\/api([1-4])(\/.*)$/u);
    if (!match) { unexpected.push(request.url()); return route.abort(); }
    const [, id, endpoint] = match, data = serverData[id], method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    requests.push({ id, method, path: endpoint + url.search, body, sid: request.headers()['x-ftl-sid'] });
    const gateKey = url.searchParams.has('cursor') && readGates.has(endpoint + ':cursor') ? endpoint + ':cursor' : endpoint;
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
  await page.goto(ORIGIN + '/#' + hash);
  await page.locator('#languageSelect option[value="de"]').waitFor({ state: 'attached' });
  if (connected && !storageUnavailable) await waitTab(page, hash);
  else await page.locator('[data-loginform="1"]').waitFor();
  return { page, context, requests, unexpected, errors, serverData, pauseReads };
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
  { language: 'de', browserLanguages: ['da-DK'], expected: 'de' },
  { language: null, browserLanguages: ['de-AT', 'en-US'], expected: 'de' },
  { language: 'unsupported', browserLanguages: ['fr-FR', 'da-DK'], expected: 'da' },
  { language: 'EN_gb', browserLanguages: ['de-DE'], expected: 'en' },
  { language: null, browserLanguages: ['fr-FR', 'nl-NL'], expected: 'en' },
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
  const authRequested = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api1/auth');
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
