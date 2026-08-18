import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class ProbeConfigTests(unittest.TestCase):
    def compile_and_run(self, sources: list[Path], name: str, includes=()):
        compiler = shutil.which("g++")
        if compiler is None:
            self.skipTest("host C++ compiler is unavailable")

        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / name
            compilation = subprocess.run(
                [
                    compiler,
                    "-std=c++17",
                    "-Wall",
                    "-Wextra",
                    "-pedantic",
                    *[
                        argument
                        for include in includes
                        for argument in ("-I", str(include))
                    ],
                    "-I",
                    str(ROOT / "src"),
                    *[str(source) for source in sources],
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

    def test_probe_configuration_and_power_cut_fixtures(self):
        self.compile_and_run(
            [
                ROOT / "src" / "probe_config.cpp",
                ROOT / "tests" / "probe_config_test.cpp",
            ],
            "probe-config-test",
        )

    def test_nvs_slot_store_and_readback_fixtures(self):
        self.compile_and_run(
            [
                ROOT / "src" / "probe_config.cpp",
                ROOT / "src" / "probe_config_store.cpp",
                ROOT / "tests" / "probe_config_store_test.cpp",
            ],
            "probe-config-store-test",
            includes=[ROOT / "tests" / "firmware_host"],
        )


if __name__ == "__main__":
    unittest.main()
