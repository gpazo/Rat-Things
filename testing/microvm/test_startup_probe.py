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


def load_probe(root):
    spec = importlib.util.spec_from_file_location("startup_probe", PROBE)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    probe._PROC_ROOT = str(root)
    return probe


def stat(tid, parent=7, state="S", start=100, comm="secret-token"):
    fields = ["0"] * 20
    fields[0], fields[1], fields[11], fields[12], fields[19] = state, str(parent), "10", "20", str(start)
    return f"{tid} ({comm}) {' '.join(fields)}\n"


def thread(root, tid=42, number=63, symbol="pipe_read", target="pipe:[123]", command=7, state="S", comm="secret-token"):
    base = root / "42" / "task" / str(tid)
    (base / "fd").mkdir(parents=True, exist_ok=True)
    (base / "stat").write_text(stat(tid, state=state, comm=comm))
    (base / "wchan").write_text(symbol + "\n")
    (base / "syscall").write_text(f"{number} 4 {command} 0xcafebabe 0xdeadbeef 0 0 0 0\n")
    (base / "stack").write_text(f"[<abcdef>] {symbol}+0x1/0x2\n")
    descriptor = base / "fd" / "4"
    if descriptor.is_symlink():
        descriptor.unlink()
    descriptor.symlink_to(target)
    return base


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "42").mkdir()
        (self.root / "42" / "stat").write_text(stat(42))
        self.base = thread(self.root)
        self.probe = load_probe(self.root)

    def sample(self, arch="aarch64"):
        result = self.probe._sample(42, 7, arch)
        line = self.probe._encode(result)
        self.assertLessEqual(len(line.encode()), 8192)
        for secret in ("secret-token", "deceptive", "deadbeef", "cafebabe", "abcdef", "top-secret", str(self.root)):
            self.assertNotIn(secret, line)
        parsed = json.loads(line)
        self.assertEqual(parsed["v"], 2)
        for item in parsed["threads"]:
            self.assertEqual(item["waits"], sorted(set(item["waits"])))
            self.assertNotIn("wait", item)
        return parsed

    def test_pipe_wait_and_cpu_counters(self):
        result = self.sample()
        self.assertEqual(result["status"], "ok")
        item = result["threads"][0]
        self.assertEqual((item["waits"], item["fd"], item["syscall"], item["cpu_ticks"]), (["pipe_io"], "pipe", 63, [10, 20]))

    def test_installation_sync_with_nfs_stack(self):
        thread(self.root, number=82, symbol="nfs_file_fsync", target="/mnt/top-secret/codex-home/installation_id")
        item = self.sample()["threads"][0]
        self.assertEqual((item["waits"], item["fd"]), (["nfs_io"], "installation_id"))

    def test_descriptor_categories_never_emit_target(self):
        cases = {
            "/mnt/top-secret/codex-home/sqlite/state_5.sqlite-wal": "sqlite",
            "/mnt/top-secret/codex-home/state_5.sqlite": "sqlite",
            "/mnt/top-secret/codex-home/sessions/top-secret.jsonl": "rollout",
            "/mnt/top-secret/codex-home/archived_sessions/top-secret.jsonl": "rollout",
            "/mnt/top-secret/codex-home/auth.json": "codex_home_other",
            "/tmp/top-secret": "local_tmp",
            "/etc/top-secret": "other",
            "socket:[123]": "socket",
            "/mnt/top-secret/codex-home/installation_id (deleted)": "installation_id",
            "/mnt/top-secret/codex-home/../top-secret": "other",
        }
        for target, expected in cases.items():
            with self.subTest(expected=expected):
                thread(self.root, symbol="do_wait", target=target)
                self.assertEqual(self.sample()["threads"][0]["fd"], expected)

    def test_wait_classification_is_fixed(self):
        for symbol, expected in (("locks_lock_inode_wait", "file_lock"), ("futex_wait_queue", "futex"), ("tcp_recvmsg", "socket_io"), ("wait_on_page_bit_common", "unknown")):
            thread(self.root, number=999, symbol=symbol)
            self.assertEqual(self.sample()["threads"][0]["waits"], [expected])
        thread(self.root, number=999, symbol="do_wait", state="R")
        self.assertEqual(self.sample()["threads"][0]["waits"], ["runnable"])

    def test_arm64_openat_pointer_is_not_a_descriptor(self):
        thread(self.root, number=56, symbol="do_wait", target="/mnt/top-secret/codex-home/installation_id")
        with patch.object(self.probe.os, "readlink", side_effect=AssertionError("unexpected descriptor read")):
            item = self.sample()["threads"][0]
        self.assertIsNone(item["fd"])
        self.assertEqual(item["access"]["fd"], "not_applicable")

    def test_fd_positions_and_lock_commands(self):
        for arch, number, command, expected in (("aarch64", 25, 7, "file_lock"), ("aarch64", 25, 38, "file_lock"), ("aarch64", 32, 2, "file_lock"), ("x86_64", 72, 7, "file_lock"), ("x86_64", 73, 1, "file_lock")):
            thread(self.root, number=number, symbol="do_wait", target="/mnt/top-secret/codex-home/installation_id", command=command)
            item = self.sample(arch)["threads"][0]
            self.assertEqual((item["fd"], item["waits"]), ("installation_id", [expected]))
        thread(self.root, number=25, symbol="do_wait", command=0)
        self.assertEqual(self.sample()["threads"][0]["access"]["fd"], "not_applicable")

    def test_unknown_architecture_does_not_interpret_fd_argument(self):
        with patch.object(self.probe.os, "readlink", side_effect=AssertionError("unexpected descriptor read")):
            result = self.sample("riscv64")
        self.assertEqual(result["arch"], "unsupported")
        self.assertIsNone(result["threads"][0]["fd"])

    def test_x86_native_read_and_futex_are_not_arm64_calls(self):
        thread(self.root, number=0, symbol="do_wait")
        self.assertEqual(self.sample("x86_64")["threads"][0]["fd"], "pipe")
        thread(self.root, number=202, symbol="do_wait")
        item = self.sample("x86_64")["threads"][0]
        self.assertEqual((item["waits"], item["fd"]), (["futex"], None))

    def test_zero_wchan_is_explicitly_unavailable(self):
        (self.base / "wchan").write_text("0\n")
        self.assertEqual(self.sample()["threads"][0]["access"]["wchan"], "unavailable")

    def test_denied_fields_and_missing_descriptor_are_explicit(self):
        original = self.probe.os.open
        def deny(path, flags):
            if path.endswith(("/syscall", "/stack")):
                raise PermissionError(errno.EPERM, "top-secret")
            return original(path, flags)
        with patch.object(self.probe.os, "open", side_effect=deny):
            item = self.sample()["threads"][0]
        self.assertEqual(item["access"]["syscall"], "denied")
        self.assertEqual(item["access"]["stack"], "denied")
        (self.base / "fd" / "4").unlink()
        self.assertEqual(self.sample()["threads"][0]["access"]["fd"], "missing")

    def test_malformed_and_huge_fields(self):
        for field in ("stat", "wchan", "syscall", "stack"):
            with self.subTest(field=field):
                thread(self.root)
                (self.base / field).write_bytes(b"top-secret\x00broken")
                self.assertEqual(self.sample()["threads"][0]["access"][field], "malformed")
                (self.base / field).write_bytes(b"x" * 100000)
                self.assertEqual(self.sample()["threads"][0]["access"][field], "too_large")

    def test_running_and_outside_syscall(self):
        for value, status, number in (("running\n", "running", None), ("-1 0xcafebabe 0xdeadbeef\n", "not_in_syscall", -1)):
            (self.base / "syscall").write_text(value)
            with patch.object(self.probe.os, "readlink", side_effect=AssertionError("unexpected descriptor read")):
                item = self.sample()["threads"][0]
            self.assertEqual((item["access"]["syscall"], item["syscall"]), (status, number))
            self.assertEqual(item["access"]["fd"], "not_applicable")

    def test_missing_process_and_non_child_fail_closed(self):
        (self.root / "42" / "stat").unlink()
        self.assertEqual(self.sample()["identity"]["before"], "missing")
        (self.root / "42" / "stat").write_text(stat(42, parent=8))
        result = self.sample()
        self.assertEqual((result["status"], result["threads"]), ("not_owned_child", []))

    def test_process_pid_reuse_discards_all_records(self):
        original = self.probe.os.open
        count = 0
        def change(path, flags):
            nonlocal count
            if path == str(self.root / "42" / "stat"):
                count += 1
                if count == 2:
                    Path(path).write_text(stat(42, start=101))
            return original(path, flags)
        with patch.object(self.probe.os, "open", side_effect=change):
            result = self.sample()
        self.assertEqual((result["status"], result["threads"]), ("identity_lost", []))

    def test_thread_tid_reuse_discards_thread_values(self):
        original = self.probe.os.open
        count = 0
        def change(path, flags):
            nonlocal count
            if path == str(self.base / "stat"):
                count += 1
                if count == 2:
                    Path(path).write_text(stat(42, start=102))
            return original(path, flags)
        with patch.object(self.probe.os, "open", side_effect=change):
            item = self.sample()["threads"][0]
        self.assertEqual(item["access"]["stat"], "changed")
        self.assertIsNone(item["state"])
        self.assertIsNone(item["state_stable"])
        self.assertEqual((item["role"], item["waits"]), ("other", ["unknown"]))
        self.assertIsNone(item["syscall"])
        self.assertIsNone(item["fd"])

    def test_thread_and_output_limits(self):
        for tid in range(43, 143):
            thread(self.root, tid=tid)
        result = self.sample()
        self.assertTrue(result["capped"])
        self.assertLessEqual(len(result["threads"]), 32)
        self.assertGreater(len(result["threads"]), 0)

    def test_maximum_size_records_are_trimmed_under_output_cap(self):
        for tid in range(43, 74):
            thread(self.root, tid=tid)
        result = self.probe._sample(42, 7, "aarch64")
        self.assertEqual(len(result["threads"]), 32)
        for item in result["threads"]:
            item["tid"] = 2147483647
            item["cpu_ticks"] = [9007199254740991, 9007199254740991]
            item["syscall"] = 2147483647
            item["fd"] = "codex_home_other"
            item["access"] = dict.fromkeys(item["access"], "not_applicable")
        encoded = self.probe._encode(result)
        self.assertLessEqual(len(encoded.encode()), 8192)
        trimmed = json.loads(encoded)
        self.assertTrue(trimmed["capped"])
        self.assertLess(len(trimmed["threads"]), 32)

    def test_task_directory_scan_is_bounded(self):
        for index in range(100):
            (self.base.parent / ("top-secret-" + str(index))).touch()
        self.assertTrue(self.sample()["capped"])

    def test_reads_only_allowlisted_proc_fields_and_fd_links(self):
        original_open, original_link = self.probe.os.open, self.probe.os.readlink
        opened, linked = [], []
        def opened_file(path, flags):
            opened.append(path)
            self.assertIn(Path(path).name, ("stat", "wchan", "syscall", "stack"))
            self.assertEqual(flags & (self.probe.os.O_WRONLY | self.probe.os.O_RDWR), 0)
            return original_open(path, flags)
        def read_link(path):
            linked.append(path)
            self.assertEqual(Path(path).parent.name, "fd")
            return original_link(path)
        with patch.object(self.probe.os, "open", side_effect=opened_file), patch.object(self.probe.os, "readlink", side_effect=read_link):
            self.sample()
        self.assertGreater(len(opened), 4)
        self.assertEqual(len(linked), 1)

    def test_cli_has_no_proc_root_option_and_no_raw_errors(self):
        script = str(PROBE)
        for args in (("--proc-root", str(self.root), "42"), ("../top-secret",), ("0",), ("2147483648",), ("1\n",), ("+1",), ("01",)):
            result = subprocess.run([sys.executable, "-I", "-S", script, *args], capture_output=True, timeout=1)
            self.assertEqual(result.stderr, b"")
            self.assertEqual(json.loads(result.stdout)["status"], "invalid_input")


    def test_source_verified_wait_contexts_and_compiler_suffixes(self):
        cases = (
            ("rpc_wait_bit_killable", "sunrpc"), ("xprt_wait_for_buffer_space", "sunrpc"),
            ("folio_wait_bit_common", "page_cache"), ("folio_put_wait_locked", "page_cache"),
            ("__folio_lock", "page_cache"), ("__folio_lock_killable", "page_cache"),
            ("handle_mm_fault", "page_fault"),
            ("__handle_mm_fault", "page_fault"), ("do_page_fault", "page_fault"),
            ("__do_page_fault", "page_fault"), ("io_cqring_wait", "io_uring"),
            ("io_cqring_wait_schedule", "io_uring"), ("ep_poll", "event_poll"),
            ("do_epoll_wait", "event_poll"), ("do_epoll_pwait", "event_poll"),
        )
        for symbol, expected in cases:
            for suffix in ("", ".isra.0", ".constprop.0", ".llvm.123"):
                with self.subTest(symbol=symbol, suffix=suffix):
                    thread(self.root, number=999, symbol=symbol + suffix, state="D")
                    self.assertEqual(self.sample()["threads"][0]["waits"], [expected])

    def test_mixed_contexts_are_sorted_and_deduplicated(self):
        cases = (
            (["filemap_fault", "folio_wait_bit_common", "__folio_lock"], ["file_backed_fault", "page_cache", "page_fault"]),
            (["nfs4_file_open", "rpc_wait_bit_killable", "xprt_wait_for_buffer_space"], ["nfs_io", "sunrpc"]),
            (["nfs4_file_open", "rpc_wait_bit_killable", "filemap_fault", "folio_wait_bit_common"],
             ["file_backed_fault", "nfs_io", "page_cache", "page_fault", "sunrpc"]),
        )
        for symbols, expected in cases:
            with self.subTest(symbols=symbols):
                thread(self.root, number=999, symbol=symbols[0], state="D")
                (self.base / "stack").write_text("".join(f"[<deadbeef>] {symbol}+0x1/0x2\n" for symbol in symbols))
                self.assertEqual(self.sample()["threads"][0]["waits"], expected)

    def test_file_fault_origin_is_exact_and_architecture_specific(self):
        for symbol, category in (("el0_ia", "instruction_fault"), ("el0_da", "data_fault")):
            for suffix in ("", ".isra.0", ".constprop.0", ".llvm.123"):
                with self.subTest(symbol=symbol, suffix=suffix):
                    thread(self.root, number=-1, symbol="folio_wait_bit_common", state="D")
                    (self.base / "syscall").write_text("-1 0xcafebabe 0xdeadbeef\n")
                    (self.base / "stack").write_text(f"filemap_fault{suffix}+0x1/0x2\n{symbol}{suffix}+0x1/0x2\n")
                    item = self.sample()["threads"][0]
                    self.assertEqual(item["waits"], sorted([category, "file_backed_fault", "page_cache", "page_fault"]))
                    self.assertIsNone(item["fd"])
                    for arch in ("x86_64", "riscv64"):
                        self.assertEqual(self.sample(arch)["threads"][0]["waits"], ["file_backed_fault", "page_cache", "page_fault"])
        for symbol in ("el0_ia_secret", "el0_da_secret", "filemap_fault_secret"):
            thread(self.root, number=999, symbol=symbol)
            self.assertEqual(self.sample()["threads"][0]["waits"], ["unknown"])

    def test_wait_syscalls_are_architecture_specific_without_fd_reads(self):
        cases = (("aarch64", 22, "event_poll"), ("aarch64", 441, "event_poll"),
                 ("x86_64", 232, "event_poll"), ("x86_64", 281, "event_poll"),
                 ("x86_64", 441, "event_poll"), ("aarch64", 426, "io_uring"),
                 ("x86_64", 426, "io_uring"), ("aarch64", 232, "unknown"),
                 ("x86_64", 22, "unknown"), ("riscv64", 426, "unknown"))
        for arch, number, expected in cases:
            with self.subTest(arch=arch, number=number):
                thread(self.root, number=number, symbol="secret_symbol")
                with patch.object(self.probe.os, "readlink", side_effect=AssertionError("unexpected descriptor read")):
                    item = self.sample(arch)["threads"][0]
                self.assertEqual(item["waits"], [expected])
                self.assertEqual(item["access"]["fd"], "not_applicable")

    def test_unknown_names_and_symbols_never_escape(self):
        thread(self.root, tid=43, number=999, symbol="secret_symbol", comm="secret-token")
        item = self.sample()["threads"][1]
        self.assertEqual((item["role"], item["waits"]), ("other", ["unknown"]))
        self.assertNotIn("secret_symbol", json.dumps(item))
        self.assertEqual((item["access"]["wchan"], item["access"]["stack"]), ("ok", "ok"))
        for symbol in ("filemap_fault_secret", "io_cqring_wait_secret", "ep_poll_secret"):
            thread(self.root, number=999, symbol=symbol)
            self.assertEqual(self.sample()["threads"][0]["waits"], ["unknown"])

    def test_roles_are_exact_and_sqlite_name_uses_fifteen_bytes(self):
        sqlite_comm = "sqlx-sqlite-worker-0"[:15]
        self.assertEqual(sqlite_comm, "sqlx-sqlite-wor")
        cases = (("codex-main", "codex_main"), ("tokio-rt-worker", "tokio_worker"),
                 (sqlite_comm, "sqlite_worker"), ("sqlx-sqlite-wo", "other"),
                 ("sqlx-sqlite-worker-0", "other"), ("codex-main-x", "other"),
                 ("secret ) name", "other"))
        for comm, expected in cases:
            with self.subTest(comm=comm):
                thread(self.root, tid=43, comm=comm)
                result = self.sample()
                self.assertEqual(result["threads"][0]["role"], "launcher")
                self.assertEqual(result["threads"][1]["role"], expected)

    def test_stat_state_comparison_does_not_replace_identity_check(self):
        self.assertTrue(self.sample()["threads"][0]["state_stable"])
        original = self.probe._stat
        calls = 0
        def changed(path, tid):
            nonlocal calls
            if path == str(self.base / "stat"):
                calls += 1
                if calls == 2:
                    self.base.joinpath("stat").write_text(stat(42, state="D"))
            return original(path, tid)
        with patch.object(self.probe, "_stat", side_effect=changed):
            item = self.sample()["threads"][0]
        self.assertEqual(item["state"], "S")
        self.assertFalse(item["state_stable"])
        self.assertEqual(item["access"]["stat"], "ok")
        self.assertEqual(item["waits"], ["pipe_io"])

    def test_runnable_state_does_not_hide_later_wait_context(self):
        thread(self.root, number=999, symbol="filemap_fault", state="R")
        original = self.probe._stat
        calls = 0
        def changed(path, tid):
            nonlocal calls
            if path == str(self.base / "stat"):
                calls += 1
                if calls == 2:
                    self.base.joinpath("stat").write_text(stat(42, state="D"))
            return original(path, tid)
        with patch.object(self.probe, "_stat", side_effect=changed):
            item = self.sample()["threads"][0]
        self.assertFalse(item["state_stable"])
        self.assertEqual(item["waits"], ["file_backed_fault", "page_fault", "runnable"])

    def test_failed_second_stat_has_no_role_or_state_claim(self):
        original = self.probe._stat
        for status in ("denied", "malformed", "missing"):
            calls = 0
            def lost(path, tid):
                nonlocal calls
                if path == str(self.base / "stat"):
                    calls += 1
                    if calls == 2:
                        return status, None
                return original(path, tid)
            with self.subTest(status=status), patch.object(self.probe, "_stat", side_effect=lost):
                item = self.sample()["threads"][0]
            self.assertEqual(item["access"]["stat"], status)
            self.assertEqual((item["role"], item["waits"]), ("other", ["unknown"]))
            self.assertIsNone(item["state_stable"])
            self.assertIsNone(item["state"])

    def test_soft_budget_remains_bounded_and_explicit(self):
        with patch.object(self.probe.time, "monotonic", side_effect=[0, 0, 0.75]):
            result = self.sample()
        self.assertEqual((result["status"], result["threads"]), ("budget_exhausted", []))
        self.assertTrue(result["capped"])

    def test_mixed_waits_are_trimmed_under_output_cap(self):
        for tid in range(43, 74):
            thread(self.root, tid=tid)
        result = self.probe._sample(42, 7, "aarch64")
        categories = sorted(category for category, _ in self.probe.WAIT_SYMBOLS)
        for item in result["threads"]:
            item["waits"] = categories
        encoded = self.probe._encode(result)
        self.assertLessEqual(len(encoded.encode()), 8192)
        trimmed = json.loads(encoded)
        self.assertTrue(trimmed["capped"])
        self.assertLess(len(trimmed["threads"]), 32)


if __name__ == "__main__":
    unittest.main()
