import errno
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PROBE = Path(__file__).resolve().parents[2] / "microvm/native-startup-probe.py"


def process_fixture(root, pid=42, parent=7, pgrp=42, start=100, symbol="do_wait", number=260, target="pipe:[123]"):
    path = root / str(pid)
    (path / "fd").mkdir(parents=True, exist_ok=True)
    fields = ["0"] * 20
    fields[0], fields[1], fields[2], fields[19] = "S", str(parent), str(pgrp), str(start)
    (path / "stat").write_text(f"{pid} (secret-token) {' '.join(fields)}\n")
    (path / "wchan").write_text(symbol + "\n")
    (path / "syscall").write_text(f"{number} 4 0 0xcafebabe 0xdeadbeef 0 0 0 0\n")
    (path / "stack").write_text(f"[<abcdef>] {symbol}+0x1/0x2\n")
    descriptor = path / "fd" / "4"
    descriptor.unlink(missing_ok=True)
    descriptor.symlink_to(target)
    return path


def tcp_row(address="17861D14", port="01BB", state="02", inode=456):
    return f"0: 00000000:0000 {address}:{port} {state} 00000000:00000000 00:00000000 00000000 0 0 {inode} 0 0\n"


class GitProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = process_fixture(self.root)
        self.member = process_fixture(self.root, pid=43, parent=42, symbol="inet_wait_for_connect", number=203, target="socket:[456]")
        (self.target / "net").mkdir()
        (self.target / "net" / "tcp").write_text("header\n" + tcp_row() + tcp_row(inode=999, address="DEADBEEF"))
        (self.target / "net" / "tcp6").write_text("header\n")
        spec = importlib.util.spec_from_file_location("git_fetch_probe", PROBE)
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.probe._PROC_ROOT = str(self.root)

    def sample(self):
        encoded = self.probe._encode(self.probe._sample_git(42, 7, "aarch64"))
        self.assertLessEqual(len(encoded.encode()), 8192)
        for secret in ("secret-token", "deadbeef", "cafebabe", "abcdef", str(self.root)):
            self.assertNotIn(secret, encoded)
        return json.loads(encoded)

    def test_root_wait_and_only_group_owned_tcp_remote(self):
        process_fixture(self.root, pid=44, pgrp=44, target="socket:[999]")
        result = self.sample()
        self.assertEqual(result["status"], "ok")
        self.assertEqual([item["pid"] for item in result["processes"]], [42, 43])
        self.assertEqual(result["processes"][0]["waits"], ["child_wait"])
        member = result["processes"][1]
        self.assertEqual(member["waits"], ["socket_connect", "socket_io"])
        self.assertEqual(member["sockets"], [{"family": 4, "address": "20.29.134.23", "port": 443, "state": 2}])

    def test_ipv6_native_word_byte_order(self):
        (self.target / "net" / "tcp").write_text("header\n")
        (self.target / "net" / "tcp6").write_text("header\n" + tcp_row(address="B80D0120000000000000000001000000", state="01"))
        self.assertEqual(self.sample()["processes"][1]["sockets"], [{"family": 6, "address": "2001:db8::1", "port": 443, "state": 1}])

    def test_target_parent_and_group_are_required(self):
        for changes in ({"parent": 8}, {"pgrp": 8}):
            process_fixture(self.root, **changes)
            result = self.sample()
            self.assertEqual((result["status"], result["processes"]), ("not_owned_child", []))

    def test_root_or_member_identity_change_discards_observations(self):
        original = self.probe._stat
        for changed in (42, 43):
            calls = 0
            def reuse(path, pid):
                nonlocal calls
                status, result = original(path, pid)
                if pid == changed:
                    calls += 1
                    if calls > 1:
                        result["start"] += 1
                return status, result
            with patch.object(self.probe, "_stat", side_effect=reuse):
                result = self.sample()
            if changed == 42:
                self.assertEqual((result["status"], result["processes"]), ("identity_lost", []))
            else:
                self.assertEqual([item["pid"] for item in result["processes"]], [42])

    def test_reads_only_allowlisted_proc_metadata(self):
        original_open, original_link = self.probe.os.open, self.probe.os.readlink
        opened = []
        def read(path, flags):
            opened.append(path)
            self.assertIn(Path(path).name, ("stat", "wchan", "syscall", "stack", "tcp", "tcp6"))
            self.assertEqual(flags & (self.probe.os.O_WRONLY | self.probe.os.O_RDWR), 0)
            return original_open(path, flags)
        def link(path):
            self.assertEqual(Path(path).parent.name, "fd")
            return original_link(path)
        process_fixture(self.root, target="/private/secret-token/auth.json")
        for name in ("cmdline", "environ", "mem", "maps"):
            (self.target / name).write_text("secret-token")
        with patch.object(self.probe.os, "open", side_effect=read), patch.object(self.probe.os, "readlink", side_effect=link):
            self.sample()
        self.assertGreater(len(opened), 10)

    def test_denied_and_missing_network_metadata_are_explicit(self):
        original = self.probe.os.open
        def deny(path, flags):
            if path.endswith("/tcp"):
                raise PermissionError(errno.EPERM, "secret-token")
            return original(path, flags)
        (self.target / "net" / "tcp6").unlink()
        with patch.object(self.probe.os, "open", side_effect=deny):
            result = self.sample()
        self.assertEqual((result["tcp_access"], result["tcp6_access"]), ("denied", "missing"))
        self.assertEqual(result["processes"][1]["sockets"], [])

    def test_scan_member_descriptor_network_and_output_caps(self):
        for fd in range(10, 100):
            (self.member / "fd" / str(fd)).symlink_to(f"socket:[{fd}]")
        self.assertEqual(self.sample()["processes"][1]["access"]["fd"], "too_large")
        for pid in range(44, 70):
            process_fixture(self.root, pid=pid, parent=42, target="socket:[456]")
        result = self.sample()
        self.assertTrue(result["capped"])
        self.assertLessEqual(len(result["processes"]), 16)
        (self.target / "net" / "tcp").write_text("header\n" + tcp_row() * 2000)
        self.assertEqual(self.sample()["tcp_access"], "too_large")
        for index in range(260):
            (self.root / f"secret-token-{index}").touch()
        self.assertTrue(self.sample()["capped"])
        large = self.probe._sample_git(42, 7, "aarch64")
        for item in large["processes"]:
            item["sockets"] = [{"family": 6, "address": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "port": 65535, "state": 12}] * 8
        encoded = self.probe._encode(large)
        self.assertLessEqual(len(encoded.encode()), 8192)
        self.assertTrue(json.loads(encoded)["capped"])

    def test_deadline_is_explicit(self):
        with patch.object(self.probe.time, "monotonic", side_effect=[0] + [1] * 100):
            result = self.sample()
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertTrue(result["capped"])

    def test_malformed_network_values_are_not_emitted(self):
        for row in (tcp_row(address="secret-token"), tcp_row(port="secret-token"), tcp_row(state="FF")):
            (self.target / "net" / "tcp").write_text("header\n" + row)
            result = self.sample()
            self.assertEqual(result["tcp_access"], "malformed")
            self.assertEqual(result["processes"][1]["sockets"], [])

    def test_cli_rejects_arbitrary_paths_and_options(self):
        for args in ([], ["0"], ["01"], ["2147483648"], ["42", "--proc-root", str(self.root)], ["secret-token"]):
            result = subprocess.run([sys.executable, "-B", "-I", "-S", str(PROBE), "--git-fetch", *args], capture_output=True, timeout=1)
            self.assertEqual(result.stderr, b"")
            self.assertEqual(json.loads(result.stdout), {"v": 1, "kind": "git_fetch", "status": "invalid_input", "processes": []})


if __name__ == "__main__":
    unittest.main()
