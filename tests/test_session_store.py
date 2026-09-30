from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parents[1]


class SessionStoreTests(unittest.TestCase):
    def test_real_littlefs_power_cuts_preserve_published_data(self):
        library = ROOT / ".pio/libdeps/xiao_esp32c3/esp_littlefs/src/littlefs"
        if not (library / "lfs.c").is_file():
            self.skipTest("run pio run first to install the pinned LittleFS sources")
        cc, cxx = shutil.which("cc"), shutil.which("g++")
        if not cc or not cxx:
            self.skipTest("host C/C++ compilers unavailable")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            objects = []
            for source in ("lfs.c", "lfs_util.c"):
                obj = output / f"{source}.o"
                result = subprocess.run([
                    cc, "-std=c11", "-O2", "-DLFS_NO_DEBUG", "-DLFS_NO_WARN",
                    "-DLFS_NO_ERROR", "-I", str(library), "-c", str(library / source),
                    "-o", str(obj),
                ], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                objects.append(str(obj))
            executable = output / "littlefs-store-test"
            result = subprocess.run([
                cxx, "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror",
                "-I", str(library), "-I", str(ROOT / "src"),
                str(ROOT / "src/session_store.cpp"),
                str(ROOT / "tests/session_store_littlefs_test.cpp"), *objects,
                "-o", str(executable),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_publication_and_commit_failure_boundaries(self):
        compiler = shutil.which("g++")
        if compiler is None:
            self.skipTest("host C++ compiler unavailable")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "session-store-test"
            built = subprocess.run([
                compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic",
                "-I", str(ROOT / "src"), str(ROOT / "src/session_store.cpp"),
                str(ROOT / "src/session_store_posix.cpp"),
                str(ROOT / "tests/session_store_test.cpp"), "-o", str(executable),
            ], capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            result = subprocess.run([str(executable), directory], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
