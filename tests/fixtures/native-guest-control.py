"""Exercise the real guest control handler with an inert process and virtual time."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_guest", Path(__file__).parents[2] / "runtime/native/guest.py")
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestControlTests(unittest.TestCase):
    def run_start(self, timeout_ms, steps, legacy=False):
        timers = []
        killed = []
        elapsed = 0

        class Timer:
            def __init__(self, seconds, callback):
                self.seconds, self.callback, self.cancelled = seconds, callback, False
                timers.append(self)

            def start(self):
                pass

            def cancel(self):
                self.cancelled = True

        class WorkerOutput:
            def readline(self, _limit):
                nonlocal elapsed
                for step in steps:
                    elapsed += step
                    for timer in timers:
                        if not timer.cancelled and elapsed >= timer.seconds:
                            timer.cancelled = True
                            timer.callback()
                    if killed:
                        return b""
                return b'{"status":"ready"}\n'

        class Worker:
            pid = 42
            stdin = io.BytesIO()
            stdout = WorkerOutput()

            def poll(self):
                return -9 if killed else None

            def wait(self, timeout):
                return -9

        guest.worker = None
        parent, child = socket.socketpair()
        try:
            request = {"operation": "start", "configuration": {}}
            if not legacy:
                request["timeoutMs"] = timeout_ms
            parent.sendall(json.dumps(request).encode() + b"\n")
            with patch.object(guest.subprocess, "Popen", return_value=Worker()), \
                    patch.object(guest.threading, "Timer", Timer), \
                    patch.object(guest.os, "killpg", side_effect=lambda pid, signal: killed.append((pid, signal))), \
                    contextlib.redirect_stdout(io.StringIO()):
                guest.handle_control(child)
            response = json.loads(parent.recv(4096))
        finally:
            child.close()
            parent.close()
            guest.worker = None
        return response, timers, killed

    def test_sequential_setup_can_exceed_the_old_60_and_120_second_limits(self):
        response, timers, killed = self.run_start(1_280_000, [605, 605])
        self.assertEqual(response, {"result": {"ready": True}})
        self.assertFalse(killed)
        self.assertEqual(timers[0].seconds, 1280)
        self.assertTrue(timers[0].cancelled)

    def test_setup_still_stops_at_the_admitted_deadline(self):
        response, _, killed = self.run_start(670_000, [671])
        self.assertIn("error", response)
        self.assertTrue(killed)

    def test_keeps_the_default_for_existing_controller_requests(self):
        response, timers, killed = self.run_start(None, [65], legacy=True)
        self.assertEqual(response, {"result": {"ready": True}})
        self.assertFalse(killed)
        self.assertEqual(timers[0].seconds, 90)

    def test_rejects_invalid_deadlines_before_starting_the_worker(self):
        for value in (None, True, -1, 0, "670000", 1.5):
            with self.subTest(value=value):
                response, timers, killed = self.run_start(value, [])
                self.assertIn("error", response)
                self.assertFalse(timers)
                self.assertFalse(killed)


if __name__ == "__main__":
    unittest.main()
