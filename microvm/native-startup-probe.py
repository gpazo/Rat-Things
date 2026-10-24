#!/usr/bin/python3
import errno
import json
import os
import posixpath
import re
import sys
import time

_PROC_ROOT = "/proc"
MAX_THREADS = 32
MAX_OUTPUT = 8192
MAX_SAFE = 9007199254740991
MAX_PID = 2147483647
STATES = frozenset("RSDZTtXxKWPI")
FD_CALLS = {
    "aarch64": {
        25: "fcntl", 32: "flock", 61: "io", 63: "io", 64: "io",
        65: "io", 66: "io", 67: "io", 68: "io", 69: "io", 70: "io",
        82: "sync", 83: "sync", 202: "socket", 203: "socket",
        206: "socket", 207: "socket", 211: "socket", 212: "socket",
        242: "socket", 267: "sync", 286: "io", 287: "io",
    },
    "x86_64": {
        0: "io", 1: "io", 17: "io", 18: "io", 19: "io", 20: "io",
        42: "socket", 43: "socket", 44: "socket", 45: "socket",
        46: "socket", 47: "socket", 72: "fcntl", 73: "flock",
        74: "sync", 75: "sync", 217: "io", 288: "socket",
        295: "io", 296: "io", 306: "sync", 327: "io", 328: "io",
    },
}
WAIT_CALLS = {
    "aarch64": {22: "event_poll", 98: "futex", 426: "io_uring", 441: "event_poll", 449: "futex"},
    "x86_64": {202: "futex", 232: "event_poll", 281: "event_poll", 426: "io_uring", 441: "event_poll", 449: "futex"},
}
THREAD_ROLES = {b"codex-main": "codex_main", b"tokio-rt-worker": "tokio_worker", b"sqlx-sqlite-wor": "sqlite_worker"}
WAIT_SYMBOLS = (
    ("nfs_io", re.compile(r"^(?:__)?nfs(?:[0-9]+)?_")),
    ("sunrpc", re.compile(r"^(?:__)?(?:rpc|xprt)_")),
    ("page_cache", re.compile(r"^(?:folio_wait_bit_common|folio_put_wait_locked|__folio_lock(?:_killable)?)(?:$|[.])")),
    ("page_fault", re.compile(r"^(?:filemap_fault|(?:__)?handle_mm_fault|(?:__)?do_page_fault)(?:$|[.])")),
    ("file_backed_fault", re.compile(r"^filemap_fault(?:$|[.])")),
    ("io_uring", re.compile(r"^io_cqring_wait(?:_schedule)?(?:$|[.])")),
    ("event_poll", re.compile(r"^(?:ep_poll|do_epoll_wait|do_epoll_pwait)(?:$|[.])")),
    ("file_lock", re.compile(r"^(?:locks_lock_inode_wait|posix_lock_inode|flock_lock_inode_wait|fcntl_setlk)(?:$|[._])")),
    ("futex", re.compile(r"^(?:__)?futex_")),
    ("pipe_io", re.compile(r"^(?:pipe_read|pipe_write|pipe_wait_readable|pipe_wait_writable)(?:$|[._])")),
    ("socket_io", re.compile(r"^(?:sk_wait_data|__skb_wait_for_more_packets|inet_csk_accept|tcp_recvmsg|tcp_sendmsg|unix_stream_read_generic)(?:$|[._])")),
)
ARM64_FAULT_SYMBOLS = (
    ("instruction_fault", re.compile(r"^el0_ia(?:$|[.])")),
    ("data_fault", re.compile(r"^el0_da(?:$|[.])")),
)


def _error_status(error):
    if error.errno in (errno.EACCES, errno.EPERM):
        return "denied"
    if error.errno in (errno.ENOENT, errno.ESRCH):
        return "missing"
    return "unavailable"


def _read(path, limit):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            data = os.read(fd, limit + 1)
        finally:
            os.close(fd)
        if len(data) > limit:
            return "too_large", None
        if not data:
            return "empty", None
        return "ok", data
    except OSError as error:
        return _error_status(error), None


def _uint(token, maximum=MAX_SAFE):
    if not re.fullmatch(rb"[0-9]{1,16}", token):
        raise ValueError()
    value = int(token)
    if value > maximum:
        raise ValueError()
    return value


def _stat(path, pid):
    status, data = _read(path, 4096)
    if status != "ok":
        return status, None
    try:
        start = data.index(b" (")
        end = data.rindex(b") ")
        fields = data[end + 2:].split()
        if _uint(data[:start], MAX_PID) != pid or len(fields) < 20:
            raise ValueError()
        state = fields[0].decode("ascii")
        if state not in STATES:
            raise ValueError()
        return "ok", {
            "role": THREAD_ROLES.get(data[start + 2:end], "other"),
            "state": state,
            "parent": _uint(fields[1], MAX_PID),
            "cpu": [_uint(fields[11]), _uint(fields[12])],
            "start": _uint(fields[19]),
        }
    except (ValueError, IndexError, UnicodeError):
        return "malformed", None


def _argument(token, maximum):
    if re.fullmatch(rb"0x[0-9a-fA-F]{1,16}", token):
        value = int(token, 16)
    else:
        value = _uint(token, maximum)
    if value > maximum:
        raise ValueError()
    return value


def _syscall(path, architecture):
    status, data = _read(path, 512)
    if status != "ok":
        return status, None, None, None
    fields = data.split()
    if fields == [b"running"]:
        return "running", None, None, None
    if len(fields) == 3 and fields[0] == b"-1":
        return "not_in_syscall", -1, None, None
    try:
        if len(fields) != 9:
            raise ValueError()
        number = _uint(fields[0], MAX_PID)
        kind = FD_CALLS.get(architecture, {}).get(number)
        fd = _argument(fields[1], MAX_PID) if kind else None
        if kind == "fcntl" and _argument(fields[2], MAX_PID) not in (6, 7, 37, 38):
            fd, kind = None, None
        if kind == "fcntl":
            kind = "lock" if _argument(fields[2], MAX_PID) in (7, 38) else "io"
        if kind == "flock":
            operation = _argument(fields[2], MAX_PID)
            kind = "lock" if operation in (1, 2) else "io"
        return "ok", number, fd, kind
    except (ValueError, IndexError):
        return "malformed", None, None, None


def _symbols(path, stack=False):
    status, data = _read(path, 4096 if stack else 256)
    if status != "ok":
        return status, []
    if data.strip() == b"0":
        return "unavailable", []
    try:
        value = data.decode("ascii")
    except UnicodeError:
        return "malformed", []
    if not stack:
        symbol = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.$]{0,191}", symbol):
            return "malformed", []
        return "ok", [symbol]
    symbols = []
    for line in value.splitlines():
        match = re.fullmatch(r"\s*(?:\[<[0-9a-fA-F]+>\]\s*)?([A-Za-z_][A-Za-z0-9_.$]{0,191})\+0x[0-9a-fA-F]+/0x[0-9a-fA-F]+(?:\s+\[[A-Za-z0-9_.-]+\])?\s*", line)
        if not match:
            return "malformed", []
        symbols.append(match.group(1))
    return "ok", symbols


def _descriptor(target):
    if re.fullmatch(r"pipe:\[[0-9]+\]", target):
        return "pipe"
    if re.fullmatch(r"socket:\[[0-9]+\]", target):
        return "socket"
    if not target.startswith("/"):
        return "other"
    if target.endswith(" (deleted)"):
        target = target[:-10]
    parts = posixpath.normpath(target).split("/")
    if "codex-home" in parts:
        rest = parts[parts.index("codex-home") + 1:]
        if rest == ["installation_id"]:
            return "installation_id"
        if rest and (rest[0] == "sqlite" or re.fullmatch(r"(?:state|logs)_[0-9]+\.sqlite(?:-wal|-shm)?", rest[0])):
            return "sqlite"
        if rest and rest[0] in ("sessions", "archived_sessions"):
            return "rollout"
        return "codex_home_other"
    if len(parts) > 1 and parts[1] == "tmp":
        return "local_tmp"
    return "other"


def _fd(path, fd):
    if fd is None:
        return "not_applicable", None
    try:
        target = os.readlink(path + "/fd/" + str(fd))
        if len(target) > 4096:
            return "too_large", None
        return "ok", _descriptor(target)
    except OSError as error:
        return _error_status(error), None


def _waits(state, symbols, number, architecture, descriptor, kind):
    patterns = WAIT_SYMBOLS + (ARM64_FAULT_SYMBOLS if architecture == "aarch64" else ())
    contexts = {category for category, pattern in patterns
                if any(pattern.match(symbol) for symbol in symbols)}
    if state == "R":
        contexts.add("runnable")
    call = WAIT_CALLS.get(architecture, {}).get(number)
    if call:
        contexts.add(call)
    if kind == "lock":
        contexts.add("file_lock")
    if kind == "socket" or (kind == "io" and descriptor == "socket"):
        contexts.add("socket_io")
    if kind == "io" and descriptor == "pipe":
        contexts.add("pipe_io")
    return sorted(contexts) if contexts else ["unknown"]


def _thread(path, tid, pid, architecture):
    access = dict.fromkeys(("stat", "wchan", "syscall", "stack", "fd"), "not_sampled")
    result = {"tid": tid, "role": "other", "state": None, "state_stable": None,
              "cpu_ticks": None, "syscall": None, "waits": ["unknown"], "fd": None, "access": access}
    access["stat"], first = _stat(path + "/stat", tid)
    if first is None:
        return result
    access["wchan"], wchan = _symbols(path + "/wchan")
    access["syscall"], number, fd, kind = _syscall(path + "/syscall", architecture)
    access["stack"], stack = _symbols(path + "/stack", stack=True)
    access["fd"], descriptor = _fd(path, fd)
    last_status, last = _stat(path + "/stat", tid)
    if last is None or first["start"] != last["start"]:
        access["stat"] = "changed" if last else last_status
        return result
    result.update(role="launcher" if tid == pid else first["role"],
                  state=first["state"], state_stable=first["state"] == last["state"],
                  cpu_ticks=first["cpu"], syscall=number, fd=descriptor,
                  waits=_waits(first["state"], wchan + stack, number, architecture, descriptor, kind))
    return result


def _sample(pid, parent_pid, architecture):
    architecture = architecture if architecture in FD_CALLS else "unsupported"
    result = {"v": 2, "status": "unavailable", "arch": architecture,
              "identity": {"before": "not_sampled", "after": "not_sampled"},
              "task_access": "not_sampled", "capped": False, "threads": []}
    path = _PROC_ROOT + "/" + str(pid)
    result["identity"]["before"], first = _stat(path + "/stat", pid)
    if first is None:
        return result
    if first["parent"] != parent_pid:
        result["status"] = "not_owned_child"
        return result
    if first["state"] in ("Z", "X", "x"):
        result["status"] = "target_exited"
        return result
    deadline = time.monotonic() + 0.75
    tids = [pid]
    try:
        with os.scandir(path + "/task") as entries:
            result["task_access"] = "ok"
            for count, entry in enumerate(entries):
                if count >= 64 or time.monotonic() >= deadline:
                    result["capped"] = True
                    break
                if not re.fullmatch(r"[1-9][0-9]{0,9}", entry.name):
                    continue
                tid = int(entry.name)
                if tid == pid or tid > MAX_PID:
                    continue
                if len(tids) == MAX_THREADS:
                    result["capped"] = True
                    break
                tids.append(tid)
    except OSError as error:
        result["task_access"] = _error_status(error)
    result["status"] = "ok"
    for tid in tids:
        if time.monotonic() >= deadline:
            result["status"] = "budget_exhausted"
            result["capped"] = True
            break
        result["threads"].append(_thread(path + "/task/" + str(tid), tid, pid, architecture))
    result["identity"]["after"], last = _stat(path + "/stat", pid)
    if last is None or first["start"] != last["start"] or last["parent"] != parent_pid or last["state"] in ("Z", "X", "x"):
        result["status"] = "identity_lost"
        result["threads"] = []
    return result


def _encode(result):
    while True:
        line = json.dumps(result, separators=(",", ":"), ensure_ascii=True) + "\n"
        if len(line.encode("ascii")) <= MAX_OUTPUT:
            return line
        result["threads"].pop()
        result["capped"] = True


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[1-9][0-9]{0,9}", sys.argv[1]) or int(sys.argv[1]) > MAX_PID:
        return {"v": 2, "status": "invalid_input", "threads": []}
    if sys.platform != "linux":
        return {"v": 2, "status": "unsupported_platform", "threads": []}
    return _sample(int(sys.argv[1]), os.getppid(), os.uname().machine)


if __name__ == "__main__":
    try:
        output = _encode(main())
    except Exception:
        output = '{"v":2,"status":"internal_error","threads":[]}\n'
    try:
        sys.stdout.write(output)
    except Exception:
        pass
