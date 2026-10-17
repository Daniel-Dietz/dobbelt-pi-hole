"""Test provisioning decisions against a simulated Proxmox CLI, without a host.

These tests exercise the real orchestration and argument arrays. They do not
claim to exercise PVE storage, bridges, ID mapping or AppArmor on a real cluster.
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
SPEC = importlib.util.spec_from_file_location("dobbelt_create_lxc", ROOT / "tools/create_lxc.py")
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


TEMPLATE = "debian-13-standard_13.10-2_amd64.tar.zst"
VOLUME = "local:vztmpl/" + TEMPLATE
CONFIG = {
    "version": 1, "defaultLanguage": "de",
    "servers": [
        {"id": "1", "label": "First DNS", "apiUrl": "http://192.0.2.10/api"},
        {"id": "2", "label": "Second DNS", "apiUrl": "https://dns2.example.test/api"},
    ],
}


class FakePVE(installer.Runner):
    """Simulate CLI responses and record every effect on a disposable guest model."""

    def __init__(self):
        self.calls = []
        self.uploads = {}
        self.version = "pve-manager/9.2.0/test"
        self.status = [{"type": "node", "local": 1, "name": "pve-test"}]
        self.storages = [
            {"storage": "local", "content": "iso,vztmpl,backup", "active": 1, "enabled": 1, "avail": 100 * 1024**3},
            {"storage": "local-lvm", "content": "images,rootdir", "active": 1, "enabled": 1, "avail": 100 * 1024**3},
        ]
        self.networks = [{"iface": "vmbr0", "type": "bridge", "active": 1}]
        self.guests = []
        self.nextid = 150
        self.catalogue = [
            {"template": "debian-13-standard_13.9-9_amd64.tar.zst", "section": "system", "architecture": "amd64"},
            {"template": TEMPLATE, "section": "system", "architecture": "amd64"},
            {"template": "debian-12-standard_12.99-1_amd64.tar.zst", "section": "system", "architecture": "amd64"},
            {"template": "debian-13-standard_13.99-1_arm64.tar.zst", "section": "system", "architecture": "arm64"},
        ]
        self.cached = [{"volid": VOLUME, "format": "tzst", "size": 123456789}]
        self.created = None
        self.create_failure = False
        self.guest_failure = False
        self.health_failure = False
        self.download_missing = False
        self.foreign_marker = False
        self.replace_after_ready = False
        self.replace_after_uploads = False
        self.bad_unprivileged = False
        self.readiness_failures = 0
        self.stopped = False

    def run(self, arguments, *, timeout=60, capture=True, check=True):
        args = [str(argument) for argument in arguments]
        self.calls.append(args)
        value = ""
        returncode = 0
        if args[0] == "pveversion":
            value = self.version
        elif args[:2] == ["pvesh", "get"]:
            path = args[2]
            if path == "/cluster/status":
                value = self.status
            elif path == "/nodes/pve-test/storage":
                value = self.storages
            elif path == "/nodes/pve-test/network":
                value = self.networks
            elif path == "/cluster/resources":
                value = self.guests
            elif path == "/cluster/nextid":
                value = int(args[args.index("--vmid") + 1]) if "--vmid" in args else self.nextid
            elif path == "/nodes/pve-test/aplinfo":
                value = self.catalogue
            elif path == "/nodes/pve-test/storage/local/content":
                value = self.cached
            elif path.endswith("/config") and self.created is not None:
                value = copy.deepcopy(self.created)
                if self.foreign_marker:
                    value["description"] = "another operator's container"
                if self.bad_unprivileged:
                    value["unprivileged"] = 0
            else:
                raise AssertionError("Unexpected Proxmox API request: " + repr(args))
            value = json.dumps(value)
        elif args[:2] == ["pveam", "download"]:
            if not self.download_missing:
                self.cached.append({"volid": args[2] + ":vztmpl/" + args[3]})
        elif args[:2] == ["pveam", "update"]:
            pass
        elif args[:2] == ["pct", "create"]:
            if self.create_failure:
                raise installer.InstallError("ID was allocated concurrently; pct create failed")
            self.created = {"description": args[args.index("--description") + 1],
                            "unprivileged": 1, "ostype": "debian", "onboot": 0, "protection": 1}
        elif args[:2] == ["pct", "push"]:
            self.uploads[args[4]] = Path(args[3]).read_bytes()
            self.assert_secure_upload(args)
            if self.replace_after_uploads and len(self.uploads) == len(installer.BUNDLE_FILES) + 1:
                self.foreign_marker = True
        elif args[:2] == ["pct", "exec"]:
            if args[6:] == ["/bin/true"] and self.readiness_failures:
                self.readiness_failures -= 1
                returncode = 1
            if args[6:] == ["/bin/true"] and self.replace_after_ready:
                self.foreign_marker = True
            if "/bin/bash" in args and self.guest_failure:
                raise installer.InstallError("Guest package installation failed")
            if "/usr/bin/python3" in args and self.health_failure:
                raise installer.InstallError("Guest HTTP health check failed")
            if "/usr/sbin/ip" in args:
                value = json.dumps([{"addr_info": [{"scope": "global", "local": "192.0.2.50"}]}])
        elif args[:2] == ["pct", "set"]:
            self.created["onboot"] = int(args[args.index("--onboot") + 1])
        elif args[:2] == ["pct", "stop"]:
            self.stopped = True
        elif args[:2] != ["pct", "start"]:
            raise AssertionError("Unexpected mutation or command: " + repr(args))
        if check and returncode:
            raise installer.InstallError("Simulated command failure")
        return subprocess.CompletedProcess(args, returncode, value, "")

    @staticmethod
    def assert_secure_upload(args):
        assert Path(args[3]).stat().st_mode & 0o777 == 0o600
        assert args[args.index("--perms") + 1] == "0600"
        assert args[args.index("--user") + 1] == "0"
        assert args[args.index("--group") + 1] == "0"


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dobbelt-host-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in installer.BUNDLE_FILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("installation fixture " + name, encoding="utf-8")
        self.config = self.root / "source.json"
        self.config.write_text(json.dumps(CONFIG), encoding="utf-8")
        self.fake = FakePVE()

    def execute(self, *options):
        output = io.StringIO()
        with patch.object(installer.os, "geteuid", return_value=0), \
                patch.object(installer.platform, "machine", return_value="x86_64"), \
                patch.object(installer.shutil, "which", side_effect=lambda name: "/usr/sbin/" + name), \
                patch.object(installer.time, "sleep"), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = installer.main(["--config", str(self.config), "--storage", "local-lvm", *options],
                                    runner=self.fake, root=self.root)
        return result, output.getvalue()

    def assert_no_guest_mutations(self):
        self.assertFalse(any(call[0] == "pct" for call in self.fake.calls), self.fake.calls)

    def test_dry_run_selects_numerically_newest_supported_template_without_mutations(self):
        self.fake.cached = []
        result, output = self.execute("--dry-run")
        self.assertEqual(result, 0, output)
        self.assertIn(VOLUME, output)
        self.assertIn('"template_download_needed": true', output)
        self.assertTrue(all(call[0] in {"pveversion", "pvesh"} for call in self.fake.calls))
        self.assertFalse(self.fake.uploads)

    def test_complete_install_uses_fresh_unprivileged_ct_and_enables_autostart_only_after_health(self):
        result, output = self.execute()
        self.assertEqual(result, 0, output)
        create = next(call for call in self.fake.calls if call[:2] == ["pct", "create"])
        self.assertEqual(create[create.index("--unprivileged") + 1], "1")
        self.assertEqual(create[create.index("--rootfs") + 1], "local-lvm:4")
        self.assertEqual(create[create.index("--onboot") + 1], "0")
        self.assertEqual(create[create.index("--start") + 1], "0")
        self.assertEqual(create[create.index("--protection") + 1], "1")
        self.assertNotIn("--features", create)
        network = create[create.index("--net0") + 1]
        self.assertIn("ip=dhcp", network)
        self.assertIn("ip6=manual", network)
        self.assertIn("firewall=1", network)
        self.assertIn("http://192.0.2.50:8080", output)
        start_at = next(i for i, call in enumerate(self.fake.calls) if call[:2] == ["pct", "start"])
        push_at = next(i for i, call in enumerate(self.fake.calls) if call[:2] == ["pct", "push"])
        health_at = next(i for i, call in enumerate(self.fake.calls) if "/usr/bin/python3" in call)
        autostart_at = next(i for i, call in enumerate(self.fake.calls) if call[:2] == ["pct", "set"])
        self.assertLess(start_at, push_at)
        self.assertLess(push_at, health_at)
        self.assertLess(health_at, autostart_at)
        self.assertEqual(self.fake.created["onboot"], 1)
        uploaded_config = json.loads(next(content for name, content in self.fake.uploads.items() if name.endswith("/config.json")))
        self.assertEqual(uploaded_config["defaultLanguage"], "de")
        self.assertTrue(uploaded_config["servers"][1]["verifyTls"])
        self.assertEqual(len(self.fake.uploads), len(installer.BUNDLE_FILES) + 1)
        for call in self.fake.calls:
            if call[:2] == ["pct", "exec"]:
                self.assertEqual(call[3:6], ["--keep-env", "0", "--"])
        self.assertFalse(any("destroy" in call or "--force" in call or "--skiplock" in call for call in self.fake.calls))

    def test_static_network_vlan_dns_and_explicit_id_are_passed_as_single_arguments(self):
        result, output = self.execute("--ctid", "250", "--ipv4", "192.0.2.50/24", "--gateway", "192.0.2.1",
                                      "--vlan", "123", "--nameserver", "192.0.2.53", "--nameserver", "192.0.2.54")
        self.assertEqual(result, 0, output)
        create = next(call for call in self.fake.calls if call[:2] == ["pct", "create"])
        self.assertEqual(create[2], "250")
        self.assertIn("ip=192.0.2.50/24", create[create.index("--net0") + 1])
        self.assertIn(",gw=192.0.2.1,tag=123", create[create.index("--net0") + 1])
        self.assertEqual(create[create.index("--nameserver") + 1], "192.0.2.53 192.0.2.54")

    def test_existing_cluster_vm_or_ct_is_never_touched(self):
        self.fake.guests = [{"vmid": 150, "type": "qemu", "node": "another-node"}]
        result, output = self.execute("--ctid", "150")
        self.assertEqual(result, 2)
        self.assertIn("already used", output)
        self.assert_no_guest_mutations()
        self.assertFalse(any(call[0] == "pveam" for call in self.fake.calls))

    def test_racing_failed_create_never_pushes_executes_stops_or_changes_autostart(self):
        self.fake.create_failure = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("concurrently", output)
        self.assertEqual([call[1] for call in self.fake.calls if call[0] == "pct"], ["create"])

    def test_foreign_ownership_marker_stops_further_actions(self):
        self.fake.foreign_marker = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("ownership marker", output)
        self.assertEqual([call[1] for call in self.fake.calls if call[0] == "pct"], ["create"])

    def test_guest_install_failure_preserves_only_our_ct_without_deleting_it(self):
        self.fake.guest_failure = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("retained for diagnosis", output)
        self.assertEqual(self.fake.created["onboot"], 0)
        self.assertTrue(self.fake.stopped)
        self.assertFalse(any(call[:2] == ["pct", "destroy"] for call in self.fake.calls))

    def test_replacement_after_start_is_detected_before_any_upload_or_cleanup(self):
        self.fake.replace_after_ready = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("ownership changed", output)
        self.assertFalse(self.fake.uploads)
        self.assertEqual([call[1] for call in self.fake.calls if call[0] == "pct"], ["create", "start", "exec"])

    def test_replacement_after_uploads_is_not_used_for_installation_or_cleanup(self):
        self.fake.replace_after_uploads = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("ownership changed", output)
        self.assertFalse(any("/bin/bash" in call for call in self.fake.calls))
        self.assertFalse(any(call[0] == "pct" and call[1] in {"stop", "set", "destroy"} for call in self.fake.calls))

    def test_failed_health_check_never_enables_autostart(self):
        self.fake.health_failure = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("health check failed", output)
        self.assertFalse(any(call[:2] == ["pct", "set"] and call[-1] == "1" for call in self.fake.calls))

    def test_unexpected_privileged_container_is_not_started_or_populated(self):
        self.fake.bad_unprivileged = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("unprivileged", output)
        self.assertFalse(any(call[0] == "pct" and call[1] in {"start", "push", "exec"} for call in self.fake.calls))

    def test_guest_readiness_is_retried_before_upload(self):
        self.fake.readiness_failures = 2
        result, output = self.execute()
        self.assertEqual(result, 0, output)
        self.assertEqual(sum(call[-1] == "/bin/true" for call in self.fake.calls), 3)

    def test_template_download_must_produce_expected_volume_before_create(self):
        self.fake.cached = []
        self.fake.download_missing = True
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("downloaded template volume is missing", output)
        self.assert_no_guest_mutations()

    def test_explicit_cached_template_does_not_refresh_or_download_catalogue(self):
        result, output = self.execute("--template", VOLUME)
        self.assertEqual(result, 0, output)
        self.assertFalse(any(call[0] == "pveam" for call in self.fake.calls))
        self.assertFalse(any("/nodes/pve-test/aplinfo" in call for call in self.fake.calls))

    def test_missing_explicit_template_is_rejected(self):
        self.fake.cached = []
        result, output = self.execute("--template", VOLUME)
        self.assertEqual(result, 2)
        self.assertIn("does not exist", output)
        self.assert_no_guest_mutations()

    def test_invalid_json_is_rejected_before_any_proxmox_command(self):
        self.config.write_text('{"version":1,"servers":[]}', encoding="utf-8")
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("two, three or four", output)
        self.assertEqual(self.fake.calls, [])

    def test_parameter_injection_and_invalid_network_values_fail_before_inventory(self):
        for options in (
            ["--storage", "local-lvm:0"], ["--bridge", "vmbr0,firewall=0"],
            ["--hostname", "dns;touch /tmp/unsafe"], ["--ipv4", "192.0.2.50"],
            ["--ipv4", "192.0.2.0/24"], ["--ipv4", "192.0.2.255/24"],
            ["--gateway", "192.0.2.1"], ["--ipv4", "127.0.0.1/8"],
            ["--nameserver", "127.0.0.1"], ["--nameserver", "192.0.2.1;evil"],
            ["--vlan", "4095"], ["--ctid", "99"], ["--memory", "0"],
            ["--template", "local:vztmpl/../../bad.tar.zst"],
        ):
            with self.subTest(options=options):
                self.fake.calls.clear()
                result, output = self.execute(*options)
                self.assertEqual(result, 2, output)
                self.assertEqual(self.fake.calls, [])

    def test_inactive_wrong_content_low_space_storage_or_bridge_and_quorum_block_creation(self):
        for failure in ("inactive", "content", "space", "bridge", "quorum"):
            self.fake = FakePVE()
            if failure == "inactive":
                self.fake.storages[1]["active"] = 0
            elif failure == "content":
                self.fake.storages[1]["content"] = "images"
            elif failure == "space":
                self.fake.storages[1]["avail"] = 1024
            elif failure == "bridge":
                self.fake.networks[0]["active"] = 0
            else:
                self.fake.status.append({"type": "cluster", "quorate": 0})
            with self.subTest(failure=failure):
                result, output = self.execute()
                self.assertEqual(result, 2, output)
                self.assert_no_guest_mutations()
                self.assertFalse(any(call[0] == "pveam" for call in self.fake.calls))

    def test_unsupported_proxmox_major_is_rejected(self):
        self.fake.version = "pve-manager/8.4.1/test"
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("supports Proxmox VE 9", output)
        self.assertEqual(self.fake.calls, [["pveversion"]])

    def test_symlinked_installation_source_is_not_transferred(self):
        path = self.root / "index.html"
        path.unlink()
        path.symlink_to(self.config)
        result, output = self.execute()
        self.assertEqual(result, 2)
        self.assertIn("unsafe installation source", output)
        self.assertEqual(self.fake.calls, [])


class RunnerTests(unittest.TestCase):
    def test_help_does_not_write_import_bytecode_into_the_checkout(self):
        with tempfile.TemporaryDirectory(prefix="dobbelt-help-test-") as directory:
            root = Path(directory)
            for name in ("create_lxc.py", "render_config.py"):
                (root / name).write_bytes((ROOT / "tools" / name).read_bytes())
            environment = os.environ.copy()
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            result = subprocess.run([sys.executable, str(root / "create_lxc.py"), "--help"],
                                    capture_output=True, text=True, env=environment, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / "__pycache__").exists())

    def test_subprocess_receives_an_argument_array_without_a_shell(self):
        with patch.object(installer.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as execute, \
                contextlib.redirect_stdout(io.StringIO()):
            installer.Runner().run(["pct", "create", "150", "literal;not-a-shell-command"])
        positional, keywords = execute.call_args
        self.assertEqual(positional[0], ["pct", "create", "150", "literal;not-a-shell-command"])
        self.assertNotIn("shell", keywords)
        self.assertGreater(keywords["timeout"], 0)


if __name__ == "__main__":
    unittest.main()
