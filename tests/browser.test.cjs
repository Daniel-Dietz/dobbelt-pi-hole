'use strict';

// Run with `node --test tests/browser.test.cjs` after installing Playwright and
// Chromium. An existing compatible browser can be selected with
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Requests use intercepted fixtures or a
// loopback-only HTTP fixture; no real Pi-hole or external service is contacted.
const assert = require('node:assert/strict');
const {
  execFileSync
} = require('node:child_process');
const {
  createHash
} = require('node:crypto');
const {
  readFileSync
} = require('node:fs');
const {
  createServer
} = require('node:http');
const {
  join
} = require('node:path');
const {
  test,
  before,
  after
} = require('node:test');
const {
  chromium
} = require('playwright');
const HTML_PATH = join(__dirname, '..', 'index.html');
const ORIGIN = 'https://dashboard.test';
// The embedded onerror handler would flip the browser sentinel if literal fixture text became executable HTML.
const RAW_TEXT = 'Tillad Domæner {server} <img src=x onerror="window.__xss=1"> & "Behold"';
const DOMAIN = 'Tillad.Domæner.example';
const LIST_URL = 'https://lists.example/Tillad-Domæner.txt';
const TIMESTAMP = 1700000000;
const TABS = ['dashboard', 'queries', 'domains', 'hosts', 'clients', 'lists', 'gravity', 'settings'];
const LABELS_KEY = 'ph_combo_labels_v1';
const SESSION_PREFIX = 'ph_sid_v2:';
/**
 * Build the public configuration consumed by a browser fixture, without private upstream addresses.
 * @param {number} count Number of synthetic Pi-hole entries to include.
 * @param {string} defaultLanguage Configured language preference, or auto.
 * @returns {object} A fresh configuration with predictable, target-scoped API routes.
 */
function publicConfig(count = 2, defaultLanguage = 'auto') {
  return {
    version: 1,
    defaultLanguage,
    servers: Array.from({
      length: count
    }, /** Give each synthetic instance a stable ID, readable label and deterministic route fingerprint. */ (_, index) => {
      const id = String(index + 1);
      return {
        id,
        label: 'Configured Pi-hole ' + id,
        base: '/api' + id + '/' + id.repeat(64)
      };
    })
  };
}

/**
 * Create a promise that the scenario can release when it wants an intercepted response to continue.
 * @param {object} t Node test context used to release the gate during cleanup.
 * @returns {{promise: Promise<void>, release: Function}} The pending operation and its release control.
 */
function deferred(t) {
  let release;
  const promise = new Promise(/** Expose the promise resolver so the test controls when the waiting response continues. */ resolve => {
    release = resolve;
  });
  t.after(/** Release an unfinished gate during cleanup so a failed assertion cannot leave requests waiting. */ () => release());
  return {
    promise,
    release
  };
}
const EXPECTED = {
  da: {
    locale: 'da-DK',
    tabs: ['Dashboard', 'Forespørgsler', 'Domæner', 'Lokal DNS', 'Klienter', 'Lister', 'Gravity', 'Indstillinger'],
    language: 'Sprog',
    both: 'Begge',
    all: 'Alle',
    blocked: 'Blokeret',
    ready: 'Klar.',
    done: 'Færdig',
    headings: {
      domains: 'Tilføj domæne',
      hosts: 'Tilføj lokalt DNS-opslag',
      clients: 'Tilføj kendt klient',
      lists: 'Tilføj blokliste / tilladelsesliste'
    },
    placeholder: 'fx netflix.com eller 192.168...',
    delete: /^Slet domænet /u,
    domainAdded: 'ændringen er bekræftet'
  },
  en: {
    locale: 'en-GB',
    tabs: ['Dashboard', 'Queries', 'Domains', 'Local DNS', 'Clients', 'Lists', 'Gravity', 'Settings'],
    language: 'Language',
    both: 'Both',
    all: 'All',
    blocked: 'Blocked',
    ready: 'Ready.',
    done: 'Done',
    headings: {
      domains: 'Add domain',
      hosts: 'Add local DNS record',
      clients: 'Add known client',
      lists: 'Add blocklist / allowlist'
    },
    placeholder: 'e.g. netflix.com or 192.168...',
    delete: /^Delete the domain /u,
    domainAdded: 'change confirmed'
  },
  de: {
    locale: 'de-DE',
    tabs: ['Übersicht', 'Anfragen', 'Domains', 'Lokales DNS', 'Clients', 'Listen', 'Gravity', 'Einstellungen'],
    language: 'Sprache',
    both: 'Beide',
    all: 'Alle',
    blocked: 'Blockiert',
    ready: 'Bereit.',
    done: 'Fertig',
    headings: {
      domains: 'Domain hinzufügen',
      hosts: 'Lokalen DNS-Eintrag hinzufügen',
      clients: 'Bekannten Client hinzufügen',
      lists: 'Sperrliste / Zulassungsliste hinzufügen'
    },
    placeholder: 'z. B. netflix.com oder 192.168...',
    delete: /^Die Domain /u,
    domainAdded: 'Änderung bestätigt'
  }
};

// The dashboard loads Chart.js as a local asset. This test fixture captures
// chart configuration without requiring that asset. Set
// CHART_JS_PATH to the documented Chart.js bundle to exercise actual canvas
// rendering with the same tests; both forms expose Chart.instances.
const CHART_FIXTURE = `window.Chart = class Chart {
  static instances = {};
  static sequence = 0;
  /** Record chart configuration and register the fixture so tests can inspect and count active charts. */
  constructor(canvas, config) {
    this.id = ++Chart.sequence;
    this.canvas = canvas;
    this.config = config;
    this.options = config.options;
    this.data = config.data;
    Chart.instances[this.id] = this;
  }
  /** Remove the destroyed chart from the registry so rerenders expose only currently active charts. */
  destroy() { delete Chart.instances[this.id]; }
};`;
let browser;
before(/** Launch the shared headless Chromium process, honoring an explicitly selected browser executable. */ async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    } : {})
  });
});
after(/** Close the shared browser after the suite, including a partially initialized run. */ async () => {
  await browser?.close();
});

/**
 * Open an isolated dashboard with synthetic Pi-hole data and controllable configuration, sessions and responses.
 * @param {object} t Node test context that owns the browser context and pending read gates.
 * @param {object} options Initial language, targets, storage, response gates and optional failure fixtures.
 * @returns {Promise<object>} The page, recorded requests, mutable fixture data and read-pause controls.
 * All ordinary requests are intercepted locally; the redirect fixture explicitly permits its loopback server.
 */
async function openDashboard(t, options = {}) {
  const {
    language = 'da',
    browserLanguages = ['en-US'],
    count = 2,
    connected = true,
    storageUnavailable = false,
    hash = 'dashboard',
    missingCharts = false,
    streamingGravity = false,
    paginatedQueries = false,
    savedQueryFilters = null,
    authResponseGate = null,
    runtimeConfig = publicConfig(count),
    configStatus = 200,
    configText = null,
    configResponseGate = null,
    waitForReady = true,
    fakeClock = false,
    holdInitialSessions = false,
    holdSummaryServer = null,
    holdQueriesServer = null,
    contentSecurityPolicy = null,
    origin = ORIGIN,
    html = readFileSync(HTML_PATH, 'utf8'),
    labelOverrides,
    localStorageEntries = {},
    sessionStorageEntries = {}
  } = options;
  const context = await browser.newContext({
    locale: browserLanguages[0],
    timezoneId: 'UTC',
    viewport: {
      width: 1600,
      height: 1100
    }
  });
  t.after(/** Dispose of this scenario's browser context and storage even if the test fails. */ () => context.close());
  const requests = [],
    configRequests = [],
    unexpected = [],
    errors = [],
    readGates = new Map();
  const configuration = {
    body: runtimeConfig,
    status: configStatus,
    text: configText,
    gate: configResponseGate
  };
  const initialServers = (Array.isArray(runtimeConfig?.servers) ? runtimeConfig.servers : []).filter(/** Retain string IDs and routes for seeding; the application remains responsible for validating their contents. */ server => typeof server?.id === 'string' && typeof server.base === 'string');
  const apiTargets = new Map();
  /**
   * Register the public routes that the interceptor may serve, including routes introduced by a configuration retry.
   * @param {object} config Candidate public configuration; malformed entries are ignored by this fixture helper.
   * Updates the fixture route-to-instance map without contacting a target.
   */
  function registerTargets(config) {
    for (const server of Array.isArray(config?.servers) ? config.servers : []) {
      if (typeof server?.id === 'string' && typeof server.base === 'string') apiTargets.set(server.base, server.id);
    }
  }
  registerTargets(runtimeConfig);
  let observeConfigRequest;
  const configObserved = new Promise(/** Capture the signal used to wait until the browser has requested its configuration. */ resolve => {
    observeConfigRequest = resolve;
  });
  t.after(/** Release every remaining intercepted read before tearing down the scenario. */ () => {
    for (const gate of readGates.values()) gate.release();
  });
  /**
   * Pause matching GET responses until the test releases them, optionally for one instance only.
   * @param {string} endpoint API path, with the fixture's :cursor suffix for a paginated response.
   * @param {?string} serverId Instance to pause; null pauses that endpoint on all instances.
   * @returns {object} A gate exposing its arrival count, promise and release method.
   */
  function pauseReads(endpoint, serverId = null) {
    const key = serverId === null ? endpoint : serverId + ':' + endpoint;
    let release;
    const promise = new Promise(/** Retain the resolver that lets the scenario resume this endpoint's pending reads. */ resolve => {
      release = resolve;
    });
    const gate = {
      arrived: 0,
      promise,
      /** Remove this read gate and release its waiters; later requests to the endpoint proceed normally. */ release() {
        readGates.delete(key);
        release();
      }
    };
    readGates.set(key, gate);
    return gate;
  }
  const initialSessionGate = holdInitialSessions ? pauseReads('/dns/blocking', typeof holdInitialSessions === 'string' ? holdInitialSessions : null) : null;
  const summaryGate = holdSummaryServer ? pauseReads('/stats/summary', holdSummaryServer) : null;
  const queriesGate = holdQueriesServer ? pauseReads('/queries', holdQueriesServer) : null;
  const serverData = Object.fromEntries([1, 2, 3, 4].map(/** Allocate independent writable API data for each possible instance so mutations cannot leak between fixtures. */ id => [String(id), {
    blocking: true,
    domains: [{
      domain: DOMAIN,
      type: 'deny',
      kind: 'exact',
      enabled: true,
      comment: RAW_TEXT,
      groups: [0]
    }],
    clients: [{
      client: '192.168.1.10',
      comment: RAW_TEXT,
      groups: [0]
    }],
    hosts: ['192.168.1.20 Tillad.example'],
    suggestions: [{
      hwaddr: 'AA:BB:CC:DD:EE:01',
      names: RAW_TEXT,
      macVendor: 'Example Vendor',
      addresses: '192.168.1.55'
    }],
    lists: [{
      address: LIST_URL,
      type: 'block',
      enabled: true,
      comment: RAW_TEXT,
      groups: [0]
    }]
  }]));
  const initialLabels = labelOverrides === undefined ? {
    overrides: Object.fromEntries(initialServers.map(/** Bind synthetic personal labels containing markup-like text to their exact configured routes. */ server => [server.base, RAW_TEXT + ' ' + server.id]))
  } : labelOverrides;
  await context.addInitScript(/** Prepare browser language and storage once per context, and install only the requested storage or Gravity failure fixtures. */ ({
    language,
    browserLanguages,
    connected,
    storageUnavailable,
    streamingGravity,
    savedQueryFilters,
    initialServers,
    initialLabels,
    localStorageEntries,
    sessionStorageEntries
  }) => {
    Object.defineProperty(navigator, 'languages', {
      get: /** Expose the ordered browser-language preferences selected by the scenario. */ () => browserLanguages
    });
    Object.defineProperty(navigator, 'language', {
      get: /** Expose the first browser-language preference as the browser's primary language. */ () => browserLanguages[0]
    });
    window.__xss = 0;
    // A reload must see the real results of prior app writes. In particular,
    // configuration changes must not reseed sessions or personal labels.
    if (sessionStorage.getItem('__fixture_initialized') !== 'yes') {
      if (initialLabels !== null) localStorage.setItem('ph_combo_labels_v1', JSON.stringify(initialLabels));
      if (language !== null) localStorage.setItem('ph_combo_language', language);
      if (savedQueryFilters) localStorage.setItem('ph_combo_ui_v1', JSON.stringify({
        queries: savedQueryFilters
      }));
      for (const server of initialServers) if (connected) sessionStorage.setItem('ph_sid_v2:' + server.base, 'fixture-sid-' + server.id);
      for (const [key, value] of Object.entries(localStorageEntries)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(sessionStorageEntries)) sessionStorage.setItem(key, value);
      sessionStorage.setItem('__fixture_initialized', 'yes');
    }
    if (storageUnavailable) {
      for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = /** Simulate a browser that rejects storage access with a SecurityError, without using host storage. */ function () {
        throw new DOMException('Storage is disabled in this test', 'SecurityError');
      };
    }
    if (streamingGravity) {
      const originalFetch = window.fetch;
      window.__gravityRequests = [];
      window.fetch = /** Intercept Gravity updates into a controlled stream while forwarding all other calls to the browser's original fetch. */ (input, init) => {
        if (String(input).includes('/action/gravity?')) {
          window.__gravityRequests.push({
            input: String(input),
            method: init.method,
            headers: init.headers
          });
          return Promise.resolve(new Response(new ReadableStream({
            /** Keep the stream controller accessible so the scenario can emit output or finish the Gravity run. */ start(controller) {
              window.__gravityStream = controller;
            }
          }), {
            status: 200
          }));
        }
        return originalFetch(input, init);
      };
    }
  }, {
    language,
    browserLanguages,
    connected,
    storageUnavailable,
    streamingGravity,
    savedQueryFilters,
    initialServers,
    initialLabels,
    localStorageEntries,
    sessionStorageEntries
  });
  await context.route('**/*', /** Serve only configured local assets and synthetic Pi-hole endpoints, record requests, and reject unexpected network activity. */ async route => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({
      contentType: 'text/html',
      body: html,
      headers: contentSecurityPolicy ? {
        'Content-Security-Policy': contentSecurityPolicy
      } : {}
    });
    if (url.pathname === '/chart.umd.min.js') {
      if (missingCharts) return route.fulfill({
        status: 404,
        body: ''
      });
      return route.fulfill({
        contentType: 'text/javascript',
        body: process.env.CHART_JS_PATH ? readFileSync(process.env.CHART_JS_PATH, 'utf8') : CHART_FIXTURE
      });
    }
    if (url.pathname === '/config.json') {
      configRequests.push({
        method: request.method(),
        headers: request.headers()
      });
      observeConfigRequest();
      if (configuration.gate) await configuration.gate;
      registerTargets(configuration.body);
      return route.fulfill({
        status: configuration.status,
        contentType: 'application/json',
        body: configuration.text === null ? JSON.stringify(configuration.body) : configuration.text
      });
    }
    const target = [...apiTargets].find(/** Resolve the requested URL to an allowed instance route without matching a neighboring route prefix. */ ([base]) => url.pathname.startsWith(base + '/'));
    if (!target) {
      unexpected.push(request.url());
      return route.abort();
    }
    const [base, id] = target,
      endpoint = url.pathname.slice(base.length),
      data = serverData[id],
      method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    requests.push({
      id,
      base,
      method,
      path: endpoint + url.search,
      body,
      sid: request.headers()['x-ftl-sid']
    });
    const endpointGate = url.searchParams.has('cursor') && readGates.has(endpoint + ':cursor') ? endpoint + ':cursor' : endpoint;
    const gateKey = readGates.has(id + ':' + endpointGate) ? id + ':' + endpointGate : endpointGate;
    if (method === 'GET' && readGates.has(gateKey)) {
      const gate = readGates.get(gateKey);
      gate.arrived++;
      await gate.promise;
    }
    const json = /** Return a JSON response through Playwright's interceptor, preserving the fixture's normal HTTP success behavior. */ value => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(value)
    });
    if (endpoint === '/auth') {
      if (method === 'POST') {
        if (authResponseGate) await authResponseGate;
        return json({
          session: {
            sid: 'fixture-login-' + id
          }
        });
      }
      return route.fulfill({
        status: 204
      });
    }
    if (endpoint === '/dns/blocking') {
      if (method === 'POST') data.blocking = body.blocking;
      return json({
        blocking: data.blocking ? 'enabled' : 'disabled'
      });
    }
    if (method !== 'GET') {
      if (endpoint.startsWith('/domains/') && method === 'POST') {
        data.domains.push(...body.domain.map(/** Expand a domain-add payload into enabled domain records in this instance's fixture data. */ domain => ({
          ...body,
          domain,
          enabled: true
        })));
      } else if (endpoint.startsWith('/domains/') && method === 'PUT') {
        const domain = decodeURIComponent(endpoint.split('/').slice(3).join('/'));
        Object.assign(data.domains.find(/** Locate the exact domain record addressed by the update request. */ row => row.domain === domain) || {}, body);
      } else if (endpoint.startsWith('/domains/') && method === 'DELETE') {
        data.domains = data.domains.filter(/** Retain every domain except the URL-decoded record selected for deletion. */ row => row.domain !== decodeURIComponent(endpoint.split('/').slice(4).join('/')));
      } else if (endpoint === '/clients' && method === 'POST') {
        data.clients.push(...body.client.map(/** Expand the submitted client array into records carrying the request's shared fields. */ client => ({
          ...body,
          client
        })));
      } else if (endpoint.startsWith('/clients/') && method === 'DELETE') {
        data.clients = data.clients.filter(/** Remove only the client selected by the decoded API path. */ row => row.client !== decodeURIComponent(endpoint.slice('/clients/'.length)));
      } else if (endpoint.startsWith('/config/dns/hosts/') && method === 'PUT') {
        data.hosts.push(decodeURIComponent(endpoint.slice('/config/dns/hosts/'.length)));
      } else if (endpoint.startsWith('/config/dns/hosts/') && method === 'DELETE') {
        data.hosts = data.hosts.filter(/** Remove only the complete local-DNS entry encoded in the request path. */ row => row !== decodeURIComponent(endpoint.slice('/config/dns/hosts/'.length)));
      } else if (endpoint === '/lists' && method === 'POST') {
        data.lists.push(...body.address.map(/** Create enabled list records using the requested allow/block type and shared payload fields. */ address => ({
          ...body,
          address,
          type: url.searchParams.get('type'),
          enabled: true
        })));
      } else if (endpoint.startsWith('/lists/') && method === 'DELETE') {
        data.lists = data.lists.filter(/** Keep lists whose address does not match the decoded deletion target. */ row => row.address !== decodeURIComponent(endpoint.slice('/lists/'.length)));
      } else {
        unexpected.push(method + ' ' + request.url());
        return json({
          error: {
            message: 'Unexpected fixture mutation'
          }
        });
      }
      return json({});
    }
    if (endpoint === '/clients') return json({
      clients: data.clients
    });
    if (endpoint === '/clients/_suggestions') return json({
      clients: data.suggestions
    });
    if (endpoint === '/domains') return json({
      domains: data.domains
    });
    if (endpoint === '/config/dns/hosts') return json({
      config: {
        dns: {
          hosts: data.hosts
        }
      }
    });
    if (endpoint === '/lists') return json({
      lists: data.lists
    });
    if (endpoint === '/stats/summary') return json({
      queries: {
        total: 12345,
        blocked: 2345,
        percent_blocked: 19
      },
      clients: {
        active: 1,
        total: 10
      },
      gravity: {
        domains_being_blocked: 123456,
        last_update: TIMESTAMP
      }
    });
    if (endpoint === '/stats/top_domains') return json(url.searchParams.has('blocked') ? {
      blocked_queries: 2345,
      domains: [{
        domain: DOMAIN,
        count: 2345
      }]
    } : {
      total_queries: 12345,
      domains: [{
        domain: DOMAIN,
        count: 10000
      }]
    });
    if (endpoint === '/stats/top_clients') return json({
      total_queries: 12345,
      clients: [{
        ip: '192.168.1.10',
        name: RAW_TEXT,
        count: 10000
      }]
    });
    if (endpoint === '/stats/query_types') return json({
      types: {
        A: 12000,
        AAAA: 345
      }
    });
    if (endpoint === '/stats/upstreams') return json({
      upstreams: [{
        name: 'cache',
        count: 1234
      }, {
        ip: '1.1.1.1',
        port: 53,
        count: 11111
      }]
    });
    if (endpoint === '/history') return json({
      history: [{
        timestamp: TIMESTAMP,
        total: 12345,
        blocked: 2345,
        cached: 1000,
        forwarded: 9000
      }]
    });
    if (endpoint === '/history/clients') return json({
      clients: Object.fromEntries(Array.from({
        length: 10
      }, /** Generate client-name history metadata, including one value that must remain literal user text. */ (_, i) => ['192.168.1.' + i, {
        name: i === 0 ? RAW_TEXT : 'Client ' + i
      }])),
      history: [{
        timestamp: TIMESTAMP,
        data: Object.fromEntries(Array.from({
          length: 10
        }, /** Generate deterministic history counts under the same client addresses as the metadata. */ (_, i) => ['192.168.1.' + i, 1000 + i]))
      }]
    });
    if (endpoint === '/queries') {
      if (paginatedQueries && url.searchParams.has('cursor')) return json({
        queries: [{
          time: TIMESTAMP + 1,
          domain: 'second.example',
          type: 'A',
          status: 'FORWARDED',
          client: {
            ip: '192.168.1.20',
            name: 'Second client'
          }
        }]
      });
      return json({
        queries: [{
          time: TIMESTAMP,
          domain: DOMAIN,
          type: 'AAAA',
          status: 'GRAVITY',
          client: {
            ip: '192.168.1.10',
            name: RAW_TEXT
          }
        }],
        ...(paginatedQueries ? {
          cursor: 'next-page'
        } : {})
      });
    }
    unexpected.push(method + ' ' + request.url());
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          message: 'Unhandled fixture endpoint'
        }
      })
    });
  });
  const page = await context.newPage();
  page.on('pageerror', /** Record uncaught page errors so each scenario can assert that its browser execution stayed clean. */ error => errors.push(error.message));
  if (fakeClock) {
    await page.clock.install();
  }
  await Promise.all([
    page.waitForRequest(/** Recognize the initial public-configuration request before making startup assertions. */ request => new URL(request.url()).pathname === '/config.json'),
    ...(holdInitialSessions ? initialServers.map(/** Wait for each paused instance to begin its session check before returning control to the scenario. */ server => page.waitForRequest(/** Match this instance's blocking-status request as evidence that its session check started. */ request => new URL(request.url()).pathname === server.base + '/dns/blocking')) : []),
    ...(typeof holdInitialSessions === 'string' ? initialServers
      .filter(/** Select healthy peers whose initial session checks are not held by the single-instance gate. */ server => server.id !== holdInitialSessions)
      .map(/** Wait for the unpaused peer's initial response body so its startup result is available to the test. */ server => page
        .waitForResponse(/** Match the blocking-status response for the current healthy peer. */ response => new URL(response.url()).pathname === server.base + '/dns/blocking')
        .then(/** Wait for completion of the matched response body, not merely receipt of response headers. */ response => response.finished())) : []),
    page.goto(origin + '/#' + hash)
  ]);
  await configObserved;
  await page.locator('#languageSelect option[value="de"]').waitFor({
    state: 'attached'
  });
  if (waitForReady) {
    if (connected && !storageUnavailable) {
      await waitTab(page, hash);
    } else {
      await page.locator('[data-loginform="1"]').waitFor();
    }
  }
  return {
    page,
    context,
    requests,
    configRequests,
    configuration,
    unexpected,
    errors,
    serverData,
    pauseReads,
    initialSessionGate,
    summaryGate,
    queriesGate
  };
}

/**
 * Wait for a tab's observable content and a rendering frame before asserting its presentation.
 * @param {object} page Playwright page containing the dashboard.
 * @param {string} tab Tab key whose table, form, status or summary marks it ready.
 * @returns {Promise<void>} Resolves when the selected readiness marker is usable.
 */
async function waitTab(page, tab) {
  const ready = {
    dashboard: '#dashGrid .big-num',
    queries: '#qStatus',
    domains: '#domArea tbody',
    hosts: '#hostArea tbody',
    clients: '#suggArea tbody',
    lists: '#listArea tbody',
    gravity: '#gravLast1',
    settings: '#settingsForm'
  };
  await page.locator(ready[tab]).first().waitFor();
  if (tab === 'queries' || tab === 'gravity') await page.waitForFunction(/** Require nonempty query or Gravity status text, since the status element exists before loading finishes. */ selector => document.querySelector(selector)?.textContent.trim().length > 0, ready[tab]);
  await page.evaluate(/** Yield one animation frame in the page so pending rendering can settle. */ () => new Promise(requestAnimationFrame));
}
/**
 * Navigate through the real tab button and wait for the destination's content.
 * @param {object} page Playwright dashboard page.
 * @param {string} tab Tab key used by the navigation button and readiness helper.
 * @returns {Promise<void>} Resolves after navigation and the tab readiness check.
 */
async function visit(page, tab) {
  await page.locator(`[data-tab="${tab}"]`).click();
  await waitTab(page, tab);
}
/**
 * Change the visible language selector and wait for the translated tab to become ready.
 * @param {object} page Playwright dashboard page.
 * @param {string} code Supported language code to select.
 * @param {string} tab Current tab whose content must finish rendering.
 * @returns {Promise<void>} Resolves when the document language and tab agree.
 */
async function language(page, code, tab) {
  await page.locator('#languageSelect').selectOption(code);
  await page.waitForFunction(/** Wait until the document advertises the language chosen by the test. */ code => document.documentElement.lang === code, code);
  await waitTab(page, tab);
}
/**
 * Check shared invariants after a browser scenario: no page errors, unexpected requests or executable injected text.
 * @param {object} fixture Dashboard fixture with its page and recorded failures.
 * @returns {Promise<void>} Resolves if all assertions pass; an assertion failure identifies the violated invariant.
 */
async function assertNoCorruption(fixture) {
  assert.deepEqual(fixture.errors, [], 'The page must not emit uncaught JavaScript errors');
  assert.deepEqual(fixture.unexpected, [], 'All network requests must match explicit local fixtures');
  assert.equal(await fixture.page.evaluate(/** Read the injection sentinel in the browser to detect execution of markup-like fixture text. */ () => window.__xss), 0, 'Text must never become executable HTML');
  assert.equal(await fixture.page.locator('#tabContent img, #serverPills img').count(), 0);
}
const REDIRECT_API_BODY = {
  client: ['192.0.2.88'],
  comment: 'redirect regression fixture',
  groups: [0]
};
const REDIRECT_PASSWORD = 'fixture-password-for-instance-1';

/**
 * Create a real loopback redirect endpoint and attach it to an otherwise intercepted dashboard fixture.
 * @param {object} t Node test context that closes the HTTP server and browser resources.
 * @param {object} options Redirect status, login/API mode and optional removal of guards for a negative control.
 * @returns {Promise<object>} The browser fixture plus original, redirected and unexpected HTTP request records.
 * Only the explicitly named source and target paths reach the local HTTP server.
 */
async function openRedirectDashboard(t, {
  status,
  loginRequest = false,
  withoutGuards = false
}) {
  const config = publicConfig(),
    endpoint = loginRequest ? '/auth' : '/clients';
  const sourcePath = config.servers[0].base + endpoint;
  const targetPath = config.servers[1].base + endpoint + '?redirect-regression=' + status;
  const sourceRequests = [],
    targetRequests = [],
    networkUnexpected = [];
  const server = createServer(/** Record real HTTP requests, issue the chosen redirect and expose any credential or body forwarding at its target. */ async (request, response) => {
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    const record = {
      method: request.method,
      sid: request.headers['x-ftl-sid'] ?? null,
      body: rawBody ? JSON.parse(rawBody) : null
    };
    if (request.url === sourcePath && request.method === 'POST') {
      sourceRequests.push(record);
      response.writeHead(status, {
        Location: targetPath
      });
      return response.end();
    }
    // Record every method: 301/302/303 may rewrite a POST into a GET.
    if (request.url === targetPath) {
      targetRequests.push(record);
      response.writeHead(200, {
        'Content-Type': 'application/json'
      });
      return response.end(JSON.stringify(loginRequest ? {
        session: {
          sid: 'fixture-redirected-sid-2'
        }
      } : {}));
    }
    networkUnexpected.push(request.method + ' ' + request.url);
    response.writeHead(404);
    response.end();
  });
  await new Promise(/** Bind the redirect fixture to a random loopback port and reject startup errors instead of continuing with an unusable server. */ (resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(/** Close the loopback listener and its connections when the test context finishes. */ () => new Promise(/** Resolve teardown only after server closure, while terminating keep-alive connections that could delay it. */ resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const original = readFileSync(HTML_PATH, 'utf8');
  let html = original;
  let policy = execFileSync('python3', ['-c', 'import sys; from tools.render_config import content_security_policy; print(content_security_policy(sys.argv[1]))', HTML_PATH], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8'
  }).trim();
  if (withoutGuards) {
    // Negative controls serve the old behavior only in memory. Keep the config
    // fetch guard and the rest of the deployed CSP, updating just the app hash.
    const start = html.indexOf('async function apiCall('),
      end = html.indexOf('async function logout(');
    assert.ok(start >= 0 && end > start);
    const guarded = html.slice(start, end),
      guard = /redirect: "error",?[ \t\r\n]*/gm;
    assert.equal([...guarded.matchAll(guard)].length, 2, 'Remove exactly the API and login guards');
    html = html.slice(0, start) + guarded.replace(guard, '') + html.slice(end);
    const hash = /** Recompute the inline application's CSP hash after an in-memory guard removal, preserving a realistic negative control. */ source => {
      const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
      assert.equal(scripts.length, 1, 'The control must identify the actual inline app script');
      return 'sha256-' + createHash('sha256').update(scripts[0][1].replace(/\r\n?/gu, '\n')).digest('base64');
    };
    const oldHash = hash(original);
    assert.ok(policy.includes("'" + oldHash + "'"));
    policy = policy.replace(oldHash, hash(html));
  }
  const fixture = await openDashboard(t, {
    origin,
    html,
    language: 'en',
    connected: !loginRequest,
    runtimeConfig: config,
    labelOverrides: null,
    contentSecurityPolicy: policy
  });
  await fixture.page.route('**/*', /** Allow only the redirect probe's source POST and target path to reach loopback; keep every other request intercepted. */ route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname + url.search;
    if (url.origin === origin && (path === sourcePath && request.method() === 'POST' || path === targetPath)) {
      return route.continue();
    }
    return route.fallback();
  });
  return {
    ...fixture,
    sourceRequests,
    targetRequests,
    networkUnexpected
  };
}

/**
 * Read in-memory and browser-stored session state for every configured instance.
 * @param {object} page Playwright dashboard page.
 * @returns {Promise<Array<object>>} Instance ID, connection flag, active SID and route-bound stored SID.
 */
async function redirectSessions(page) {
  return page.evaluate(/** Collect session state inside the page using the supplied storage-key prefix. */ prefix => state.servers.map(/** Project one instance's live and stored credentials so redirected-session mixing becomes observable. */ server => ({
    id: server.id,
    connected: server.connected,
    sid: server.sid,
    stored: sessionStorage.getItem(prefix + server.base)
  })), SESSION_PREFIX);
}
/**
 * Exercise the dashboard's shared API helper with the synthetic redirect payload.
 * @param {object} page Playwright dashboard page.
 * @returns {Promise<string>} The literal fulfilled or rejected outcome, without hiding target request records.
 */
async function submitRedirectApi(page) {
  return page.evaluate(/** Call the real client-write helper in the browser and report whether redirect handling rejects it. */ async body => {
    try {
      await apiCall(serverById('1'), '/clients', {
        method: 'POST',
        body
      });
      return 'fulfilled';
    } catch {
      return 'rejected';
    }
  }, REDIRECT_API_BODY);
}
/**
 * Submit the redirect-test password through the real login form and await its outcome notification.
 * @param {object} page Playwright dashboard page.
 * @returns {Promise<void>} Resolves when either the protected failure or negative-control success is visible.
 */
async function submitRedirectLogin(page) {
  await page.locator('[data-loginpw="1"]').fill(REDIRECT_PASSWORD);
  await page.locator('[data-loginform="1"] button').click();
  // Wait for either outcome so an unguarded login fails an assertion promptly.
  await page.locator('.toast').first().waitFor();
}
/**
 * Verify that exactly the intended source request arrived and no unrelated network activity occurred.
 * @param {object} fixture Redirect fixture with captured HTTP records and browser failures.
 * @param {boolean} loginRequest Select the expected login password or authenticated API payload.
 * @returns {Promise<void>} Resolves after source-request and shared browser assertions pass.
 */
async function assertRedirectFixture(fixture, loginRequest) {
  assert.deepEqual(fixture.sourceRequests, [{
    method: 'POST',
    sid: loginRequest ? null : 'fixture-sid-1',
    body: loginRequest ? {
      password: REDIRECT_PASSWORD
    } : REDIRECT_API_BODY
  }], 'The intended instance must receive exactly one original request with its fixture credentials/body');
  assert.deepEqual(fixture.networkUnexpected, [], 'The loopback server must receive only explicit fixture requests');
  await assertNoCorruption(fixture);
}
for (const status of [301, 302, 303, 307, 308]) {
  test(`API redirect ${status} is rejected before another instance receives a request`, /** For each redirect status, prove that an authenticated API write never reaches another instance or changes its sessions. */ async t => {
    const fixture = await openRedirectDashboard(t, {
        status
      }),
      {
        page
      } = fixture;
    const before = await redirectSessions(page);
    assert.deepEqual(before, [1, 2].map(/** Construct the expected pair of connected, independently stored sessions before the redirect probe. */ id => ({
      id: String(id),
      connected: true,
      sid: 'fixture-sid-' + id,
      stored: 'fixture-sid-' + id
    })));
    assert.equal(await submitRedirectApi(page), 'rejected');
    assert.deepEqual(fixture.targetRequests, [], 'No redirected request, SID or body may reach instance 2');
    assert.deepEqual(await redirectSessions(page), before, 'Rejection must not mix up existing sessions');
    await assertRedirectFixture(fixture, false);
  });
  test(`login redirect ${status} is rejected without authenticating the wrong instance`, /** For each redirect status, prove that the login form cannot forward its password or adopt another instance's SID. */ async t => {
    const fixture = await openRedirectDashboard(t, {
        status,
        loginRequest: true
      }),
      {
        page
      } = fixture;
    const before = await redirectSessions(page);
    assert.deepEqual(before, [1, 2].map(/** Construct the expected logged-out state for both instances before a redirected login. */ id => ({
      id: String(id),
      connected: false,
      sid: null,
      stored: null
    })));
    await submitRedirectLogin(page);
    assert.equal(await page.locator('.toast.err').count(), 1, 'The normal login failure handler must report the rejection');
    assert.deepEqual(fixture.targetRequests, [], 'No redirected request or password may reach instance 2');
    assert.deepEqual(await redirectSessions(page), before, 'Neither instance may acquire a redirected session');
    assert.equal(await page.locator('[data-loginform="1"]').count(), 1);
    await assertRedirectFixture(fixture, true);
  });
}
test('the real redirect fixture exposes API SID/body forwarding without the guard (307, memory-only)', /** Remove guards only in memory and prove the fixture detects real 307 forwarding of the original SID and body. */ async t => {
  const fixture = await openRedirectDashboard(t, {
    status: 307,
    withoutGuards: true
  });
  assert.equal(await submitRedirectApi(fixture.page), 'fulfilled');
  assert.deepEqual(fixture.targetRequests, [{
    method: 'POST',
    sid: 'fixture-sid-1',
    body: REDIRECT_API_BODY
  }], 'The same test must observe the second request when the production guard is removed');
  await assertRedirectFixture(fixture, false);
});
test('the real redirect fixture exposes login forwarding and session mixup without the guard (308, memory-only)', /** Remove guards only in memory and demonstrate the 308 password forwarding and wrong-instance login that the fix prevents. */ async t => {
  const fixture = await openRedirectDashboard(t, {
    status: 308,
    loginRequest: true,
    withoutGuards: true
  });
  await submitRedirectLogin(fixture.page);
  assert.equal(await fixture.page.locator('.toast.ok').count(), 1);
  assert.deepEqual(fixture.targetRequests, [{
    method: 'POST',
    sid: null,
    body: {
      password: REDIRECT_PASSWORD
    }
  }]);
  assert.deepEqual(await redirectSessions(fixture.page), [{
    id: '1',
    connected: true,
    sid: 'fixture-redirected-sid-2',
    stored: 'fixture-redirected-sid-2'
  }, {
    id: '2',
    connected: false,
    sid: null,
    stored: null
  }], 'Without the guard, the login response from instance 2 is incorrectly stored for instance 1');
  await assertRedirectFixture(fixture, true);
});
test('the generated CSP allows the dashboard and charts but blocks foreign inline scripts and handlers', /** Exercise the generated CSP in Chromium: allow the real application and charts while rejecting injected scripts and handlers. */ async t => {
  // The HTTP integration tests independently verify the renderer's hash against
  // served bytes. This test exercises that real policy in Chromium.
  const policy = execFileSync('python3', ['-c', 'import sys; from tools.render_config import content_security_policy; print(content_security_policy(sys.argv[1]))', HTML_PATH], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8'
  }).trim();
  const fixture = await openDashboard(t, {
      language: 'de',
      contentSecurityPolicy: policy
    }),
    {
      page
    } = fixture;
  assert.deepEqual(await page.locator('#tabs button').allTextContents(), EXPECTED.de.tabs);
  await page.waitForFunction(/** Wait until both configured instances have created all eight dashboard charts. */ () => Object.values(Chart.instances).length === 8);
  assert.ok(await page.evaluate(/** Read whether every chart uses the German locale under the deployed content-security policy. */ () => Object.values(Chart.instances).every(/** Check the locale attached to one chart rather than relying on surrounding translated text. */ chart => chart.options.locale === 'de-DE')));
  assert.equal(await page.locator('#dashGrid').evaluate(/** Read the computed dashboard layout to prove the existing stylesheet remains permitted. */ element => getComputedStyle(element).display), 'grid', 'The existing inline stylesheet must remain usable');
  if (process.env.CHART_JS_PATH) {
    assert.equal(await page.evaluate(/** Read the actual loaded Chart.js version when the production asset is under test. */ () => Chart.version), '4.4.1');
    assert.ok(await page.evaluate(/** Inspect all canvas contents in the browser to prove the real Chart.js bundle rendered under CSP. */ () => Object.values(Chart.instances).every(/** Require a nonempty canvas with at least one painted pixel for this chart. */ chart => {
      const pixels = chart.ctx.getImageData(0, 0, chart.canvas.width, chart.canvas.height).data;
      return chart.width > 0 && chart.height > 0 && pixels.some(/** Find a nonzero alpha channel in the RGBA buffer as evidence of visible drawing. */ (value, index) => index % 4 === 3 && value > 0);
    })), 'The real Chart.js bundle must paint each canvas under the deployed policy');
  }

  // DOM insertion must trigger the browser's policy. Executing the probe body
  // through page.evaluate itself would bypass CSP and would not test this.
  await page.evaluate(/** Insert real DOM-based script and event-handler probes so CSP enforcement, rather than evaluate privileges, is tested. */ () => {
    window.__blockedScriptRan = 0;
    window.__blockedHandlerRan = 0;
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', /** Collect browser policy violations with directive, blocked resource and enforcement mode for later assertions. */ event => {
      window.__cspViolations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        disposition: event.disposition
      });
    });
    const script = document.createElement('script');
    // This inserted script would increment the counter if the browser failed to enforce its CSP.
    script.textContent = 'window.__blockedScriptRan += 1;';
    document.body.append(script);
    const button = document.createElement('button');
    button.id = 'cspProbeButton';
    button.textContent = 'CSP test probe';
    // This inline click handler would increment its counter if CSP allowed event-attribute code.
    button.setAttribute('onclick', 'window.__blockedHandlerRan += 1;');
    document.body.append(button);
  });
  await page.locator('#cspProbeButton').click();
  await page.waitForFunction(/** Wait for both inline-script and inline-handler rejection events before checking that neither probe executed. */ () => ['script-src-elem', 'script-src-attr'].every(/** Require an enforced inline violation for each of the two script directives. */ directive => window.__cspViolations.some(/** Recognize the enforced inline violation belonging to the directive under inspection. */ event => event.directive === directive && event.blocked === 'inline' && event.disposition === 'enforce')));
  assert.deepEqual(await page.evaluate(/** Read both execution sentinels to prove the blocked script and handler stayed inactive. */ () => [window.__blockedScriptRan, window.__blockedHandlerRan]), [0, 0]);
  await visit(page, 'domains');
  await language(page, 'en', 'domains');
  assert.equal(await page.locator('#tabContent h2').first().textContent(), EXPECTED.en.headings.domains, 'Ordinary app event listeners must continue working under CSP');
  await assertNoCorruption(fixture);
});
test('configuration loading blocks API calls while language, theme and navigation change', /** Hold configuration loading while changing shell controls, then prove operational requests start only after valid targets arrive. */ async t => {
  const gate = deferred(t);
  const fixture = await openDashboard(t, {
      language: null,
      browserLanguages: ['de-AT'],
      configResponseGate: gate.promise,
      waitForReady: false
    }),
    {
      page
    } = fixture;
  await page.locator('#configLoading').waitFor();
  assert.match(await page.locator('#configLoading').textContent(), /Konfiguration/u);
  assert.equal(fixture.configRequests.length, 1);
  assert.equal(fixture.configRequests[0].headers['x-ftl-sid'], undefined, 'Configuration is public and must not receive a Pi-hole SID');
  assert.deepEqual(fixture.requests, []);
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#themeToggle').click();
  await page.evaluate(/** Navigate by URL fragment while configuration is pending to exercise the queued-tab choice. */ () => {
    location.hash = 'clients';
  });
  await page.waitForFunction(/** Wait for the loading shell to finish switching to English before checking its diagnostic text. */ () => document.documentElement.lang === 'en');
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
test('initial session checks finish before forms become interactive and preserve startup choices', /** Delay initial session checks, change startup choices, then verify that forms appear once and retain immediate user input. */ async t => {
  const fixture = await openDashboard(t, {
      holdInitialSessions: true,
      waitForReady: false
    }),
    {
      page,
      initialSessionGate
    } = fixture;
  assert.equal(initialSessionGate.arrived, 2);
  await page.locator('#configLoading').waitFor();
  assert.equal(await page.locator('#tabs button, #tabContent form').count(), 0);
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#themeToggle').click();
  await page.evaluate(/** Request the Domains tab before initial authentication completes. */ () => {
    location.hash = 'domains';
  });
  await page.locator('#languageSelect').selectOption('de');
  await page.evaluate(/** Replace the pending tab choice with Clients so startup must honor the latest selection. */ () => {
    location.hash = 'clients';
  });
  assert.equal(await page.locator('#tabs button, #tabContent form').count(), 0, 'Pending authentication must not expose an operational form');
  assert.ok(fixture.requests.every(/** Ensure startup made only blocking-status session checks while authentication was held. */ request => request.path === '/dns/blocking'), 'Only the initial session checks may run at this stage');
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
  assert.equal(fixture.requests.filter(/** Count client-list reads to detect duplicate operational renders after session initialization. */ request => request.path === '/clients').length, 2, 'Startup must render the final operational tab only once');
  assert.equal(fixture.requests.filter(/** Select writes to prove startup and language changes did not submit any form. */ request => request.method !== 'GET').length, 0);
  await assertNoCorruption(fixture);
});
test('a stalled initial session stays unverified and retains its SID for a later retry', /** Preserve saved credentials on network failure while keeping late responses from reconnecting automatically. */ async t => {
  const fixture = await openDashboard(t, {
      language: 'de',
      holdInitialSessions: '2',
      waitForReady: false,
      fakeClock: true
    }),
    {
      page,
      initialSessionGate
    } = fixture;
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
  assert.equal(await page.locator('#dashGrid .big-num').first().textContent(), 12345 .toLocaleString('de-DE'));
  const timedOutBase = fixture.configuration.body.servers[1].base;
  assert.equal(await page.evaluate(/** Keep the potentially valid SID when the instance is temporarily unavailable. */ key => sessionStorage.getItem(key), SESSION_PREFIX + timedOutBase), 'fixture-sid-2');
  assert.equal(await page.locator('[data-session-retry="2"]').count(), 1);
  assert.equal(fixture.requests.filter(/** Count requests to the stalled peer to ensure it never receives ordinary tab reads. */ request => request.id === '2').length, 1, 'The timed-out peer must not receive operational reads');
  initialSessionGate.release();
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await page.locator('#serverPills .pill.on b').allTextContents(), [RAW_TEXT + ' 1'], 'A late session response must not reconnect the timed-out peer');
  assert.equal(await page.locator('[data-loginform="2"]').count(), 1);
  assert.equal(await page.evaluate(/** A late, obsolete response must not clear the saved SID. */ key => sessionStorage.getItem(key), SESSION_PREFIX + timedOutBase), 'fixture-sid-2');
  await page.locator('[data-session-retry="2"]').click();
  await page.waitForFunction(/** Verify the retained SID before reporting the instance connected. */ () => state.servers.find(server => server.id === '2')?.connected === true);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  await assertNoCorruption(fixture);
});
for (const scenario of [{
  name: 'missing file',
  language: 'da',
  configStatus: 404
}, {
  name: 'malformed JSON',
  language: 'en',
  configText: '<img src=x onerror="window.__xss=1">'
}, {
  name: 'invalid targets',
  language: 'de',
  runtimeConfig: {
    ...publicConfig(),
    version: 99
  }
}]) test(`configuration ${scenario.name} fails closed and can be retried`, /** Exercise missing, malformed and unsupported configuration responses, then retry with a valid file without fallback targets. */ async t => {
  const fixture = await openDashboard(t, {
      ...scenario,
      waitForReady: false
    }),
    {
      page
    } = fixture;
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
test('a stalled configuration request times out without API calls and retry recovers', /** Trigger the configuration timeout, retry successfully and verify the released obsolete response cannot replace the new result. */ async t => {
  const gate = deferred(t);
  const fixture = await openDashboard(t, {
      language: 'de',
      configResponseGate: gate.promise,
      waitForReady: false,
      fakeClock: true
    }),
    {
      page
    } = fixture;
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
test('configured labels and server order remain literal text in tabs and forms', /** Reorder configured instances and use markup-like labels to verify their literal text and order in every target control. */ async t => {
  const config = publicConfig(3);
  config.servers = [config.servers[2], config.servers[0], config.servers[1]].map(/** Attach the same injection-sensitive label pattern to each reordered configured instance. */ server => ({
    ...server,
    label: RAW_TEXT + ' ' + server.id
  }));
  const fixture = await openDashboard(t, {
      runtimeConfig: config,
      labelOverrides: null,
      hash: 'settings'
    }),
    {
      page
    } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(/** Derive expected pill text directly from the new central configuration order. */ server => server.label));
  assert.deepEqual(await page.locator('#settingsForm [data-label]').evaluateAll(/** Read all editable label values from the Settings form inside the browser. */ inputs => inputs.map(/** Extract one label input's current value, preserving its literal characters. */ input => input.value)), config.servers.map(/** Derive the expected Settings values from configured labels in their original order. */ server => server.label));
  await visit(page, 'domains');
  assert.deepEqual(await page.locator('#targetDomain option').allTextContents(), ['Alle (' + config.servers.map(/** Build the combined target caption from the ordered configured labels. */ server => server.label).join(' + ') + ')', ...config.servers.map(/** List the individual target captions expected after the combined option. */ server => server.label)]);
  await assertNoCorruption(fixture);
});
test('personal labels store only differences, survive file renames and reorder, and reset to the file', /** Save a personal name, rename and reorder central targets, then reset to central names while preserving scoped sessions. */ async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, {
      runtimeConfig: config,
      labelOverrides: null,
      hash: 'settings'
    }),
    {
      page
    } = fixture;
  await page.locator('[data-label="1"]').fill(RAW_TEXT);
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for the saved personal name to appear in the first instance pill. */ label => document.querySelector('#serverPills b')?.textContent === label, RAW_TEXT);
  assert.deepEqual(await page.evaluate(/** Decode the saved label document to check that only the changed route has an override. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), {
    overrides: {
      [config.servers[0].base]: RAW_TEXT
    }
  });
  const beforeReload = fixture.requests.length;
  fixture.configuration.body = {
    ...config,
    servers: [{
      ...config.servers[1],
      label: 'Renamed second Pi-hole'
    }, {
      ...config.servers[0],
      label: 'Renamed first Pi-hole'
    }]
  };
  await page.reload();
  await waitTab(page, 'settings');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Renamed second Pi-hole', RAW_TEXT]);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 2);
  assert.ok(fixture.requests.slice(beforeReload).every(/** Verify that each unchanged target still uses its original instance-scoped SID after reload. */ request => request.sid === 'fixture-sid-' + request.id), 'Unchanged targets keep their original scoped sessions');
  assert.equal(await page.locator('[data-label="1"]').inputValue(), RAW_TEXT);
  assert.equal(await page.locator('[data-label="2"]').inputValue(), 'Renamed second Pi-hole');
  await page.locator('#resetLabels').click();
  await page.waitForFunction(/** Wait for reset to restore the first instance's renamed central label in Settings. */ () => document.querySelector('[data-label="1"]')?.value === 'Renamed first Pi-hole');
  assert.deepEqual(await page.evaluate(/** Decode the reset label document and confirm that no personal overrides remain. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), {
    overrides: {}
  });
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Renamed second Pi-hole', 'Renamed first Pi-hole']);
  assert.equal(fixture.requests.filter(/** Select non-GET requests to prove display-name changes never wrote Pi-hole configuration. */ request => request.method !== 'GET').length, 0, 'Personal labels never mutate Pi-hole configuration');
  await assertNoCorruption(fixture);
});
test('Settings accepts 120 Unicode characters and visibly rejects an overlong label without saving', /** Check the Unicode code-point label limit and verify that invalid input remains editable without replacing the saved value. */ async t => {
  const config = publicConfig();
  config.servers[0].label = '😀'.repeat(120);
  const fixture = await openDashboard(t, {
      language: 'de',
      runtimeConfig: config,
      labelOverrides: null,
      hash: 'settings'
    }),
    {
      page
    } = fixture;
  const label = page.locator('[data-label="1"]');
  assert.equal(await label.inputValue(), config.servers[0].label);
  const edited = '🦊'.repeat(120);
  await label.fill(edited);
  assert.equal(await label.inputValue(), edited, 'Editing must not truncate surrogate pairs to a 120-code-unit maxlength');
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for the newly saved emoji label to appear without surrogate-pair truncation. */ value => document.querySelector('#serverPills b')?.textContent === value, edited);
  const saved = {
    overrides: {
      [config.servers[0].base]: edited
    }
  };
  assert.deepEqual(await page.evaluate(/** Read the saved override document before testing rejection of an overlong label. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), saved);
  await label.fill('x'.repeat(121));
  await page.locator('#settingsForm button[type="submit"]').click();
  assert.equal(await label.evaluate(/** Read the input's browser validity flag after submitting an overlong name. */ input => input.validity.valid), false);
  assert.match(await label.evaluate(/** Read the visible browser validation message to check the documented 120-character limit. */ input => input.validationMessage), /120/u);
  assert.equal(await label.inputValue(), 'x'.repeat(121), 'Invalid text remains available for correction');
  assert.equal(await page.locator('#serverPills b').first().textContent(), edited);
  assert.deepEqual(await page.evaluate(/** Read saved overrides again to prove the rejected label did not overwrite them. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), saved, 'Validation failure must not replace the saved label');
  assert.equal(fixture.requests.filter(/** Select writes to ensure label validation caused no Pi-hole mutations. */ request => request.method !== 'GET').length, 0);
  await assertNoCorruption(fixture);
});
test('changing a target fingerprint never reuses the previous target session or personal label', /** Replace one route fingerprint and verify that its old SID and personal name cannot authenticate or label the replacement. */ async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, {
      runtimeConfig: config
    }),
    {
      page
    } = fixture;
  const changed = {
    ...config.servers[0],
    base: '/api1/' + 'a'.repeat(64),
    label: 'Replacement Pi-hole'
  };
  fixture.configuration.body = {
    ...config,
    servers: [changed, config.servers[1]]
  };
  const beforeReload = fixture.requests.length;
  await page.reload();
  await page.locator('[data-loginform="1"]').waitFor();
  await waitTab(page, 'dashboard');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), ['Replacement Pi-hole', RAW_TEXT + ' 2']);
  assert.equal(await page.locator('#serverPills .pill.on').count(), 1);
  assert.equal(fixture.requests.slice(beforeReload).filter(/** Find requests to the replacement before login; there should be none. */ request => request.id === '1').length, 0, 'The replacement stays logged out until explicitly authenticated');
  assert.ok(fixture.requests.slice(beforeReload).filter(/** Select the unchanged peer's requests after the configuration reload. */ request => request.id === '2').every(/** Check that the unchanged peer retains its own SID while the replacement remains logged out. */ request => request.sid === 'fixture-sid-2'));
  assert.equal(await page.evaluate(/** Read the replacement route's stored SID before any explicit authentication. */ key => sessionStorage.getItem(key), SESSION_PREFIX + changed.base), null);
  await page.locator('[data-loginpw="1"]').fill('replacement-fixture-password');
  await page.locator('[data-loginform="1"] button').click();
  await page.waitForFunction(/** Wait until the replacement's explicit login joins the still-connected peer. */ () => document.querySelectorAll('#serverPills .pill.on').length === 2);
  const auth = fixture.requests.slice(beforeReload).find(/** Locate the replacement's first POST so its exact login route and payload can be inspected. */ request => request.id === '1' && request.method === 'POST');
  assert.equal(auth?.base, changed.base);
  assert.equal(auth.path, '/auth');
  assert.equal(auth.sid, undefined, 'The old target SID must not be sent to the replacement');
  assert.deepEqual(auth.body, {
    password: 'replacement-fixture-password'
  });
  assert.equal(await page.evaluate(/** Read the replacement's newly stored SID after its own login succeeds. */ key => sessionStorage.getItem(key), SESSION_PREFIX + changed.base), 'fixture-login-1');
  await assertNoCorruption(fixture);
});
test('legacy labels migrate once by ID while legacy targets, count and sessions are ignored', /** Migrate legacy names once while refusing stored legacy routes, counts and sessions as configuration authority. */ async t => {
  const config = publicConfig();
  const legacy = {
    count: 4,
    servers: [{
      id: '1',
      label: RAW_TEXT,
      base: 'https://untrusted.invalid/api'
    }, {
      id: '2',
      label: ' '
    }, {
      id: '3',
      label: 'Hidden legacy third'
    }, {
      id: '4',
      label: 'Hidden legacy fourth'
    }]
  };
  const fixture = await openDashboard(t, {
      runtimeConfig: config,
      connected: false,
      labelOverrides: null,
      localStorageEntries: {
        ph_combo_cfg_v2: JSON.stringify(legacy)
      },
      sessionStorageEntries: Object.fromEntries([1, 2, 3, 4].map(/** Seed obsolete per-ID session keys so migration must remove them instead of reusing them. */ id => ['ph_sid_' + id, 'legacy-session-' + id]))
    }),
    {
      page
    } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), [RAW_TEXT, config.servers[1].label]);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(await page.evaluate(/** Read every obsolete session key in the browser after the migration attempt. */ () => [1, 2, 3, 4].map(/** Look up the legacy SID key for this instance ID. */ id => sessionStorage.getItem('ph_sid_' + id))), [null, null, null, null]);
  assert.equal(await page.evaluate(/** Check that the obsolete browser configuration document was removed. */ () => localStorage.getItem('ph_combo_cfg_v2')), null);
  assert.deepEqual(await page.evaluate(/** Decode migrated personal names to verify that only a valid configured route receives an override. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), {
    overrides: {
      [config.servers[0].base]: RAW_TEXT
    }
  });
  await visit(page, 'settings');
  await page.locator('#resetLabels').click();
  await page.evaluate(/** Reinsert the legacy document after reset to prove an existing override document prevents repeated migration. */ value => localStorage.setItem('ph_combo_cfg_v2', value), JSON.stringify(legacy));
  await page.reload();
  await waitTab(page, 'settings');
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(/** Derive the central default labels expected when the reinserted legacy document is ignored. */ server => server.label));
  assert.deepEqual(await page.evaluate(/** Read the empty override document after reload to confirm reset was not undone by remigration. */ key => JSON.parse(localStorage.getItem(key)), LABELS_KEY), {
    overrides: {}
  }, 'An existing empty override document prevents remigration');
  assert.deepEqual(fixture.requests, []);
  await assertNoCorruption(fixture);
});
test('invalid personal labels do not override valid configured labels', /** Reject blank and overlong stored overrides while keeping the valid central labels visible. */ async t => {
  const config = publicConfig();
  const fixture = await openDashboard(t, {
      runtimeConfig: config,
      labelOverrides: {
        overrides: {
          [config.servers[0].base]: ' ',
          [config.servers[1].base]: 'x'.repeat(121)
        }
      }
    }),
    {
      page
    } = fixture;
  assert.deepEqual(await page.locator('#serverPills b').allTextContents(), config.servers.map(/** Build the expected fallback names from the authoritative configuration. */ server => server.label));
  await assertNoCorruption(fixture);
});
for (const code of ['da', 'en', 'de']) for (const count of [2, 3, 4]) {
  test(`${code}: every tab, localized charts and intact data with ${count} Pi-holes`, /** Exercise all tabs for every language and instance count, checking localized presentation without changing fixture data. */ async t => {
    const fixture = await openDashboard(t, {
        language: code,
        count
      }),
      {
        page
      } = fixture,
      expected = EXPECTED[code];
    assert.deepEqual(await page.locator('#tabs button').allTextContents(), expected.tabs);
    assert.equal(await page.locator('#languageSelect').getAttribute('aria-label'), expected.language);
    assert.equal(await page.locator('#serverPills .pill').count(), count);
    assert.equal(await page.locator('#serverPills b').first().textContent(), RAW_TEXT + ' 1');
    assert.equal(await page.locator('#dashGrid .big-num').first().textContent(), 12345 .toLocaleString(expected.locale));
    assert.equal(await page.locator('#dashGrid .big-num').last().textContent(), (12345 * count).toLocaleString(expected.locale));
    const chartData = await page.evaluate(/** Read chart locales, axis labels and dataset names from browser-owned chart objects. */ () => Object.values(Chart.instances).map(/** Extract just the chart metadata needed for locale and label assertions. */ chart => ({
      locale: chart.options.locale,
      labels: chart.data.labels,
      series: chart.data.datasets.map(/** Read each dataset's displayed series name in its existing chart order. */ dataset => dataset.label)
    })));
    assert.equal(chartData.length, count * 4);
    assert.ok(chartData.every(/** Check that every chart uses the formatting locale for the selected interface language. */ chart => chart.locale === expected.locale));
    assert.equal(chartData[0].series[0], expected.blocked);
    assert.equal(chartData[0].labels[0], new Date(TIMESTAMP * 1000).toLocaleTimeString(expected.locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }));
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
        assert.equal(await row.locator('td').first().textContent(), new Date(TIMESTAMP * 1000).toLocaleString(expected.locale, {
          timeZone: 'UTC'
        }));
      }
      if (tab === 'domains' || tab === 'clients' || tab === 'lists') assert.ok((await page.locator('#tabContent').textContent()).includes(RAW_TEXT));
      if (tab === 'gravity') assert.equal(await page.locator('#gravLog1').textContent(), expected.ready);
      if (tab === 'settings') assert.equal(await page.locator('[data-label="1"]').inputValue(), RAW_TEXT + ' 1');
      await assertNoCorruption(fixture);
    }
  });
}
for (const scenario of [{
  language: 'de',
  browserLanguages: ['da-DK'],
  runtimeConfig: publicConfig(2, 'en'),
  expected: 'de'
}, {
  language: null,
  browserLanguages: ['de-AT', 'en-US'],
  expected: 'de'
}, {
  language: 'unsupported',
  browserLanguages: ['fr-FR', 'da-DK'],
  expected: 'da'
}, {
  language: 'EN_gb',
  browserLanguages: ['de-DE'],
  expected: 'en'
}, {
  language: null,
  browserLanguages: ['fr-FR', 'nl-NL'],
  expected: 'en'
}, {
  language: null,
  browserLanguages: ['de-AT'],
  runtimeConfig: publicConfig(2, 'da'),
  expected: 'da'
}, {
  language: 'unsupported',
  browserLanguages: ['de-DE'],
  runtimeConfig: publicConfig(2, 'en'),
  expected: 'en'
}]) test(`language preference ${JSON.stringify(scenario)} resolves correctly`, /** Check each saved, configured and browser-language combination against its expected resolution order. */ async t => {
  const fixture = await openDashboard(t, scenario);
  assert.equal(await fixture.page.locator('html').getAttribute('lang'), scenario.expected);
  assert.equal(await fixture.page.locator('#languageSelect').inputValue(), scenario.expected);
  await assertNoCorruption(fixture);
});
test('da → en → de → da preserves every unfinished form and query filter', /** Switch repeatedly through all languages while retaining drafts, target choices, query filters and expanded Settings help. */ async t => {
  const fixture = await openDashboard(t),
    {
      page
    } = fixture;
  const scenarios = [{
    tab: 'domains',
    fields: {
      '#dDomain': '^Tillad\\.example$',
      '#dComment': RAW_TEXT
    },
    selects: {
      '#dType': 'allow',
      '#dKind': 'regex',
      '#targetDomain': '2'
    }
  }, {
    tab: 'hosts',
    fields: {
      '#hIp': '192.168.1.88',
      '#hName': 'Tillad.example'
    },
    selects: {
      '#targetHost': '2'
    }
  }, {
    tab: 'clients',
    fields: {
      '#cClient': '192.168.1.88',
      '#cComment': RAW_TEXT,
      '.sugg-name': RAW_TEXT + ' suggestion'
    },
    selects: {
      '#targetClient': '2',
      '#targetSugg0': '2'
    }
  }, {
    tab: 'lists',
    fields: {
      '#lUrl': LIST_URL,
      '#lComment': RAW_TEXT
    },
    selects: {
      '#lType': 'allow',
      '#targetList': '2'
    }
  }, {
    tab: 'settings',
    fields: {
      '[data-label="1"]': RAW_TEXT + ' pending'
    },
    selects: {}
  }, {
    tab: 'queries',
    fields: {
      '#qFilter': DOMAIN
    },
    selects: {
      '#qRange': '24',
      '#qTypeFilter': 'AAAA',
      '#qPageSize': '100'
    }
  }];
  for (const scenario of scenarios) {
    await visit(page, scenario.tab);
    if (scenario.tab === 'settings') await page.locator('details.help summary').click();
    for (const [selector, value] of Object.entries(scenario.fields)) await page.locator(selector).fill(value);
    for (const [selector, value] of Object.entries(scenario.selects)) await page.locator(selector).selectOption(value);
    for (const code of ['en', 'de', 'da']) {
      await language(page, code, scenario.tab);
      for (const [selector, value] of Object.entries({
        ...scenario.fields,
        ...scenario.selects
      })) {
        assert.equal(await page.locator(selector).inputValue(), value, `${scenario.tab}: ${selector} must survive switching to ${code}`);
      }
      if (scenario.tab === 'settings') assert.equal(await page.locator('details.help').getAttribute('open'), '');
      assert.equal(await page.evaluate(/** Read the persisted language choice after each user-driven switch. */ () => localStorage.getItem('ph_combo_language')), code);
      await assertNoCorruption(fixture);
    }
  }
  assert.equal(fixture.requests.filter(/** Select mutation requests to prove that translating unfinished forms never submits them. */ request => request.method !== 'GET').length, 0, 'Changing language must not submit unfinished forms');
});
for (const code of ['da', 'en', 'de']) test(`${code}: CRUD payloads, confirmation dialogs and toast data remain correct`, /** Submit and delete representative domains, hosts, clients and lists in each language while inspecting unchanged API payloads. */ async t => {
  const fixture = await openDashboard(t, {
      language: code
    }),
    {
      page,
      requests
    } = fixture;
  await visit(page, 'domains');
  await page.locator('#dDomain').fill('^Tillad\\.example$');
  await page.locator('#dComment').fill(RAW_TEXT);
  await page.locator('#dType').selectOption('allow');
  await page.locator('#dKind').selectOption('regex');
  await page.locator('#targetDomain').selectOption('1');
  await page.locator('#domainForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for successful domain submission to clear its primary input before inspecting the request. */ () => document.querySelector('#dDomain').value === '');
  const created = requests.find(/** Find the domain-add POST for the selected allow/regex operation. */ request => request.method === 'POST' && request.path === '/domains/allow/regex');
  assert.deepEqual(created?.body, {
    domain: ['^Tillad\\.example$'],
    comment: RAW_TEXT,
    type: 'allow',
    kind: 'regex',
    groups: [0]
  });
  assert.equal(created.sid, 'fixture-sid-1');
  assert.ok((await page.locator('#toastArea').textContent()).includes(RAW_TEXT + ' 1'));
  assert.ok((await page.locator('#toastArea').textContent()).includes(EXPECTED[code].domainAdded));
  await page.locator('#domArea tbody').waitFor();
  const row = page.locator('#domArea tbody tr').filter({
    hasText: DOMAIN
  });
  const dialogPromise = page.waitForEvent('dialog');
  const clicking = row.locator('[data-del-domain-row]').click();
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'confirm');
  assert.match(dialog.message(), EXPECTED[code].delete);
  assert.ok(dialog.message().includes(DOMAIN));
  assert.ok(dialog.message().includes(RAW_TEXT + ' 1'));
  assert.ok(dialog.message().includes('{server}'), 'Interpolated data must not be interpolated a second time');
  await dialog.accept();
  await clicking;
  await page.waitForFunction(/** Wait until the deleted domain is absent from the rendered comparison table. */ domain => ![...document.querySelectorAll('#domArea td.mono')].some(/** Recognize a remaining cell containing the deleted domain's exact text. */ td => td.textContent === domain), DOMAIN);
  assert.equal(requests.filter(/** Count DELETEs for the exact encoded domain to verify both selected targets were addressed. */ request => request.method === 'DELETE' && request.path === '/domains/deny/exact/' + encodeURIComponent(DOMAIN)).length, 2);
  await visit(page, 'hosts');
  await page.locator('#hIp').fill('192.168.1.99');
  await page.locator('#hName').fill('Tillad.example');
  await page.locator('#targetHost').selectOption('1');
  await page.locator('#hostForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for the successful local-DNS submission to clear its IP input. */ () => document.querySelector('#hIp').value === '');
  assert.ok(requests.some(/** Recognize the host PUT whose data belongs entirely in the encoded path, with no JSON body. */ request => request.method === 'PUT' && request.path === '/config/dns/hosts/' + encodeURIComponent('192.168.1.99 Tillad.example') && request.body === undefined));
  await visit(page, 'clients');
  await page.locator('#cClient').fill('192.168.1.99');
  await page.locator('#cComment').fill(RAW_TEXT);
  await page.locator('#targetClient').selectOption('1');
  await page.locator('#clientForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for client creation to clear the submitted address field. */ () => document.querySelector('#cClient').value === '');
  assert.deepEqual(requests.find(/** Locate the client-create request before comparing its comment and group payload. */ request => request.method === 'POST' && request.path === '/clients')?.body, {
    client: ['192.168.1.99'],
    comment: RAW_TEXT,
    groups: [0]
  });
  await visit(page, 'lists');
  await page.locator('#lUrl').fill('https://lists.example/Tillad-new.txt');
  await page.locator('#lComment').fill(RAW_TEXT);
  await page.locator('#lType').selectOption('allow');
  await page.locator('#targetList').selectOption('1');
  await page.locator('#listForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for the submitted list URL to clear after its successful write. */ () => document.querySelector('#lUrl').value === '');
  assert.deepEqual(requests.find(/** Find the allowlist POST, including its query parameter, before checking the payload. */ request => request.method === 'POST' && request.path === '/lists?type=allow')?.body, {
    address: ['https://lists.example/Tillad-new.txt'],
    comment: RAW_TEXT,
    groups: [0]
  });
  await assertNoCorruption(fixture);
});
test('restricted browser storage keeps login and language switching usable', /** Reject browser storage, hold the login response and verify that language changes preserve the password and real login timing. */ async t => {
  let releaseAuth;
  const authResponseGate = new Promise(/** Expose the login-response resolver so the test controls when authentication finishes. */ resolve => {
    releaseAuth = resolve;
  });
  t.after(/** Release a held login response during teardown to avoid leaving the fixture blocked. */ () => releaseAuth());
  const fixture = await openDashboard(t, {
      language: null,
      browserLanguages: ['de-CH'],
      connected: false,
      storageUnavailable: true,
      authResponseGate
    }),
    {
      page
    } = fixture;
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  await page.locator('[data-loginpw="1"]').fill('fixture-password-Only');
  await page.locator('#languageSelect').selectOption('en');
  await page.waitForFunction(/** Wait until the login password survives the first language change without relying on persistent storage. */ () => document.querySelector('[data-loginpw="1"]')?.value === 'fixture-password-Only');
  const authRequested = page.waitForRequest(/** Match the exact login POST before holding its response across another language change. */ request => request.method() === 'POST' && new URL(request.url()).pathname === fixture.configuration.body.servers[0].base + '/auth');
  await page.locator('[data-loginform="1"] button').click();
  const authRequest = await authRequested;
  // The combined total card exists before login completes. Switching language
  // while the auth response is held must not be mistaken for a completed login.
  await language(page, 'de', 'dashboard');
  assert.equal(await page.locator('#serverPills .pill.on').count(), 0);
  releaseAuth();
  await page.locator('#serverPills .pill.on').waitFor();
  assert.deepEqual(authRequest.postDataJSON(), {
    password: 'fixture-password-Only'
  });
  await language(page, 'en', 'dashboard');
  assert.equal(await page.locator('#serverPills .pill.on').count(), 1);
  await assertNoCorruption(fixture);
});
test('active Gravity output survives language changes and tab navigation without restarting the update', /** Stream raw Gravity output through tab and language changes and prove the update runs only once. */ async t => {
  const fixture = await openDashboard(t, {
      streamingGravity: true
    }),
    {
      page
    } = fixture;
  await visit(page, 'gravity');
  await page.locator('#gravBtn1').click();
  await page.waitForFunction(/** Wait for the controlled Gravity response stream to be opened by the application. */ () => !!window.__gravityStream);
  const rawLog = '\u001b[32m' + RAW_TEXT + '\u001b[0m\nGrüße vom Server\n';
  await page.evaluate(/** Send the supplied synthetic log text as UTF-8 bytes into the pending Gravity stream. */ text => window.__gravityStream.enqueue(new TextEncoder().encode(text)), rawLog);
  await page.waitForFunction(/** Wait until the raw fixture text is visible in the Gravity log before switching languages. */ text => document.querySelector('#gravLog1').textContent.includes(text), RAW_TEXT);
  for (const code of ['en', 'de', 'da']) {
    await language(page, code, 'gravity');
    assert.equal(await page.locator('#gravBtn1').isDisabled(), true);
    assert.ok((await page.locator('#gravLog1').textContent()).includes(RAW_TEXT));
  }
  await visit(page, 'settings');
  await page.evaluate(/** Append another raw log chunk while the Gravity tab is not visible. */ () => window.__gravityStream.enqueue(new TextEncoder().encode('Tillad Domæner — still raw\n')));
  await visit(page, 'gravity');
  assert.ok((await page.locator('#gravLog1').textContent()).includes('Tillad Domæner — still raw'));
  await page.evaluate(/** Finish the controlled Gravity response so the application can display its completion state. */ () => window.__gravityStream.close());
  await page.waitForFunction(/** Wait for the Gravity button to become usable again after the stream closes. */ () => !document.querySelector('#gravBtn1').disabled);
  for (const code of ['de', 'en', 'da']) {
    await language(page, code, 'gravity');
    assert.ok((await page.locator('#gravLog1').textContent()).includes('--- ' + EXPECTED[code].done + ' ---'));
    assert.ok((await page.locator('#gravLog1').textContent()).includes(RAW_TEXT));
  }
  assert.equal(await page.evaluate(/** Read the total Gravity request count to detect a restart caused by navigation or translation. */ () => window.__gravityRequests.length), 1);
  await assertNoCorruption(fixture);
});
test('missing optional Chart.js displays a localized diagnostic and leaves the dashboard usable', /** Remove the local chart asset and verify that localized diagnostics accompany still-usable dashboard totals. */ async t => {
  const fixture = await openDashboard(t, {
      language: 'de',
      missingCharts: true
    }),
    {
      page
    } = fixture;
  assert.ok((await page.locator('#dashChartArea').textContent()).includes('Diagrammbibliothek'));
  assert.ok((await page.locator('#dashChartArea').textContent()).includes('chart.umd.min.js'));
  assert.equal(await page.locator('#dashGrid .big-num').count(), 3);
  await assertNoCorruption(fixture);
});
test('rapid language changes retain the latest typing and follow reordered client suggestions', /** Overlap language changes with a reordered client-suggestion response and retain edits by device identity. */ async t => {
  const fixture = await openDashboard(t),
    {
      page
    } = fixture;
  await visit(page, 'clients');
  const suggestion = '[data-suggestion-name="AA:BB:CC:DD:EE:01"]';
  const target = '[data-form-state-key="suggestion-target:AA:BB:CC:DD:EE:01"]';
  await page.locator('#cClient').fill('192.168.1.99');
  await page.locator('#cComment').fill('original draft');
  await page.locator(suggestion).fill(RAW_TEXT + ' original device');
  await page.locator(target).selectOption('2');
  // A newly discovered device sorts before the edited suggestion on reload.
  fixture.serverData['1'].suggestions.unshift({
    hwaddr: '00:00:00:00:00:01',
    names: 'New earlier device'
  });
  const gate = fixture.pauseReads('/clients/_suggestions');
  for (const code of ['en', 'de', 'da']) {
    await page.locator('#languageSelect').selectOption(code);
    await page.waitForFunction(/** Wait for the entered client address to be restored before typing a newer comment. */ () => document.querySelector('#cClient')?.value === '192.168.1.99');
    await page.locator('#cComment').fill('typed during ' + code);
  }
  assert.ok(gate.arrived > 0, 'The language changes must overlap pending API requests');
  gate.release();
  await page.locator('[data-suggestion-name="00:00:00:00:00:01"]').waitFor();
  await page.evaluate(/** Yield a browser frame after the delayed suggestions arrive before checking preserved field values. */ () => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#cComment').inputValue(), 'typed during da', 'A late render must not overwrite newer typing');
  assert.equal(await page.locator(suggestion).inputValue(), RAW_TEXT + ' original device');
  assert.equal(await page.locator(target).inputValue(), '2', 'Target server must follow device identity instead of its old row position');
  assert.equal(await page.locator('[data-suggestion-name="00:00:00:00:00:01"]').inputValue(), '');
  assert.equal(await page.locator('[data-form-state-key="suggestion-target:00:00:00:00:00:01"]').inputValue(), 'all');
  assert.equal(await page.locator('html').getAttribute('lang'), 'da');
  await assertNoCorruption(fixture);
});
test('query filters edited during slow client-name loading survive the language render', /** Edit query filters during delayed client-name loading and confirm the later language render retains the newer choices. */ async t => {
  const fixture = await openDashboard(t),
    {
      page
    } = fixture;
  await visit(page, 'queries');
  await page.locator('#qFilter').fill(DOMAIN);
  await page.locator('#qRange').selectOption('24');
  await waitTab(page, 'queries');
  const gate = fixture.pauseReads('/clients');
  await page.locator('#languageSelect').selectOption('en');
  await page.waitForFunction(/** Wait for the original query filter to be restored before entering its replacement. */ domain => document.querySelector('#qFilter')?.value === domain, DOMAIN);
  await page.locator('#qFilter').fill('new filter typed during loading');
  await page.locator('#qRange').selectOption('72');
  gate.release();
  await waitTab(page, 'queries');
  assert.equal(await page.locator('#qFilter').inputValue(), 'new filter typed during loading');
  assert.equal(await page.locator('#qRange').inputValue(), '72');
  assert.ok((await page.locator('#qArea').textContent()).includes('No queries found'));
  await assertNoCorruption(fixture);
});
test('new client and type selections made while query cursor pages load override the old language snapshot', /** Hold a cursor page while selecting different client and type filters, then reject restoration of the older snapshot. */ async t => {
  const fixture = await openDashboard(t, {
      hash: 'queries',
      paginatedQueries: true,
      savedQueryFilters: {
        client: 'ip:192.168.1.20',
        type: 'A'
      }
    }),
    {
      page
    } = fixture;
  await page.waitForFunction(/** Wait for the saved client and record-type choices to be restored on the initial query view. */ () => document.querySelector('#qClientFilter')?.value === 'ip:192.168.1.20' && document.querySelector('#qTypeFilter')?.value === 'A');
  const gate = fixture.pauseReads('/queries:cursor');
  await page.locator('#languageSelect').selectOption('en');
  await page.locator('#qClientFilter option[value="ip:192.168.1.10"]').waitFor({
    state: 'attached'
  });
  await page.locator('#qTypeFilter option[value="AAAA"]').waitFor({
    state: 'attached'
  });
  await page.locator('#qClientFilter').selectOption('ip:192.168.1.10');
  await page.locator('#qTypeFilter').selectOption('AAAA');
  assert.ok(gate.arrived > 0, 'A cursor page must remain pending while the user makes new selections');
  gate.release();
  await page.waitForFunction(/** Wait for all expected cursor-page records before checking the user's newer filter choices. */ () => document.querySelector('#qStatus')?.textContent.includes('4 queries in total'));
  await page.evaluate(/** Yield a rendering frame after cursor completion so deferred restoration has run. */ () => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#qClientFilter').inputValue(), 'ip:192.168.1.10');
  assert.equal(await page.locator('#qTypeFilter').inputValue(), 'AAAA');
  assert.deepEqual(await page.evaluate(/** Read the application's stored query-filter state as well as the visible select controls. */ () => ({
    client: uiState.queries.client,
    type: uiState.queries.type
  })), {
    client: 'ip:192.168.1.10',
    type: 'AAAA'
  });
  assert.equal(await page.locator('#qArea tbody tr').count(), 2);
  await assertNoCorruption(fixture);
});

// A completed submission clears its inputs programmatically. Those clears emit
// no input/change events, so late language renders must respect the existing DOM
// controls instead of replaying the pre-submit draft. Keep API reads pending to
// exercise the deferred restoration pass after a successful POST/PUT.
const SUBMISSION_DURING_LANGUAGE_RENDER = [{
  tab: 'domains',
  form: '#domainForm',
  endpoint: '/domains',
  target: '#targetDomain',
  fields: {
    '#dDomain': 'submitted-domain.example',
    '#dComment': RAW_TEXT
  },
  method: 'POST',
  mutation: '/domains/deny/exact'
}, {
  tab: 'hosts',
  form: '#hostForm',
  endpoint: '/config/dns/hosts',
  target: '#targetHost',
  fields: {
    '#hIp': '192.168.1.89',
    '#hName': 'submitted-host.example'
  },
  method: 'PUT',
  mutation: '/config/dns/hosts/' + encodeURIComponent('192.168.1.89 submitted-host.example')
}, {
  tab: 'clients',
  form: '#clientForm',
  endpoint: '/clients',
  target: '#targetClient',
  fields: {
    '#cClient': '192.168.1.89',
    '#cComment': RAW_TEXT
  },
  method: 'POST',
  mutation: '/clients'
}, {
  tab: 'lists',
  form: '#listForm',
  endpoint: '/lists',
  target: '#targetList',
  fields: {
    '#lUrl': 'https://lists.example/submitted-list.txt',
    '#lComment': RAW_TEXT
  },
  method: 'POST',
  mutation: '/lists?type=block'
}];
for (const scenario of SUBMISSION_DURING_LANGUAGE_RENDER) for (const overlap of [false, true]) {
  test(`${scenario.tab}: a successful submission stays cleared after ${overlap ? 'overlapping language renders' : 'a pending language render'}`,
  /**
  * Submit each add form during a delayed or overlapping language render and prove successful values stay cleared without another write.
  */
  async t => {
    const fixture = await openDashboard(t, {
        hash: scenario.tab
      }),
      {
        page
      } = fixture;
    for (const [selector, value] of Object.entries(scenario.fields)) await page.locator(selector).fill(value);
    await page.locator(scenario.target).selectOption('1');
    // Hold both pending language-render reads and the mutation's mandatory
    // preflight. No write is permitted until the preflight is released.
    const gate = fixture.pauseReads(scenario.endpoint);
    await page.locator('#languageSelect').selectOption('en');
    for (const [selector, value] of Object.entries(scenario.fields)) {
      assert.equal(await page.locator(selector).inputValue(), value, 'The synchronous language render must restore the draft before submission');
    }
    const preflightRequest = page.waitForRequest(
      /** Recognize the form submission's fresh GET, separately from the earlier language-render read. */
      request => request.method() === 'GET' &&
        new URL(request.url()).pathname.endsWith(scenario.endpoint)
    );
    await page.locator(`${scenario.form} button[type="submit"]`).click();
    await preflightRequest;
    assert.ok(gate.arrived > 0, 'A pending language-render GET must not be mistaken for a verified empty collection');
    assert.equal(fixture.requests.filter(
      /** Confirm that no mutation bypassed the held safety preflight. */
      request => request.method === scenario.method && request.path === scenario.mutation).length, 0,
      'A mutation must wait until its fresh preflight can read the current state');
    if (overlap) {
      // A second language render may replace the form while the preflight is held;
      // both renders must preserve the pending draft without starting a write.
      await page.locator('#languageSelect').selectOption('de');
      for (const [selector, value] of Object.entries(scenario.fields))
        assert.equal(await page.locator(selector).inputValue(), value);
    }
    gate.release();
    await page.waitForFunction(/** After the preflight resumes, require all successfully submitted fields to clear. */
      selectors => selectors.every(/** Inspect the current form rather than a detached earlier DOM node. */
        selector => document.querySelector(selector)?.value === ''), Object.keys(scenario.fields));
    await waitTab(page, scenario.tab);
    await page.waitForLoadState('networkidle');
    for (const selector of Object.keys(scenario.fields)) {
      assert.equal(await page.locator(selector).inputValue(), '', 'Deferred language restoration must not repopulate successfully submitted values');
    }
    assert.equal(fixture.requests.filter(/** Count the same mutation after rendering settles to detect any duplicate submission. */ request => request.method === scenario.method && request.path === scenario.mutation).length, 1, 'Language rendering must not repeat the write');
    await assertNoCorruption(fixture);
  });
}


test('Issue #8: failed domain reads remain unknown and cannot offer an add action', /** A failed GET must not become an empty collection or permit a write based on absence. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const { page } = fixture;
  await page.route('**/*', /** Fail the second instance's domain GET while preserving every other fixture route. */ async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname.includes('/api2/') && url.pathname.endsWith('/domains')) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'upstream unavailable' } }) });
    }
    return route.fallback();
  });
  await visit(page, 'domains');
  await page.waitForFunction(/** Wait until the affected instance explicitly displays its unreadable state. */ () => document.querySelector('#domArea')?.textContent.includes('Unknown'));
  assert.equal(await page.locator('[data-add-domain-server="2"]').count(), 0);
  assert.ok((await page.locator('#domArea').textContent()).includes('Data unavailable'));
  await assertNoCorruption(fixture);
});

test('Issue #8: all rejected domain deletes never report a successful deletion', /** Prove HTTP 403 on every target does not produce a success toast or remove the row. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const { page, serverData } = fixture;
  await visit(page, 'domains');
  await page.route('**/*', /** Reject only destructive domain requests, leaving fresh reads available. */ async route => {
    if (route.request().method() === 'DELETE' && new URL(route.request().url()).pathname.includes('/domains/')) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'permission denied' } }) });
    }
    return route.fallback();
  });
  page.once('dialog', /** Confirm the deliberately rejected deletion request. */ dialog => dialog.accept());
  await page.locator('[data-del-domain-row]').first().click();
  await page.waitForFunction(/** Require explicit failed outcomes for both instances before checking state. */ () => (document.querySelector('#toastArea')?.textContent.match(/change or preflight failed/g) || []).length >= 2);
  assert.equal(serverData['1'].domains.length, 1);
  assert.equal(serverData['2'].domains.length, 1);
  assert.ok(!(await page.locator('#toastArea').textContent()).includes('change confirmed'));
  await assertNoCorruption(fixture);
});

test('Issue #8: partial domain deletion identifies the confirmed and failed target', /** A successful first delete and a rejected second delete must retain distinct outcomes. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const { page, serverData } = fixture;
  await visit(page, 'domains');
  await page.route('**/*', /** Reject DELETE only at instance two and pass instance one through to its fixture. */ async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'DELETE' && url.pathname.includes('/api2/') && url.pathname.includes('/domains/')) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'denied' } }) });
    }
    return route.fallback();
  });
  page.once('dialog', /** Accept the two-target operation. */ dialog => dialog.accept());
  await page.locator('[data-del-domain-row]').first().click();
  await page.waitForFunction(/** Require both the confirmed and failed outcome messages. */ () => {
    const output = document.querySelector('#toastArea')?.textContent || '';
    return output.includes('change confirmed') && output.includes('change or preflight failed');
  });
  assert.equal(serverData['1'].domains.length, 0);
  assert.equal(serverData['2'].domains.length, 1);
  await assertNoCorruption(fixture);
});

test('Issue #8: a lost successful write is unknown and a manual retry rechecks it', /** Simulate a server committing a domain before its reply is lost; no second POST is allowed. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const { page, serverData } = fixture;
  let posts = 0;
  await visit(page, 'domains');
  await page.route('**/*', /** Commit the first POST into the fixture state but make its response disappear. */ async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.includes('/domains/allow/exact')) {
      posts++;
      serverData['1'].domains.push({ domain: 'lostreply.example', type: 'allow', kind: 'exact', enabled: true, comment: 'pending', groups: [0] });
      return route.abort('failed');
    }
    return route.fallback();
  });
  await page.locator('#dDomain').fill('lostreply.example');
  await page.locator('#dComment').fill('pending');
  await page.locator('#dType').selectOption('allow');
  await page.locator('#targetDomain').selectOption('1');
  await page.locator('#domainForm button[type="submit"]').click();
  await page.waitForFunction(/** Wait for an uncertain outcome rather than a false success. */ () => (document.querySelector('#toastArea')?.textContent || '').includes('write outcome unknown'));
  assert.equal(await page.locator('#dDomain').inputValue(), 'lostreply.example');
  assert.equal(posts, 1);
  await page.locator('#domainForm button[type="submit"]').click();
  await page.waitForFunction(/** Fresh preflight should prove the desired state is present and clear the original draft. */ () => document.querySelector('#dDomain')?.value === '');
  assert.equal(posts, 1, 'A manual retry must not write again when fresh data shows the desired state');
  await assertNoCorruption(fixture);
});

for (const scenario of [
  { tab: 'hosts', method: 'PUT', endpoint: '/config/dns/hosts/', fields: [['#hIp','192.168.1.96'], ['#hName','pending.example']], submit: '#hostForm button[type="submit"]', target: '#targetHost' },
  { tab: 'clients', method: 'POST', endpoint: '/clients', fields: [['#cClient','192.168.1.96'], ['#cComment','pending']], submit: '#clientForm button[type="submit"]', target: '#targetClient' },
  { tab: 'lists', method: 'POST', endpoint: '/lists', fields: [['#lUrl','https://pending.example/hosts'], ['#lComment','pending']], submit: '#listForm button[type="submit"]', target: '#targetList' }
]) test('Issue #8: rejected ' + scenario.tab + ' writes preserve form input', /** Verify each management screen retains its draft and reports explicit failure. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const { page } = fixture;
  await visit(page, scenario.tab);
  await page.route('**/*', /** Reject the requested mutation but allow its safety preflight GET. */ async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === scenario.method && url.pathname.includes(scenario.endpoint)) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'permission denied' } }) });
    }
    return route.fallback();
  });
  for (const [selector, value] of scenario.fields) await page.locator(selector).fill(value);
  await page.locator(scenario.target).selectOption('1');
  await page.locator(scenario.submit).click();
  await page.waitForFunction(/** Wait for a verified rejection rather than relying on the button's initial enabled state. */ () => (document.querySelector('#toastArea')?.textContent || '').includes('change or preflight failed'));
  for (const [selector, value] of scenario.fields) assert.equal(await page.locator(selector).inputValue(), value);
  await assertNoCorruption(fixture);
});


for (const scenario of [
  { tab: 'hosts', endpoint: '/config/dns/hosts', area: '#hostArea', add: '[data-add-host="2"]' },
  { tab: 'clients', endpoint: '/clients', area: '#clientArea', add: '[data-add-client-server="2"]' },
  { tab: 'lists', endpoint: '/lists', area: '#listArea', add: '[data-add-list="2"]' },
  { tab: 'clients', endpoint: '/clients/_suggestions', area: '#suggArea', add: '[data-add-sugg]' }
]) test(`Issue #8: failed ${scenario.endpoint} read stays unknown instead of missing`,
  /** Check one failed instance read without suppressing confirmed records from a healthy peer. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page } = fixture;
    await page.route('**/*',
      /** Return a server error from only the selected instance and read path. */
      async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && url.pathname.includes('/api2/') &&
            url.pathname.endsWith(scenario.endpoint)) {
          return route.fulfill({
            status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'read failed' } })
          });
        }
        return route.fallback();
      });
    await visit(page, scenario.tab);
    await page.waitForFunction(/** Wait for the incomplete-data banner in the affected management view. */
      area => (document.querySelector(area)?.textContent || '').includes('Data unavailable'), scenario.area);
    const view = await page.locator(scenario.area).textContent();
    assert.ok(view.includes('Unknown') || view.includes('unknown') ||
      view.includes('Data unavailable'), 'An unavailable instance must not be reported as missing');
    if (scenario.endpoint !== '/clients/_suggestions') {
      assert.equal(await page.locator(scenario.add).count(), 0,
        'A failed instance read must not enable an inferred add action');
    }
    await assertNoCorruption(fixture);
  });

test('Issue #8: a language rerender cannot start a second write while the first is pending',
  /** Hold a successful POST, replace the form through translation, and attempt a duplicate submission. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page, requests } = fixture;
    await visit(page, 'domains');
    const writeBlocked = deferred(t);
    const writeSeen = deferred(t);
    let seen = false;
    await page.route('**/*',
      /** Pause the first domain mutation after its preflight, leaving the page interactive. */
      async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'POST' && url.pathname.endsWith('/domains/deny/exact')) {
          if (!seen) { seen = true; writeSeen.release(); }
          await writeBlocked.promise;
        }
        return route.fallback();
      });
    await page.locator('#dDomain').fill('locked.example');
    await page.locator('#targetDomain').selectOption('1');
    await page.locator('#domainForm button[type="submit"]').click();
    await writeSeen.promise;
    await page.locator('#languageSelect').selectOption('de');
    assert.equal(await page.locator('#dDomain').inputValue(), 'locked.example');
    await page.locator('#domainForm button[type="submit"]').click();
    await page.waitForFunction(/** Confirm that the second click was blocked while the original request is pending. */
      () => (document.querySelector('#toastArea')?.textContent || '').includes('läuft noch'));
    writeBlocked.release();
    await page.waitForFunction(/** Await the result from the original request, now translated into German. */
      () => (document.querySelector('#toastArea')?.textContent || '').includes('Änderung bestätigt'));
    assert.equal(await page.locator('#dDomain').inputValue(), '',
      'The successfully submitted unchanged draft must clear even after a language rerender');
    assert.equal(requests.filter(/** Count actual writes instead of button clicks. */
      request => request.method === 'POST' && request.path === '/domains/deny/exact').length, 1);
    await assertNoCorruption(fixture);
  });


test('Issue #8 Codex: copied list preserves its original comment and group IDs',
  /** Copy one list across instances and verify its exact source metadata is sent. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page, serverData, requests } = fixture;
    serverData['1'].lists[0].comment = 'group-preserving source';
    serverData['1'].lists[0].groups = [3, 7];
    serverData['2'].lists = [];
    await visit(page, 'lists');
    await page.locator('[data-add-list="2"]').click();
    await page.waitForFunction(/** Require a verified remote copy, not merely the first click. */
      () => (document.querySelector('#toastArea')?.textContent || '').includes('change confirmed'));
    const copied = requests.find(/** Locate only the intended copy to Pi-hole two. */
      request => request.id === '2' && request.method === 'POST' && request.path === '/lists?type=block');
    assert.deepEqual(copied?.body, {
      address: [LIST_URL],
      comment: 'group-preserving source',
      groups: [3, 7]
    });
    assert.deepEqual(serverData['2'].lists[0].groups, [3, 7]);
    await assertNoCorruption(fixture);
  });

test('Issue #8 Codex: an unavailable connected client stays unknown, not disconnected',
  /** Reject the second server's configured-client read and inspect the exact table cell. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page } = fixture;
    await page.route('**/*',
      /** Simulate a live but temporarily unreadable client collection. */
      async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' &&
            url.pathname.includes('/api2/') && url.pathname.endsWith('/clients')) {
          return route.fulfill({
            status: 503, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'backend unavailable' } })
          });
        }
        return route.fallback();
      });
    await visit(page, 'clients');
    await page.waitForFunction(/** Wait for both known and unreadable data states to appear. */
      () => (document.querySelector('#clientArea')?.textContent || '').includes('Data unavailable'));
    const unavailableCell = page.locator('#clientArea tbody tr').first().locator('td').nth(3);
    assert.equal((await unavailableCell.textContent()).trim(), 'Unknown');
    assert.equal(await unavailableCell.locator('button').count(), 0);
    await assertNoCorruption(fixture);
  });

test('Issue #8 Codex: a source list missing its groups cannot be copied as group zero',
  /** Avoid silent list metadata corruption when source group membership is absent. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page, serverData, requests } = fixture;
    delete serverData['1'].lists[0].groups;
    serverData['2'].lists = [];
    await visit(page, 'lists');
    await page.locator('[data-add-list="2"]').click();
    await page.waitForFunction(/** Require the source validation error without a copy mutation. */
      () => (document.querySelector('#toastArea')?.textContent || '').includes('Incomplete response'));
    assert.equal(requests.filter(/** No POST is safe without source group metadata. */
      request => request.id === '2' && request.method === 'POST' && request.path.startsWith('/lists')).length, 0);
    await assertNoCorruption(fixture);
  });


for (const scenario of [
  { tab: 'domains', endpoint: '/domains', area: '#domArea' },
  { tab: 'hosts', endpoint: '/config/dns/hosts', area: '#hostArea' },
  { tab: 'clients', endpoint: '/clients', area: '#clientArea' },
  { tab: 'lists', endpoint: '/lists', area: '#listArea' }
]) test('Issue #8 Codex: expired sessions show login on ' + scenario.tab,
  /** A 401 must invalidate both sessions and render login fields rather than an unavailable-only table. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page } = fixture;
    await page.route('**/*',
      /** Return a genuine authentication rejection only from the requested collection. */
      async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' &&
            /\/api[12]\//u.test(url.pathname) && url.pathname.endsWith(scenario.endpoint)) {
          return route.fulfill({ status: 401, contentType: 'application/json',
            body: JSON.stringify({ error: { message: 'expired session' } }) });
        }
        return route.fallback();
      });
    // The usual visit() helper requires a table body, which correctly does not
    // exist after HTTP 401: wait for the login forms instead.
    await page.locator(`[data-tab="${scenario.tab}"]`).click();
    await page.waitForFunction(/** Require two usable login forms when all sessions have expired. */
      area => document.querySelector(area)?.querySelectorAll('[data-loginform]').length === 2, scenario.area);
    assert.equal(await page.locator(scenario.area + ' [data-loginpw]').count(), 2);
    assert.equal(await page.locator(scenario.area + ' [data-add-domain-server], ' + scenario.area + ' [data-add-host], ' + scenario.area + ' [data-add-list]').count(), 0);
    await assertNoCorruption(fixture);
  });

test('Issue #8 Codex: a stale-route 409 cannot be presented as an uncertain write',
  /** A fingerprint conflict never reaches Pi-hole and must be a definite rejection, not a lost response. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page, requests } = fixture;
    await visit(page, 'domains');
    await page.route('**/*', /** Reject only the mutation using the documented old-route conflict. */
      async route => {
        if (route.request().method() === 'POST' &&
            new URL(route.request().url()).pathname.endsWith('/domains/deny/exact')) {
          return route.fulfill({ status: 409, contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'dashboard_config_changed' } }) });
        }
        return route.fallback();
      });
    await page.locator('#dDomain').fill('stale-route.example');
    await page.locator('#targetDomain').selectOption('1');
    await page.locator('#domainForm button[type="submit"]').click();
    await page.waitForFunction(/** A definite rejection is reported without an uncertainty retry action. */
      () => (document.querySelector('#toastArea')?.textContent || '').includes('change or preflight failed'));
    const message = await page.locator('#toastArea').textContent();
    assert.ok(!message.includes('write outcome unknown'));
    assert.equal(await page.locator('#dDomain').inputValue(), 'stale-route.example');
    assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith('/domains/deny/exact')).length, 0,
      'The intercepted 409 must not modify the Pi-hole fixture');
    await assertNoCorruption(fixture);
  });

for (const mode of ['navigation', 'language']) {
  test('Issue #8 Codex: an older successful submission cannot erase an identical newer draft after ' + mode,
    /** Hold a valid write while a new user edit reuses the exact submitted values. */
    async t => {
      const fixture = await openDashboard(t, { language: 'en' });
      const { page } = fixture;
      await visit(page, 'domains');
      const pendingWrite = deferred(t);
      const seenWrite = deferred(t);
      let intercepted = false;
      await page.route('**/*',
        /** Pause the first mutation after its fresh preflight without losing it. */
        async route => {
          if (route.request().method() === 'POST' &&
              new URL(route.request().url()).pathname.endsWith('/domains/deny/exact')) {
            if (!intercepted) { intercepted = true; seenWrite.release(); }
            await pendingWrite.promise;
          }
          return route.fallback();
        });
      await page.locator('#dDomain').fill('new-draft.example');
      await page.locator('#dComment').fill('identical but newly typed');
      await page.locator('#targetDomain').selectOption('1');
      await page.locator('#domainForm button[type="submit"]').click();
      await seenWrite.promise;
      if (mode === 'navigation') {
        await visit(page, 'hosts');
        await visit(page, 'domains');
      } else {
        await page.locator('#languageSelect').selectOption('de');
      }
      // A newly typed field, even with the same bytes, is not the submitted draft.
      await page.locator('#dDomain').fill('');
      await page.locator('#dDomain').fill('new-draft.example');
      await page.locator('#dComment').fill('');
      await page.locator('#dComment').fill('identical but newly typed');
      pendingWrite.release();
      await page.waitForFunction(/** Await the original mutation result before checking the new draft. */
        () => (document.querySelector('#toastArea')?.textContent || '').includes('change confirmed') ||
          (document.querySelector('#toastArea')?.textContent || '').includes('Änderung bestätigt'));
      assert.equal(await page.locator('#dDomain').inputValue(), 'new-draft.example');
      assert.equal(await page.locator('#dComment').inputValue(), 'identical but newly typed');
      await assertNoCorruption(fixture);
    });
}


const SELECTOR_EDIT_DURING_WRITE = [
  { tab: 'domains', method: 'POST', path: '/domains/deny/exact',
    fields: [['#dDomain', 'draft-target.example'], ['#dComment', 'fresh destination']],
    target: '#targetDomain', control: '#targetDomain', value: '2', submit: '#domainForm button[type="submit"]' },
  { tab: 'domains', method: 'POST', path: '/domains/deny/exact',
    fields: [['#dDomain', 'draft-type.example'], ['#dComment', 'fresh kind']],
    target: '#targetDomain', control: '#dType', value: 'allow', submit: '#domainForm button[type="submit"]' },
  { tab: 'domains', method: 'POST', path: '/domains/deny/exact',
    fields: [['#dDomain', 'draft-kind.example'], ['#dComment', 'fresh regex']],
    target: '#targetDomain', control: '#dKind', value: 'regex', submit: '#domainForm button[type="submit"]' },
  { tab: 'hosts', method: 'PUT', path: '/config/dns/hosts/',
    fields: [['#hIp', '192.168.1.97'], ['#hName', 'draft-host.example']],
    target: '#targetHost', control: '#targetHost', value: '2', submit: '#hostForm button[type="submit"]' },
  { tab: 'clients', method: 'POST', path: '/clients',
    fields: [['#cClient', '192.168.1.97'], ['#cComment', 'draft client']],
    target: '#targetClient', control: '#targetClient', value: '2', submit: '#clientForm button[type="submit"]' },
  { tab: 'lists', method: 'POST', path: '/lists',
    fields: [['#lUrl', 'https://draft.example/blocklist.txt'], ['#lComment', 'draft list']],
    target: '#targetList', control: '#targetList', value: '2', submit: '#listForm button[type="submit"]' },
  { tab: 'lists', method: 'POST', path: '/lists',
    fields: [['#lUrl', 'https://draft.example/allowlist.txt'], ['#lComment', 'draft allowlist']],
    target: '#targetList', control: '#lType', value: 'allow', submit: '#listForm button[type="submit"]' }
];
for (const scenario of SELECTOR_EDIT_DURING_WRITE) {
  test('Issue #8 Codex: changing ' + scenario.control + ' retains the entire newer draft',
    /** A pending successful write cannot discard a draft newly targeted or retyped by a selector change. */
    async t => {
      const fixture = await openDashboard(t, { language: 'en' });
      const { page } = fixture;
      await visit(page, scenario.tab);
      const held = deferred(t);
      const seen = deferred(t);
      let observed = false;
      await page.route('**/*',
        /** Hold the original server-one mutation after its safety preflight and before applying it. */
        async route => {
          const url = new URL(route.request().url());
          if (route.request().method() === scenario.method && url.pathname.includes(scenario.path)) {
            if (!observed) { observed = true; seen.release(); }
            await held.promise;
          }
          return route.fallback();
        });
      for (const [selector, value] of scenario.fields) await page.locator(selector).fill(value);
      await page.locator(scenario.target).selectOption('1');
      await page.locator(scenario.submit).click();
      await seen.promise;
      await page.locator(scenario.control).selectOption(scenario.value);
      held.release();
      await page.waitForFunction(/** Require acknowledgement of the original write before inspecting the new draft. */
        () => (document.querySelector('#toastArea')?.textContent || '').includes('change confirmed'));
      for (const [selector, value] of scenario.fields) {
        assert.equal(await page.locator(selector).inputValue(), value,
          'Newly selected target/type must preserve all draft inputs');
      }
      assert.equal(await page.locator(scenario.control).inputValue(), scenario.value);
      await assertNoCorruption(fixture);
    });
}

for (const scenario of [
  { tab: 'domains', method: 'POST', path: '/domains/deny/exact',
    fields: [['#dDomain', 'refresh-late.example'], ['#dComment', 'late result']],
    target: '#targetDomain', submit: '#domainForm button[type="submit"]',
    area: '#domArea', marker: 'refresh-late.example', mode: 'language' },
  { tab: 'hosts', method: 'PUT', path: '/config/dns/hosts/',
    fields: [['#hIp', '192.168.1.98'], ['#hName', 'refresh-host.example']],
    target: '#targetHost', submit: '#hostForm button[type="submit"]',
    area: '#hostArea', marker: 'refresh-host.example', mode: 'language' },
  { tab: 'clients', method: 'POST', path: '/clients',
    fields: [['#cClient', '192.168.1.98'], ['#cComment', 'refresh client']],
    target: '#targetClient', submit: '#clientForm button[type="submit"]',
    area: '#clientArea', marker: '192.168.1.98', mode: 'language' },
  { tab: 'lists', method: 'POST', path: '/lists',
    fields: [['#lUrl', 'https://refresh.example/new.txt'], ['#lComment', 'refresh list']],
    target: '#targetList', submit: '#listForm button[type="submit"]',
    area: '#listArea', marker: 'https://refresh.example/new.txt', mode: 'language' },
  { tab: 'domains', method: 'POST', path: '/domains/deny/exact',
    fields: [['#dDomain', 'refresh-after-return.example'], ['#dComment', 'after navigation']],
    target: '#targetDomain', submit: '#domainForm button[type="submit"]',
    area: '#domArea', marker: 'refresh-after-return.example', mode: 'navigation' }
]) {
  test('Issue #8 Codex: late ' + scenario.tab + ' write refreshes the current table after ' + scenario.mode,
    /** The active tab's newest loader must refresh after an older detached submission commits. */
    async t => {
      const fixture = await openDashboard(t, { language: 'en' });
      const { page } = fixture;
      await visit(page, scenario.tab);
      const held = deferred(t);
      const seen = deferred(t);
      let observed = false;
      await page.route('**/*',
        /** Delay applying the mutation until the newer tab rendering has finished its initial GET. */
        async route => {
          const url = new URL(route.request().url());
          if (route.request().method() === scenario.method && url.pathname.includes(scenario.path)) {
            if (!observed) { observed = true; seen.release(); }
            await held.promise;
          }
          return route.fallback();
        });
      for (const [selector, value] of scenario.fields) await page.locator(selector).fill(value);
      await page.locator(scenario.target).selectOption('1');
      await page.locator(scenario.submit).click();
      await seen.promise;
      if (scenario.mode === 'language') {
        await language(page, 'de', scenario.tab);
      } else {
        await visit(page, 'hosts');
        await visit(page, scenario.tab);
      }
      assert.ok(!(await page.locator(scenario.area).textContent()).includes(scenario.marker),
        'The replacement render must have loaded before the original write completes');
      held.release();
      await page.waitForFunction(/** The write-completion refresh must update the currently displayed table. */
        scenario => (document.querySelector(scenario.area)?.textContent || '').includes(scenario.marker),
        { area: scenario.area, marker: scenario.marker });
      await assertNoCorruption(fixture);
    });
}

for (const rejectedReply of [false, true]) {
  test('Issue #8 Codex: partially successful suggestions refresh clients when the other target ' +
    (rejectedReply ? 'rejects the write' : 'drops the response'),
    /**
     * A successful suggestion add must appear in the client inventory even if a
     * second target is rejected or its mutation reply is lost. The suggestion
     * must stop offering an add action once it is known on a healthy instance.
     */
    async t => {
      const fixture = await openDashboard(t, { language: 'en' });
      const { page, serverData, requests } = fixture;
      await visit(page, 'clients');
      const suggestionId = 'AA:BB:CC:DD:EE:01';
      let failedTargetAttempts = 0;
      await page.route('**/*',
        /** Reject or interrupt the second instance's POST without affecting instance one. */
        async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (request.method() === 'POST' && url.pathname.includes('/api2/') &&
              url.pathname.endsWith('/clients')) {
            failedTargetAttempts++;
            if (rejectedReply) {
              return route.fulfill({
                status: 403,
                contentType: 'application/json',
                body: JSON.stringify({ error: { message: 'synthetic forbidden' } })
              });
            }
            return route.abort('failed');
          }
          return route.fallback();
        });
      await page.locator('[data-add-sugg]').first().click();
      await page.waitForFunction(
        /** Wait for the confirmed first-server client to appear in the reloaded table. */
        id => (document.querySelector('#clientArea')?.textContent || '').includes(id),
        suggestionId
      );
      assert.ok(serverData['1'].clients.some(
        /** Only the healthy instance must contain the successful added record. */
        record => record.client === suggestionId
      ));
      assert.equal(serverData['2'].clients.some(
        /** The failed target must not be silently counted as a success. */
        record => record.client === suggestionId
      ), false);
      assert.equal(await page.locator('[data-add-sugg][data-key="' + suggestionId + '"]').count(), 0,
        'A confirmed client must disappear from the suggested-add controls');
      const actualWrites = requests.filter(
        /** Count real HTTP writes, not the number of displayed toast messages. */
        request => request.path === '/clients' && request.method === 'POST'
      );
      assert.equal(actualWrites.length, 1, 'The original fixture receives exactly one healthy-target write');
      assert.equal(failedTargetAttempts, 1, 'The separate rejected-target interceptor sees exactly one write');
      assert.ok((await page.locator('#toastArea').textContent()).includes('change confirmed'));
      await assertNoCorruption(fixture);
    });
}


for (const failurePoint of ['preflight', 'write']) {
  test('Issue #8 Codex: rejected suggestion ' + failurePoint + ' retains its name and exact target after reload',
    /**
     * Failed suggestion attempts refresh the joined inventory without discarding
     * the surviving device draft or silently broadening its selected destination.
     */
    async t => {
      const fixture = await openDashboard(t, { language: 'en' });
      const { page, serverData } = fixture;
      await visit(page, 'clients');
      const identifier = 'AA:BB:CC:DD:EE:01';
      const nameSelector = '[data-suggestion-name="' + identifier + '"]';
      const targetSelector = '[data-form-state-key="suggestion-target:' + identifier + '"]';
      const draftName = 'Draft after ' + failurePoint + ' rejection';
      await page.locator(nameSelector).fill(draftName);
      await page.locator(targetSelector).selectOption('2');
      let rejected = 0;
      await page.route('**/*',
        /** Reject one target preflight or POST while leaving the subsequent read refresh functional. */
        async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path.includes('/api2/') && path.endsWith('/clients') &&
              request.method() === (failurePoint === 'preflight' ? 'GET' : 'POST') &&
              rejected === 0) {
            rejected++;
            return route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: 'synthetic rejection' } })
            });
          }
          return route.fallback();
        });
      const refreshed = page.waitForResponse(
        /** Observe the live suggestion refresh after the rejected operation. */
        response => response.request().method() === 'GET' &&
          new URL(response.url()).pathname.includes('/api1/') &&
          new URL(response.url()).pathname.endsWith('/clients/_suggestions')
      );
      await page.locator('[data-add-sugg][data-key="' + identifier + '"]').click();
      await refreshed;
      await page.waitForFunction(
        /** Both data tables must be rebuilt before asserting field state on live rows. */
        () => !!document.querySelector('#clientArea .datatable') &&
          !!document.querySelector('#suggArea [data-suggestion-name="AA:BB:CC:DD:EE:01"]')
      );
      assert.equal(await page.locator(nameSelector).inputValue(), draftName,
        'A rejected suggestion must preserve the typed name after reload');
      assert.equal(await page.locator(targetSelector).inputValue(), '2',
        'A rejected suggestion must not reset its destination to all instances');
      assert.ok((await page.locator('#toastArea').textContent()).includes('change or preflight failed'));
      assert.equal(rejected, 1);
      assert.ok(!serverData['2'].clients.some(
        /** Rejecting one selected target must not silently create a configured client. */
        client => client.client === identifier
      ));
      await assertNoCorruption(fixture);
    });
}

test('Issue #8 Codex: an obsolete client read cannot change the latest unavailable instance state',
  /**
   * Resolve an old confirmed GET after a new GET has failed. A later pagination
   * redraw must not treat the newer unknown instance as an actionable absence.
   */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const { page, serverData } = fixture;
    serverData['2'].clients = [];
    await visit(page, 'clients');
    const oldReadSeen = deferred(t);
    const releaseOldRead = deferred(t);
    let reads = 0;
    await page.route('**/*',
      /** Hold the first server-two collection read and reject the second concurrent read. */
      async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.includes('/api2/') &&
            url.pathname.endsWith('/clients')) {
          reads++;
          if (reads === 1) {
            oldReadSeen.release();
            await releaseOldRead.promise;
            return route.fallback();
          }
          if (reads === 2) {
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: { message: 'synthetic newer read failure' } })
            });
          }
        }
        return route.fallback();
      });
    await page.locator('#clientReload').click();
    await oldReadSeen.promise;
    await page.locator('#clientReload').click();
    await page.waitForFunction(
      /** The latest failed server-two read must publish while the old read remains held. */
      () => !!document.querySelector('#clientArea .datatable') &&
        (document.querySelector('#clientArea')?.textContent || '').includes('Data unavailable')
    );
    const oldResponse = page.waitForResponse(
      /** Detect the delayed response so its obsolete continuation can settle. */
      response => response.request().method() === 'GET' &&
        new URL(response.url()).pathname.includes('/api2/') &&
        new URL(response.url()).pathname.endsWith('/clients') &&
        response.status() === 200
    );
    releaseOldRead.release();
    await oldResponse;
    await page.evaluate(
      /** Wait two rendering frames so an obsolete response can no longer alter the current table. */
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await page.locator('#clientPageSize').selectOption('25');
    assert.ok((await page.locator('#clientArea').textContent()).includes('Data unavailable'),
      'An older success cannot remove an unavailable-data warning');
    assert.equal(await page.locator('[data-add-client-server="2"]').count(), 0,
      'A client absent only from unknown data must never be offered as an Add action');
    assert.equal(reads, 2);
    await assertNoCorruption(fixture);
  });


test('Issue #9: normal API and login requests time out without destroying valid session state', /** Hold an API request and login until the browser deadline aborts both. */ async t => {
  const fixture = await openDashboard(t, { language: 'de', fakeClock: true });
  const { page } = fixture;
  await page.evaluate(/** Intercept only selected requests with abort-aware promises. */ () => {
    const original = window.fetch;
    window.fetch = (url, init) => {
      if (String(url).endsWith('/stats/top_clients') || (String(url).endsWith('/auth') && init?.method === 'POST')) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', /** Simulate the network ending its pending request on cancellation. */ () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      }
      return original(url, init);
    };
    window.__issue9ApiTimeout = apiCall(serverById('1'), '/stats/top_clients').then(
      /** Timeouts must not be counted as successes. */ () => 'unexpected-success',
      /** Retain the localized deadline error for the test. */ error => error.message);
    window.__issue9LoginTimeout = login(serverById('1'), 'synthetic-password').then(
      /** Timeouts must not authenticate the instance. */ () => 'unexpected-success',
      /** Retain the localized deadline error for the test. */ error => error.message);
  });
  await page.clock.runFor(15001);
  const result = await page.evaluate(/** Read completed errors and the previously valid SID. */ async () => ({
    errors: await Promise.all([window.__issue9ApiTimeout, window.__issue9LoginTimeout]),
    sid: serverById('1').sid
  }));
  assert.deepEqual(result.errors, ['Zeitlimit für die Anfrage überschritten.', 'Zeitlimit für die Anfrage überschritten.']);
  assert.equal(result.sid, 'fixture-sid-1');
  await assertNoCorruption(fixture);
});

test('Issue #9: an obsolete one-hour query load never overwrites a newer 24-hour result', /** Pause an old range and complete the replacement before releasing it. */ async t => {
  const fixture = await openDashboard(t, { language: 'en', hash: 'queries' });
  const { page } = fixture;
  const oldGate = deferred(t);
  const oldRequest = deferred(t);
  await page.route('**/queries?*', /** Delay only the one-hour range while serving the latest range normally. */ async route => {
    const url = new URL(route.request().url());
    const hours = (Number(url.searchParams.get('until')) - Number(url.searchParams.get('from'))) / 3600;
    if (hours !== 1) return route.fallback();
    oldRequest.release();
    await oldGate.promise;
    try {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ queries: [{ time: TIMESTAMP, domain: 'obsolete.example', type: 'A', status: 'FORWARDED' }] }) });
    } catch { /* The cancelled stale request may no longer be fulfilled. */ }
  });
  await page.locator('#qRange').selectOption('1');
  await oldRequest.promise;
  await page.locator('#qRange').selectOption('24');
  await page.waitForFunction(/** Wait for the later request to publish both servers' current rows. */ () => document.querySelector('#qStatus')?.textContent.includes('2 queries in total'));
  oldGate.release();
  await page.evaluate(/** Flush one rendering frame after releasing the old response. */ () => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#qRange').inputValue(), '24');
  assert.equal(await page.locator('#qArea tbody tr').count(), 2);
  assert.doesNotMatch(await page.locator('#qArea').textContent(), /obsolete\.example/u);
  await assertNoCorruption(fixture);
});

test('Issue #9: logout clears the local SID before an unsuccessful remote revoke finishes', /** A network failure must never retain local authentication. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const result = await fixture.page.evaluate(/** Intercept the revoke, start logout and inspect local state immediately. */ async () => {
    const server = serverById('1');
    const original = window.fetch;
    window.fetch = (url, init) => init?.method === 'DELETE' && String(url).endsWith('/auth')
      ? Promise.reject(new TypeError('offline')) : original(url, init);
    const pending = logout(server);
    const clearedImmediately = !server.sid && !server.connected && sessionStorage.getItem(sessionStorageKey(server)) === null;
    const remoteRevoked = await pending;
    window.fetch = original;
    return { clearedImmediately, remoteRevoked };
  });
  assert.deepEqual(result, { clearedImmediately: true, remoteRevoked: false });
  await assertNoCorruption(fixture);
});

test('Issue #9: HTTP 401 on a raw Gravity response invalidates only the original server SID', /** Cover the raw-response authentication path, not only decoded JSON calls. */ async t => {
  const fixture = await openDashboard(t, { language: 'en' });
  const result = await fixture.page.evaluate(/** Replace only the raw Gravity response with an explicit session rejection. */ async () => {
    const server = serverById('1');
    const original = window.fetch;
    window.fetch = (url, init) => String(url).includes('/action/gravity') && init?.method === 'POST'
      ? Promise.resolve(new Response(null, { status: 401 })) : original(url, init);
    let caught = false;
    try { await apiCall(server, '/action/gravity?color=true', { method: 'POST', rawResponse: true }); }
    catch (error) { caught = error instanceof AuthError; }
    window.fetch = original;
    return { caught, connected: server.connected, sid: server.sid, stored: sessionStorage.getItem(sessionStorageKey(server)), peerSid: serverById('2').sid };
  });
  assert.deepEqual(result, { caught: true, connected: false, sid: null, stored: null, peerSid: 'fixture-sid-2' });
  await assertNoCorruption(fixture);
});


for (const language of ['da', 'en', 'de']) {
  test('Issue #9: stale 401 cannot clear a replacement login (' + language + ')',
    /** An obsolete authenticated request may fail without logging out a newer successful login. */
    async t => {
      const fixture = await openDashboard(t, { language });
      const result = await fixture.page.evaluate(
        /** Delay one request's HTTP 401 until the same instance has authenticated with a fresh SID. */
        async () => {
          const server = serverById('1');
          const originalFetch = window.fetch;
          let releaseOld;
          const oldResponse = new Promise(resolve => { releaseOld = resolve; });
          window.fetch = (url, options) => {
            if (String(url).endsWith('/stats/summary') &&
                options?.headers?.['X-FTL-SID'] === 'fixture-sid-1') return oldResponse;
            if (String(url).endsWith('/auth') && options?.method === 'POST') {
              return Promise.resolve(new Response(
                JSON.stringify({ session: { sid: 'replacement-sid-1' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              ));
            }
            return originalFetch(url, options);
          };
          try {
            const staleCall = apiCall(server, '/stats/summary').then(
              () => false, error => error instanceof AuthError
            );
            await login(server, 'replacement-password');
            releaseOld(new Response(null, { status: 401 }));
            const gotAuthError = await staleCall;
            return {
              gotAuthError,
              connected: server.connected,
              sid: server.sid,
              saved: sessionStorage.getItem(sessionStorageKey(server)),
              peerSid: serverById('2').sid
            };
          } finally {
            window.fetch = originalFetch;
          }
        });
      assert.deepEqual(result, {
        gotAuthError: true,
        connected: true,
        sid: 'replacement-sid-1',
        saved: 'replacement-sid-1',
        peerSid: 'fixture-sid-2'
      });
      await assertNoCorruption(fixture);
    });
}

test('Issue #9: late logout 401 cannot clear a new session',
  /** A stale remote-revocation result must not mutate credentials created after local logout. */
  async t => {
    const fixture = await openDashboard(t, { language: 'da' });
    const result = await fixture.page.evaluate(
      /** Complete an old DELETE only after a replacement login succeeds. */
      async () => {
        const server = serverById('1');
        const originalFetch = window.fetch;
        let finishRevoke;
        const heldRevoke = new Promise(resolve => { finishRevoke = resolve; });
        window.fetch = (url, options) => {
          if (String(url).endsWith('/auth') && options?.method === 'DELETE') return heldRevoke;
          if (String(url).endsWith('/auth') && options?.method === 'POST') {
            return Promise.resolve(new Response(
              JSON.stringify({ session: { sid: 'after-logout-sid' } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));
          }
          return originalFetch(url, options);
        };
        try {
          const pendingLogout = logout(server);
          await login(server, 'new-password');
          finishRevoke(new Response(null, { status: 401 }));
          const revoked = await pendingLogout;
          return {
            revoked,
            connected: server.connected,
            sid: server.sid,
            saved: sessionStorage.getItem(sessionStorageKey(server))
          };
        } finally {
          window.fetch = originalFetch;
        }
      });
    assert.deepEqual(result, {
      revoked: false,
      connected: true,
      sid: 'after-logout-sid',
      saved: 'after-logout-sid'
    });
    await assertNoCorruption(fixture);
  });

for (const language of ['da', 'en', 'de']) {
  test('Issue #9: a healthy dashboard card renders while a peer hangs (' + language + ')',
    /** Publish one instance's confirmed summary without misrepresenting an outstanding peer as successful. */
    async t => {
      const fixture = await openDashboard(t, { language, holdSummaryServer: '2', waitForReady: false });
      const { page, summaryGate } = fixture;
      await page.locator('[data-dashboard-preview="1"]').waitFor();
      await page.locator('[data-dashboard-pending="2"]').waitFor();
      assert.ok(summaryGate.arrived > 0, 'The second instance must still be pending');
      assert.equal(await page.locator('[data-dashboard-preview="1"] .big-num').textContent(),
        (12345).toLocaleString(EXPECTED[language].locale));
      const progress = await page.locator('[data-dashboard-progress="true"]').textContent();
      assert.ok(progress.includes('1') && progress.includes('2'), 'The combined total must identify partial coverage');
      summaryGate.release();
      await page.locator('#dashGrid [data-toggle-block="2"]').waitFor();
      assert.equal(await page.locator('#dashGrid [data-toggle-block]').count(), 2);
      await assertNoCorruption(fixture);
    });

  test('Issue #9: queries from a healthy server appear before the peer responds (' + language + ')',
    /** Verify that one slow /queries response cannot delay another server's visible rows. */
    async t => {
      const fixture = await openDashboard(t, {
        language, hash: 'queries', holdQueriesServer: '2', waitForReady: false
      });
      const { page, queriesGate } = fixture;
      await page.locator('#qArea tbody tr').first().waitFor();
      assert.ok(queriesGate.arrived > 0, 'A second peer request must still be held');
      assert.equal(await page.locator('#qArea tbody tr').count(), 1);
      const status = await page.locator('#qStatus').textContent();
      assert.ok(status.includes('1') && status.includes('2'), 'Progress must disclose that not all instances responded');
      queriesGate.release();
      await page.waitForFunction(
        /** Wait for both independent instance results instead of a fixed delay. */
        () => document.querySelectorAll('#qArea tbody tr').length === 2
      );
      assert.equal(await page.locator('#qArea tbody tr').count(), 2);
      await assertNoCorruption(fixture);
    });
}

test('Issue #9: older client-name refresh cannot overwrite a newer result',
  /** Resolve two friendly-name requests in reverse order and keep only the latest generation. */
  async t => {
    const fixture = await openDashboard(t, { language: 'en' });
    const result = await fixture.page.evaluate(
      /** Delay the first instance response past the second generation's completion. */
      async () => {
        const originalFetch = window.fetch;
        let releaseOld;
        const oldResponse = new Promise(resolve => { releaseOld = resolve; });
        let calls = 0;
        const target = serverById('1').base + '/clients';
        window.fetch = (url, options) => {
          if (String(url) === target) {
            calls++;
            if (calls === 1) return oldResponse;
            return Promise.resolve(new Response(
              JSON.stringify({ clients: [{ client: '192.168.1.10', comment: 'Current name' }] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ));
          }
          return originalFetch(url, options);
        };
        try {
          const first = refreshClientNames();
          const second = await refreshClientNames();
          releaseOld(new Response(
            JSON.stringify({ clients: [{ client: '192.168.1.10', comment: 'Obsolete name' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
          const firstPublished = await first;
          return { firstPublished, second, name: state.clientNames.get('192.168.1.10') };
        } finally {
          window.fetch = originalFetch;
        }
      }
    );
    assert.deepEqual(result, { firstPublished: false, second: true, name: 'Current name' });
    await assertNoCorruption(fixture);
  });


for (const language of ['da', 'en', 'de']) {
  test('Issue #9: a timed-out HTTP 200 body cannot confirm an API read or write (' + language + ')',
    /** Abort stalled JSON bodies after valid HTTP headers without inventing a successful read or mutation. */
    async t => {
      const fixture = await openDashboard(t, { language, fakeClock: true });
      const { page } = fixture;
      await page.evaluate(
        /** Replace two JSON response bodies with never-ending streams that reject only when their deadline aborts. */
        () => {
          const originalFetch = window.fetch;
          window.__issue9BodyOriginalFetch = originalFetch;
          window.fetch = (url, init) => {
            const uri = String(url);
            if (uri.endsWith('/stats/summary') ||
                (uri.endsWith('/dns/blocking') && init?.method === 'POST')) {
              const stream = new ReadableStream({
                /** Simulate the browser aborting a response body after headers have arrived. */
                start(controller) {
                  init.signal.addEventListener('abort',
                    /** The fetch body reader must see the cancellation rather than an empty JSON document. */
                    () => controller.error(new DOMException('body aborted', 'AbortError')),
                    { once: true });
                }
              });
              return Promise.resolve(new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }));
            }
            return originalFetch(url, init);
          };
          const server = serverById('1');
          window.__issue9BodyOutcomes = Promise.all([
            apiCall(server, '/stats/summary').then(
              /** An unread response body must not count as a confirmed read. */
              () => ({ operation: 'read', confirmed: true }),
              /** Retain the deadline category as well as its translated message. */
              error => ({ operation: 'read', confirmed: false, timeout: error instanceof RequestTimeoutError, message: error.message })
            ),
            apiCall(server, '/dns/blocking', { method: 'POST', body: { blocking: false } }).then(
              /** Successful HTTP headers alone must never confirm the remote write. */
              () => ({ operation: 'write', confirmed: true }),
              /** A lost write acknowledgement is not automatically repeated. */
              error => ({ operation: 'write', confirmed: false, timeout: error instanceof RequestTimeoutError, message: error.message })
            )
          ]);
        });
      await page.clock.runFor(15001);
      const result = await page.evaluate(
        /** Read the completed deadline results and restore the original browser fetch. */
        async () => {
          const outcomes = await window.__issue9BodyOutcomes;
          window.fetch = window.__issue9BodyOriginalFetch;
          return {
            outcomes,
            expectedMessage: msg('common.requestTimeout'),
            stillConnected: serverById('1').connected,
            sid: serverById('1').sid
          };
        });
      assert.deepEqual(result.outcomes.map(({ operation, confirmed, timeout }) =>
        ({ operation, confirmed, timeout })), [
        { operation: 'read', confirmed: false, timeout: true },
        { operation: 'write', confirmed: false, timeout: true }
      ]);
      assert.ok(result.outcomes.every(outcome => outcome.message === result.expectedMessage));
      assert.equal(result.stillConnected, true, 'A stalled body alone cannot invalidate the original SID');
      assert.equal(result.sid, 'fixture-sid-1');
      await assertNoCorruption(fixture);
    });
}
