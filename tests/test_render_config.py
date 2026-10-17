"""Configuration-contract checks; these require only the Python standard library."""

import copy
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
    return {
        "version": 1,
        "servers": [
            {"id": "1", "label": 'Pi-hole <eins> & "Grüße"', "apiUrl": "http://pihole-one.example/api"},
            {"id": "2", "label": "Pi-hole two", "apiUrl": "https://pihole-two.example:8443/api", "verifyTls": False},
        ],
    }


def identity_base(identifier, api_url):
    return "/api" + identifier + "/" + hashlib.sha256((identifier + "\0" + api_url).encode("utf-8")).hexdigest()


class ValidationTests(unittest.TestCase):
    def test_defaults_and_normalized_server_fields(self):
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
        for count in (2, 3, 4):
            for language in ("auto", "da", "en", "de"):
                with self.subTest(count=count, language=language):
                    config = {"version": 1, "defaultLanguage": language, "servers": [
                        {"id": str(number), "label": "Server " + str(number), "apiUrl": f"http://fixture-{number}/api"}
                        for number in range(1, count + 1)
                    ]}
                    self.assertEqual(len(renderer.validate_config(config)["servers"]), count)

    def test_rejects_wrong_top_level_types_version_and_language(self):
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
    def test_normalizes_equivalent_urls_and_is_idempotent(self):
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
    def test_projection_exposes_only_browser_fields(self):
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
    def test_resolvers_come_from_the_supplied_file_and_support_ipv6(self):
        with tempfile.TemporaryDirectory(prefix="dobbelt-resolver-test-") as directory:
            path = Path(directory) / "resolv.conf"
            path.write_text("# Docker DNS\nsearch fixture.test\nnameserver 127.0.0.11\n"
                            "nameserver 2001:0db8::53 # IPv6\nnameserver 127.0.0.11\n", encoding="utf-8")
            self.assertEqual(renderer.read_resolvers(path), ["127.0.0.11", "2001:db8::53"])
            config = renderer.validate_config(valid_config())
            output = renderer.render_nginx(config, "/generated/config.json", "/srv/dashboard", renderer.read_resolvers(path))
            self.assertIn("resolver 127.0.0.11 [2001:db8::53]", output)
            for contents in ("nameserver not-an-ip\n", "nameserver 127.0.0.11 extra\n", "nameserver fe80::1%eth0\n"):
                path.write_text(contents, encoding="utf-8")
                with self.subTest(contents=contents), self.assertRaises(renderer.ConfigError):
                    renderer.read_resolvers(path)

    def test_hostname_routes_require_a_resolver_but_literal_addresses_do_not(self):
        config = renderer.validate_config(valid_config())
        with self.assertRaises(renderer.ConfigError):
            renderer.render_nginx(config, "/generated/config.json", "/srv/dashboard", [])
        config["servers"][0]["apiUrl"] = "http://192.0.2.10/api"
        config["servers"][1]["apiUrl"] = "http://[2001:db8::10]/proxy/api"
        output = renderer.render_nginx(config, "/generated/config.json", "/srv/dashboard", [])
        self.assertIn("http://[2001:db8::10]/proxy/api", output)

    def test_tls_verification_defaults_to_on_and_can_be_explicitly_disabled(self):
        config = valid_config()
        config["servers"][0]["apiUrl"] = "https://pihole-one.example/api"
        del config["servers"][1]["verifyTls"]
        normalized = renderer.validate_config(config)
        verified = renderer.render_nginx(normalized, "/generated/config.json", "/srv/dashboard", ["127.0.0.11"],
                                          ca_bundle="/certs/fixture-ca.pem")
        self.assertIn("proxy_ssl_verify on;", verified)
        self.assertNotIn("proxy_ssl_verify off;", verified)
        self.assertIn("/certs/fixture-ca.pem", verified)
        for server in config["servers"]:
            server["verifyTls"] = False
        unverified = renderer.render_nginx(renderer.validate_config(config), "/generated/config.json", "/srv/dashboard", ["127.0.0.11"])
        self.assertIn("proxy_ssl_verify off;", unverified)
        self.assertNotIn("proxy_ssl_verify on;", unverified)


class FileAndCLITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dobbelt-config-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "config.json"
        self.output = self.root / "generated"
        self.resolver_file = self.root / "resolv.conf"
        self.resolver_file.write_text("nameserver 127.0.0.11\n", encoding="utf-8")

    def run_renderer(self, *extra_args):
        return subprocess.run([
            sys.executable, str(RENDERER), "--config", str(self.source), "--output-dir", str(self.output),
            "--web-root", "/srv/dashboard", "--resolver-file", str(self.resolver_file),
            *extra_args,
        ], cwd=ROOT, capture_output=True, text=True, timeout=10)

    def test_load_rejects_missing_malformed_and_duplicate_key_files(self):
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
        self.source.write_text(json.dumps(valid_config()), encoding="utf-8")
        result = self.run_renderer()
        self.assertEqual(result.returncode, 0, result.stderr)
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
