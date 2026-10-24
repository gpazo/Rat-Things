import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def install(modloop, inputs, destination="/lib/modules", evidence="/opt/rat-build-evidence/kernel.json"):
    data = Path(modloop).read_bytes()
    if len(data) > inputs["modloop"]["maximumBytes"] or hashlib.sha256(data).hexdigest() != inputs["modloop"]["sha256"]:
        raise ValueError("Kernel module input checksum or size differs from its lock")
    listing = subprocess.run(["unsquashfs", "-lln", modloop], capture_output=True, check=True, timeout=30).stdout
    if len(listing) > 8 * 1024 ** 2:
        raise ValueError("Kernel module listing exceeds its bound")
    sizes = re.findall(rb"^[dlcbps-][rwxstST-]{9}\s+\d+/\d+\s+(\d+)\s+", listing, re.MULTILINE)
    if not sizes or len(sizes) > 30000 or sum(map(int, sizes)) > 512 * 1024 ** 2:
        raise ValueError("Kernel module extraction exceeds its bound")
    with tempfile.TemporaryDirectory(prefix="rat-kernel-") as temporary:
        extracted = Path(temporary, "root")
        subprocess.run(["unsquashfs", "-no-progress", "-d", str(extracted), modloop], check=True, timeout=120)
        modules = extracted / "modules"
        entries = list(modules.iterdir())
        if sorted(path.name for path in entries) != sorted([inputs["release"], "firmware"]) or any(
                path.is_symlink() or not path.is_dir() for path in entries):
            raise ValueError("Kernel module release differs from its lock")
        boot_reference = modules / inputs["release"] / "vmlinuz"
        if not boot_reference.is_symlink() or boot_reference.readlink() != Path("/boot/vmlinuz-virt"):
            raise ValueError("Kernel boot reference differs from the locked Alpine layout")
        boot_reference.unlink()
        total = 0
        for path in sorted(modules.rglob("*")):
            if path.is_symlink():
                target = path.resolve()
                if not target.is_relative_to(modules.resolve()):
                    raise ValueError("Kernel module symlink escapes the extracted module tree")
            elif path.is_file():
                total += path.stat().st_size
                if total > 512 * 1024 ** 2:
                    raise ValueError("Kernel module extraction exceeds its byte limit")
            elif not path.is_dir():
                raise ValueError("Kernel module tree contains a special file")
        Path(destination).mkdir(parents=True, exist_ok=True)
        if any(Path(destination).iterdir()):
            raise ValueError("Guest already contains a kernel module tree")
        shutil.copytree(modules, destination, dirs_exist_ok=True, symlinks=True)
    subprocess.run(["depmod", inputs["release"]], check=True, timeout=60)
    shipped = [{"path": str(path.relative_to(destination)), "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
               for path in sorted(Path(destination).rglob("*")) if path.is_file() and not path.is_symlink()]
    required = []
    for name in inputs["requiredModules"]:
        fields = {field: set(subprocess.run(["modinfo", "-k", inputs["release"], "-F", field, name],
                  capture_output=True, text=True, check=True, timeout=10).stdout.splitlines())
                  for field in ["filename", "name", "license"]}
        if fields["name"] != {name} or len(fields["license"]) != 1 or "" in fields["license"]:
            raise ValueError("Required kernel capability has ambiguous identity or license")
        common = {"name": name, "license": next(iter(fields["license"]))}
        if fields["filename"] == {"(builtin)"}:
            builtin_names = {Path(path).stem.replace("-", "_") for path in
                             Path(destination, inputs["release"], "modules.builtin").read_text().splitlines()}
            if name not in builtin_names:
                raise ValueError("Required builtin capability is absent from the locked kernel inventory")
            required.append({**common, "kind": "builtin"})
        else:
            if len(fields["filename"]) != 1:
                raise ValueError("Required kernel module has ambiguous files")
            module = Path(next(iter(fields["filename"])))
            if not module.is_file() or module.is_symlink() or not module.resolve().is_relative_to(Path(destination, inputs["release"]).resolve()):
                raise ValueError("Required kernel module is outside the installed release")
            vermagic = subprocess.run(["modinfo", "-F", "vermagic", str(module)], capture_output=True,
                                      text=True, check=True, timeout=10).stdout.strip()
            if not vermagic.startswith(inputs["release"] + " "):
                raise ValueError("Required kernel module has an incompatible release")
            required.append({**common, "kind": "module", "path": str(module.relative_to(destination)), "vermagic": vermagic})
        subprocess.run(["modprobe", "--show-depends", "--set-version", inputs["release"], name],
                       check=True, capture_output=True, timeout=10)
    Path(evidence).write_text(json.dumps({"release": inputs["release"], "files": shipped, "requiredModules": required},
                                       sort_keys=True, indent=2) + "\n")


if __name__ == "__main__":
    install(sys.argv[1], json.loads(Path(__file__).with_name("kernel-inputs.json").read_text()))
