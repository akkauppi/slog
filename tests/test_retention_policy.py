import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class RetentionPolicyTests(unittest.TestCase):
    def test_safe_rolling_retention_fixtures(self):
        compiler = shutil.which("g++")
        if compiler is None:
            self.skipTest("host C++ compiler is unavailable")

        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "retention-policy-test"
            compilation = subprocess.run(
                [
                    compiler,
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-pedantic",
                    "-I",
                    str(ROOT / "src"),
                    str(ROOT / "src" / "retention_policy.cpp"),
                    str(ROOT / "tests" / "retention_policy_test.cpp"),
                    "-o",
                    str(executable),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(compilation.returncode, 0, compilation.stderr)

            result = subprocess.run(
                [str(executable)], capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
