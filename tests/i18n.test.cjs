"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)].filter(/** Exclude script tags that load external assets; the unit harness evaluates only inline declarations. */ match => !/\bsrc\s*=/iu.test(match[1])).map(/** Extract the JavaScript body from each remaining inline script tag. */ match => match[2]);
const source = inlineScripts.find(/** Select the inline application containing the keyed I18N catalog instead of unrelated script fragments. */ script => /\bconst\s+I18N\s*=/u.test(script));
assert.ok(source, "index.html must contain its keyed catalogs and application script");
const startupMarker = "// Start the dashboard.";
const startupOffset = source.indexOf(startupMarker);
assert.ok(startupOffset >= 0, "The startup marker keeps unit tests independent of Pi-hole APIs");
const definitions = source.slice(0, startupOffset);

/**
 * Create isolated string-based storage with the browser Storage API's missing-key behavior.
 * @param {Object<string, string>} entries Initial string key/value pairs for this test's storage map.
 * @returns {object} In-memory getItem, setItem, removeItem and clear methods.
 * No test state is read from or written to the host filesystem.
 */
function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    /** Return the stored string value, or null when the string-normalized key is absent. */
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    /** Normalize key and value to strings before saving them in this fixture's map. */
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    /** Remove the string-normalized key without affecting the other stored test values. */
    removeItem(key) {
      values.delete(String(key));
    },
    /** Clear all values belonging to this isolated storage fixture. */
    clear() {
      values.clear();
    }
  };
}

/** Minimal explicit-attribute DOM for i18n bindings; real layout is browser-tested. */
class ElementStub {
  /**
   * Initialize the small element model needed by explicit translation bindings.
   * @param {string} tagName Element tag; stored uppercase like a browser DOM element.
   * @param {object} attributes Initial attribute names and values.
   * @param {string} text Initial literal text content.
   * Creates independent child and listener collections without implementing layout.
   */
  constructor(tagName = "div", attributes = {}, text = "") {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attributesMap = new Map(Object.entries(attributes));
    this.children = [];
    this.textContent = text;
    this.innerHTML = "";
    this.value = "";
    this.listeners = new Map();
  }
  /** Expose the element's ID attribute as a string, using the DOM-style empty fallback. */
  get id() {
    return this.getAttribute("id") || "";
  }
  /** Expose attributes as name/value records for the application's binding enumeration. */
  get attributes() {
    return [...this.attributesMap].map(/** Convert one map entry into the attribute shape expected by the translation helpers. */ ([name, value]) => ({
      name,
      value
    }));
  }
  /** Return an attribute value, or null when this fixture element has no such attribute. */
  getAttribute(name) {
    return this.attributesMap.get(name) ?? null;
  }
  /** Report whether the attribute exists, including attributes with an empty value. */
  hasAttribute(name) {
    return this.attributesMap.has(name);
  }
  /** Store a string-valued attribute on the fixture element. */
  setAttribute(name, value) {
    this.attributesMap.set(name, String(value));
  }
  /** Append child elements in document order for later selector traversal. */
  append(...elements) {
    this.children.push(...elements);
  }
  /** Record the latest listener for an event name so initialization can register handlers without a real event loop. */
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  /**
   * Match the limited comma-separated selectors used by the translation tests.
   * @param {string} selector Tag, ID or attribute-presence selectors to check.
   * @returns {boolean} Whether at least one supported selector matches this element.
   */
  matches(selector) {
    return selector.split(",").some(/** Test one selector alternative against the element's tag, ID or attribute presence. */ part => {
      const value = part.trim();
      const attribute = /^\[([^\]=]+)\]$/u.exec(value);
      if (attribute) return this.hasAttribute(attribute[1]);
      if (value.startsWith("#")) return this.id === value.slice(1);
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }
  /**
   * Collect matching descendants in document order using the supported selector subset.
   * @param {string} selector Selector passed to each descendant's matches method.
   * @returns {Array<ElementStub>} Matching descendants; the current element itself is excluded.
   */
  querySelectorAll(selector) {
    return this.children.flatMap(/** Include a matching child before recursively collecting that child's matching descendants. */ child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  /** Return the first matching descendant or null, mirroring the DOM lookup used by the application. */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

/**
 * Build the document and dashboard shell needed to evaluate translation declarations.
 * @returns {ElementStub} A document-like root with html/body, shell elements and lookup/creation helpers.
 * This stub represents explicit bindings only; browser tests cover layout and real event behavior.
 */
function documentStub() {
  const document = new ElementStub("document");
  document.nodeType = 9;
  document.documentElement = new ElementStub("html");
  document.body = new ElementStub("body");
  document.append(document.documentElement);
  document.documentElement.append(document.body);
  for (const id of ["languageSelect", "tabs", "serverPills", "tabContent", "toastArea"]) {
    document.body.append(new ElementStub(id === "languageSelect" ? "select" : "div", {
      id
    }));
  }
  document.getElementById = /** Look up a fixture element by its ID through the supported selector implementation. */ id => document.querySelector(`#${id}`);
  document.createElement = /** Create a detached fixture element when application code requests a new DOM node. */ tagName => new ElementStub(tagName);
  return document;
}

/**
 * Evaluate application declarations in a fresh VM while omitting the dashboard startup block.
 * @param {object} options Saved language, browser languages and optional denied-storage behavior.
 * @returns {object} The VM context, document stub and helpers for evaluating test expressions.
 * Timers and window listeners are inert; any attempted network request throws.
 */
function loadApp({
  saved = null,
  languages = ["en-GB"],
  storageDenied = false
} = {}) {
  const document = documentStub();
  const sandbox = {
    document,
    navigator: {
      languages,
      language: languages[0] || "en-GB"
    },
    localStorage: memoryStorage(saved === null ? {} : {
      ph_combo_language: saved
    }),
    sessionStorage: memoryStorage(),
    Element: ElementStub,
    Node: {
      ELEMENT_NODE: 1,
      DOCUMENT_NODE: 9,
      TEXT_NODE: 3
    },
    location: {
      hash: "",
      href: "https://dashboard.example.test/"
    },
    history: {
      /** Accept history updates without navigating, because this unit harness has no browser history. */ replaceState() {}
    },
    console,
    structuredClone,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    /** Return a harmless timer handle without scheduling asynchronous dashboard work. */
    setTimeout() {
      return 0;
    },
    /** Accept timer cancellation for inert timers without introducing event-loop activity. */
    clearTimeout() {},
    /** Ignore global event registration because these tests invoke translation behavior directly. */
    addEventListener() {},
    /** Fail immediately if a unit test accidentally reaches a network-dependent application path. */
    fetch() {
      throw new Error("Unit tests must not contact Pi-hole instances");
    }
  };
  sandbox.window = sandbox;
  if (storageDenied) {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(sandbox, name, {
        /** Simulate unavailable browser storage by throwing whenever the application accesses this property. */
        get() {
          throw new Error("Browser storage is unavailable");
        },
        configurable: true
      });
    }
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(definitions, context, {
    filename: "index.html:inline",
    timeout: 5000
  });
  return {
    context,
    document,
    /** Evaluate a test expression in the isolated application context with a five-second execution limit. */
    read(expression) {
      return vm.runInContext(expression, context, {
        timeout: 5000
      });
    },
    /** Serialize a VM expression through JSON so assertions compare ordinary host-realm values. */
    value(expression) {
      return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
    }
  };
}

/**
 * Extract sorted, unique placeholder names from a translation message.
 * @param {string} message Message that may contain named placeholders in braces.
 * @returns {Array<string>} Parameter names used for cross-language catalog parity checks.
 */
function parameterNames(message) {
  return [...new Set([...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(/** Keep the captured placeholder name and discard its surrounding braces. */ match => match[1]))].sort();
}

/**
 * Find the position after a quoted source segment while skipping escaped characters.
 * @param {string} text Application source being scanned.
 * @param {number} start Offset of the opening single quote, double quote or backtick.
 * @returns {number} Offset immediately after its closing delimiter.
 * @throws {Error} When the source ends before that delimiter is found.
 */
function quoteEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }
  throw new Error("Unterminated quoted text in application source");
}

/**
 * Remove the I18N object declaration before inspecting application translation references.
 * @param {string} text Inline application source containing the catalog declaration.
 * @returns {string} Source outside the catalog, so a key's definition cannot count as its use.
 * @throws {Error} If the catalog is absent or its object never closes.
 */
function withoutCatalog(text) {
  const declaration = /\bconst\s+I18N\s*=/u.exec(text);
  assert.ok(declaration, "Catalog declaration exists");
  const start = text.indexOf("{", declaration.index + declaration[0].length);
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (["'", '"', "`"].includes(text[index])) {
      index = quoteEnd(text, index) - 1;
      continue;
    }
    if (text[index] === "{") depth++;
    if (text[index] === "}" && --depth === 0) return text.slice(0, declaration.index) + text.slice(index + 1);
  }
  throw new Error("Unterminated I18N catalog");
}

/**
 * Read a call's first argument while respecting quoted text and nested delimiters.
 * @param {string} text Source containing the translation-helper call.
 * @param {number} start Offset immediately after the call's opening parenthesis.
 * @returns {string} Argument text before the first outer comma or closing parenthesis.
 * @throws {Error} If the call has no detectable argument boundary.
 */
function firstArgument(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (["'", '"', "`"].includes(character)) {
      index = quoteEnd(text, index) - 1;
      continue;
    }
    if (depth === 0 && [",", ")"].includes(character)) return text.slice(start, index);
    if (["(", "[", "{"].includes(character)) depth++;
    if ([")", "]", "}"].includes(character)) depth--;
  }
  throw new Error("Unterminated translation call");
}

/**
 * Extract quoted dotted message keys from a source fragment.
 * @param {string} text Translation argument or application source to inspect.
 * @returns {Array<string>} Matching semantic-key literals in source order.
 */
function keyLiterals(text) {
  return [...text.matchAll(/(["'])([a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\1/gu)].map(/** Keep the captured dotted message key, excluding the quotation marks. */ match => match[2]);
}
test("the complete inline application is valid JavaScript", /** Compile the complete inline application without executing it to catch JavaScript syntax errors. */ () => {
  assert.doesNotThrow(/** Construct the VM script inside the assertion so parser errors become a clear test failure. */ () => new vm.Script(source, {
    filename: "index.html:inline"
  }));
});
test("Danish, English and German have identical nonempty semantic keys and parameters", /** Require every language catalog to have identical nonempty keys and matching named parameters. */ () => {
  const app = loadApp();
  const catalogs = app.value("I18N");
  assert.deepEqual(Object.keys(catalogs).sort(), ["da", "de", "en"]);
  const keys = Object.keys(catalogs.en).sort();
  assert.ok(keys.length > 0);
  for (const language of Object.keys(catalogs)) {
    assert.deepEqual(Object.keys(catalogs[language]).sort(), keys, `${language}: complete key parity`);
    for (const key of keys) {
      assert.match(key, /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/u, `${key}: stable semantic key`);
      assert.equal(typeof catalogs[language][key], "string", `${language}/${key}: plain-text message`);
      assert.ok(catalogs[language][key].trim(), `${language}/${key}: nonempty translation`);
      assert.deepEqual(parameterNames(catalogs[language][key]), parameterNames(catalogs.en[key]), `${language}/${key}: named parameters match English`);
    }
  }
});
test("supported language metadata contains native labels and formatting locales", /** Verify native language names, formatting locales and the stable stored-language/version identifiers. */ () => {
  const app = loadApp();
  assert.deepEqual(app.value("SUPPORTED_LANGUAGES"), {
    da: {
      label: "Dansk",
      locale: "da-DK"
    },
    en: {
      label: "English",
      locale: "en-GB"
    },
    de: {
      label: "Deutsch",
      locale: "de-DE"
    }
  });
  assert.equal(app.read("LANGUAGE_KEY"), "ph_combo_language");
  assert.match(app.read("APP_VERSION"), /^\d+\.\d+\.\d+$/u);
});
test("language resolution honors user preference, configured defaults and regional browser order", /** Check regional-tag normalization and the precedence of saved, configured and ordered browser languages. */ () => {
  const app = loadApp();
  for (const [input, expected] of [["da-DK", "da"], ["DE-at", "de"], [" de-CH ", "de"], ["en-GB", "en"], ["en_US", "en"]]) {
    assert.equal(app.read(`normalizeLanguage(${JSON.stringify(input)})`), expected);
  }
  for (const input of [null, 42, {}, "", "fr-FR", "constructor", "__proto__"]) {
    assert.equal(app.read(`normalizeLanguage(${JSON.stringify(input)})`), null);
  }
  const cases = [["de-DE", ["da-DK", "en-GB"], "de"], ["EN-gb", ["de-DE", "da-DK"], "en"], ["invalid", ["fr-FR", "de-AT", "en-GB"], "de"], [null, ["fr-FR", "da-DK", "de-DE"], "da"], [null, ["en-US", "de-DE"], "en"], ["fr-FR", ["ja-JP", "th-TH"], "en"], [null, [], "en"], [null, null, "en"], ["de-DE", ["da-DK"], "de", "en"], [null, ["de-DE"], "da", "da"], ["unsupported", ["de-DE"], "en", "en"], [null, ["de-CH"], "de", "auto"]];
  for (const [saved, languages, expected, configured = "auto"] of cases) {
    assert.equal(app.read(`resolveLanguage(${JSON.stringify(saved)}, ${JSON.stringify(languages)}, ${JSON.stringify(configured)})`), expected);
  }
  assert.equal(loadApp({
    saved: "de-AT",
    languages: ["en-GB"]
  }).read("currentLanguage"), "de");
  assert.equal(loadApp({
    saved: "invalid",
    languages: ["fr-FR", "da-DK"]
  }).read("currentLanguage"), "da");
});

/**
 * Create a fresh public configuration for validation tests, including intentionally unsupported counts when requested.
 * @param {number} count Number of synthetic instance entries.
 * @param {string} defaultLanguage Configured preference to pass to the validator.
 * @returns {object} Public labels and deterministic fingerprinted routes without private target addresses.
 */
function publicConfig(count = 2, defaultLanguage = "auto") {
  return {
    version: 1,
    defaultLanguage,
    servers: Array.from({
      length: count
    }, /** Create one stable synthetic instance ID and its matching route fingerprint. */ (_, index) => {
      const id = String(index + 1);
      return {
        id,
        label: "Configured Pi-hole " + id,
        base: "/api" + id + "/" + id.repeat(64)
      };
    })
  };
}
test("runtime configuration validates the supported count and derives display metadata without mutation", /** Validate supported counts and languages, derived display fields, immutable inputs and Unicode label normalization. */ () => {
  const app = loadApp();
  for (const count of [2, 3, 4]) for (const defaultLanguage of ["auto", "da", "en", "de"]) {
    const input = publicConfig(count, defaultLanguage);
    input.servers.reverse();
    app.context.testConfig = structuredClone(input);
    assert.deepEqual(app.value("validateRuntimeConfig(testConfig)"), {
      ...input,
      servers: input.servers.map(/** Add the expected color and chip metadata to each unchanged public instance record. */ server => ({
        ...server,
        color: "c-" + server.id,
        chip: "s" + server.id
      }))
    });
    assert.deepEqual(app.context.testConfig, input, "Validation must leave the caller's editable data unchanged");
  }
  const input = publicConfig();
  delete input.defaultLanguage;
  input.servers[0].label = "  Grüße <DNS> & {server}  ";
  input.servers[1].label = "😀".repeat(120);
  app.context.testConfig = input;
  const normalized = app.value("validateRuntimeConfig(testConfig)");
  assert.equal(normalized.defaultLanguage, "auto");
  assert.equal(normalized.servers[0].label, "Grüße <DNS> & {server}");
  assert.equal(normalized.servers[1].label, input.servers[1].label, "The label limit counts Unicode characters");
});
test("invalid runtime documents and unsafe endpoint forms are rejected in full", /** Reject malformed configuration shapes and unsafe routes without accepting a partial target list. */ () => {
  const app = loadApp();
  const changed = /** Start each invalid case from a fresh valid document, apply its single mutation and return the independent result. */ mutate => {
    const input = publicConfig();
    mutate(input);
    return input;
  };
  const cases = [["null document", null], ["array document", []], ["string document", "config.json"], ["missing version", changed(/** Omit the required version field to test rejection of an unversioned document. */ config => {
    delete config.version;
  })], ["string version", changed(/** Use a string version to test strict schema typing. */ config => {
    config.version = "1";
  })], ["future version", changed(/** Use an unknown future version to test explicit version support. */ config => {
    config.version = 2;
  })], ["unexpected top-level field", changed(/** Add an obsolete count field to test rejection of unexpected top-level configuration. */ config => {
    config.count = 4;
  })], ["unsupported default language", changed(/** Use an unsupported configured language to test the accepted language set. */ config => {
    config.defaultLanguage = "fr";
  })], ["noncanonical configured language", changed(/** Use a regional configured language where the schema requires a canonical language code. */ config => {
    config.defaultLanguage = "de-DE";
  })], ["null configured language", changed(/** Set the configured language to null to test its required string form when present. */ config => {
    config.defaultLanguage = null;
  })], ["missing servers", changed(/** Remove the target list to test that servers is required. */ config => {
    delete config.servers;
  })], ["nonarray servers", changed(/** Replace the target array with an object to test its container type. */ config => {
    config.servers = {};
  })], ["empty servers", changed(/** Empty the target list to test the minimum instance count. */ config => {
    config.servers = [];
  })], ["one server", publicConfig(1)], ["five servers", publicConfig(5)], ["null server", changed(/** Insert a null server to test that each target must be an object. */ config => {
    config.servers[0] = null;
  })], ["array server", changed(/** Insert an array as a server to reject the wrong object shape. */ config => {
    config.servers[0] = [];
  })], ["unexpected server field", changed(/** Add a private upstream field to test that public configuration accepts only its documented projection. */ config => {
    config.servers[0].upstream_url = "http://private.invalid/api/";
  })], ["missing ID", changed(/** Remove a server ID to test that every route has a stable instance identity. */ config => {
    delete config.servers[0].id;
  })], ["numeric ID", changed(/** Use a numeric ID where the public schema requires a string. */ config => {
    config.servers[0].id = 1;
  })], ["unknown ID", changed(/** Use an ID outside the supported instance range. */ config => {
    config.servers[0].id = "5";
  })], ["noncanonical ID", changed(/** Use a zero-padded ID to test canonical identity spelling. */ config => {
    config.servers[0].id = "01";
  })], ["duplicate IDs", changed(/** Reuse the first instance's ID to test duplicate-identity rejection. */ config => {
    config.servers[1].id = "1";
  })], ["duplicate targets", changed(/** Reuse the first instance's route to test duplicate-target rejection. */ config => {
    config.servers[1].base = config.servers[0].base;
  })], ["missing label", changed(/** Omit a target label to test that a human-readable name is required. */ config => {
    delete config.servers[0].label;
  })], ["nontext label", changed(/** Use a numeric label to test its required text type. */ config => {
    config.servers[0].label = 42;
  })], ["blank label", changed(/** Use whitespace-only text to test rejection of empty normalized labels. */ config => {
    config.servers[0].label = "  ";
  })], ["oversized label", changed(/** Exceed the label limit by one character to test the exact upper boundary. */ config => {
    config.servers[0].label = "x".repeat(121);
  })], ["multiline label", changed(/** Insert a newline to test rejection of multiline labels. */ config => {
    config.servers[0].label = "First\nSecond";
  })], ["control character label", changed(/** Insert a NUL character to test rejection of embedded control data. */ config => {
    config.servers[0].label = "DNS\u0000";
  })], ["delete character label", changed(/** Insert the DEL control character to test that boundary of the prohibited range. */ config => {
    config.servers[0].label = "DNS\u007f";
  })], ["C1 control character label", changed(/** Insert a C1 control character to cover control codes outside basic ASCII. */ config => {
    config.servers[0].label = "DNS\u0085";
  })], ["lone high surrogate label", changed(/** Insert an unpaired high surrogate to test rejection of malformed Unicode text. */ config => {
    config.servers[0].label = "DNS\ud800";
  })], ["lone low surrogate label", changed(/** Insert an unpaired low surrogate to cover the other malformed Unicode case. */ config => {
    config.servers[0].label = "DNS\udc00";
  })], ["missing base", changed(/** Remove the public API base to test that every instance has a route. */ config => {
    delete config.servers[0].base;
  })], ["nontext base", changed(/** Use a numeric API base to test strict URL text typing. */ config => {
    config.servers[0].base = 42;
  })]];
  for (const base of ["/api1", "/api1/", "/api1/" + "a".repeat(63), "/api1/" + "a".repeat(65), "/api1/" + "A".repeat(64), "/api1/" + "g".repeat(64), "/api2/" + "a".repeat(64), "/api1/" + "a".repeat(64) + "/", "/api1/" + "a".repeat(64) + "?target=other", "/api1/" + "a".repeat(64) + "#other", "https://private.invalid/api1/" + "a".repeat(64), "//private.invalid/api1/" + "a".repeat(64), "/api1/../api2/" + "a".repeat(64), "/api1/%2e%2e/" + "a".repeat(64), "/api1\\" + "a".repeat(64)]) cases.push(["unsafe base " + base, changed(/** Apply each unsafe route variant to an otherwise valid instance so rejection is attributable to the route. */ config => {
    config.servers[0].base = base;
  })]);
  for (const [description, input] of cases) {
    app.context.testConfig = input;
    assert.throws(/** Invoke the actual runtime validator with the current invalid document and require it to throw. */ () => app.read("validateRuntimeConfig(testConfig)"), description);
  }
});
test("missing translations fall back to English, then the literal key", /** Verify English fallback and literal-key fallback, including unsupported languages and inherited property names. */ () => {
  const app = loadApp();
  app.read('I18N.en["test.englishOnly"] = "Hello {name}"; currentLanguage = "de";');
  assert.equal(app.read('msg("test.englishOnly", { name: "Daniel" })'), "Hello Daniel");
  assert.equal(app.read('msg("test.unknown")'), "test.unknown");
  assert.equal(app.read('msg("toString")'), "toString");
  app.read('currentLanguage = "unsupported";');
  assert.equal(app.read('msg("test.englishOnly", { name: "Daniel" })'), "Hello Daniel");
});
test("interpolation preserves raw user data without replacements or a second interpolation pass", /** Verify single-pass interpolation preserves raw user text, replacement-like characters and falsey values. */ () => {
  const app = loadApp();
  app.read('I18N.en["test.raw"] = "{value} | {other} | {value}"; currentLanguage = "en";');
  const raw = 'Forrige Næste Slet ikke logget ind {other} $& $1 $$ <b>"DNS"</b> \' & 😀';
  app.context.testRawValue = raw;
  assert.equal(app.read('msg("test.raw", { value: testRawValue, other: "marker" })'), `${raw} | marker | ${raw}`);
  assert.equal(app.read('msg("test.raw", { value: "" })'), " | {other} | ");
  assert.equal(app.read('msg("test.raw", { value: 0, other: false })'), "0 | false | 0");
});
test("HTML messages escape the whole translated message and parameter values", /** Verify HTML-safe messages escape the entire translation and its interpolated parameters. */ () => {
  const app = loadApp();
  app.context.testHtmlTemplate = `<label>"{value}" & '</label>`;
  app.read('I18N.en["test.html"] = testHtmlTemplate; currentLanguage = "en";');
  const raw = '<img src=x onerror="alert(1)"> & \' $& {value}';
  app.context.testRawValue = raw;
  const plain = `<label>"${raw}" & '</label>`;
  const expected = plain.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  assert.equal(app.read('msg("test.html", { value: testRawValue })'), plain);
  assert.equal(app.read('htmlMsg("test.html", { value: testRawValue })'), expected);
});
test("plural messages use locale rules and a localized count, including fractional counts", /** Check locale-specific plural categories and formatted counts, including zero, large and fractional values. */ () => {
  const app = loadApp();
  const languages = app.value("SUPPORTED_LANGUAGES");
  for (const [language, {
    locale
  }] of Object.entries(languages)) {
    app.read(`currentLanguage = ${JSON.stringify(language)};
      I18N[currentLanguage]["test.items.one"] = "one: {count} / {name}";
      I18N[currentLanguage]["test.items.other"] = "other: {count} / {name}";`);
    for (const count of [0, 1, 2, 1000, 1.5]) {
      const category = new Intl.PluralRules(locale).select(count);
      const expected = `${category}: ${new Intl.NumberFormat(locale).format(count)} / Forrige`;
      assert.equal(app.read(`msgCount("test.items", ${count}, { name: "Forrige", count: "ignored" })`), expected, `${language}: ${count}`);
    }
  }
});
test("number, percent and timestamp formatting follows the selected locale", /** Compare numeric, percentage and timestamp formatting with the selected locale and test invalid-value fallbacks. */ () => {
  const app = loadApp();
  const timestamp = 1760703000;
  for (const [language, {
    locale
  }] of Object.entries(app.value("SUPPORTED_LANGUAGES"))) {
    app.read(`currentLanguage = ${JSON.stringify(language)};`);
    assert.equal(app.read("localeCode()"), locale);
    assert.equal(app.read("fmtNum(12345.6)"), new Intl.NumberFormat(locale).format(12345.6));
    assert.equal(app.read("fmtPct(12.5)"), new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 1
    }).format(0.125));
    assert.equal(app.read(`fmtDate(${timestamp})`), new Date(timestamp * 1000).toLocaleString(locale));
    assert.equal(app.read("fmtDate(0)"), app.read('msg("common.never")'));
    for (const value of ["null", "undefined", "NaN", "Infinity", '"invalid"']) {
      assert.equal(app.read(`fmtNum(${value})`), "–");
      assert.equal(app.read(`fmtPct(${value})`), "–");
    }
  }
});
test("explicit bindings update all supported attributes while user content remains unchanged", /** Translate only explicit binding attributes while leaving ordinary content, attributes and input values unchanged. */ () => {
  const app = loadApp({
    saved: "de"
  });
  app.read('I18N.de["test.bound"] = "Deutsch <b> & {version}";');
  const root = new ElementStub("section");
  const raw = 'Forrige Næste Slet {version} $& <client> "DNS"';
  const untouched = new ElementStub("span", {
    title: raw,
    "aria-label": raw
  }, raw);
  const label = new ElementStub("span", {
    "data-i18n": "test.bound"
  }, "old label");
  const input = new ElementStub("input", {
    "data-i18n-title": "test.bound",
    "data-i18n-aria-label": "test.bound",
    "data-i18n-placeholder": "test.bound",
    title: "old",
    "aria-label": "old",
    placeholder: "old"
  });
  input.value = raw;
  const metadata = new ElementStub("meta", {
    "data-i18n-content": "test.bound",
    content: "old"
  });
  root.append(untouched, label, input, metadata);
  app.context.testRoot = root;
  app.read("applyI18n(testRoot)");
  const expected = `Deutsch <b> & ${app.read("APP_VERSION")}`;
  assert.equal(label.textContent, expected);
  assert.equal(label.innerHTML, "", "bindings write textContent, never translation HTML");
  for (const attribute of ["title", "aria-label", "placeholder"]) assert.equal(input.getAttribute(attribute), expected);
  assert.equal(metadata.getAttribute("content"), expected);
  assert.equal(input.value, raw);
  assert.equal(untouched.textContent, raw);
  assert.equal(untouched.getAttribute("title"), raw);
  assert.equal(untouched.getAttribute("aria-label"), raw);
  app.context.testRoot = label;
  label.textContent = "reset";
  app.read("applyI18n(testRoot)");
  assert.equal(label.textContent, expected, "the explicitly bound root itself is translated");
});
test("the language selector exposes all three native labels and persists a supported choice", /** Initialize the language selector, inspect native labels and persist a normalized supported language choice. */ async () => {
  const app = loadApp({
    saved: "en"
  });
  app.read("initI18n()");
  const select = app.document.getElementById("languageSelect");
  const options = [...select.innerHTML.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/gu)].map(/** Extract each generated option's language code and visible native-language label. */ match => [match[1], match[2]]);
  assert.deepEqual(options, [["da", "Dansk"], ["en", "English"], ["de", "Deutsch"]]);
  await app.read('setLanguage("de-AT", false)');
  assert.equal(app.read("currentLanguage"), "de");
  assert.equal(app.document.documentElement.lang, "de");
  assert.equal(select.value, "de");
  assert.equal(app.read("localStorage.getItem(LANGUAGE_KEY)"), "de");
});
test("unavailable browser storage still permits automatic selection and in-memory language changes", /** Deny browser storage and verify automatic language selection and later in-memory switching still work. */ async () => {
  const app = loadApp({
    languages: ["de-DE"],
    storageDenied: true
  });
  assert.equal(app.read("currentLanguage"), "de");
  assert.equal(app.read("storedValue(LANGUAGE_KEY)"), null);
  await app.read('setLanguage("da", false)');
  assert.equal(app.read("currentLanguage"), "da");
  assert.equal(app.document.documentElement.lang, "da");
});
test("all static translation references, conditional branches and tab keys exist", /** Find message references independently of catalog definitions, including plural variants and static attribute bindings. */ () => {
  const app = loadApp();
  const catalog = app.value("I18N.en");
  const application = withoutCatalog(source);
  const namespaces = new Set(Object.keys(catalog).map(/** Extract known message namespaces so dotted application strings can be checked without treating unrelated values as keys. */ key => key.split(".")[0]));
  const references = new Set();
  for (const match of application.matchAll(/\b(msg|htmlMsg|msgCount)\s*\(/gu)) {
    const argument = firstArgument(application, match.index + match[0].length);
    for (const key of keyLiterals(argument)) {
      if (match[1] === "msgCount") {
        references.add(`${key}.one`);
        references.add(`${key}.other`);
      } else {
        references.add(key);
      }
    }
  }
  for (const key of keyLiterals(application)) {
    if (namespaces.has(key.split(".")[0]) && !Object.hasOwn(catalog, `${key}.one`)) references.add(key);
  }
  for (const match of html.matchAll(/\bdata-i18n(?:-(?:title|aria-label|placeholder|content))?="([a-z][A-Za-z0-9_.-]+)"/gu)) {
    references.add(match[1]);
  }
  for (const [, key] of app.value("TABS")) references.add(key);
  assert.ok(references.size > 0, "application references were inspected independently of catalog definitions");
  const missing = [...references].filter(/** Select referenced keys that have no direct entry in the English fallback catalog. */ key => !Object.hasOwn(catalog, key)).sort();
  assert.deepEqual(missing, [], "every referenced message and plural form must exist");
});
test("legacy text-replacement translation and mutation observers are absent", /** Guard against reintroducing text-replacement translation machinery or mutation-observer-based translation. */ () => {
  assert.doesNotMatch(source, /\bnew\s+MutationObserver\b/u);
  assert.doesNotMatch(source, /\b(?:ENGLISH_TEXT|ENGLISH_REPLACEMENTS|originalTextNodes|originalAttributes|translateUiString|translateDynamicUiText|translateTextNode|translateAttributes|i18nObserver)\b/u);
  assert.doesNotMatch(source, /\btr\s*\(/u);
});
