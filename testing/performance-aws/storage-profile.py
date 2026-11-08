#!/usr/bin/env python3
"""Run one mount command under bounded, allowlisted startup profiling."""

import datetime
import ipaddress
import json
import os
import re
import resource
import signal
import subprocess
import sys
import tempfile
import time


MARKER = "storage-mount-profile "
SCHEMA = "rat-things.storage-mount-profile.v1"
STRACE = "/usr/bin/strace"
MOUNT = "/usr/bin/mount"
MOUNT_LOG = "/var/log/amazon/efs/mount.log"
MAX_OUTPUT_BYTES = 2000
MAX_LOG_BYTES = 256 * 1024
MAX_IMPORT_BYTES = 256 * 1024
MAX_IMPORT_TIMINGS = 64
MAX_SYSCALLS = 20
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-[a-z0-9]+)*-[0-9]$", re.ASCII)
FILESYSTEM_PATTERN = re.compile(r"^fs-[0-9a-f]+$", re.ASCII)
ACCESS_POINT_PATTERN = re.compile(r"^accesspoint=(fsap-[0-9a-f]+),mounttargetip=(.+)$", re.ASCII)
LOG_LINE_PATTERN = re.compile(
    r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}) - "
    r"(?P<level>INFO|DEBUG|WARNING|ERROR|CRITICAL) - (?P<message>.*)$",
    re.ASCII,
)
IMPORT_LINE_PATTERN = re.compile(
    r"^import time:\s*(?P<self>\d+)\s*\|\s*(?P<cumulative>\d+)\s*\|\s*(?P<module>[A-Za-z_][A-Za-z0-9_.]*)$",
    re.ASCII,
)
IMPORT_MODULE_PATTERN = re.compile(
    r"^(?:efs_utils_common|mount_s3files)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$",
    re.ASCII,
)
TRACE_LINE_PATTERN = re.compile(
    r"^\s*(?P<percent>\d+(?:\.\d+)?)\s+"
    r"(?P<seconds>\d+(?:\.\d+)?)\s+"
    r"(?P<usecs>\d*)\s+"
    r"(?P<calls>\d+)"
    r"(?:\s+(?P<errors>\d+))?\s+"
    r"(?P<name>[A-Za-z0-9_]+)\s*$",
    re.ASCII,
)
ALLOWED_SYSCALLS = frozenset(
    {
        "access",
        "arch_prctl",
        "brk",
        "clone",
        "clone3",
        "close",
        "connect",
        "execve",
        "faccessat2",
        "fstat",
        "fstatfs",
        "getdents64",
        "getrandom",
        "ioctl",
        "mmap",
        "mprotect",
        "munmap",
        "newfstatat",
        "openat",
        "poll",
        "ppoll",
        "read",
        "recvfrom",
        "recvmsg",
        "select",
        "sendto",
        "sendmsg",
        "statx",
        "write",
        "wait4",
    }
)
PHASE_PREFIXES = (
    ("helper_configured", "version=3.1.3 options=", None),
    ("mount_target_ip_selected", "Use the mount target ip address ", " provided in the mount options to mount."),
    ("proxy_starting", "Starting efs-proxy: ", None),
    ("proxy_starting", "Starting stunnel: ", None),
    ("proxy_started", "Started efs-proxy, pid: ", None),
    ("proxy_started", "Started stunnel, pid: ", None),
    ("nfs_mount_attempt", 'Executing: "', None),
    ("mounted", "Successfully mounted ", None),
)


def validated_mount_arguments(args):
    if len(args) != 6 or args[0:3] != ["-t", "s3files", "-o"]:
        raise ValueError("expected the fixed S3 Files mount argument shape")
    if not FILESYSTEM_PATTERN.fullmatch(args[3 + 1]):
        raise ValueError("expected an S3 Files filesystem id")
    options = args[3]
    options_match = ACCESS_POINT_PATTERN.fullmatch(options)
    if options_match is None:
        raise ValueError("expected the fixed S3 Files mount options")
    try:
        ipaddress.ip_address(options_match.group(2))
    except ValueError as error:
        raise ValueError("expected an IP address mount target") from error
    mount_root = args[5]
    if (
        not mount_root.startswith("/")
        or "\x00" in mount_root
        or any(part in {".", ".."} for part in mount_root.split("/"))
    ):
        raise ValueError("expected an absolute mount root")
    return args


def validated_region(environment):
    value = environment.get("AWS_REGION") or environment.get("AWS_DEFAULT_REGION")
    if value and len(value) <= 32 and REGION_PATTERN.fullmatch(value):
        return value
    return None


def phase_id(message):
    for event_id, prefix, suffix in PHASE_PREFIXES:
        if message.startswith(prefix) and (suffix is None or message.endswith(suffix)):
            return event_id
    return None


def read_mount_log_delta(snapshot):
    try:
        information = os.stat(MOUNT_LOG)
        with open(MOUNT_LOG, "rb") as source:
            if (information.st_dev, information.st_ino) == snapshot[:2] and information.st_size >= snapshot[2]:
                source.seek(snapshot[2])
            else:
                source.seek(max(0, information.st_size - MAX_LOG_BYTES))
            return source.read(MAX_LOG_BYTES).decode("utf-8", "replace").splitlines()
    except OSError:
        return []


def mount_log_snapshot():
    try:
        information = os.stat(MOUNT_LOG)
        return information.st_dev, information.st_ino, information.st_size
    except OSError:
        return None, None, 0


def read_phases(snapshot, started_wall, ended_wall):
    phases = []
    for line in read_mount_log_delta(snapshot):
        match = LOG_LINE_PATTERN.fullmatch(line)
        if match is None:
            continue
        event_id = phase_id(match.group("message"))
        if event_id is None:
            continue
        try:
            timestamp = datetime.datetime.strptime(
                match.group("timestamp"), "%Y-%m-%d %H:%M:%S %Z"
            )
            event_wall = timestamp.timestamp()
        except (OverflowError, ValueError):
            continue
        if event_wall < started_wall - 1.5 or event_wall > ended_wall + 1.5:
            continue
        phases.append({"id": event_id, "timestamp": match.group("timestamp")})
        if len(phases) == 32:
            break
    return phases


def read_tail(path, limit):
    try:
        with open(path, "rb") as source:
            source.seek(0, os.SEEK_END)
            size = source.tell()
            source.seek(max(0, size - limit))
            return source.read(limit)
    except OSError:
        return b""


def parse_trace(path):
    total_seconds = None
    calls = None
    syscalls = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as source:
            for line in source:
                match = TRACE_LINE_PATTERN.fullmatch(line.rstrip("\n"))
                if match is None:
                    continue
                name = match.group("name")
                seconds = float(match.group("seconds"))
                syscall_calls = int(match.group("calls"))
                if name == "total":
                    total_seconds = seconds
                    calls = syscall_calls
                elif name in ALLOWED_SYSCALLS:
                    syscalls.append(
                        {"name": name, "calls": syscall_calls, "seconds": seconds}
                    )
    except OSError:
        pass
    syscalls.sort(key=lambda value: (-value["seconds"], value["name"]))
    return {
        "scope": "mount-launcher-only",
        "available": total_seconds is not None and calls is not None,
        "totalSeconds": total_seconds,
        "calls": calls,
        "syscalls": syscalls[:MAX_SYSCALLS],
    }


def parse_import_timings(data):
    timings = []
    for line in data.decode("utf-8", "replace").splitlines():
        match = IMPORT_LINE_PATTERN.fullmatch(line.strip())
        if match is None or IMPORT_MODULE_PATTERN.fullmatch(match.group("module")) is None:
            continue
        timings.append(
            {
                "module": match.group("module"),
                "selfUs": int(match.group("self")),
                "cumulativeUs": int(match.group("cumulative")),
            }
        )
        if len(timings) == MAX_IMPORT_TIMINGS:
            break
    return timings


def filtered_native_stderr(data):
    lines = []
    for line in data.splitlines():
        decoded = line.decode("utf-8", "replace")
        if IMPORT_LINE_PATTERN.fullmatch(decoded.strip()):
            continue
        lines.append(line)
    return b"\n".join(lines)


def usage_delta(before, after):
    return {
        "userMs": max(0.0, round((after.ru_utime - before.ru_utime) * 1000, 3)),
        "systemMs": max(0.0, round((after.ru_stime - before.ru_stime) * 1000, 3)),
        "majorFaults": max(0, after.ru_majflt - before.ru_majflt),
        "minorFaults": max(0, after.ru_minflt - before.ru_minflt),
    }


def profile_record(outcome, duration_ms, exit_code, environment, usage, trace, phases, imports):
    return {
        "schema": SCHEMA,
        "outcome": outcome,
        "durationMs": duration_ms,
        "exitCode": exit_code,
        "rootEnv": {
            "awsRegionPresent": "AWS_REGION" in environment,
            "awsDefaultRegionPresent": "AWS_DEFAULT_REGION" in environment,
        },
        "validatedRegion": validated_region(environment),
        "usage": usage,
        "trace": trace,
        "phases": phases,
        "importTimings": imports,
    }


def emit(record):
    sys.stdout.write(MARKER + json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--timeout-ms":
        sys.stderr.write("storage profile wrapper requires --timeout-ms and mount arguments\n")
        return 2
    try:
        timeout_ms = int(sys.argv[2])
        if timeout_ms < 1 or timeout_ms > 120000:
            raise ValueError("timeout out of range")
        mount_args = validated_mount_arguments(sys.argv[3:])
    except (ValueError, IndexError) as error:
        sys.stderr.write("storage profile wrapper rejected its fixed inputs\n")
        return 2

    environment = os.environ.copy()
    trace = {
        "scope": "mount-launcher-only",
        "available": False,
        "totalSeconds": None,
        "calls": None,
        "syscalls": [],
    }
    phases = []
    imports = []
    output = b""
    error_output = b""
    import_output = b""
    child_usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    log_snapshot = mount_log_snapshot()
    started_wall = time.time()
    started_ns = time.monotonic_ns()
    exit_code = 127
    timed_out = False

    try:
        with tempfile.TemporaryDirectory(prefix="storage-mount-profile.", dir="/tmp") as private_dir:
            trace_path = os.path.join(private_dir, "strace-summary.txt")
            stdout_path = os.path.join(private_dir, "mount.stdout")
            stderr_path = os.path.join(private_dir, "mount.stderr")
            child_environment = environment.copy()
            if environment.get("STORAGE_PROFILE_IMPORTTIME") == "1":
                child_environment["PYTHONPROFILEIMPORTTIME"] = "1"
            command = [STRACE, "-c", "-o", trace_path, MOUNT] + mount_args
            try:
                with open(stdout_path, "wb") as child_stdout, open(stderr_path, "wb") as child_stderr:
                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.DEVNULL,
                        stdout=child_stdout,
                        stderr=child_stderr,
                        env=child_environment,
                        start_new_session=True,
                    )
                    try:
                        exit_code = process.wait(timeout=timeout_ms / 1000.0)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        try:
                            os.killpg(process.pid, signal.SIGTERM)
                        except OSError:
                            pass
                        try:
                            exit_code = process.wait(timeout=0.25)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(process.pid, signal.SIGKILL)
                            except OSError:
                                pass
                            process.wait()
                        exit_code = 124
            except OSError:
                error_output = b"storage profiling could not start the fixed mount tracer"
            output = read_tail(stdout_path, MAX_OUTPUT_BYTES)
            import_output = read_tail(stderr_path, MAX_IMPORT_BYTES)
            error_output = error_output or import_output[-MAX_OUTPUT_BYTES:]
            imports = parse_import_timings(import_output)
            trace = parse_trace(trace_path)
    finally:
        ended_wall = time.time()
        duration_ms = max(0, round((time.monotonic_ns() - started_ns) / 1_000_000, 3))
        phases = read_phases(log_snapshot, started_wall, ended_wall)
        child_usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        usage = usage_delta(child_usage_before, child_usage_after)

    if exit_code < 0:
        exit_code = min(255, 128 + abs(exit_code))
    if timed_out:
        error_output = (error_output + b"\n" if error_output else b"") + b"mount tracer timed out"
    if exit_code != 0:
        native_output = (output + b"\n" if output else b"") + filtered_native_stderr(error_output)
        if native_output:
            sys.stderr.buffer.write(native_output[-MAX_OUTPUT_BYTES:])
            if not native_output.endswith(b"\n"):
                sys.stderr.write("\n")
    emit(
        profile_record(
            "success" if exit_code == 0 else "failure",
            duration_ms,
            exit_code,
            environment,
            usage,
            trace,
            phases,
            imports,
        )
    )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
