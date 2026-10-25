import contextlib
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[2]
helper = load("linux_kvm_helper", ROOT / "runtime/linux-kvm/rat-linux-worker")
guest = load("linux_kvm_guest", ROOT / "runtime/native/guest.py")


class LinuxKvmTests(unittest.TestCase):
    def configuration(self, path):
        identity = path.stat()
        return {"kernel": "/Image", "initrd": "/worker-initramfs.gz", "disk": str(path),
                "serialLog": "/serial.log", "workspace": "existing", "cpuCount": 1, "memoryMiB": 2048,
                "device": str(identity.st_dev), "inode": str(identity.st_ino),
                "filesystemUUID": "12345678-1234-1234-1234-123456789abc"}

    def test_rejects_unbounded_resources_and_unsafe_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.raw"
            path.touch()
            valid = self.configuration(path)
            helper.validate_configuration(valid)
            for changed in ({"cpuCount": True}, {"cpuCount": 2}, {"memoryMiB": 4096}, {"workspace": "other"},
                            {"kernel": "relative"}, {"filesystemUUID": "uuid extra_argument"}, {"qemuArgs": []}):
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    helper.validate_configuration({**valid, **changed})

    @unittest.skipUnless(sys.platform == "linux", "Linux sealed memory file")
    def test_boot_initrd_has_no_disk_name_and_cannot_be_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "guest.gz"
            source.write_bytes(b"guest-image")
            descriptor = helper.boot_initrd(source, "a" * 64)
            try:
                self.assertEqual(os.read(descriptor, 11), b"guest-image")
                self.assertEqual(os.fstat(descriptor).st_nlink, 0)
                self.assertIn("memfd:rat-things-boot-initrd", os.readlink(f"/proc/self/fd/{descriptor}"))
                expected = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
                self.assertEqual(fcntl.fcntl(descriptor, fcntl.F_GET_SEALS), expected)
                with self.assertRaises(PermissionError):
                    os.write(descriptor, b"changed")
                with self.assertRaises(PermissionError):
                    os.ftruncate(descriptor, 0)
                self.assertEqual(list(Path(directory).iterdir()), [source])
            finally:
                os.close(descriptor)

    def test_pinned_disk_rejects_replacement_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.raw"
            with path.open("wb") as target:
                target.truncate(helper.WORKSPACE_BYTES)
            configuration = self.configuration(path)
            original = path.with_name("original")
            path.rename(original)
            path.symlink_to(original)
            with self.assertRaises(OSError):
                helper.lock_disk(configuration)
            path.unlink()
            with path.open("wb") as target:
                target.truncate(helper.WORKSPACE_BYTES)
            with self.assertRaises(ValueError):
                helper.lock_disk(configuration)

    def test_workspace_idle_checks_lock_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.raw"
            with path.open("wb") as target:
                target.truncate(helper.WORKSPACE_BYTES)
            configuration = self.configuration(path)
            identity = {key: configuration[key] for key in ("disk", "device", "inode", "filesystemUUID")}

            def probe(value):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    helper.workspace_idle(value)
                return json.loads(output.getvalue())

            descriptor = helper.lock_disk(configuration)
            try:
                self.assertEqual(probe(identity), {"stopped": False})
            finally:
                os.close(descriptor)
            self.assertEqual(probe(identity), {"stopped": True})
            with self.assertRaises(ValueError):
                probe({**identity, "inode": "0"})

    def test_child_holds_disk_lock_until_confirmed_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.raw"
            with path.open("wb") as target:
                target.truncate(helper.WORKSPACE_BYTES)
            configuration = self.configuration(path)
            descriptor = helper.lock_disk(configuration)
            process = subprocess.Popen(["/bin/sleep", "30"], pass_fds=(descriptor,))
            os.close(descriptor)
            try:
                with self.assertRaises(BlockingIOError):
                    helper.lock_disk(configuration)
            finally:
                process.kill()
                process.wait(timeout=5)
            os.close(helper.lock_disk(configuration))

    @unittest.skipUnless(sys.platform == "linux", "Linux process death signal")
    def test_supervisor_reaps_child_when_helper_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "workspace.raw"
            with path.open("wb") as target:
                target.truncate(helper.WORKSPACE_BYTES)
            configuration = self.configuration(path)
            descriptor = helper.lock_disk(configuration)
            child_pid = Path(directory) / "child.pid"
            child = ["/usr/bin/python3", "-c", "import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(30)", str(child_pid)]
            parent = subprocess.Popen(["/usr/bin/python3", "-c",
                "import json,os,subprocess,sys,time;subprocess.Popen(['/usr/bin/python3',sys.argv[1],'--supervise-qemu',str(os.getpid()),sys.argv[2],sys.argv[3]],pass_fds=tuple(json.loads(sys.argv[2])));time.sleep(30)",
                str(ROOT / "runtime/linux-kvm/rat-linux-worker"), json.dumps([descriptor]), json.dumps(child)],
                pass_fds=(descriptor,), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(descriptor)
            try:
                deadline = time.monotonic() + 5
                while not child_pid.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(child_pid.exists(), "Supervised process did not start")
                pid = int(child_pid.read_text())
                with self.assertRaises(BlockingIOError):
                    helper.lock_disk(configuration)
                parent.kill()
                parent.communicate(timeout=5)
                self.assertFalse(Path(f"/proc/{pid}").exists(), "Transport closed before the process was reaped")
                os.close(helper.lock_disk(configuration))
            finally:
                if parent.poll() is None:
                    parent.kill()
                parent.communicate(timeout=5)

    def guest_request(self, frame):
        parent, child = socket.socketpair()
        try:
            parent.sendall(frame)
            parent.shutdown(socket.SHUT_WR)
            with contextlib.redirect_stdout(io.StringIO()):
                guest.handle_control(child)
            return json.loads(parent.recv(4096))
        finally:
            parent.close()
            child.close()

    def test_unauthenticated_control_cannot_stop_worker(self):
        guest.control_token = "a" * 64
        try:
            with patch.object(guest, "stop_worker") as stop:
                for frame in (b'{"operation":"stop"}\n', b'{"operation":"stop","controlToken":"bad"}\n',
                              b'null\n', b'not json\n'):
                    with self.subTest(frame=frame):
                        self.assertIn("error", self.guest_request(frame))
                stop.assert_not_called()
                result = self.guest_request(json.dumps({"operation": "ping", "controlToken": "a" * 64}).encode() + b"\n")
                self.assertEqual(result, {"result": {"ready": True}})
        finally:
            guest.control_token = None

    def test_linux_requires_token_file_and_mac_keeps_existing_contract(self):
        with patch.object(guest.os, "open", side_effect=FileNotFoundError) as opened:
            self.assertIsNone(guest.load_control_token("rat.workspace=fresh"))
            opened.assert_not_called()
            with self.assertRaises(FileNotFoundError):
                guest.load_control_token("rat.control=token rat.workspace=fresh")
            opened.assert_called_once()


if __name__ == "__main__":
    unittest.main()
