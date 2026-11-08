import importlib.util
import pathlib
import tempfile
import unittest


PROFILE_PATH = pathlib.Path(__file__).with_name("storage-profile.py")
SPEC = importlib.util.spec_from_file_location("storage_profile", PROFILE_PATH)
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class StorageProfileParserTests(unittest.TestCase):
    def test_parses_strace_total_row_with_empty_usecs_column(self):
        summary = """% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
 75.00    0.000015           5         3           openat
 25.00    0.000005           2         2           close
------ ----------- ----------- --------- --------- ----------------
100.00    0.000020                     5           total
"""
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as output:
            output.write(summary)
            output.flush()
            trace = PROFILE.parse_trace(output.name)

        self.assertTrue(trace["available"])
        self.assertEqual(trace["totalSeconds"], 0.000020)
        self.assertEqual(trace["calls"], 5)
        self.assertEqual(trace["syscalls"], [
            {"name": "openat", "calls": 3, "seconds": 0.000015},
            {"name": "close", "calls": 2, "seconds": 0.000005},
        ])

    def test_parses_padded_cpython_importtime_lines_and_filters_other_modules(self):
        output = b"""import time:       151 |        151 | _io
import time:      1024 |       1024 |   efs_utils_common
import time:       511 |       1535 |     efs_utils_common.metadata
import time:       999 |        999 | arbitrary_private_module
"""
        self.assertEqual(PROFILE.parse_import_timings(output), [
            {"module": "efs_utils_common", "selfUs": 1024, "cumulativeUs": 1024},
            {"module": "efs_utils_common.metadata", "selfUs": 511, "cumulativeUs": 1535},
        ])


if __name__ == "__main__":
    unittest.main()
