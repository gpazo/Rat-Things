import argparse
import hashlib
import json
import os
import stat
import sys
from types import SimpleNamespace


def archive(root, output, *, source_date_epoch=None, normalize=False, maximum_bytes=1400 * 1024 ** 2, maximum_entries=100000):
    if normalize and (not isinstance(source_date_epoch, int) or not 0 <= source_date_epoch <= 0xFFFFFFFF):
        raise ValueError("Normalized archives require a newc source date epoch")
    root = os.path.abspath(root)
    inodes = {}
    written = set()
    hashes = {}
    inventory = []
    byte_count = 0
    empty_files = {"etc/hostname", "etc/hosts", "etc/resolv.conf", "etc/machine-id", "var/lib/dbus/machine-id"}
    excluded_trees = {"dev", "proc", "sys", "run", "tmp", "workspace"}
    if normalize:
        excluded_trees |= {"root", "var/cache", "var/tmp", "var/log", "var/lib/dnf", "opt/rat-build-tools",
                           "opt/rat-build-evidence", "home/agent/.codex"}

    def write(data):
        nonlocal byte_count
        byte_count += len(data)
        if byte_count > maximum_bytes:
            raise ValueError("Native archive exceeds its uncompressed byte limit")
        output.write(data)

    def generated(mode, *, device=0):
        return SimpleNamespace(st_dev=-1, st_ino=0, st_mode=mode, st_uid=0, st_gid=0,
                               st_nlink=1, st_mtime=source_date_epoch or 0, st_size=0, st_rdev=device)

    def entry(name, info, data=None):
        if len(inventory) >= maximum_entries:
            raise ValueError("Native archive exceeds its entry limit")
        key = (info.st_dev, info.st_ino) if info.st_dev != -1 else (-1, name)
        inode = inodes.setdefault(key, len(inodes) + 1)
        duplicate = stat.S_ISREG(info.st_mode) and key in written
        size = len(data) if data is not None else info.st_size if stat.S_ISREG(info.st_mode) and not duplicate else 0
        filename = name.encode() + b"\0"
        mtime = source_date_epoch if normalize else int(info.st_mtime)
        fields = [inode, info.st_mode, info.st_uid, info.st_gid, info.st_nlink, mtime, size,
                  0, 0, os.major(info.st_rdev), os.minor(info.st_rdev), len(filename), 0]
        if any(value < 0 or value > 0xFFFFFFFF for value in fields):
            raise ValueError("Filesystem metadata exceeds newc limits")
        write(b"070701" + b"".join(f"{value:08x}".encode() for value in fields))
        write(filename)
        write(b"\0" * ((-110 - len(filename)) % 4))
        content_hash = hashlib.sha256()
        if data is not None:
            write(data)
            content_hash.update(data)
        elif stat.S_ISREG(info.st_mode) and not duplicate:
            with open(os.path.join(root, name), "rb") as source:
                before = os.fstat(source.fileno())
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                    raise ValueError("Filesystem changed during export")
                remaining = size
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError("Filesystem changed during export")
                    write(chunk)
                    content_hash.update(chunk)
                    remaining -= len(chunk)
                after = os.fstat(source.fileno())
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise ValueError("Filesystem changed during export")
        write(b"\0" * ((-size) % 4))
        if not duplicate:
            hashes[key] = content_hash.hexdigest()
        record = {"path": name, "mode": info.st_mode, "uid": info.st_uid, "gid": info.st_gid,
                  "inode": inode, "links": info.st_nlink, "mtime": mtime, "bytes": size}
        if stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            record["sha256"] = hashes[key]
        if stat.S_ISLNK(info.st_mode):
            record["target"] = data.decode()
        if stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
            record["device"] = {"major": os.major(info.st_rdev), "minor": os.minor(info.st_rdev)}
        inventory.append(record)
        written.add(key)

    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        files.sort()
        names = directories + files
        directories[:] = [name for name in directories if os.path.relpath(os.path.join(directory, name), root) not in excluded_trees]
        for name in names:
            full = os.path.join(directory, name)
            relative = os.path.relpath(full, root)
            if normalize and relative in {".dockerenv", "opt/rat-build-tools", "opt/rat-build-evidence"}:
                continue
            info = os.lstat(full)
            if stat.S_ISSOCK(info.st_mode):
                raise ValueError("Cannot export a live filesystem socket")
            if normalize and relative in empty_files:
                entry(relative, generated(stat.S_IFREG | 0o644), b"")
            else:
                entry(relative, info, os.readlink(full).encode() if stat.S_ISLNK(info.st_mode) else None)
    if normalize:
        present = {item["path"] for item in inventory}
        for name in sorted(empty_files - present):
            if os.path.dirname(name) in present:
                entry(name, generated(stat.S_IFREG | 0o644), b"")
        if "dev" not in present:
            entry("dev", generated(stat.S_IFDIR | 0o755))
        entry("dev/console", generated(stat.S_IFCHR | 0o600, device=os.makedev(5, 1)))
        entry("dev/null", generated(stat.S_IFCHR | 0o666, device=os.makedev(1, 3)))
    filename = b"TRAILER!!!\0"
    fields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(filename), 0]
    write(b"070701" + b"".join(f"{value:08x}".encode() for value in fields) + filename)
    write(b"\0" * ((-110 - len(filename)) % 4))
    return {"format": "newc", "sourceDateEpoch": source_date_epoch, "uncompressedBytes": byte_count, "entries": inventory}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--source-date-epoch", type=int)
    parser.add_argument("--normalize", action="store_true")
    parser.add_argument("--maximum-bytes", type=int, default=1400 * 1024 ** 2)
    parser.add_argument("--maximum-entries", type=int, default=100000)
    parser.add_argument("--inventory")
    arguments = parser.parse_args()
    result = archive(arguments.root, sys.stdout.buffer, source_date_epoch=arguments.source_date_epoch,
                     normalize=arguments.normalize, maximum_bytes=arguments.maximum_bytes, maximum_entries=arguments.maximum_entries)
    if arguments.inventory:
        with open(arguments.inventory, "x") as inventory_file:
            json.dump(result, inventory_file, sort_keys=True, indent=2)
            inventory_file.write("\n")
