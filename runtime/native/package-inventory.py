import argparse
import base64
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys


RELEASE = "2023.12.20261016"
PACKAGE_FIELDS = ("name", "epoch", "version", "release", "architecture", "sourceRpm", "license")
QUERY = "%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\t%{LICENSE}\n"


def command(arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True, timeout=120).stdout


def packages(text, architecture="aarch64"):
    if architecture not in ("aarch64", "x86_64"):
        raise ValueError("Unsupported RPM target architecture")
    result = []
    for line in text.splitlines():
        values = line.split("\t")
        if values[0] == "gpg-pubkey":
            continue
        if len(values) != len(PACKAGE_FIELDS) or any(not value or value == "(none)" for value in values):
            raise ValueError("Incomplete installed RPM identity, source, or license")
        if not values[1].isdigit() or values[4] not in (architecture, "noarch"):
            raise ValueError("Unexpected installed RPM epoch or architecture")
        result.append(dict(zip(PACKAGE_FIELDS, values)))
    result.sort(key=lambda item: tuple(item[field] for field in PACKAGE_FIELDS))
    identities = [tuple(item[field] for field in PACKAGE_FIELDS[:5]) for item in result]
    if not result or len(identities) != len(set(identities)):
        raise ValueError("Empty or duplicated installed RPM inventory")
    return result


def fingerprints(armor):
    payloads = armor.split("-----BEGIN PGP PUBLIC KEY BLOCK-----")[1:]
    result = []
    for payload in payloads:
        body = payload.split("-----END PGP PUBLIC KEY BLOCK-----", 1)[0]
        encoded = "".join(line.strip() for line in body.splitlines()
                          if line.strip() and not line.startswith(("=", "Version:", "Comment:")))
        data = base64.b64decode(encoded, validate=True)
        position = 0
        while position < len(data):
            header = data[position]
            position += 1
            if header & 0xC0 == 0xC0:
                tag = header & 0x3F
                size = data[position]
                position += 1
                if 192 <= size < 224:
                    size = ((size - 192) << 8) + data[position] + 192
                    position += 1
                elif size == 255:
                    size = struct.unpack_from(">I", data, position)[0]
                    position += 4
                elif size >= 224:
                    raise ValueError("Partial OpenPGP key packets are unsupported")
            elif header & 0x80:
                tag = (header >> 2) & 15
                length_bytes = (1, 2, 4, 0)[header & 3]
                if not length_bytes:
                    raise ValueError("Unbounded OpenPGP key packet")
                size = int.from_bytes(data[position:position + length_bytes], "big")
                position += length_bytes
            else:
                raise ValueError("Invalid OpenPGP key packet")
            packet = data[position:position + size]
            position += size
            if len(packet) != size:
                raise ValueError("Truncated OpenPGP key packet")
            if tag == 6:
                if not packet or packet[0] != 4 or size > 65535:
                    raise ValueError("Expected a version 4 RPM signing key")
                result.append(hashlib.sha1(b"\x99" + struct.pack(">H", size) + packet).hexdigest())
    if not result:
        raise ValueError("RPM signing key fingerprint is missing")
    return sorted(set(result))


def collect(root, destination, run=command, before_packages=(), architecture="aarch64"):
    root, destination = Path(root), Path(destination)
    destination.mkdir(parents=True, exist_ok=False)

    def record(path):
        relative = str(path.relative_to(root))
        data = path.read_bytes()
        copied = destination / "files" / relative
        copied.parent.mkdir(parents=True, exist_ok=True)
        copied.write_bytes(data)
        return {"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    configurations = sorted((root / "etc/yum.repos.d").glob("*.repo"))
    metadata = sorted((root / "var/cache/dnf").glob("amazonlinux-*/repodata/*"))
    keys = sorted(path for path in (root / "etc/pki/rpm-gpg").glob("*") if path.is_file())
    variables = sorted(path for path in (root / "etc/dnf/vars").glob("*") if path.is_file())
    if any(path.name == "releasever" and path.read_text().strip() == "latest" for path in variables):
        raise ValueError("Persistent latest RPM repository selection is forbidden")
    if not configurations or not keys or not any(path.name == "repomd.xml" for path in metadata):
        raise ValueError("RPM repository configuration, signing keys, or metadata are missing")
    installed = packages(run(["rpm", "-qa", "--queryformat", QUERY]), architecture)
    trust = run(["rpm", "-q", "gpg-pubkey", "--queryformat", "%{DESCRIPTION}\n"])
    key_fingerprints = fingerprints(trust)
    (destination / "imported-rpm-keys.asc").write_text(trust)
    cached = []
    for path in sorted((root / "var/cache/dnf").glob("amazonlinux-*/packages/*.rpm")):
        verification = run(["rpmkeys", "--checksig", "--verbose", str(path)])
        signature_lines = [line.strip() for line in verification.splitlines() if "signature" in line.lower()]
        if not signature_lines or any(not line.endswith(": OK") for line in signature_lines) or any(
                marker in verification for marker in ("NOT OK", "NOKEY", "NOTTRUSTED")):
            raise ValueError("Cached RPM signature verification failed")
        identity = packages(run(["rpm", "-qp", "--queryformat", QUERY, str(path)]), architecture)
        if len(identity) != 1 or identity[0] not in installed:
            raise ValueError("Cached RPM does not match the installed package inventory")
        checksum = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                checksum.update(block)
        cached.append({"filename": path.name, "bytes": path.stat().st_size, "sha256": checksum.hexdigest(),
                       "package": identity[0], "signatures": signature_lines})
    if any(package not in before_packages and not any(item["package"] == package for item in cached) for package in installed):
        raise ValueError("Installed transaction package has no cached RPM checksum and signature")
    inventory = {"schemaVersion": 1, "releasever": RELEASE, "enabledRepositories": ["amazonlinux"],
                 "beforePackages": list(before_packages), "packages": installed, "cachedRpms": cached, "keyFingerprints": key_fingerprints,
                 "importedKeysSha256": hashlib.sha256(trust.encode()).hexdigest(),
                 "repositoryFiles": [record(path) for path in configurations + variables + keys + metadata]}
    (destination / "inventory.json").write_text(json.dumps(inventory, sort_keys=True, indent=2) + "\n")
    return inventory


if __name__ == "__main__":
    architecture = command(["rpm", "--eval", "%{_arch}"]).strip()
    if len(sys.argv) == 3 and sys.argv[1] == "snapshot":
        destination = Path(sys.argv[2])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps({"packages": packages(command(["rpm", "-qa", "--queryformat", QUERY]), architecture)}, indent=2) + "\n")
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument("destination")
        parser.add_argument("--before", required=True)
        arguments = parser.parse_args()
        collect("/", arguments.destination, before_packages=json.loads(Path(arguments.before).read_text())["packages"], architecture=architecture)
