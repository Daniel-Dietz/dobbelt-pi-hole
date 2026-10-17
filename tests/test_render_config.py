"""Configuration-contract checks; these require only the Python standard library."""

import copy
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "tools" / "render_config.py"
SPEC = importlib.util.spec_from_file_location("dashboard_render_config", RENDERER)
renderer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = renderer
SPEC.loader.exec_module(renderer)


def valid_config():
    """Return fresh canonical input with two distinct targets and mixed TLS settings.

    The first label deliberately contains Unicode and HTML-like punctuation;
    tests may mutate this object without changing another test's fixture.
    """
    return {
        "version": 1,
        "servers": [
            {"id": "1", "label": 'Pi-hole <eins> & "Grüße"', "apiUrl": "http://pihole-one.example/api"},
            {"id": "2", "label": "Pi-hole two", "apiUrl": "https://pihole-two.example:8443/api", "verifyTls": False},
        ],
    }


def identity_base(identifier, api_url):
    """Compute the expected route for an ID and normalized API URL independently.

    Tests use this helper to check the public destination-binding contract
    without calling the renderer's own identity implementation.
    """
    return "/api" + identifier + "/" + hashlib.sha256((identifier + "\0" + api_url).encode("utf-8")).hexdigest()


class ValidationTests(unittest.TestCase):
    """Check canonical JSON shape, supported values and normalized server uniqueness."""

    def test_defaults_and_normalized_server_fields(self):
        """Check missing defaults and harmless normalization without losing explicit choices.

        Trim labels, canonicalize the API URL and default language/TLS policy,
        while preserving the second server's explicit verification override.
        """
        config = valid_config()
        config["servers"][0].update({"label": "  Main Pi-hole  ", "apiUrl": "HTTP://PIHOLE-ONE.EXAMPLE:80/api/"})
        normalized = renderer.validate_config(config)
        self.assertEqual(normalized, {
            "version": 1, "defaultLanguage": "auto",
            "servers": [
                {"id": "1", "label": "Main Pi-hole", "apiUrl": "http://pihole-one.example/api", "verifyTls": True},
                {"id": "2", "label": "Pi-hole two", "apiUrl": "https://pihole-two.example:8443/api", "verifyTls": False},
            ],
        })

    def test_two_three_and_four_servers_and_supported_languages(self):
        """Accept every supported instance count with auto, Danish, English and German."""
        for count in (2, 3, 4):
            for language in ("auto", "da", "en", "de"):
                with self.subTest(count=count, language=language):
                    config = {"version": 1, "defaultLanguage": language, "servers": [
                        {"id": str(number), "label": "Server " + str(number), "apiUrl": f"http://fixture-{number}/api"}
                        for number in range(1, count + 1)
                    ]}
                    self.assertEqual(len(renderer.validate_config(config)["servers"]), count)

    def test_rejects_wrong_top_level_types_version_and_language(self):
        """Reject invalid document shapes, schema versions and language values.

        Booleans and strings must not masquerade as the supported integer
        version, and locale variants are not canonical defaultLanguage values.
        """
        for value in (None, [], "config", 1, True, {"version": 1}, {"servers": []}):
            with self.subTest(value=value), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(value)
        for version in (None, "1", True, 0, 2):
            config = valid_config()
            config["version"] = version
            with self.subTest(version=version), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)
        for language in (None, "fr", "de-DE", True, 1):
            config = valid_config()
            config["defaultLanguage"] = language
            with self.subTest(language=language), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)

    def test_rejects_unknown_keys_at_both_levels(self):
        """Reject misspelled, obsolete or secret-bearing keys rather than ignoring them.

        Check both document settings and individual server entries so a typo
        cannot silently leave an administrator's intended setting unapplied.
        """
        for key in ("serverCount", "password", "defaultLangauge"):
            config = valid_config()
            config[key] = "unsupported"
            with self.subTest(key=key), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)
        for key in ("apiURL", "base", "color", "password"):
            config = valid_config()
            config["servers"][0][key] = "unsupported"
            with self.subTest(key=key), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)

    def test_rejects_invalid_server_lists(self):
        """Require two to four server objects, not arbitrary lists or scalar entries."""
        for servers in (None, {}, [], valid_config()["servers"][:1], valid_config()["servers"] * 3):
            config = valid_config()
            config["servers"] = servers
            with self.subTest(servers=servers), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)
        for server in (None, [], 1, "server"):
            config = valid_config()
            config["servers"][0] = server
            with self.subTest(server=server), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)

    def test_rejects_invalid_server_fields_and_missing_required_keys(self):
        """Enforce ID, label, URL and TLS field contracts before proxy rendering.

        Include missing fields, oversized/invalid Unicode labels, injection-
        shaped IDs and values that merely resemble a boolean verification flag.
        """
        cases = {
            "id": [None, 1, "", "0", "5", "01", "1\" onclick=\"alert(1)"],
            "label": [None, 1, "", " \t ", "x" * 121, "\ud800"],
            "apiUrl": [None, 1, ""],
            "verifyTls": [None, "false", 0, 1],
        }
        for key, values in cases.items():
            for value in values:
                config = valid_config()
                config["servers"][0][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(renderer.ConfigError):
                    renderer.validate_config(config)
        for key in ("id", "label", "apiUrl"):
            config = valid_config()
            del config["servers"][0][key]
            with self.subTest(missing=key), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)

    def test_rejects_duplicate_ids_and_equivalent_upstream_urls(self):
        """Reject ambiguous identities even when duplicate targets use different URL spelling.

        Default ports, hostname case and a trailing DNS dot must not let one
        upstream appear as two independent dashboard instances.
        """
        config = valid_config()
        config["servers"][1]["id"] = "1"
        with self.assertRaises(renderer.ConfigError):
            renderer.validate_config(config)
        for url in ("http://pihole-one.example/api", "HTTP://PIHOLE-ONE.EXAMPLE:80/api/", "http://pihole-one.example./api"):
            config = valid_config()
            config["servers"][1]["apiUrl"] = url
            with self.subTest(url=url), self.assertRaises(renderer.ConfigError):
                renderer.validate_config(config)


class URLTests(unittest.TestCase):
    """Check API URL canonicalization and rejection of unsafe nginx input."""

    def test_normalizes_equivalent_urls_and_is_idempotent(self):
        """Canonicalize DNS, IDNA, IP literals and default ports without changing API roots.

        Re-normalizing each expected result must leave it unchanged so route
        identities remain stable across repeated configuration generation.
        """
        cases = {
            "HTTP://EXAMPLE.TEST:80/api/": "http://example.test/api",
            "https://EXAMPLE.TEST.:443/api/": "https://example.test/api",
            "http://192.0.2.10:8080/api": "http://192.0.2.10:8080/api",
            "https://[2001:0DB8:0:0::1]:443/api/": "https://[2001:db8::1]/api",
            "http://bücher.example/api": "http://xn--bcher-kva.example/api",
            "https://example.test/api/v6/": "https://example.test/api/v6",
            "https://example.test/proxy/api/": "https://example.test/proxy/api",
        }
        for original, expected in cases.items():
            with self.subTest(original=original):
                self.assertEqual(renderer.normalize_api_url(original), expected)
                self.assertEqual(renderer.normalize_api_url(expected), expected)

    def test_rejects_unsafe_or_ambiguous_url_components(self):
        """Reject credentials, queries, fragments and paths unsafe for a fixed API target.

        Include traversal, malformed ports/hosts, whitespace and nginx-like
        syntax so rendering cannot reinterpret untrusted URL text as directives.
        """
        values = [
            "ftp://example.test/api", "//example.test/api", "https://example.test",
            "http://user:password@example.test/api", "http://@example.test/api",
            "http://example.test/api?token=fixture", "http://example.test/api?",
            "http://example.test/api#fragment", "http://example.test/api#",
            "http://example.test/api\n", "http://exam\tple.test/api", " http://example.test/api",
            "http://example.test/api path", "http://example.test\\evil/api",
            "http://example.test:0/api", "http://example.test:65536/api", "http://example.test:abc/api",
            "http://[not-an-ip]/api", "http:///api", "http://example.test/api/../admin",
            "http://example.test/api/./v6", "http://example.test/api//v6", "http://example.test/api/%2e%2e/admin",
            "http://example.test/api/$request_uri", "http://example.test/api/;return", "http://example.test/api/\"}",
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(renderer.ConfigError):
                renderer.normalize_api_url(value)


class PublicConfigTests(unittest.TestCase):
    """Check which canonical fields cross into the browser and when route identities change."""

    def test_projection_exposes_only_browser_fields(self):
        """Require public JSON to contain presentation fields and opaque route prefixes only.

        Upstream URLs, hostnames and TLS verification choices stay in the
        private configuration and must not leak through serialization.
        """
        config = renderer.validate_config(valid_config())
        public = renderer.make_public_config(config)
        self.assertEqual(public, {
            "version": 1, "defaultLanguage": "auto",
            "servers": [{"id": server["id"], "label": server["label"],
                         "base": identity_base(server["id"], server["apiUrl"])} for server in config["servers"]],
        })
        serialized = json.dumps(public)
        for private in ("apiUrl", "verifyTls", "pihole-one.example", "pihole-two.example"):
            self.assertNotIn(private, serialized)

    def test_identity_tracks_target_changes_but_survives_renaming_and_reordering(self):
        """Keep sessions stable for display changes but invalidate a changed destination.

        Renaming and reordering preserve each ID's route; replacing one URL
        changes only that server's route and leaves the other identity intact.
        """
        config = renderer.validate_config(valid_config())
        original = {server["id"]: server["base"] for server in renderer.make_public_config(config)["servers"]}
        renamed = copy.deepcopy(config)
        renamed["servers"][0]["label"] = "New display name"
        renamed["servers"].reverse()
        current = {server["id"]: server["base"] for server in renderer.make_public_config(renamed)["servers"]}
        self.assertEqual(current, original)
        replaced = copy.deepcopy(config)
        replaced["servers"][0]["apiUrl"] = "http://replacement.example/api"
        current = renderer.make_public_config(replaced)["servers"]
        self.assertNotEqual(current[0]["base"], original["1"])
        self.assertEqual(current[1]["base"], original["2"])


class ProxyRenderingTests(unittest.TestCase):
    """Check generated nginx resolver, TLS and response-policy directives.

    These tests inspect rendered configuration. The separate Docker suite
    verifies that those policies behave as expected in a running nginx process.
    """

    def test_resolvers_come_from_the_supplied_file_and_support_ipv6(self):
        """Use only normalized, deduplicated IP resolvers from the selected file.

        IPv6 addresses need nginx brackets, while malformed nameserver entries
        and scoped addresses must cause a configuration error.
        """
        with tempfile.TemporaryDirectory(prefix="dobbelt-resolver-test-") as directory:
            path = Path(directory) / "resolv.conf"
            path.write_text("# Docker DNS\nsearch fixture.test\nnameserver 127.0.0.11\n"
                            "nameserver 2001:0db8::53 # IPv6\nnameserver 127.0.0.11\n", encoding="utf-8")
            self.assertEqual(renderer.read_resolvers(path), ["127.0.0.11", "2001:db8::53"])
            config = renderer.validate_config(valid_config())
            output = renderer.render_nginx(config, "/generated/config.json", ROOT, renderer.read_resolvers(path))
            self.assertIn("resolver 127.0.0.11 [2001:db8::53]", output)
            for contents in ("nameserver not-an-ip\n", "nameserver 127.0.0.11 extra\n", "nameserver fe80::1%eth0\n"):
                path.write_text(contents, encoding="utf-8")
                with self.subTest(contents=contents), self.assertRaises(renderer.ConfigError):
                    renderer.read_resolvers(path)

    def test_hostname_routes_require_a_resolver_but_literal_addresses_do_not(self):
        """Require DNS configuration only when an upstream contains a hostname.

        Literal IPv4 and IPv6 routes remain renderable without a resolver file
        supplying any addresses.
        """
        config = renderer.validate_config(valid_config())
        with self.assertRaises(renderer.ConfigError):
            renderer.render_nginx(config, "/generated/config.json", ROOT, [])
        config["servers"][0]["apiUrl"] = "http://192.0.2.10/api"
        config["servers"][1]["apiUrl"] = "http://[2001:db8::10]/proxy/api"
        output = renderer.render_nginx(config, "/generated/config.json", ROOT, [])
        self.assertIn("http://[2001:db8::10]/proxy/api", output)

    def test_tls_verification_defaults_to_on_and_can_be_explicitly_disabled(self):
        """Render verified HTTPS by default and honor only explicit per-target overrides.

        Check the selected CA bundle and mutually exclusive on/off directives;
        actual certificate handshakes are covered by the container suite.
        """
        config = valid_config()
        config["servers"][0]["apiUrl"] = "https://pihole-one.example/api"
        del config["servers"][1]["verifyTls"]
        normalized = renderer.validate_config(config)
        verified = renderer.render_nginx(normalized, "/generated/config.json", ROOT, ["127.0.0.11"],
                                          ca_bundle="/certs/fixture-ca.pem")
        self.assertIn("proxy_ssl_verify on;", verified)
        self.assertNotIn("proxy_ssl_verify off;", verified)
        self.assertIn("/certs/fixture-ca.pem", verified)
        for server in config["servers"]:
            server["verifyTls"] = False
        unverified = renderer.render_nginx(renderer.validate_config(config), "/generated/config.json", ROOT, ["127.0.0.11"])
        self.assertIn("proxy_ssl_verify off;", unverified)
        self.assertNotIn("proxy_ssl_verify on;", unverified)

    def test_proxy_isolates_front_proxy_credentials_and_preserves_streaming_policy(self):
        """Require credential isolation, unbuffered proxying and headers on error responses.

        Inspect directives that suppress browser/upstream authentication state,
        ignore backend X-Accel controls and apply each security header exactly
        once with nginx's always flag.
        """
        output = renderer.render_nginx(renderer.validate_config(valid_config()), "/generated/config.json", ROOT, ["127.0.0.11"])
        for directive in (
            'proxy_set_header Authorization "";', 'proxy_set_header Cookie "";',
            "proxy_hide_header Set-Cookie;", "proxy_hide_header WWW-Authenticate;",
            "proxy_cache off;", "proxy_intercept_errors off;", "proxy_buffering off;",
            "proxy_read_timeout 300s;", "proxy_ssl_protocols TLSv1.2 TLSv1.3;",
        ):
            self.assertIn(directive, output)
        self.assertIn("proxy_ignore_headers X-Accel-Redirect X-Accel-Buffering", output)
        self.assertIn("server_tokens off;", output)
        for header in ("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy",
                       "Permissions-Policy", "Cross-Origin-Resource-Policy", "Cache-Control"):
            matching = [line for line in output.splitlines() if line.strip().startswith("add_header " + header + " ")]
            self.assertEqual(len(matching), 1)
            self.assertTrue(matching[0].endswith(" always;"), header)


class ContentSecurityPolicyTests(unittest.TestCase):
    """Check script-hash CSP generation against controlled HTML bytes."""

    def setUp(self):
        """Allocate an empty temporary HTML path for each CSP scenario and its cleanup."""
        self.directory = tempfile.TemporaryDirectory(prefix="dobbelt-csp-test-")
        self.addCleanup(self.directory.cleanup)
        self.index = Path(self.directory.name) / "index.html"

    def test_hashes_inline_scripts_exactly_with_html_newline_normalization(self):
        """Hash inline code as the HTML parser sees it, including Unicode and newlines.

        External Chart.js remains allowed through self; inline event handlers
        remain blocked, while dynamic inline styles retain their existing policy.
        """
        script = '\nwindow.example = "Grüße & <text>";\n'
        other = "window.second = true;"
        self.index.write_bytes(('<script src="chart.umd.min.js"></script><script>' + script.replace("\n", "\r\n")
                                + "</script><script>" + other + "</script>").encode("utf-8"))
        policy = renderer.content_security_policy(self.index)
        directives = dict(part.strip().split(" ", 1) for part in policy.split(";") if part.strip())
        expected = ["'sha256-" + base64.b64encode(hashlib.sha256(value.encode("utf-8")).digest()).decode("ascii") + "'"
                    for value in (script, other)]
        self.assertEqual(directives["script-src"], "'self' " + " ".join(expected))
        self.assertNotIn("unsafe-inline", directives["script-src"])
        self.assertNotIn("unsafe-eval", directives["script-src"])
        self.assertEqual(directives["script-src-attr"], "'none'")
        self.assertIn("'unsafe-inline'", directives["style-src"], "Dynamic styles remain supported")

    def test_script_change_replaces_the_allowed_hash(self):
        """Remove the former script hash when changed application bytes are rendered."""
        self.index.write_text("<script>window.version = 1;</script>", encoding="utf-8")
        previous = renderer.content_security_policy(self.index)
        self.index.write_text("<script>window.version = 2;</script>", encoding="utf-8")
        current = renderer.content_security_policy(self.index)
        self.assertNotEqual(previous, current)
        previous_hash = previous.split("'sha256-", 1)[1].split("'", 1)[0]
        self.assertNotIn(previous_hash, current)

    def test_missing_or_unreadable_application_fails_closed(self):
        """Refuse to generate a script policy without valid, bounded application content.

        Cover an absent file, missing/incomplete script tags, NUL bytes,
        invalid UTF-8 and oversized input instead of allowing broad script access.
        """
        with self.assertRaises(renderer.ConfigError):
            renderer.content_security_policy(self.index)
        for content in (b"<html>No app</html>", b"<script>incomplete", b"<script>\0</script>",
                        b"<script>\xff</script>", b" " * (renderer.MAX_APP_BYTES + 1)):
            with self.subTest(content=content[:30]):
                self.index.write_bytes(content)
                with self.assertRaises(renderer.ConfigError):
                    renderer.content_security_policy(self.index)


class FileAndCLITests(unittest.TestCase):
    """Exercise real renderer CLI output and preservation of administrator-owned files."""

    def setUp(self):
        """Create isolated source/output paths and a deterministic DNS resolver file.

        Each subprocess operates inside these temporary paths, which are
        removed through the test's registered cleanup.
        """
        self.directory = tempfile.TemporaryDirectory(prefix="dobbelt-config-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "config.json"
        self.output = self.root / "generated"
        self.resolver_file = self.root / "resolv.conf"
        self.resolver_file.write_text("nameserver 127.0.0.11\n", encoding="utf-8")

    def run_renderer(self, *extra_args):
        """Run the real renderer with fixture paths and return captured process output.

        Append caller-supplied CLI options for individual scenarios. A nonzero
        status is returned for assertions rather than raised; execution is
        bounded to ten seconds and uses the current Python interpreter.
        """
        return subprocess.run([
            sys.executable, str(RENDERER), "--config", str(self.source), "--output-dir", str(self.output),
            "--web-root", str(ROOT), "--resolver-file", str(self.resolver_file),
            *extra_args,
        ], cwd=ROOT, capture_output=True, text=True, timeout=10)

    def test_load_rejects_missing_malformed_and_duplicate_key_files(self):
        """Reject unusable JSON files and ambiguous duplicate keys at either nesting level.

        Include an invalid Unicode surrogate so successful JSON parsing alone
        cannot bypass the canonical field contract.
        """
        with self.assertRaises(renderer.ConfigError):
            renderer.load_config(self.source)
        surrogate = valid_config()
        surrogate["servers"][0]["label"] = "\ud800"
        values = ["{ malformed", "null", '{"version":1,"version":1,"servers":[]}',
                  json.dumps(valid_config()).replace('"id": "1"', '"id": "1", "id": "1"'), json.dumps(surrogate)]
        for value in values:
            self.source.write_text(value, encoding="utf-8")
            with self.subTest(value=value), self.assertRaises(renderer.ConfigError):
                renderer.load_config(self.source)

    def test_cli_generates_public_json_and_proxy_from_the_same_canonical_file(self):
        """Check both generated artifacts agree while preserving the source file's bytes.

        Route identities appear in public JSON and nginx, private hostnames
        appear only where needed for proxying, and labels do not become nginx
        configuration text. The supplied resolver must reach the output.
        """
        source = json.dumps(valid_config(), ensure_ascii=False, indent=2)
        self.source.write_text(source, encoding="utf-8")
        result = self.run_renderer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        public = json.loads((self.output / "config.json").read_text(encoding="utf-8"))
        expected = renderer.make_public_config(renderer.validate_config(valid_config()))
        self.assertEqual(public, expected)
        generated = (self.output / "nginx.conf").read_text(encoding="utf-8")
        for server in public["servers"]:
            self.assertIn(server["base"], generated)
        for hostname in ("pihole-one.example", "pihole-two.example"):
            self.assertIn(hostname, generated)
        self.assertIn("127.0.0.11", generated)
        self.assertIn("dashboard_config_changed", generated)
        self.assertIn(str(self.output / "config.json"), generated)
        self.assertNotIn(valid_config()["servers"][0]["label"], generated)
        self.assertEqual(self.source.read_text(encoding="utf-8"), source, "Rendering must not rewrite the editable file")

    def test_invalid_reconfiguration_returns_nonzero_without_partially_replacing_outputs(self):
        """Keep both previously generated files intact when new canonical input is invalid.

        Require the CLI's configuration-error status and diagnostic; this
        covers validation failure before writing, not rollback after activation.
        """
        self.source.write_text(json.dumps(valid_config()), encoding="utf-8")
        result = self.run_renderer()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        before = {name: (self.output / name).read_bytes() for name in ("config.json", "nginx.conf")}
        self.source.write_text('{"version":1,"servers":[]}', encoding="utf-8")
        result = self.run_renderer()
        self.assertEqual(result.returncode, 2)
        self.assertIn("Configuration error:", result.stderr)
        self.assertEqual({name: (self.output / name).read_bytes() for name in before}, before)

    def test_cli_cannot_overwrite_the_canonical_source_with_generated_files(self):
        """Reject output paths that collide with either possible canonical source filename.

        Check source bytes remain unchanged when config.json or nginx.conf
        would otherwise be overwritten in the selected output directory.
        """
        original = json.dumps(valid_config())
        for filename in ("config.json", "nginx.conf"):
            with self.subTest(filename=filename):
                self.source = self.root / filename
                self.source.write_text(original, encoding="utf-8")
                self.output = self.source.parent
                result = self.run_renderer()
                self.assertEqual(result.returncode, 2)
                self.assertIn("Configuration error:", result.stderr)
                self.assertEqual(self.source.read_text(encoding="utf-8"), original)

    def test_cli_can_bind_only_to_a_literal_ipv4_or_ipv6_address(self):
        """Check wildcard defaults and exclusive literal-address listener overrides.

        An explicit bind must remove the wildcard listeners. Hostnames, scoped
        or bracketed addresses, embedded ports and directive injection are
        rejected instead of being copied into nginx's listen syntax.
        """
        self.source.write_text(json.dumps(valid_config()), encoding="utf-8")
        result = self.run_renderer()
        self.assertEqual(result.returncode, 0, result.stderr)
        # Re-read the current output on each call so every CLI invocation is checked.
        listeners = lambda: [line.strip() for line in (self.output / "nginx.conf").read_text(encoding="utf-8").splitlines()
                             if line.strip().startswith("listen ")]
        self.assertEqual(listeners(), ["listen 8080;", "listen [::]:8080;"])
        for address, expected in (("127.0.0.1", "listen 127.0.0.1:8080;"), ("::1", "listen [::1]:8080;")):
            with self.subTest(address=address):
                result = self.run_renderer("--listen-address", address)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(listeners(), [expected], "An explicit bind must not also expose a wildcard listener")
        for invalid in ("localhost", "127.0.0.1:8080", "[::1]", "fe80::1%eth0", "127.0.0.1; listen 80"):
            with self.subTest(invalid=invalid):
                result = self.run_renderer("--listen-address", invalid)
                self.assertEqual(result.returncode, 2)
                self.assertIn("listen", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
