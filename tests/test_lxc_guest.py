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
    """Check the native installer's real Debian and systemd behavior inside Docker.

    A disposable privileged guest supplies the cgroup environment systemd
    needs; unprivileged echo backends supply the API responses. This suite
    deliberately does not claim to verify the Proxmox host layer.
    """

    @classmethod
    def setUpClass(cls):
        """Require Docker/cgroup v2 and prepare the isolated fixture environment.

        Allocate a temporary directory, suite network and three unprivileged
        HTTP backends. Cleanup is registered in reverse resource order so
        partial setup failures still remove the containers before their network.
        """
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
        # Remove this suite's network only after its registered containers are gone.
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
        """Force-remove the suite's recorded containers and clear their registrations."""
        for name in tuple(cls.containers):
            docker("rm", "--force", name, check=False)
            cls.containers.discard(name)

    @staticmethod
    def origin(name, port):
        """Return the loopback HTTP origin for a published container TCP port.

        Inspect Docker's actual ephemeral binding and fail clearly if the
        expected port was not exposed, including after a guest restart.
        """
        state = json.loads(docker("inspect", name).stdout)[0]
        bindings = (state["NetworkSettings"]["Ports"] or {}).get(f"{port}/tcp")
        if not bindings:
            raise AssertionError(f"{name} did not expose the expected test port {port}")
        return "http://127.0.0.1:" + bindings[0]["HostPort"]

    @staticmethod
    def wait_http(container, path, expected=None, timeout=30):
        """Poll for HTTP 200 and, when supplied, a predicate over the JSON response.

        Retry transient connection and decoding errors until the deadline;
        report the last observation if the guest never serves the expected data.
        """
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
        """Run a literal command array in the disposable guest and capture its result.

        Optional text input is passed to stdin for configuration or fixture
        scripts. Return CompletedProcess for assertions; by default, a nonzero
        exit raises an assertion with both output streams. Every execution is
        bounded by the caller's timeout in seconds.
        """
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
        """Wait until guest PID 1 reports completed boot rather than a starting state.

        Accept running or degraded so unrelated container unit failures do not
        substitute for application readiness checks. The dashboard service is
        tested separately; the boot wait fails after a bounded deadline.
        """
        deadline, last = time.monotonic() + 45, "systemd has not responded"
        while time.monotonic() < deadline:
            result = self.guest_exec("systemctl", "show", "--property=SystemState", "--value", check=False, timeout=5)
            last = result.stdout.strip() or result.stderr.strip()
            if result.returncode == 0 and last in {"running", "degraded"}:
                return
            time.sleep(0.2)
        self.fail(f"The guest did not finish systemd boot: {last}")

    def tearDown(self):
        """Collect guest boot, service, journal and cgroup diagnostics after a failure.

        Leave actual resource removal to class cleanup, preserving the guest
        long enough to inspect failures in installation or subsequent restarts.
        """
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
        """Return fresh canonical JSON for two fixtures with Unicode-rich display names."""
        return {
            "version": 1, "defaultLanguage": "de",
            "servers": [
                {"id": number, "label": f'Pi-hole {number} · Grüße <fixture> & "quotes"',
                 "apiUrl": f"http://lxc-pihole-{number}:8081/api"}
                for number in ("1", "2")
            ],
        }

    def start_guest(self, config):
        """Boot a fresh Debian 13 systemd guest with the supplied source JSON mounted.

        Start a disposable privileged Docker container with private writable
        cgroups, loopback HTTP publication and read-only source mounts. Assert
        the expected isolation, distro and absent nginx package before the
        real installation begins; store the guest metadata on this test case.
        """
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
        """Run the real native installer in the disposable guest and return its result.

        The source tree and initial JSON come from read-only mounts; the guest
        listener uses port 8080 on all IPv4 interfaces for fixture access. The
        ten-minute command timeout permits package/dependency downloads. Set
        check false when testing an intentional refusal to install.
        """
        return self.guest_exec(
            "bash", "/source/tools/install_lxc_guest.sh", "--source-dir", "/source",
            "--config", "/fixture/source-config.json", "--listen-address", "0.0.0.0",
            "--listen-port", "8080", check=check, timeout=600,
        )

    def get_json(self, path, status=200, **kwargs):
        """Request a guest dashboard endpoint, assert its HTTP status and decode JSON."""
        actual, _headers, body = request(self.guest["origin"], path, **kwargs)
        self.assertEqual(actual, status, body.decode("utf-8", errors="replace"))
        return json.loads(body)

    def public_config(self, config):
        """Build the expected browser projection without using the installed renderer.

        Preserve language, order and labels while deriving each identity-bound
        route through the shared independent hash helper; omit private targets.
        """
        return {"version": 1, "defaultLanguage": config["defaultLanguage"], "servers": [
            {"id": server["id"], "label": server["label"], "base": expected_base(server)}
            for server in config["servers"]
        ]}

    def backend_requests(self, number):
        """Read one backend's structured API log without adding a logged API request."""
        status, _headers, body = request(self.backends[str(number)]["origin"], "/__fixture__/requests")
        self.assertEqual(status, 200)
        return json.loads(body)

    def write_config(self, config):
        """Replace canonical JSON content inside the guest without replacing its inode.

        Write through the existing administrator-owned file so permission and
        ownership checks remain meaningful during restart and failure scenarios.
        """
        # Write through the guest's existing file so ownership and permissions stay unchanged.
        self.guest_exec("python3", "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text(sys.stdin.read(),encoding='utf-8')",
                        PRIVATE_CONFIG, input=json.dumps(config, ensure_ascii=False))

    def package_state(self):
        """Return hashes and metadata for guest package databases, logs and apt lists.

        Capture content, modes and modification times so a refused installation
        cannot silently run apt update or other package work before its guard.
        This helper only reads package state.
        """
        # Hash package state/logs and record directory metadata to detect package
        # actions, including apt update without a subsequent installation.
        result = self.guest_exec("python3", "-c", """
import hashlib, json
from pathlib import Path
state = {}
for root in map(Path, ['/var/lib/dpkg/status', '/var/log/dpkg.log', '/var/log/apt', '/var/lib/apt/lists']):
    for path in [root, *sorted(root.rglob('*'))] if root.is_dir() else [root]:
        if path.exists():
            info = path.stat()
            state[str(path)] = [info.st_mode, info.st_mtime_ns,
                               hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None]
print(json.dumps(state))
""")
        return json.loads(result.stdout)

    def assert_existing_nginx_is_refused(self):
        """Verify a non-fresh guest is rejected before touching an existing service.

        Install a harmless sleep-based nginx unit and sentinel configuration,
        then compare its PID, enablement, file bytes/metadata, canonical JSON
        and package state across the rejected installer run. Remove only these
        controlled fixture files afterward so the genuine fresh install can run.
        """
        unit_path = "/etc/systemd/system/nginx.service"
        config_path = "/etc/nginx/nginx.conf"
        sentinel_unit = ("[Unit]\nDescription=Native installer preservation fixture\n"
                         "[Service]\nType=exec\nExecStart=/usr/bin/sleep infinity\n"
                         "[Install]\nWantedBy=multi-user.target\n")
        sentinel_config = "# Existing nginx configuration owned by the integration fixture\nevents {}\nhttp {}\n"
        self.guest_exec("python3", "-c", """
import json, sys
from pathlib import Path
for name, content in json.loads(sys.stdin.read()).items():
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    path.chmod(0o644)
""", input=json.dumps({unit_path: sentinel_unit, config_path: sentinel_config}))
        self.guest_exec("systemctl", "daemon-reload")
        self.guest_exec("systemctl", "enable", "--now", "nginx.service")
        self.assertEqual(self.guest_exec("systemctl", "is-active", "nginx.service").stdout.strip(), "active")
        before_pid = self.guest_exec("systemctl", "show", "--property=MainPID", "--value", "nginx.service").stdout.strip()
        self.assertGreater(int(before_pid), 1)
        before_packages = self.package_state()
        before_config = self.guest_exec("cat", PRIVATE_CONFIG).stdout
        before_metadata = self.guest_exec("stat", "--format=%u:%g:%a:%y:%z", unit_path, config_path, PRIVATE_CONFIG).stdout

        rejected = self.install(check=False)
        self.assertEqual(rejected.returncode, 2)
        self.assertIn("Installation error: existing nginx ", rejected.stderr)
        self.assertEqual(self.guest_exec("systemctl", "is-active", "nginx.service").stdout.strip(), "active")
        self.assertEqual(self.guest_exec("systemctl", "is-enabled", "nginx.service").stdout.strip(), "enabled")
        self.assertEqual(self.guest_exec("systemctl", "show", "--property=MainPID", "--value", "nginx.service").stdout.strip(), before_pid,
                         "Rejecting a non-fresh guest must not stop or restart its existing service")
        self.assertEqual(self.guest_exec("cat", unit_path).stdout, sentinel_unit)
        self.assertEqual(self.guest_exec("cat", config_path).stdout, sentinel_config)
        self.assertEqual(self.guest_exec("cat", PRIVATE_CONFIG).stdout, before_config)
        self.assertEqual(self.guest_exec("stat", "--format=%u:%g:%a:%y:%z", unit_path, config_path, PRIVATE_CONFIG).stdout, before_metadata)
        self.assertEqual(self.package_state(), before_packages, "The fresh-guest rejection must precede package actions")

        # These are exclusively the controlled fixture's unit and config. Remove
        # them before exercising a genuinely fresh nginx install in this guest.
        self.guest_exec("systemctl", "disable", "--now", "nginx.service")
        self.guest_exec("python3", "-c", "from pathlib import Path;import sys;[Path(p).unlink() for p in sys.argv[1:]];Path('/etc/nginx').rmdir()",
                        unit_path, config_path)
        self.guest_exec("systemctl", "daemon-reload")

    def assert_headers(self, headers, inline_hash):
        """Check response isolation and CSP against the delivered application's hash.

        Compare header names case-insensitively and require explicit script
        hashes, blocked framing and no-store without unsafe script allowances.
        """
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
        """Require the dedicated service to own all nginx processes and return its UID.

        Check that it is active/enabled under a non-root account, while the
        generic nginx unit is neither active nor enabled as a competing service.
        """
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
        """Check the boundary between root-owned configuration and service-owned runtime.

        The supplied service UID must own regenerated artifacts. Application
        files and canonical settings must not be writable by the service or
        other users, while the service must still be able to read its private
        JSON and regenerate runtime files.
        """
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
        """Exercise installation, configuration changes and boot in the native guest.

        Preserve equivalent pre-staged JSON, verify assets, permissions and
        real API proxy traffic, then change targets and reject stale writes.
        A container reboot must regenerate discarded runtime files; invalid
        canonical input must prevent service startup until corrected. All
        package installation, file corruption and restarts stay in the
        disposable test guest rather than a Proxmox host.
        """
        config = self.config()
        self.start_guest(config)
        # An equivalent canonical file may be staged before the fresh install.
        # Its different formatting also proves the installer preserves its bytes.
        canonical_text = json.dumps(config, ensure_ascii=False, indent=4) + "\n"
        self.guest_exec("python3", "-c", "from pathlib import Path;import sys;p=Path(sys.argv[1]);p.parent.mkdir(mode=0o750);p.write_text(sys.stdin.read(),encoding='utf-8');p.chmod(0o600)",
                        PRIVATE_CONFIG, input=canonical_text)
        self.assert_existing_nginx_is_refused()
        self.install()
        self.assertEqual(self.guest_exec("cat", PRIVATE_CONFIG).stdout, canonical_text,
                         "A pre-existing equivalent canonical configuration must be retained without rewriting")
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
        # Wait for the exact replacement projection before testing stale-route rejection.
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
        # The predicate proves boot regenerated the expected configuration generation.
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
        # Recovery is complete only when the corrected public projection is served again.
        self.wait_http(self.guest, "/config.json", lambda value: value == self.public_config(replacement))
        self.assert_service()


if __name__ == "__main__":
    unittest.main(verbosity=2)
