import struct
import tempfile
import unittest
import zlib
import re
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import logs
import sauna_analysis


def fixture(torn=False, version=1):
    descriptors = b"".join(logs.DESCRIPTOR.pack(bytes([0x28, i, 0, 0, 0, 0, 0, i]), -20 * i) for i in range(8))
    header_struct = logs.HEADER_V1 if version == 1 else logs.HEADER_V2
    header_size = header_struct.size + len(descriptors) + 4
    common = (logs.HEADER_MAGIC, version, header_size, 7, 10000, 600000,
              20, 8, 0, 4000, 4500, 1500, 30, 1800, 6)
    if version == 1:
        header = header_struct.pack(*common)
    else:
        header = header_struct.pack(*common, 42, 9, 2, 1, 0, 32768)
    header += descriptors
    header += struct.pack("<I", zlib.crc32(header) & 0xFFFFFFFF)
    record_struct = logs.RECORD_V1 if version == 1 else logs.RECORD_V2
    records = b"".join(
        record_struct.pack(second, *([2000 + second] * 8), 0xFF,
                           *(() if version == 1 else (3500, 0x0003)))
        for second in (-20, -10, 0, 10)
    )
    block = logs.BLOCK.pack(logs.BLOCK_MAGIC, 0, 4, len(records), zlib.crc32(records) & 0xFFFFFFFF) + records
    if torn:
        return header + block + logs.BLOCK.pack(logs.BLOCK_MAGIC, 1, 2, 42, 0) + b"short"
    footer = logs.FOOTER.pack(logs.FOOTER_MAGIC, 1, 4, 10, 0)
    footer = footer[:-4] + struct.pack("<I", zlib.crc32(footer[:-4]) & 0xFFFFFFFF)
    return header + block + footer


class LogTests(unittest.TestCase):
    def test_complete_session(self):
        session = logs.parse_session(fixture())
        self.assertEqual(session.session_id, 7)
        self.assertEqual(len(session.samples), 4)
        self.assertTrue(session.finalized)
        self.assertEqual(session.finish_reason, "normal_cooling")
        self.assertEqual(session.samples[0].temperatures_c[0], 19.8)

    def test_torn_tail_is_recovered(self):
        session = logs.parse_session(fixture(torn=True))
        self.assertEqual(len(session.samples), 4)
        self.assertFalse(session.finalized)
        self.assertTrue(any("torn" in warning for warning in session.warnings))

    def test_version_two_health_metadata(self):
        session = logs.parse_session(fixture(version=2))
        self.assertEqual(session.version, 2)
        self.assertEqual(session.boot_id, 42)
        self.assertEqual(session.reset_reason, "brownout")
        self.assertEqual(session.continuation_kind, "probable_power_restore")
        self.assertEqual(session.initial_rtc_source, "external_32k_xtal")
        self.assertEqual(session.samples[0].chip_temperature_c, 35.0)

    def test_sample_anchored_max_duration_kind_is_named(self):
        data = bytearray(fixture(version=2))
        header_size = struct.unpack_from("<H", data, 10)[0]
        data[51] = 3
        data[53] = 30
        struct.pack_into(
            "<I", data, header_size - 4,
            zlib.crc32(data[:header_size - 4]) & 0xFFFFFFFF,
        )
        session = logs.parse_session(data)
        self.assertEqual(session.continuation_kind, "max_duration_sample_anchored")
        self.assertEqual(session.continuation_delay_seconds, 30)

    def test_every_power_cut_offset_is_safe(self):
        complete = fixture(version=2)
        header_size = struct.unpack_from("<H", complete, 10)[0]
        for cut in range(len(complete) + 1):
            if cut < header_size:
                with self.assertRaises(ValueError):
                    logs.parse_session(complete[:cut])
                continue
            session = logs.parse_session(complete[:cut])
            self.assertLessEqual(len(session.samples), 4)
            if cut < len(complete):
                self.assertFalse(session.finalized)

    def test_bad_header_crc_is_rejected(self):
        data = bytearray(fixture())
        data[20] ^= 1
        with self.assertRaisesRegex(ValueError, "header CRC"):
            logs.parse_session(data)

    def test_csv_and_plot_outputs(self):
        session = logs.parse_session(fixture())
        with tempfile.TemporaryDirectory() as directory:
            csv_path = Path(directory) / "session.csv"
            html_path = Path(directory) / "session.html"
            logs.export_csv(session, csv_path)
            logs.export_html(session, html_path)
            self.assertIn("probe_1_c", csv_path.read_text())
            self.assertIn("Sauna session 7", html_path.read_text())
            self.assertIn("applySaunaPlotTheme", html_path.read_text())
            self.assertIn("prefers-color-scheme:dark", html_path.read_text())
            self.assertIsNone(re.search(r'<script[^>]+src=["\']https?://', html_path.read_text()))
            report = logs.session_report(session)
            self.assertIn("vertical_gradient_c_per_m", report)
            self.assertIn("thermal_analysis", report)
            self.assertEqual(report["probes"][0]["missing_samples"], 0)


class AnalysisTests(unittest.TestCase):
    def session(self, session_id=1, continuation_of=0, start=-120, count=61,
                missing_probe=None, pulse=True):
        sensors = [logs.Sensor(f"28{index:014X}", -20 * index) for index in range(8)]
        samples = []
        for index in range(count):
            second = start + index * 10
            temperatures = []
            for probe in range(8):
                value = 70.0 - probe * 2.0
                if pulse and 120 <= second <= 180 and probe < 4:
                    value += (second - 120) / 60 * 8
                elif pulse and second > 180 and probe < 4:
                    value += 8
                temperatures.append(None if probe == missing_probe else value)
            samples.append(logs.Sample(second, tuple(temperatures), 34.0, 3))
        return logs.Session(session_id, 10000, sensors, samples, True, "normal_cooling", [],
                            continuation_of=continuation_of, version=2,
                            reset_reason="power_on", initial_rtc_source="external_32k_xtal")

    def test_gradient_events_and_missing_probe(self):
        run = sauna_analysis.build_run([self.session(missing_probe=5)])
        report = sauna_analysis.analyze_run(run)
        self.assertAlmostEqual(report["vertical_gradient_c_per_m"]["minimum"], 10.0, places=5)
        self.assertGreaterEqual(len(report["rapid_warming_candidates"]), 1)
        self.assertEqual(report["probes"][5]["valid_samples"], 0)
        self.assertIsNone(report["probes"][5]["maximum_c"])

    def test_power_continuation_uses_explicit_break(self):
        first = self.session(session_id=10, start=-20, count=5, pulse=False)
        second = self.session(session_id=11, continuation_of=10, start=-20, count=5, pulse=False)
        run = sauna_analysis.build_run([first, second])
        self.assertEqual(len(run.breaks), 1)
        self.assertEqual(run.breaks[0], run.points[4].observed_seconds)
        self.assertEqual(run.points[5].observed_seconds - run.points[4].observed_seconds, 0)
        self.assertNotEqual(run.points[5].relative_seconds, run.points[5].observed_seconds)

    def test_every_working_probe_count_is_supported(self):
        for working in range(1, 9):
            session = self.session(pulse=False)
            session.samples = [
                logs.Sample(sample.relative_seconds,
                            tuple(value if index < working else None
                                  for index, value in enumerate(sample.temperatures_c)),
                            sample.chip_temperature_c, sample.status_flags)
                for sample in session.samples
            ]
            report = sauna_analysis.analyze_run(sauna_analysis.build_run([session]))
            self.assertEqual(report["probes"][working - 1]["valid_samples"], len(session.samples))
            if working < 4:
                self.assertIsNone(report["vertical_gradient_c_per_m"]["mean"])

    def test_comparison_report_is_offline(self):
        runs = [sauna_analysis.build_run([self.session(1)]),
                sauna_analysis.build_run([self.session(2, pulse=False)])]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "comparison.html"
            sauna_analysis.export_comparison_html(runs, output)
            document = output.read_text()
            self.assertIn("Thermal comparison", document)
            self.assertIn("140 cm", document)
            self.assertIn("applySaunaPlotTheme", document)
            self.assertIsNone(re.search(r'<script[^>]+src=["\']https?://', document))


if __name__ == "__main__":
    unittest.main()
