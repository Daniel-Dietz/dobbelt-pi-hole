"""Exercise the built Docker image with disposable, local HTTP backends.

Run after `docker build -t dobbelt-pi-hole:test .` with:
    python3 -m unittest discover -s tests -p 'test_container.py' -v
Set DASHBOARD_TEST_IMAGE to test a different locally built image.
Docker and OpenSSL are required; missing prerequisites fail the CI gate.
"""

import base64
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "fake_pihole.py"


def docker(*args, check=True, timeout=30):
    result = subprocess.run(
        ["docker", *map(str, args)], cwd=ROOT, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
    )
    if check and result.returncode:
        raise AssertionError(
            f"docker {' '.join(map(str, args))} exited {result.returncode}\n"
            f"{result.stdout}{result.stderr}"
        )
    return result


def request(origin, path, method="GET", body=None, headers=None, timeout=5, allow_fixture_certificate=False, ca_file=None):
    url = urlsplit(origin)
    if url.scheme == "https":
        context = ssl.create_default_context(cafile=ca_file)
        if allow_fixture_certificate:
            # Only direct test-fixture health/log requests use this exception.
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        connection = http.client.HTTPSConnection(url.hostname, url.port, timeout=timeout, context=context)
    else:
        connection = http.client.HTTPConnection(url.hostname, url.port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def expected_base(server):
    # Fixtures use already-normalized URLs. This independently checks the public contract.
    identity = hashlib.sha256((server["id"] + "\0" + server["apiUrl"]).encode("utf-8")).hexdigest()
    return "/api" + server["id"] + "/" + identity


def make_fixture_certificate(directory, hostname):
    """Generate a disposable certificate and test-only key, never committed or reused."""
    if not shutil.which("openssl"):
        raise RuntimeError("OpenSSL is required to generate the disposable HTTPS fixture certificate")
    directory.mkdir(mode=0o755)
    certificate, key = directory / "fixture.crt", directory / "fixture.key"
    result = subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc", "-sha256", "-days", "1", "-batch",
        "-subj", "/CN=" + hostname, "-addext", "subjectAltName=DNS:" + hostname + ",IP:127.0.0.1",
        "-keyout", str(key), "-out", str(certificate),
    ], capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise AssertionError("Could not create fixture certificate: " + result.stderr)
    # The image runs as UID 101. This generated, test-only key must be readable there.
    key.chmod(0o644)
    certificate.chmod(0o644)
    return certificate


class ContainerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("docker"):
            raise RuntimeError("Docker is required for the container integration tests")
        docker("info", "--format", "{{.ServerVersion}}")
        cls.image = os.environ.get("DASHBOARD_TEST_IMAGE", "dobbelt-pi-hole:test")
        docker("image", "inspect", cls.image)
        cls.prefix = "dobbelt-test-" + uuid.uuid4().hex[:12]
        cls.network = cls.prefix + "-net"
        cls.containers = set()
        cls.temp = tempfile.TemporaryDirectory(prefix=cls.prefix + "-")
        cls.addClassCleanup(cls.temp.cleanup)
        docker("network", "create", cls.network)
        cls.addClassCleanup(lambda: docker("network", "rm", cls.network, check=False))
        cls.addClassCleanup(cls.remove_all_containers)
        cls.backends = {}
        for number in range(1, 5):
            cls.backends[str(number)] = cls.start_backend("pihole-fixture-" + str(number))

    @classmethod
    def remove_container(cls, name):
        if name in cls.containers:
            docker("rm", "--force", name, check=False)
            cls.containers.discard(name)

    @classmethod
    def remove_all_containers(cls):
        for name in tuple(cls.containers):
            cls.remove_container(name)

    @classmethod
    def run_container(cls, suffix, port, extra, command=()):
        name = cls.prefix + "-" + suffix + "-" + uuid.uuid4().hex[:6]
        # Track names before creation so failed startup is cleaned up too.
        cls.containers.add(name)
        docker(
            "run", "--detach", "--pull", "never", "--name", name,
            "--network", cls.network, "--publish", f"127.0.0.1::{port}",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            *extra, cls.image, *command,
        )
        inspection = json.loads(docker("inspect", name).stdout)[0]
        bindings = (inspection["NetworkSettings"]["Ports"] or {}).get(str(port) + "/tcp")
        # A correctly rejected configuration can exit before Docker exposes its port.
        origin = "http://127.0.0.1:" + bindings[0]["HostPort"] if bindings else None
        return {"name": name, "origin": origin}

    @classmethod
    def wait_ready(cls, container, path, expected=None, timeout=20):
        deadline, last = time.monotonic() + timeout, "no response"
        while time.monotonic() < deadline:
            inspection = json.loads(docker("inspect", container["name"]).stdout)[0]
            if not inspection["State"]["Running"]:
                break
            try:
                status, _headers, body = request(container["origin"], path, timeout=1,
                                                allow_fixture_certificate=container.get("allow_fixture_certificate", False))
                if status == 200 and (expected is None or expected(json.loads(body))):
                    return
                last = f"HTTP {status}: {body[:300]!r}"
            except (OSError, http.client.HTTPException, ValueError) as error:
                last = str(error)
            time.sleep(0.1)
        logs = docker("logs", container["name"], check=False)
        raise AssertionError(f"{container['name']} did not become ready: {last}\n{logs.stdout}{logs.stderr}")

    @classmethod
    def start_backend(cls, alias, tls_directory=None):
        options = [
            "--network-alias", alias, "--entrypoint", "python3",
            "--mount", f"type=bind,src={FIXTURE},dst=/fixture/fake_pihole.py,readonly",
            "--no-healthcheck",
        ]
        command = ["/fixture/fake_pihole.py", "--name", alias]
        if tls_directory:
            options.extend(["--mount", f"type=bind,src={tls_directory},dst=/fixture/tls,readonly"])
            command.extend(["--tls-cert", "/fixture/tls/fixture.crt", "--tls-key", "/fixture/tls/fixture.key"])
        container = cls.run_container(alias, 8081, options, command)
        if tls_directory:
            if container["origin"]:
                container["origin"] = container["origin"].replace("http://", "https://", 1)
            container["allow_fixture_certificate"] = True
        container["alias"] = alias
        cls.wait_ready(container, "/__fixture__/health")
        return container

    def setUp(self):
        self.apps = []
        for backend in self.backends.values():
            status, _headers, _body = request(backend["origin"], "/__fixture__/reset", "POST")
            self.assertEqual(status, 200)

    def tearDown(self):
        # Logs are useful even when nginx failed before exposing a port.
        failed = any(test is self or getattr(test, "test_case", None) is self
                     for test, _traceback in self._outcome.result.errors + self._outcome.result.failures)
        if failed:
            for app in self.apps:
                if app["name"] not in self.containers:
                    continue
                logs = docker("logs", app["name"], check=False)
                print(f"\nContainer logs ({app['name']}):\n{logs.stdout}{logs.stderr}", flush=True)

    def config(self, count=2):
        return {
            "version": 1, "defaultLanguage": "de",
            "servers": [
                {"id": str(number), "label": f'Pi-hole {number} · Grüße <fixture> & "quotes"',
                 "apiUrl": f"http://pihole-fixture-{number}:8081/api"}
                for number in range(1, count + 1)
            ],
        }

    def start_dashboard(self, config=None, raw=None, missing=False, wait=True, ca_bundle=None):
        directory = Path(self.temp.name) / uuid.uuid4().hex
        directory.mkdir(mode=0o755)
        if not missing:
            (directory / "config.json").write_text(
                raw if raw is not None else json.dumps(config, ensure_ascii=False), encoding="utf-8",
            )
        options = [
            "--mount", f"type=bind,src={directory},dst=/config,readonly",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
            "--tmpfs", "/run/dobbelt-pi-hole:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=0755",
        ]
        if ca_bundle:
            options.extend(["--mount", f"type=bind,src={ca_bundle},dst=/etc/ssl/certs/ca-certificates.crt,readonly"])
        app = self.run_container("dashboard", 8080, options)
        app["directory"] = directory
        self.apps.append(app)
        self.addCleanup(self.remove_container, app["name"])
        if wait:
            self.wait_ready(app, "/config.json")
        return app

    def get_json(self, container, path, status=200, **kwargs):
        kwargs.setdefault("allow_fixture_certificate", container.get("allow_fixture_certificate", False))
        actual, _headers, body = request(container["origin"], path, **kwargs)
        self.assertEqual(actual, status, body.decode("utf-8", errors="replace"))
        return json.loads(body)

    def backend_requests(self, number):
        return self.get_json(self.backends[str(number)], "/__fixture__/requests")

    def assert_stale(self, app, path, method="POST"):
        value = self.get_json(app, path, status=409, method=method,
                              body=b'{"fixture":"must not reach an upstream"}',
                              headers={"Content-Type": "application/json", "X-FTL-SID": "retired-session"})
        self.assertEqual(value["error"]["code"], "dashboard_config_changed")

    def test_public_configuration_and_routes_for_two_three_and_four_servers(self):
        for count in (2, 3, 4):
            with self.subTest(count=count):
                config = self.config(count)
                app = self.start_dashboard(config)
                public = self.get_json(app, "/config.json")
                self.assertEqual(public, {
                    "version": 1, "defaultLanguage": "de",
                    "servers": [{"id": server["id"], "label": server["label"], "base": expected_base(server)}
                                for server in config["servers"]],
                })
                status, headers, body = request(app["origin"], "/config.json")
                self.assertEqual(status, 200)
                self.assertIn("no-store", headers.get("Cache-Control", ""))
                self.assertNotIn(b"apiUrl", body)
                self.assertNotIn(b"verifyTls", body)
                self.assertNotIn(b"pihole-fixture-", body)
                for server in config["servers"]:
                    response = self.get_json(app, expected_base(server) + "/stats/summary?fixture=1")
                    self.assertEqual(response["backend"], "pihole-fixture-" + server["id"])
                    self.assertEqual(response["path"], "/api/stats/summary?fixture=1")
                status, _headers, page = request(app["origin"], "/")
                self.assertEqual(status, 200)
                self.assertIn(b"languageSelect", page)
                status, _headers, chart = request(app["origin"], "/chart.umd.min.js")
                self.assertEqual(status, 200)
                self.assertGreater(len(chart), 1000)
                status, _headers, _body = request(app["origin"], "/config/config.json")
                self.assertEqual(status, 404, "The editable canonical file must not be served")
                if count < 4:
                    self.assert_stale(app, f"/api{count + 1}/lists")
                self.remove_container(app["name"])

    def test_proxy_preserves_encoded_paths_queries_bodies_headers_and_statuses(self):
        config = self.config()
        config["servers"][1]["apiUrl"] = "http://pihole-fixture-2:8081/proxy/api"
        app = self.start_dashboard(config)
        base = expected_base(config["servers"][0])
        suffix = ("/lists/https%3A%2F%2Flists.example%2Fa%252Fb%20with%2Bplus%3Fx%3Da%26y%3Db"
                  "?type=allow&value=a%2Fb%252Fc%26d%3De&same=one&same=two")
        body = json.dumps({"comment": 'Grüße <fixture> & "quotes"', "groups": [0]}, ensure_ascii=False).encode("utf-8")
        for method in ("POST", "PUT", "DELETE"):
            with self.subTest(method=method):
                response = self.get_json(app, base + suffix, method=method, body=body, headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "X-FTL-SID": "fixture-forwarded-session", "X-Fixture-Header": "must-survive",
                })
                self.assertEqual(response["method"], method)
                self.assertEqual(response["path"], "/api" + suffix)
                self.assertEqual(base64.b64decode(response["bodyBase64"]), body)
                self.assertEqual(response["headers"]["x-ftl-sid"], "fixture-forwarded-session")
                self.assertEqual(response["headers"]["x-fixture-header"], "must-survive")
                self.assertEqual(response["headers"]["content-type"], "application/json; charset=utf-8")
                self.assertEqual(response["headers"]["host"], "pihole-fixture-1:8081")
        response = self.get_json(app, expected_base(config["servers"][1]) + suffix, method="POST", body=body,
                                 headers={"Content-Type": "application/json"})
        self.assertEqual(response["backend"], "pihole-fixture-2")
        self.assertEqual(response["path"], "/proxy/api" + suffix)
        self.assertEqual(base64.b64decode(response["bodyBase64"]), body)
        response = self.get_json(app, base + "/auth", method="POST", body=b'{"password":"fixture-only-password"}',
                                 headers={"Content-Type": "application/json"})
        self.assertEqual(response["session"]["sid"], "fixture-session-pihole-fixture-1")
        self.get_json(app, base + "/__fixture__/unauthorized", status=401)
        status, _headers, body = request(app["origin"], base + "/__fixture__/no-content")
        self.assertEqual((status, body), (204, b""))

    def test_stale_and_legacy_routes_reject_writes_without_contacting_backends(self):
        config = self.config()
        app = self.start_dashboard(config)
        previous = {**config["servers"][0], "apiUrl": "http://retired-fixture.invalid/api"}
        for path in (expected_base(previous) + "/lists?type=block", "/api1/lists", "/api1/", "/api3/unknown/lists"):
            with self.subTest(path=path):
                self.assert_stale(app, path)
        for number in range(1, 5):
            self.assertEqual(self.backend_requests(number), [], "Rejected writes must never reach an upstream")

    def test_missing_or_invalid_configuration_fails_before_nginx_serves(self):
        invalid = self.config()
        invalid["servers"][1]["id"] = "1"
        cases = ({"missing": True}, {"raw": "{ invalid JSON"}, {"config": invalid})
        for case in cases:
            with self.subTest(case=case):
                app = self.start_dashboard(**case, wait=False)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    state = json.loads(docker("inspect", app["name"]).stdout)[0]["State"]
                    if not state["Running"]:
                        break
                    time.sleep(0.1)
                self.assertFalse(state["Running"], "An invalid configuration must fail startup")
                self.assertNotEqual(state["ExitCode"], 0)
                logs = docker("logs", app["name"], check=False)
                self.assertIn("Configuration error:", logs.stdout + logs.stderr)
                self.remove_container(app["name"])

    def test_offline_upstream_does_not_block_startup_and_runtime_dns_finds_it_later(self):
        config = self.config()
        late_alias = "late-fixture-" + uuid.uuid4().hex[:8]
        config["servers"][1]["apiUrl"] = "http://" + late_alias + ":8081/api"
        app = self.start_dashboard(config)
        public = self.get_json(app, "/config.json")
        self.assertEqual(len(public["servers"]), 2)
        first = self.get_json(app, expected_base(config["servers"][0]) + "/stats/summary")
        self.assertEqual(first["backend"], "pihole-fixture-1")
        late_backend = self.start_backend(late_alias)
        self.addCleanup(self.remove_container, late_backend["name"])
        response = self.get_json(app, expected_base(config["servers"][1]) + "/stats/summary")
        self.assertEqual(response["backend"], late_alias)

    def test_https_upstream_requires_trust_or_explicit_verification_override(self):
        alias = "pihole-https-fixture"
        certificate = make_fixture_certificate(Path(self.temp.name) / "https-fixture", alias)
        backend = self.start_backend(alias, certificate.parent)
        self.addCleanup(self.remove_container, backend["name"])
        config = self.config()
        config["servers"][0]["apiUrl"] = "https://" + alias + ":8081/api"
        base = expected_base(config["servers"][0])

        # The default configuration must reject a self-signed peer before sending an API request.
        verified = self.start_dashboard(config)
        status, _headers, _body = request(verified["origin"], base + "/stats/summary", headers={"X-FTL-SID": "fixture-tls-session"})
        self.assertEqual(status, 502)
        self.assertEqual(self.get_json(backend, "/__fixture__/requests"), [])

        explicitly_disabled = copy.deepcopy(config)
        explicitly_disabled["servers"][0]["verifyTls"] = False
        unverified = self.start_dashboard(explicitly_disabled)
        response = self.get_json(unverified, base + "/stats/summary", headers={"X-FTL-SID": "fixture-tls-session"})
        self.assertEqual(response["backend"], alias)
        self.assertEqual(response["headers"]["x-ftl-sid"], "fixture-tls-session")
        self.assertEqual(len(self.get_json(backend, "/__fixture__/requests")), 1)

        # Supplying the fixture CA bundle also works with verification left at its default of true.
        trusted = self.start_dashboard(config, ca_bundle=certificate)
        response = self.get_json(trusted, base + "/stats/summary")
        self.assertEqual(response["backend"], alias)
        self.assertEqual(len(self.get_json(backend, "/__fixture__/requests")), 2)

    def test_restart_applies_canonical_config_and_invalidates_previous_target_routes(self):
        config = self.config()
        app = self.start_dashboard(config)
        old_base = expected_base(config["servers"][0])
        self.get_json(app, old_base + "/stats/summary")
        old_requests = self.backend_requests(1)
        replacement = copy.deepcopy(config)
        replacement["defaultLanguage"] = "en"
        replacement["servers"][0].update({
            "label": "Replacement Pi-hole", "apiUrl": "http://pihole-fixture-3:8081/api",
        })
        replacement["servers"].append({
            "id": "4", "label": "Added Pi-hole", "apiUrl": "http://pihole-fixture-4:8081/api",
        })
        temporary = app["directory"] / "config.next.json"
        temporary.write_text(json.dumps(replacement), encoding="utf-8")
        temporary.replace(app["directory"] / "config.json")
        docker("restart", "--time", "5", app["name"])
        inspection = json.loads(docker("inspect", app["name"]).stdout)[0]
        bindings = (inspection["NetworkSettings"]["Ports"] or {}).get("8080/tcp")
        if bindings:
            app["origin"] = "http://127.0.0.1:" + bindings[0]["HostPort"]
        self.wait_ready(app, "/config.json", lambda value: value["defaultLanguage"] == "en")
        public = self.get_json(app, "/config.json")
        self.assertEqual([server["id"] for server in public["servers"]], ["1", "2", "4"])
        self.assertEqual(public["servers"][0]["label"], "Replacement Pi-hole")
        self.assertEqual(public["servers"][0]["base"], expected_base(replacement["servers"][0]))
        self.assertNotEqual(public["servers"][0]["base"], old_base)
        self.assert_stale(app, old_base + "/lists?type=block")
        self.assertEqual(self.backend_requests(1), old_requests)
        self.assertEqual(self.backend_requests(3), [], "A stale write must not reach the replacement either")
        response = self.get_json(app, public["servers"][0]["base"] + "/stats/summary")
        self.assertEqual(response["backend"], "pihole-fixture-3")
        response = self.get_json(app, public["servers"][2]["base"] + "/stats/summary")
        self.assertEqual(response["backend"], "pihole-fixture-4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
