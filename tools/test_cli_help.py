"""Check that help works without starting a service or enrolling a machine."""
import subprocess
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

BINARY = Path(sys.argv.pop(1)).resolve()


class HelpTest(unittest.TestCase):
    def run_help(self, *args):
        with tempfile.TemporaryDirectory() as cwd:
            return subprocess.run([str(BINARY), *args], cwd=cwd, text=True,
                                  capture_output=True, timeout=5)

    def test_named_help_explains_the_selected_mode(self):
        for mode, expected in [("coordinator", "--poll-interval-sec"),
                               ("agent", "--min-free-mb"),
                               ("hosted-agent", "Enrollment codes")]:
            with self.subTest(mode=mode):
                result = self.run_help("help", mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)

    def test_mode_help_exits_before_runtime_configuration(self):
        for mode in ["coordinator", "agent", "hosted-agent", "discover",
                     "trigger", "logs", "status", "cancel"]:
            for flag in ["--help", "-h"]:
                with self.subTest(mode=mode, flag=flag):
                    result = self.run_help(mode, flag)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Usage:", result.stdout)

    def test_unknown_help_topic_reports_an_error(self):
        result = self.run_help("help", "does-not-exist")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Unknown help topic", result.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows batch launcher")
    def test_launcher_help_preserves_a_pending_graceful_stop(self):
        launcher = Path(__file__).resolve().parents[1] / "config/experiment/Start-Smith.bat"
        with tempfile.TemporaryDirectory() as cwd:
            package = Path(cwd)
            shutil.copy2(BINARY, package / "Smith.exe")
            for dependency in BINARY.parent.glob("*.dll"):
                shutil.copy2(dependency, package / dependency.name)
            shutil.copy2(launcher, package / launcher.name)
            stop_file = package / "stop-agent"
            stop_file.write_text("finish current work")
            for args in [["help"], ["agent", "--help"], ["agent", "-h"],
                         ["agent", "--workspace-id", "demo", "--labels", "a,b", "--help"]]:
                with self.subTest(args=args):
                    result = subprocess.run(["cmd.exe", "/d", "/c", "Start-Smith.bat", *args],
                                            cwd=cwd, text=True, capture_output=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Enrollment codes", result.stdout)
                    self.assertEqual(stop_file.read_text(), "finish current work")
                    self.assertFalse((package / "hosted-workspace").exists())


if __name__ == "__main__":
    unittest.main()
