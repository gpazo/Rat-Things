import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


GUEST = Path(__file__).resolve().parents[4] / "runtime/native/guest.py"


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeGuestTests(unittest.TestCase):
    def test_archive_preserves_hard_links_and_symbolic_links(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "source")
            target = Path(directory, "target")
            source.mkdir()
            target.mkdir()
            Path(source, "original").write_text("executable payload")
            os.chmod(Path(source, "original"), 0o755)
            os.link(Path(source, "original"), Path(source, "alias"))
            os.symlink("original", Path(source, "symbolic"))
            output = io.BytesIO()
            load(GUEST.with_name("archive-root.py")).archive(str(source), output)
            subprocess.run(["cpio", "-idm"], cwd=target, input=output.getvalue(), check=True, capture_output=True)
            self.assertEqual(Path(target, "alias").read_text(), "executable payload")
            self.assertEqual(Path(target, "original").stat().st_ino, Path(target, "alias").stat().st_ino)
            self.assertEqual(Path(target, "original").stat().st_mode & 0o777, 0o755)
            self.assertEqual(os.readlink(Path(target, "symbolic")), "original")

    def test_stopping_an_exited_worker_still_completes(self):
        process = subprocess.Popen(["/usr/bin/true"], start_new_session=True)
        process.wait(timeout=5)
        self.assertIsNone(load(GUEST).stop_worker(process))

    def test_stopping_a_running_worker_reaps_it(self):
        process = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
        try:
            self.assertIsNone(load(GUEST).stop_worker(process))
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
