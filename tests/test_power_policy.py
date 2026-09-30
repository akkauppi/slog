from pathlib import Path
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).parents[1]
class PowerPolicyTests(unittest.TestCase):
    def test_cold_checks_wake_thresholds_faults_recording_and_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = str(Path(directory) / 'power')
            subprocess.run(['g++', '-std=c++11', '-Wall', '-Wextra', '-Werror',
                            '-Isrc', 'tests/test_power_policy.cpp', '-o', binary],
                           cwd=ROOT, check=True)
            subprocess.run([binary], check=True)
