"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)]
  .filter((match) => !/\bsrc\s*=/iu.test(match[1]))
  .map((match) => match[2]);
const source = inlineScripts.find((script) => /\bconst\s+I18N\s*=/u.test(script));
assert.ok(source, "index.html must contain its keyed catalogs and application script");
const startupMarker = "// Start the dashboard.";
const startupOffset = source.indexOf(startupMarker);
assert.ok(startupOffset >= 0, "The startup marker keeps unit tests independent of Pi-hole APIs");
const definitions = source.slice(0, startupOffset);

/** A browser-like storage map; tests never use the host's files or credentials. */
function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); }
  };
}

/** Minimal explicit-attribute DOM for i18n bindings; real layout is browser-tested. */
class ElementStub {
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
  get id() { return this.getAttribute("id") || ""; }
  get attributes() {
    return [...this.attributesMap].map(([name, value]) => ({ name, value }));
  }
  getAttribute(name) { return this.attributesMap.get(name) ?? null; }
  hasAttribute(name) { return this.attributesMap.has(name); }
  setAttribute(name, value) { this.attributesMap.set(name, String(value)); }
  append(...elements) { this.children.push(...elements); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      const attribute = /^\[([^\]=]+)\]$/u.exec(value);
      if (attribute) return this.hasAttribute(attribute[1]);
      if (value.startsWith("#")) return this.id === value.slice(1);
      return this.tagName.toLowerCase() === value.toLowerCase();
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function documentStub() {
  const document = new ElementStub("document");
  document.nodeType = 9;
  document.documentElement = new ElementStub("html");
  document.body = new ElementStub("body");
  document.append(document.documentElement);
  document.documentElement.append(document.body);
  for (const id of ["languageSelect", "tabs", "serverPills", "tabContent", "toastArea"]) {
    document.body.append(new ElementStub(id === "languageSelect" ? "select" : "div", { id }));
  }
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.createElement = (tagName) => new ElementStub(tagName);
  return document;
}

/** Evaluate production declarations with bootstrap and network activity disabled. */
function loadApp({ saved = null, languages = ["en-GB"], storageDenied = false } = {}) {
  const document = documentStub();
  const sandbox = {
    document,
    navigator: { languages, language: languages[0] || "en-GB" },
    localStorage: memoryStorage(saved === null ? {} : { ph_combo_language: saved }),
    sessionStorage: memoryStorage(),
    Element: ElementStub,
    Node: { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, TEXT_NODE: 3 },
    location: { hash: "", href: "https://dashboard.example.test/" },
    history: { replaceState() {} },
    console,
    structuredClone,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    setTimeout() { return 0; },
    clearTimeout() {},
    addEventListener() {},
    fetch() { throw new Error("Unit tests must not contact Pi-hole instances"); }
  };
  sandbox.window = sandbox;
  if (storageDenied) {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(sandbox, name, {
        get() { throw new Error("Browser storage is unavailable"); },
        configurable: true
      });
    }
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(definitions, context, { filename: "index.html:inline", timeout: 5000 });
  return {
    context,
    document,
    read(expression) { return vm.runInContext(expression, context, { timeout: 5000 }); },
    value(expression) { return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)); }
  };
}

function parameterNames(message) {
  return [...new Set([...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)]
    .map((match) => match[1]))].sort();
}

/** Skip quoted text while finding declaration or call boundaries. */
function quoteEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === quote) return index + 1;
  }
  throw new Error("Unterminated quoted text in application source");
}

/** Exclude the catalog itself so unused catalog entries cannot hide missing references. */
function withoutCatalog(text) {
  const declaration = /\bconst\s+I18N\s*=/u.exec(text);
  assert.ok(declaration, "Catalog declaration exists");
  const start = text.indexOf("{", declaration.index + declaration[0].length);
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (["'", '"', "`"].includes(text[index])) { index = quoteEnd(text, index) - 1; continue; }
    if (text[index] === "{") depth++;
    if (text[index] === "}" && --depth === 0) return text.slice(0, declaration.index) + text.slice(index + 1);
  }
  throw new Error("Unterminated I18N catalog");
}

function firstArgument(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (["'", '"', "`"].includes(character)) { index = quoteEnd(text, index) - 1; continue; }
    if (depth === 0 && [",", ")"].includes(character)) return text.slice(start, index);
    if (["(", "[", "{"].includes(character)) depth++;
    if ([")", "]", "}"].includes(character)) depth--;
  }
  throw new Error("Unterminated translation call");
}

function keyLiterals(text) {
  return [...text.matchAll(/(["'])([a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)\1/gu)]
    .map((match) => match[2]);
}

test("the complete inline application is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: "index.html:inline" }));
});

test("Danish, English and German have identical nonempty semantic keys and parameters", () => {
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
      assert.deepEqual(parameterNames(catalogs[language][key]), parameterNames(catalogs.en[key]),
        `${language}/${key}: named parameters match English`);
    }
  }
});

test("supported language metadata contains native labels and formatting locales", () => {
  const app = loadApp();
  assert.deepEqual(app.value("SUPPORTED_LANGUAGES"), {
    da: { label: "Dansk", locale: "da-DK" },
    en: { label: "English", locale: "en-GB" },
    de: { label: "Deutsch", locale: "de-DE" }
  });
  assert.equal(app.read("LANGUAGE_KEY"), "ph_combo_language");
  assert.match(app.read("APP_VERSION"), /^\d+\.\d+\.\d+$/u);
});

test("language resolution honors saved preferences, regional tags and browser order", () => {
  const app = loadApp();
  for (const [input, expected] of [["da-DK", "da"], ["DE-at", "de"], [" de-CH ", "de"], ["en-GB", "en"], ["en_US", "en"]]) {
    assert.equal(app.read(`normalizeLanguage(${JSON.stringify(input)})`), expected);
  }
  for (const input of [null, 42, {}, "", "fr-FR", "constructor", "__proto__"]) {
    assert.equal(app.read(`normalizeLanguage(${JSON.stringify(input)})`), null);
  }
  const cases = [
    ["de-DE", ["da-DK", "en-GB"], "de"],
    ["EN-gb", ["de-DE", "da-DK"], "en"],
    ["invalid", ["fr-FR", "de-AT", "en-GB"], "de"],
    [null, ["fr-FR", "da-DK", "de-DE"], "da"],
    [null, ["en-US", "de-DE"], "en"],
    ["fr-FR", ["ja-JP", "th-TH"], "en"],
    [null, [], "en"],
    [null, null, "en"]
  ];
  for (const [saved, languages, expected] of cases) {
    assert.equal(app.read(`resolveLanguage(${JSON.stringify(saved)}, ${JSON.stringify(languages)})`), expected);
  }
  assert.equal(loadApp({ saved: "de-AT", languages: ["en-GB"] }).read("currentLanguage"), "de");
  assert.equal(loadApp({ saved: "invalid", languages: ["fr-FR", "da-DK"] }).read("currentLanguage"), "da");
});

test("missing translations fall back to English, then the literal key", () => {
  const app = loadApp();
  app.read('I18N.en["test.englishOnly"] = "Hello {name}"; currentLanguage = "de";');
  assert.equal(app.read('msg("test.englishOnly", { name: "Daniel" })'), "Hello Daniel");
  assert.equal(app.read('msg("test.unknown")'), "test.unknown");
  assert.equal(app.read('msg("toString")'), "toString");
  app.read('currentLanguage = "unsupported";');
  assert.equal(app.read('msg("test.englishOnly", { name: "Daniel" })'), "Hello Daniel");
});

test("interpolation preserves raw user data without replacements or a second interpolation pass", () => {
  const app = loadApp();
  app.read('I18N.en["test.raw"] = "{value} | {other} | {value}"; currentLanguage = "en";');
  const raw = 'Forrige Næste Slet ikke logget ind {other} $& $1 $$ <b>"DNS"</b> \' & 😀';
  app.context.testRawValue = raw;
  assert.equal(app.read('msg("test.raw", { value: testRawValue, other: "marker" })'),
    `${raw} | marker | ${raw}`);
  assert.equal(app.read('msg("test.raw", { value: "" })'), " | {other} | ");
  assert.equal(app.read('msg("test.raw", { value: 0, other: false })'), "0 | false | 0");
});

test("HTML messages escape the whole translated message and parameter values", () => {
  const app = loadApp();
  app.context.testHtmlTemplate = `<label>"{value}" & '</label>`;
  app.read('I18N.en["test.html"] = testHtmlTemplate; currentLanguage = "en";');
  const raw = '<img src=x onerror="alert(1)"> & \' $& {value}';
  app.context.testRawValue = raw;
  const plain = `<label>"${raw}" & '</label>`;
  const expected = plain.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  assert.equal(app.read('msg("test.html", { value: testRawValue })'), plain);
  assert.equal(app.read('htmlMsg("test.html", { value: testRawValue })'), expected);
});

test("plural messages use locale rules and a localized count, including fractional counts", () => {
  const app = loadApp();
  const languages = app.value("SUPPORTED_LANGUAGES");
  for (const [language, { locale }] of Object.entries(languages)) {
    app.read(`currentLanguage = ${JSON.stringify(language)};
      I18N[currentLanguage]["test.items.one"] = "one: {count} / {name}";
      I18N[currentLanguage]["test.items.other"] = "other: {count} / {name}";`);
    for (const count of [0, 1, 2, 1000, 1.5]) {
      const category = new Intl.PluralRules(locale).select(count);
      const expected = `${category}: ${new Intl.NumberFormat(locale).format(count)} / Forrige`;
      assert.equal(app.read(`msgCount("test.items", ${count}, { name: "Forrige", count: "ignored" })`), expected,
        `${language}: ${count}`);
    }
  }
});

test("number, percent and timestamp formatting follows the selected locale", () => {
  const app = loadApp();
  const timestamp = 1760703000;
  for (const [language, { locale }] of Object.entries(app.value("SUPPORTED_LANGUAGES"))) {
    app.read(`currentLanguage = ${JSON.stringify(language)};`);
    assert.equal(app.read("localeCode()"), locale);
    assert.equal(app.read("fmtNum(12345.6)"), new Intl.NumberFormat(locale).format(12345.6));
    assert.equal(app.read("fmtPct(12.5)"), new Intl.NumberFormat(locale, {
      style: "percent", maximumFractionDigits: 1
    }).format(0.125));
    assert.equal(app.read(`fmtDate(${timestamp})`), new Date(timestamp * 1000).toLocaleString(locale));
    assert.equal(app.read("fmtDate(0)"), app.read('msg("common.never")'));
    for (const value of ["null", "undefined", "NaN", "Infinity", '"invalid"']) {
      assert.equal(app.read(`fmtNum(${value})`), "–");
      assert.equal(app.read(`fmtPct(${value})`), "–");
    }
  }
});

test("explicit bindings update all supported attributes while user content remains unchanged", () => {
  const app = loadApp({ saved: "de" });
  app.read('I18N.de["test.bound"] = "Deutsch <b> & {version}";');
  const root = new ElementStub("section");
  const raw = 'Forrige Næste Slet {version} $& <client> "DNS"';
  const untouched = new ElementStub("span", { title: raw, "aria-label": raw }, raw);
  const label = new ElementStub("span", { "data-i18n": "test.bound" }, "old label");
  const input = new ElementStub("input", {
    "data-i18n-title": "test.bound", "data-i18n-aria-label": "test.bound",
    "data-i18n-placeholder": "test.bound", title: "old", "aria-label": "old", placeholder: "old"
  });
  input.value = raw;
  const metadata = new ElementStub("meta", { "data-i18n-content": "test.bound", content: "old" });
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

test("the language selector exposes all three native labels and persists a supported choice", async () => {
  const app = loadApp({ saved: "en" });
  app.read("initI18n()");
  const select = app.document.getElementById("languageSelect");
  const options = [...select.innerHTML.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/gu)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(options, [["da", "Dansk"], ["en", "English"], ["de", "Deutsch"]]);
  await app.read('setLanguage("de-AT", false)');
  assert.equal(app.read("currentLanguage"), "de");
  assert.equal(app.document.documentElement.lang, "de");
  assert.equal(select.value, "de");
  assert.equal(app.read("localStorage.getItem(LANGUAGE_KEY)"), "de");
});

test("unavailable browser storage still permits automatic selection and in-memory language changes", async () => {
  const app = loadApp({ languages: ["de-DE"], storageDenied: true });
  assert.equal(app.read("currentLanguage"), "de");
  assert.equal(app.read("storedValue(LANGUAGE_KEY)"), null);
  await app.read('setLanguage("da", false)');
  assert.equal(app.read("currentLanguage"), "da");
  assert.equal(app.document.documentElement.lang, "da");
});

test("all static translation references, conditional branches and tab keys exist", () => {
  const app = loadApp();
  const catalog = app.value("I18N.en");
  const application = withoutCatalog(source);
  const namespaces = new Set(Object.keys(catalog).map((key) => key.split(".")[0]));
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
  const missing = [...references].filter((key) => !Object.hasOwn(catalog, key)).sort();
  assert.deepEqual(missing, [], "every referenced message and plural form must exist");
});

test("legacy text-replacement translation and mutation observers are absent", () => {
  assert.doesNotMatch(source, /\bnew\s+MutationObserver\b/u);
  assert.doesNotMatch(source, /\b(?:ENGLISH_TEXT|ENGLISH_REPLACEMENTS|originalTextNodes|originalAttributes|translateUiString|translateDynamicUiText|translateTextNode|translateAttributes|i18nObserver)\b/u);
  assert.doesNotMatch(source, /\btr\s*\(/u);
});
