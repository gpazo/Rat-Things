import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name):
    path = ROOT / "runtime/native" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def entries(data):
    result = {}
    offset = 0
    while True:
        assert data[offset:offset + 6] == b"070701"
        fields = [int(data[offset + 6 + index * 8:offset + 14 + index * 8], 16) for index in range(13)]
        name_size = fields[11]
        name = data[offset + 110:offset + 109 + name_size].decode()
        offset += 110 + name_size
        offset += -offset % 4
        payload = data[offset:offset + fields[6]]
        offset += fields[6]
        offset += -offset % 4
        if name == "TRAILER!!!":
            return result
        result[name] = {"inode": fields[0], "links": fields[4], "mode": fields[1], "mtime": fields[5], "major": fields[9], "minor": fields[10], "data": payload}


class NativeArchiveTests(unittest.TestCase):
    def test_normalizes_generated_state_and_supplies_initial_console_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {"etc/hosts": "container hosts", "etc/hostname": "random container", "etc/resolv.conf": "host DNS",
                     "etc/machine-id": "host id", "var/lib/dbus/machine-id": "dbus id", "var/log/build.log": "build log",
                     "var/cache/dnf/cache": "cache", "var/lib/dnf/history": "transaction time", "tmp/source.c": "source",
                     "root/.aws/credentials": "account", "home/agent/.codex/auth.json": "account", "workspace/repo": "source",
                     "opt/rat-build-tools/archive-root.py": "builder", "opt/rat-build-evidence/inventory.json": "evidence",
                     "opt/rat-things/native-guest.py": "maintained guest"}
            for name, contents in files.items():
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(contents)
            output = io.BytesIO()
            inventory = load("archive-root.py").archive(root, output, normalize=True, source_date_epoch=123)
            actual = entries(output.getvalue())
            for name in ("etc/hosts", "etc/hostname", "etc/resolv.conf", "etc/machine-id", "var/lib/dbus/machine-id"):
                self.assertEqual(actual[name]["data"], b"")
            self.assertEqual(actual["opt/rat-things/native-guest.py"]["data"], b"maintained guest")
            for name in files.keys() - {"etc/hosts", "etc/hostname", "etc/resolv.conf", "etc/machine-id", "var/lib/dbus/machine-id", "opt/rat-things/native-guest.py"}:
                self.assertNotIn(name, actual)
            for name, major, minor, mode in (("dev/console", 5, 1, 0o600), ("dev/null", 1, 3, 0o666)):
                self.assertEqual(actual[name]["mode"], stat.S_IFCHR | mode)
                self.assertEqual((actual[name]["major"], actual[name]["minor"]), (major, minor))
            self.assertTrue(all(value["mtime"] == 123 for value in actual.values()))
            self.assertEqual(inventory["uncompressedBytes"], len(output.getvalue()))
            self.assertEqual({entry["path"] for entry in inventory["entries"]}, set(actual))

    def test_normalized_archive_does_not_depend_on_file_mtimes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary, "payload")
            path.write_text("stable bytes")
            original = io.BytesIO()
            load("archive-root.py").archive(temporary, original, normalize=True, source_date_epoch=123)
            os.utime(path, (100, 100))
            repeated = io.BytesIO()
            load("archive-root.py").archive(temporary, repeated, normalize=True, source_date_epoch=123)
            self.assertEqual(original.getvalue(), repeated.getvalue())

    def test_normalization_keeps_hard_links_and_guest_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "original").write_text("linked bytes")
            os.link(root / "original", root / "alias")
            os.symlink("original", root / "symbolic")
            output = io.BytesIO()
            load("archive-root.py").archive(root, output, normalize=True, source_date_epoch=123)
            actual = entries(output.getvalue())
            self.assertEqual(actual["original"]["inode"], actual["alias"]["inode"])
            self.assertEqual(actual["original"]["links"], 2)
            self.assertEqual(actual["original"]["data"] + actual["alias"]["data"], b"linked bytes")
            self.assertEqual(actual["symbolic"]["data"], b"original")
            self.assertTrue(stat.S_ISLNK(actual["symbolic"]["mode"]))

    def test_rejects_unbounded_or_unversioned_normalized_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            Path(temporary, "payload").write_bytes(b"x" * 512)
            with self.assertRaisesRegex(ValueError, "source date epoch"):
                load("archive-root.py").archive(temporary, io.BytesIO(), normalize=True)
            with self.assertRaisesRegex(ValueError, "byte limit"):
                load("archive-root.py").archive(temporary, io.BytesIO(), normalize=True, source_date_epoch=1, maximum_bytes=128)
            with self.assertRaisesRegex(ValueError, "entry limit"):
                load("archive-root.py").archive(temporary, io.BytesIO(), normalize=True, source_date_epoch=1, maximum_entries=1)


class KernelModulesTests(unittest.TestCase):
    def install_fixture(self, change=lambda modules: None, built_in=False):
        module = load("install-kernel-modules.py")
        release = "6.18.52-0-virt"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "modloop"
            source.write_bytes(b"locked module fixture")
            destination = root / "installed"
            evidence = root / "evidence.json"
            inputs = {"release": release, "modloop": {"maximumBytes": 1024, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
                      "requiredModules": ["virtio_pci"]}

            def run(arguments, **options):
                output = b""
                if arguments[:2] == ["unsquashfs", "-lln"]:
                    output = b"-rw-r--r-- 0/0 20 2026-09-17 squashfs-root/modules/6.18.52-0-virt/kernel/virtio_pci.ko\n"
                elif arguments[:2] == ["unsquashfs", "-no-progress"]:
                    modules = Path(arguments[arguments.index("-d") + 1], "modules")
                    (modules / release / "kernel").mkdir(parents=True)
                    (modules / release / "kernel/virtio_pci.ko").write_bytes(b"module bytes")
                    (modules / "firmware").mkdir()
                    (modules / release / "vmlinuz").symlink_to("/boot/vmlinuz-virt")
                    if built_in:
                        (modules / release / "modules.builtin").write_text("kernel/drivers/virtio/virtio_pci.ko\n")
                    change(modules)
                elif arguments[0] == "depmod" or arguments[0] == "modprobe":
                    pass
                elif arguments[:2] == ["modinfo", "-k"]:
                    field = arguments[arguments.index("-F") + 1]
                    output = {"filename": "(builtin)\n(builtin)\n" if built_in else str(destination / release / "kernel/virtio_pci.ko") + "\n",
                              "name": "virtio_pci\nvirtio_pci\n" if built_in else "virtio_pci\n",
                              "license": "GPL\nGPL\n" if built_in else "GPL\n"}[field]
                elif arguments[:3] == ["modinfo", "-F", "vermagic"]:
                    if arguments[-1] != str(destination / release / "kernel/virtio_pci.ko"):
                        raise module.subprocess.CalledProcessError(1, arguments)
                    output = release + " SMP\n"
                elif arguments[:3] == ["modinfo", "-F", "license"]:
                    output = "GPL\n"
                else:
                    raise AssertionError(arguments)
                return SimpleNamespace(stdout=output)

            with patch.object(module.subprocess, "run", run):
                module.install(str(source), inputs, str(destination), str(evidence))
            self.assertFalse((destination / release / "vmlinuz").is_symlink())
            self.assertEqual((destination / release / "kernel/virtio_pci.ko").read_bytes(), b"module bytes")
            return json.loads(evidence.read_text())

    def test_installs_locked_alpine_modules_with_firmware_and_omits_boot_reference(self):
        observed = self.install_fixture()
        self.assertEqual([entry["path"] for entry in observed["files"]], ["6.18.52-0-virt/kernel/virtio_pci.ko"])
        self.assertEqual(observed["requiredModules"][0]["vermagic"], "6.18.52-0-virt SMP")

    def test_records_builtin_capability_without_treating_metadata_as_a_file(self):
        observed = self.install_fixture(built_in=True)
        self.assertEqual(observed["requiredModules"], [{"name": "virtio_pci", "kind": "builtin", "license": "GPL"}])
        with self.assertRaises(ValueError):
            self.install_fixture(lambda modules: (modules / "6.18.52-0-virt/modules.builtin").write_text(""), built_in=True)

    def test_rejects_another_release_and_other_links_outside_the_module_tree(self):
        changes = [lambda modules: (modules / "other-release").mkdir(),
                   lambda modules: (modules / "6.18.52-0-virt/kernel/escape").symlink_to("/etc/passwd"),
                   lambda modules: ((modules / "6.18.52-0-virt/vmlinuz").unlink(), (modules / "6.18.52-0-virt/vmlinuz").symlink_to("/other/kernel"))]
        for change in changes:
            with self.subTest(change=changes.index(change)), self.assertRaises(ValueError):
                self.install_fixture(change)


class PackageInventoryTests(unittest.TestCase):
    def fixture(self, root):
        key = b"\xc6\x0a\x04\x00\x00\x00\x01\x01\x00\x08\x01\x01"
        armor = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n" + base64.b64encode(key).decode() + "\n-----END PGP PUBLIC KEY BLOCK-----\n"
        files = {"etc/yum.repos.d/amazonlinux.repo": "[amazonlinux]\nbaseurl=https://example.invalid/locked\ngpgcheck=1\n",
                 "etc/dnf/vars/releasever": "2023.12.20261016", "etc/pki/rpm-gpg/RPM-GPG-KEY": armor,
                 "var/cache/dnf/amazonlinux-example/repodata/repomd.xml": "<repomd/>",
                 "var/cache/dnf/amazonlinux-example/packages/example.rpm": "recorded fake RPM fixture"}
        for name, contents in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        package = "example\t0\t1.2\t3.amzn2023\taarch64\texample-1.2-3.amzn2023.src.rpm\tMIT\n"

        def run(arguments):
            if arguments[:2] == ["rpm", "-qa"]:
                return package + "gpg-pubkey\t0\t1234\t5678\t(none)\t(none)\t(none)\n"
            if arguments[:2] == ["rpm", "-qp"]:
                return package
            if arguments[:3] == ["rpm", "-q", "gpg-pubkey"]:
                return armor
            if arguments[0] == "rpmkeys":
                return "example.rpm:\n    Header V4 RSA/SHA256 Signature, key ID 12345678: OK\n    Payload SHA256 digest: OK\n"
            raise AssertionError(arguments)
        return run

    def test_records_full_installed_inventory_repository_bytes_and_checked_rpm(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary, "root")
            run = self.fixture(root)
            destination = Path(temporary, "evidence")
            result = load("package-inventory.py").collect(root, destination, run)
            self.assertEqual(result, json.loads((destination / "inventory.json").read_text()))
            self.assertEqual(result["packages"], [{"name": "example", "epoch": "0", "version": "1.2", "release": "3.amzn2023", "architecture": "aarch64", "sourceRpm": "example-1.2-3.amzn2023.src.rpm", "license": "MIT"}])
            self.assertEqual(result["cachedRpms"][0]["filename"], "example.rpm")
            self.assertEqual(result["cachedRpms"][0]["bytes"], 25)
            self.assertEqual(len(result["keyFingerprints"][0]), 40)
            self.assertEqual((destination / "files/var/cache/dnf/amazonlinux-example/repodata/repomd.xml").read_text(), "<repomd/>")

    def test_rejects_a_latest_override_or_unverified_cached_rpm(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary, "root")
            run = self.fixture(root)
            variable = root / "etc/dnf/vars/releasever"
            variable.write_text("latest")
            with self.assertRaisesRegex(ValueError, "latest"):
                load("package-inventory.py").collect(root, Path(temporary, "latest"), run)
            variable.write_text("2023.12.20261016")
            def invalid_signature(arguments):
                return "Header V4 RSA Signature: NOKEY" if arguments[0] == "rpmkeys" else run(arguments)
            with self.assertRaisesRegex(ValueError, "signature"):
                load("package-inventory.py").collect(root, Path(temporary, "bad-signature"), invalid_signature)

    def test_rejects_missing_package_source_or_license(self):
        with self.assertRaisesRegex(ValueError, "source, or license"):
            load("package-inventory.py").packages("example\t0\t1\t1\taarch64\t(none)\tMIT\n")

    def test_rejects_new_installed_packages_without_cached_rpm_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary, "root")
            run = self.fixture(root)
            (root / "var/cache/dnf/amazonlinux-example/packages/example.rpm").unlink()
            with self.assertRaisesRegex(ValueError, "no cached RPM"):
                load("package-inventory.py").collect(root, Path(temporary, "missing-rpm"), run)


if __name__ == "__main__":
    unittest.main()
