from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class SessionTemperatureTests(unittest.TestCase):
    def test_recorded_peak_and_cooling_rearm(self):
        compiler = shutil.which("g++")
        if compiler is None:
            self.skipTest("host C++ compiler unavailable")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "session-temperature-test"
            result = subprocess.run([
                compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror",
                "-pedantic", "-I", str(ROOT / "src"),
                str(ROOT / "tests/session_temperature_test.cpp"),
                "-o", str(executable),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
