"""Run the native installer in a real Debian 13 guest with systemd as PID 1.

Build the disposable test image first:
    docker build -f tests/Dockerfile.lxc-guest -t dobbelt-pi-hole:lxc-guest-test .
    python3 -m unittest discover -s tests -p 'test_lxc_guest.py' -v

Set DASHBOARD_LXC_GUEST_TEST_IMAGE to select another locally built test image.
The Linux Docker Engine must provide cgroup v2 and a writable, private cgroup
namespace to the disposable privileged guest. No host cgroup, Docker socket or
host network is mounted. The Pi-hole fixtures run without privileges and all API
requests remain on an isolated Docker network. Docker/systemd failures fail this
gate; they are never skipped.

This checks Debian installation and real service behavior. It does not emulate
Proxmox pct, LXC ID mappings, AppArmor, templates, storage or bridge management.
"""

import base64
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

from test_container import FIXTURE, ROOT, docker, expected_base, request


SERVICE = "dobbelt-pi-hole.service"
ACCOUNT = "dobbelt-pi-hole"
PRIVATE_CONFIG = "/etc/dobbelt-pi-hole/config.json"
RUNTIME = "/run/dobbelt-pi-hole"
WEB_ROOT = "/usr/share/dobbelt-pi-hole"
CHART_SHA256 = "81ffafe13c37e1b25793b020d446f4d9739b949dadb7f9f79d709a0cad781c2f"
CHART_LICENSE_SHA256 = "5a0877ad6d818529be4f33009d0942cdf7e2ed7656156f4aba7308459a546030"


class NativeGuestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("docker"):
            raise RuntimeError("Docker is required for the native Debian/systemd integration test")
        if docker("info", "--format", "{{.CgroupVersion}}").stdout.strip() != "2":
            raise RuntimeError("The native guest test requires Docker Engine with cgroup v2")
        cls.image = os.environ.get("DASHBOARD_LXC_GUEST_TEST_IMAGE", "dobbelt-pi-hole:lxc-guest-test")
        docker("image", "inspect", cls.image)
        cls.prefix = "dobbelt-native-" + uuid.uuid4().hex[:12]
        cls.network = cls.prefix + "-net"
        cls.containers = set()
        cls.temp = tempfile.TemporaryDirectory(prefix=cls.prefix + "-")
        cls.addClassCleanup(cls.temp.cleanup)
        docker("network", "create", cls.network)
        cls.addClassCleanup(lambda: docker("network", "rm", cls.network, check=False))
        cls.addClassCleanup(cls.remove_all_containers)
        cls.backends = {}
        for number in range(1, 4):
            alias = "lxc-pihole-" + str(number)
            name = cls.prefix + "-" + alias
            cls.containers.add(name)
            docker(
                "run", "--detach", "--pull", "never", "--name", name,
                "--network", cls.network, "--network-alias", alias,
                "--publish", "127.0.0.1::8081", "--user", "65534:65534",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
                "--mount", f"type=bind,src={FIXTURE},dst=/fixture/fake_pihole.py,readonly",
                "--entrypoint", "python3", cls.image,
                "/fixture/fake_pihole.py", "--name", alias,
            )
            backend = {"name": name, "origin": cls.origin(name, 8081), "alias": alias}
            cls.backends[str(number)] = backend
            cls.wait_http(backend, "/__fixture__/health")

    @classmethod
    def remove_all_containers(cls):
        for name in tuple(cls.containers):
            docker("rm", "--force", name, check=False)
            cls.containers.discard(name)

    @staticmethod
    def origin(name, port):
        state = json.loads(docker("inspect", name).stdout)[0]
        bindings = (state["NetworkSettings"]["Ports"] or {}).get(f"{port}/tcp")
        if not bindings:
            raise AssertionError(f"{name} did not expose the expected test port {port}")
        return "http://127.0.0.1:" + bindings[0]["HostPort"]

    @staticmethod
    def wait_http(container, path, expected=None, timeout=30):
        deadline, last = time.monotonic() + timeout, "no response"
        while time.monotonic() < deadline:
            try:
                status, _headers, body = request(container["origin"], path, timeout=1)
                if status == 200 and (expected is None or expected(json.loads(body))):
                    return
                last = f"HTTP {status}: {body[:250]!r}"
            except (OSError, http.client.HTTPException, ValueError) as error:
                last = str(error)
            time.sleep(0.1)
        raise AssertionError(f"{container['name']} did not serve {path}: {last}")

    def guest_exec(self, *args, check=True, timeout=30, input=None):
        result = subprocess.run(
            ["docker", "exec", "--interactive", self.guest["name"], *map(str, args)],
            cwd=ROOT, input=input, text=True, capture_output=True, timeout=timeout,
        )
        if check and result.returncode:
            raise AssertionError(
                f"Guest command {args!r} exited {result.returncode}\n{result.stdout}{result.stderr}"
            )
        return result

    def wait_systemd(self):
        deadline, last = time.monotonic() + 45, "systemd has not responded"
        while time.monotonic() < deadline:
            result = self.guest_exec("systemctl", "show", "--property=SystemState", "--value", check=False, timeout=5)
            last = result.stdout.strip() or result.stderr.strip()
            if result.returncode == 0 and last in {"running", "degraded"}:
                return
            time.sleep(0.2)
        self.fail(f"The guest did not finish systemd boot: {last}")

    def tearDown(self):
        failed = any(test is self or getattr(test, "test_case", None) is self
                     for test, _traceback in self._outcome.result.errors + self._outcome.result.failures)
        if failed and hasattr(self, "guest"):
            logs = docker("logs", "--tail", "120", self.guest["name"], check=False)
            print(f"\nGuest PID1 logs:\n{logs.stdout}{logs.stderr}", flush=True)
            for args in (
                ("systemctl", "status", "--no-pager", "--full", SERVICE),
                ("journalctl", "--no-pager", "--unit", SERVICE, "--lines", "100"),
                ("systemctl", "--failed", "--no-pager"),
                ("findmnt", "/sys/fs/cgroup"),
            ):
                result = self.guest_exec(*args, check=False, timeout=10)
                print(f"\nGuest {args!r}:\n{result.stdout}{result.stderr}", flush=True)

    def config(self):
        return {
            "version": 1, "defaultLanguage": "de",
            "servers": [
                {"id": number, "label": f'Pi-hole {number} · Grüße <fixture> & "quotes"',
                 "apiUrl": f"http://lxc-pihole-{number}:8081/api"}
                for number in ("1", "2")
            ],
        }

    def start_guest(self, config):
        source_config = Path(self.temp.name) / "source-config.json"
        source_config.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        name = self.prefix + "-guest"
        self.guest = {"name": name}
        self.containers.add(name)
        docker(
            "run", "--detach", "--pull", "never", "--name", name,
            "--hostname", "dobbelt-native-test", "--network", self.network,
            "--publish", "127.0.0.1::8080", "--privileged", "--cgroupns=private",
            "--init=false",
            "--stop-timeout", "15", "--tmpfs", "/run:rw,nosuid,nodev,mode=0755",
            "--tmpfs", "/run/lock:rw,nosuid,nodev,mode=0755",
            "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
            "--mount", f"type=bind,src={ROOT},dst=/source,readonly",
            "--mount", f"type=bind,src={source_config},dst=/fixture/source-config.json,readonly",
            self.image,
        )
        self.guest["origin"] = self.origin(name, 8080)
        self.wait_systemd()
        inspection = json.loads(docker("inspect", name).stdout)[0]
        self.assertEqual(inspection["HostConfig"]["CgroupnsMode"], "private")
        self.assertNotEqual(inspection["HostConfig"]["NetworkMode"], "host")
        self.assertFalse(any(mount["Destination"].startswith(("/sys", "/var/run/docker.sock"))
                             for mount in inspection["Mounts"]), "The test must not bind host cgroups or a Docker socket")
        self.assertEqual(self.guest_exec("cat", "/proc/1/comm").stdout.strip(), "systemd")
        self.assertEqual(self.guest_exec("systemd-detect-virt", "--container").stdout.strip(), "docker")
        mounts = self.guest_exec("findmnt", "--noheadings", "--output", "FSTYPE,OPTIONS", "/sys/fs/cgroup").stdout.split()
        self.assertEqual(mounts[0], "cgroup2")
        self.assertIn("rw", mounts[1].split(","), "systemd requires writable delegated cgroups")
        distro = self.guest_exec("python3", "-c", "import platform,json;print(json.dumps(platform.freedesktop_os_release()))")
        self.assertEqual((json.loads(distro.stdout)["ID"], json.loads(distro.stdout)["VERSION_ID"]), ("debian", "13"))
        absent = self.guest_exec("dpkg-query", "--show", "--showformat=${Status}", "nginx", check=False)
        self.assertNotIn("install ok installed", absent.stdout, "The guest installer must actually install nginx")

    def install(self, check=True):
        return self.guest_exec(
            "bash", "/source/tools/install_lxc_guest.sh", "--source-dir", "/source",
            "--config", "/fixture/source-config.json", "--listen-address", "0.0.0.0",
            "--listen-port", "8080", check=check, timeout=600,
        )

    def get_json(self, path, status=200, **kwargs):
        actual, _headers, body = request(self.guest["origin"], path, **kwargs)
        self.assertEqual(actual, status, body.decode("utf-8", errors="replace"))
        return json.loads(body)

    def public_config(self, config):
        return {"version": 1, "defaultLanguage": config["defaultLanguage"], "servers": [
            {"id": server["id"], "label": server["label"], "base": expected_base(server)}
            for server in config["servers"]
        ]}

    def backend_requests(self, number):
        status, _headers, body = request(self.backends[str(number)]["origin"], "/__fixture__/requests")
        self.assertEqual(status, 200)
        return json.loads(body)

    def write_config(self, config):
        # Write through the guest's existing file so ownership and permissions stay unchanged.
        self.guest_exec("python3", "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.stdin.read(),encoding='utf-8')",
                        PRIVATE_CONFIG, input=json.dumps(config, ensure_ascii=False))

    def assert_headers(self, headers, inline_hash):
        headers = {name.lower(): value for name, value in headers.items()}
        csp = headers.get("content-security-policy", "")
        directives = {fields[0]: fields[1:] for part in csp.split(";") if (fields := part.split())}
        self.assertIn("'self'", directives.get("script-src", []))
        self.assertIn("'sha256-" + inline_hash + "'", directives.get("script-src", []))
        self.assertNotIn("'unsafe-inline'", directives.get("script-src", []))
        self.assertNotIn("'unsafe-eval'", directives.get("script-src", []))
        self.assertEqual(directives.get("frame-ancestors"), ["'none'"])
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(headers.get("x-frame-options"), "DENY")
        self.assertEqual(headers.get("referrer-policy"), "no-referrer")
        self.assertIn("no-store", headers.get("cache-control", ""))

    def assert_service(self):
        self.assertEqual(self.guest_exec("systemctl", "is-active", SERVICE).stdout.strip(), "active")
        self.assertEqual(self.guest_exec("systemctl", "is-enabled", SERVICE).stdout.strip(), "enabled")
        self.assertEqual(self.guest_exec("systemctl", "show", "--property=User", "--value", SERVICE).stdout.strip(), ACCOUNT)
        uid = int(self.guest_exec("id", "--user", ACCOUNT).stdout.strip())
        self.assertGreater(uid, 0)
        pid = int(self.guest_exec("systemctl", "show", "--property=MainPID", "--value", SERVICE).stdout.strip())
        self.assertGreater(pid, 1)
        self.assertEqual(int(self.guest_exec("ps", "-o", "uid=", "-p", pid).stdout.strip()), uid)
        processes = self.guest_exec("ps", "-C", "nginx", "-o", "uid=,args=").stdout.splitlines()
        self.assertTrue(processes, "The service must run a real nginx process")
        for process in processes:
            self.assertEqual(int(process.split(maxsplit=1)[0]), uid, process)
        self.assertNotEqual(self.guest_exec("systemctl", "is-active", "nginx.service", check=False).stdout.strip(), "active")
        self.assertNotEqual(self.guest_exec("systemctl", "is-enabled", "nginx.service", check=False).stdout.strip(), "enabled")
        return uid

    def assert_file_permissions(self, uid):
        root_owned_paths = [PRIVATE_CONFIG, "/etc/dobbelt-pi-hole/nginx.conf", "/etc/dobbelt-pi-hole/listen.env",
                            WEB_ROOT + "/index.html", "/opt/dobbelt-pi-hole/render_config.py"]
        runtime_paths = [RUNTIME + "/config.json", RUNTIME + "/nginx.conf"]
        paths = root_owned_paths + [RUNTIME] + runtime_paths
        result = self.guest_exec("python3", "-c",
                                "import json,os,stat,sys;print(json.dumps({p:[os.stat(p).st_uid,os.stat(p).st_gid,stat.S_IMODE(os.stat(p).st_mode)] for p in sys.argv[1:]}))",
                                *paths)
        metadata = json.loads(result.stdout)
        for path in root_owned_paths:
            self.assertEqual(metadata[path][0], 0, path)
            self.assertEqual(metadata[path][2] & 0o022, 0, path + " must not be writable by the service or other users")
        self.assertEqual(metadata[PRIVATE_CONFIG][2] & 0o007, 0, "The canonical configuration must not be world-readable")
        self.assertEqual(metadata[RUNTIME][0], uid)
        for path in runtime_paths:
            self.assertEqual(metadata[path][0], uid, "ExecStartPre must run as the service account")
        readable = self.guest_exec("runuser", "--user", ACCOUNT, "--", "test", "-r", PRIVATE_CONFIG, check=False)
        self.assertEqual(readable.returncode, 0, "The service must read the canonical file to regenerate its runtime files")
        writable = self.guest_exec("runuser", "--user", ACCOUNT, "--", "test", "-w", PRIVATE_CONFIG, check=False)
        self.assertNotEqual(writable.returncode, 0, "The service must not modify the administrator's canonical file")

    def test_real_install_service_restart_and_boot_regenerate_safe_routes(self):
        config = self.config()
        self.start_guest(config)
        self.install()
        self.wait_http(self.guest, "/healthz")
        self.assert_file_permissions(self.assert_service())
        self.assertEqual(self.get_json("/config.json"), self.public_config(config))

        status, _headers, page = request(self.guest["origin"], "/")
        self.assertEqual(status, 200)
        self.assertIn(b'id="languageSelect"', page)
        inline_scripts = re.findall(rb"<script(?:\s[^>]*)?>([\s\S]*?)</script\s*>", page, re.IGNORECASE)
        inline_scripts = [script for script in inline_scripts if script.strip()]
        self.assertEqual(len(inline_scripts), 1, "The standalone dashboard must have one hashed inline application")
        inline_hash = base64.b64encode(hashlib.sha256(inline_scripts[0]).digest()).decode("ascii")
        for path, expected_status in (("/", 200), ("/config.json", 200), ("/healthz", 200), ("/missing", 404)):
            status, headers, body = request(self.guest["origin"], path)
            self.assertEqual(status, expected_status, body)
            self.assert_headers(headers, inline_hash)
        status, headers, chart = request(self.guest["origin"], "/chart.umd.min.js")
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(chart).hexdigest(), CHART_SHA256)
        self.assert_headers(headers, inline_hash)
        license_hash = self.guest_exec("sha256sum", "/usr/share/licenses/chart.js/LICENSE").stdout.split()[0]
        self.assertEqual(license_hash, CHART_LICENSE_SHA256)
        app_license = self.guest_exec("sha256sum", "/usr/share/licenses/dobbelt-pi-hole/LICENSE").stdout.split()[0]
        self.assertEqual(app_license, hashlib.sha256((ROOT / "LICENSE").read_bytes()).hexdigest())
        for private_path in ("/etc/dobbelt-pi-hole/config.json", "/nginx.conf", "/listen.env", "/render_config.py"):
            status, _headers, _body = request(self.guest["origin"], private_path)
            self.assertEqual(status, 404)

        base = expected_base(config["servers"][0])
        suffix = "/lists/https%3A%2F%2Flists.example%2Fa%252Fb%20name?type=allow&x=a%26b%3Dc&x=two"
        body = json.dumps({"comment": "Grüße <fixture>", "groups": [0]}, ensure_ascii=False).encode("utf-8")
        response = self.get_json(base + suffix, method="POST", body=body, headers={
            "Content-Type": "application/json", "X-FTL-SID": "native-fixture-session",
        })
        self.assertEqual(response["backend"], "lxc-pihole-1")
        self.assertEqual(response["method"], "POST")
        self.assertEqual(response["path"], "/api" + suffix)
        self.assertEqual(base64.b64decode(response["bodyBase64"]), body)
        self.assertEqual(response["headers"]["x-ftl-sid"], "native-fixture-session")
        self.assertEqual(response["headers"]["host"], "lxc-pihole-1:8081")
        status, headers, _body = request(self.guest["origin"], base + "/__fixture__/unauthorized")
        self.assertEqual(status, 401)
        self.assert_headers(headers, inline_hash)
        self.assertEqual(self.get_json(expected_base(config["servers"][1]) + "/stats/summary")["backend"], "lxc-pihole-2")

        replacement = copy.deepcopy(config)
        replacement["defaultLanguage"] = "en"
        replacement["servers"][0].update({"label": "Changed native target", "apiUrl": "http://lxc-pihole-3:8081/api"})
        before_old, before_new = self.backend_requests(1), self.backend_requests(3)
        self.write_config(replacement)
        self.guest_exec("systemctl", "restart", SERVICE)
        self.wait_http(self.guest, "/config.json", lambda value: value == self.public_config(replacement))
        self.assert_service()
        for stale in (base + "/lists", "/api1/lists", "/api4/lists"):
            status, headers, raw = request(self.guest["origin"], stale, method="POST", body=b'{"fixture":"must stay local"}')
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(raw)["error"]["code"], "dashboard_config_changed")
            self.assert_headers(headers, inline_hash)
        self.assertEqual(self.backend_requests(1), before_old)
        self.assertEqual(self.backend_requests(3), before_new)
        new_base = expected_base(replacement["servers"][0])
        self.assertEqual(self.get_json(new_base + "/stats/summary")["backend"], "lxc-pihole-3")

        # Re-running a fresh-install command must not overwrite the administrator's changes.
        repeat = self.install(check=False)
        self.assertNotEqual(repeat.returncode, 0)
        self.assertEqual(self.get_json("/config.json"), self.public_config(replacement))
        self.assert_service()

        # Docker restart starts a new systemd PID 1 and discards /run's tmpfs.
        # Corrupt derived files before shutdown to prove boot generates them again.
        self.guest_exec("python3", "-c", "from pathlib import Path;Path('/run/dobbelt-pi-hole/config.json').write_text('{}');Path('/run/dobbelt-pi-hole/nginx.conf').write_text('invalid derived nginx;');Path('/run/dobbelt-pi-hole/boot-marker').touch()")
        docker("restart", "--time", "15", self.guest["name"], timeout=45)
        self.guest["origin"] = self.origin(self.guest["name"], 8080)
        self.wait_systemd()
        self.wait_http(self.guest, "/config.json", lambda value: value == self.public_config(replacement))
        self.assertNotEqual(self.guest_exec("test", "-e", RUNTIME + "/boot-marker", check=False).returncode, 0)
        self.assert_file_permissions(self.assert_service())
        self.assertEqual(self.get_json(new_base + "/stats/summary")["backend"], "lxc-pihole-3")

        invalid = copy.deepcopy(replacement)
        invalid["servers"][1]["id"] = "1"
        self.write_config(invalid)
        failed_start = self.guest_exec("systemctl", "restart", SERVICE, check=False)
        self.assertNotEqual(failed_start.returncode, 0, "An invalid canonical file must fail ExecStartPre")
        self.assertNotEqual(self.guest_exec("systemctl", "is-active", SERVICE, check=False).stdout.strip(), "active")
        self.assertEqual(self.guest_exec("systemctl", "show", "--property=NRestarts", "--value", SERVICE).stdout.strip(), "0")
        with self.assertRaises((OSError, http.client.HTTPException)):
            request(self.guest["origin"], "/config.json", timeout=1)
        self.write_config(replacement)
        self.guest_exec("systemctl", "restart", SERVICE)
        self.wait_http(self.guest, "/config.json", lambda value: value == self.public_config(replacement))
        self.assert_service()


if __name__ == "__main__":
    unittest.main(verbosity=2)
