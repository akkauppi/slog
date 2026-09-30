from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT=Path(__file__).parents[1]
class SharedContractTests(unittest.TestCase):
    def test_host_wire_and_radio_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["test_wire", "test_link"]:
                binary=Path(directory)/name
                subprocess.run(["g++","-std=c++11","-Wall","-Wextra","-Werror",
                                "-Ilib/saunan_link/src","-Ilib/saunan_wire/src",
                                f"tests/{name}.cpp","lib/saunan_link/src/radio_config.cpp",
                                "lib/saunan_wire/src/saunan_wire.cpp","-o",str(binary)],cwd=ROOT,check=True)
                subprocess.run([str(binary)],check=True,capture_output=True)
