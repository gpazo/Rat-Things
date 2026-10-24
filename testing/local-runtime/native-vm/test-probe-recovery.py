#!/usr/bin/env python3
"""Exercise the native helper's real file locks and controller pipe, without starting a VM.

Build a fixture executable with
xcrun swiftc -D NATIVE_PROBE_TEST_FIXTURE runtime/native/main.swift -o /tmp/rat-native-probe-fixture
Then run this file with that executable's absolute path as its only argument.
The fixture-only modes are absent from ordinary release builds.
"""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import unittest
import uuid

HELPER = str(Path(sys.argv.pop()).resolve()) if len(sys.argv) == 2 else None


class ProbeRecovery(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rat-native-lock-")
        self.directory = Path(self.temporary.name).resolve() / ("probe-" + str(uuid.uuid4()))
        self.directory.mkdir(mode=0o700)
        self.disk = self.directory / "workspace.raw"
        self.disk.write_bytes(b"disposable workspace")
        self.disk.chmod(0o600)
        state = self.disk.stat()
        self.binding = {"identity": {"version": 1, "sessionId": "sess_probe" + uuid.uuid4().hex,
                                    "generation": str(uuid.uuid4()), "setupDigest": "a" * 64},
                        "device": str(state.st_dev), "inode": str(state.st_ino), "filesystemUUID": str(uuid.uuid4())}
        self.receipt = self.directory / "binding.json"
        self.write_binding()
        self.children = []

    def write_binding(self):
        self.receipt.write_text(json.dumps(self.binding))
        self.receipt.chmod(0o600)

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            if child.stdin is not None and child.stdin.closed:
                child.stdin = None
            child.communicate(timeout=5)
        self.temporary.cleanup()

    def recover(self):
        result = subprocess.run([HELPER, "--dispose-probe-disk", str(self.directory)],
                                capture_output=True, env={}, timeout=5)
        return result.returncode, json.loads(result.stdout)

    def holder(self, mode="--hold-probe-disk"):
        child = subprocess.Popen([HELPER, mode, str(self.directory)], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        self.children.append(child)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=5), "native fixture did not respond")
        message = json.loads(child.stdout.readline())
        self.assertEqual(message, {"status": "opened" if mode == "--defer-probe-lock" else "locked"})
        return child

    def test_held_inode_refuses_disposal_and_controller_eof_releases_it(self):
        holder = self.holder()
        self.assertEqual(self.recover(), (2, {"schemaVersion": 1, "status": "locked"}))
        self.assertEqual(self.disk.read_bytes(), b"disposable workspace")
        holder.stdin.close()
        self.assertEqual(holder.wait(timeout=5), 1)
        self.assertEqual(self.recover(), (0, {"schemaVersion": 1, "status": "disposed"}))
        self.assertFalse(self.disk.exists())
        self.assertEqual(self.recover(), (0, {"schemaVersion": 1, "status": "absent"}))
        holder.stdin = None

    def test_known_helper_death_releases_the_real_os_lock(self):
        holder = self.holder()
        holder.kill()
        holder.wait(timeout=5)
        self.assertEqual(self.recover(), (0, {"schemaVersion": 1, "status": "disposed"}))

    def test_an_open_descriptor_cannot_attach_after_recovery_unlinks_the_disk(self):
        holder = self.holder("--defer-probe-lock")
        self.assertEqual(self.recover(), (0, {"schemaVersion": 1, "status": "disposed"}))
        holder.stdin.write(b"x")
        holder.stdin.flush()
        self.assertEqual(holder.wait(timeout=5), 1)
        self.assertEqual(holder.stdout.read(), b"")

    def test_replaced_inode_and_symlink_are_retained(self):
        old = self.directory / "retained.raw"
        self.disk.rename(old)
        self.disk.write_bytes(b"replacement")
        self.disk.chmod(0o600)
        self.assertEqual(self.recover(), (1, {"schemaVersion": 1, "status": "invalid"}))
        self.assertEqual(self.disk.read_bytes(), b"replacement")
        self.disk.unlink()
        self.disk.symlink_to(old)
        self.assertEqual(self.recover(), (1, {"schemaVersion": 1, "status": "invalid"}))
        self.assertTrue(self.disk.is_symlink())
        self.assertEqual(old.read_bytes(), b"disposable workspace")

    def test_foreign_binding_device_and_inode_are_rejected(self):
        for field in ["device", "inode"]:
            original = self.binding[field]
            self.binding[field] = str(int(original) + 1)
            self.write_binding()
            self.assertEqual(self.recover(), (1, {"schemaVersion": 1, "status": "invalid"}))
            self.assertTrue(self.disk.exists())
            self.binding[field] = original

    def test_serial_output_is_capped_while_excess_is_drained(self):
        log = self.directory / "serial.log"
        log.touch(mode=0o600)
        result = subprocess.run([HELPER, "--serial-log-fixture", str(log)], capture_output=True, env={}, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(log.read_bytes(), b"H" * (1024 * 1024))


if __name__ == "__main__":
    if HELPER is None:
        raise SystemExit("Pass the compiled NATIVE_PROBE_TEST_FIXTURE helper path")
    unittest.main()
