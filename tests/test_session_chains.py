import dataclasses
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import logs
import sauna_analysis
from test_logs import fixture


def segment(session_id, parent, seconds, *, reason=1, kind=0, delay=0):
    header = bytearray(fixture(version=2)[:142])
    struct.pack_into("<I", header, 12, session_id)
    struct.pack_into("<I", header, 42, parent)
    header[51], header[53] = kind, delay
    struct.pack_into("<I", header, 138, zlib.crc32(header[:138]))
    payload = b"".join(logs.RECORD_V2.pack(t, *([7000] * 8), 255, 3500, 3)
                       for t in seconds)
    block = logs.BLOCK.pack(logs.BLOCK_MAGIC, 0, len(seconds), len(payload),
                            zlib.crc32(payload)) + payload
    footer = logs.FOOTER.pack(logs.FOOTER_MAGIC, reason, len(seconds), seconds[-1], 0)
    footer = footer[:-4] + struct.pack("<I", zlib.crc32(footer[:-4]))
    return bytes(header) + block + footer


class ChainTests(unittest.TestCase):
    def test_selecting_any_member_returns_the_whole_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / f"session-{i}.slog" for i in (10, 11, 12)]
            for i, path in enumerate(paths):
                path.write_bytes(segment(10 + i, 9 + i if i else 0, [0, 10]))
            for path in paths:
                self.assertEqual([s.session_id for s in logs.discover_run(path)], [10, 11, 12])
            self.assertEqual([s.session_id for s in logs.discover_run(paths[1], False)], [11])

    def test_duplicate_files_must_be_byte_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = (Path(directory) / name for name in ("one.slog", "two.slog"))
            first.write_bytes(segment(10, 0, [0, 10]))
            second.write_bytes(first.read_bytes())
            self.assertEqual(len(logs.discover_run(first)), 1)
            second.write_bytes(segment(10, 0, [0, 20]))
            with self.assertRaisesRegex(ValueError, "conflicting files"):
                logs.discover_run(first)

    def test_python_and_browser_align_the_same_raw_continuation(self):
        if shutil.which("node") is None:
            self.skipTest("node unavailable for differential test")
        root_bytes = segment(10, 0, [-20, -10, 0, 10], reason=2)
        child_bytes = segment(11, 10, [-40, -30, -20, -10, 0, 10], kind=3, delay=30)
        sessions = [logs.parse_session(data) for data in (root_bytes, child_bytes)]
        run = sauna_analysis.build_run(sessions)
        self.assertEqual(len(sessions[1].samples), 6)  # Raw child remains intact.
        self.assertEqual(len(run.points), 8)
        self.assertEqual(len(run.breaks), 0)
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / f"{i}.slog" for i in range(2)]
            for path, data in zip(paths, (root_bytes, child_bytes)):
                path.write_bytes(data)
            script = f"""
import {{ readFileSync }} from 'node:fs';
import {{ parseSlog, buildRun }} from {json.dumps((ROOT / 'portal/js/log-analysis.js').as_uri())};
const run = buildRun({json.dumps([str(p) for p in paths])}.map(p => parseSlog(readFileSync(p))));
console.log(JSON.stringify({{points:run.points.map(p=>[p.segment,p.relativeSeconds,p.observedSeconds]),gaps:run.breaks.length}}));
"""
            browser = json.loads(subprocess.check_output(
                ["node", "--input-type=module", "-e", script], text=True))
        self.assertEqual(browser, {
            "points": [[p.segment, p.relative_seconds, p.observed_seconds] for p in run.points],
            "gaps": len(run.breaks),
        })

    def test_unproven_timing_keeps_every_raw_point_and_an_unknown_gap(self):
        root = logs.parse_session(segment(10, 0, [-20, -10, 0, 10], reason=2))
        child = logs.parse_session(segment(11, 10, [-40, -30, -20, -10, 0, 10], kind=3, delay=30))
        cases = [
            (dataclasses.replace(root, boot_id=0), child),
            (root, dataclasses.replace(child, boot_id=root.boot_id + 1)),
            (root, dataclasses.replace(child, continuation_delay_seconds=0)),
            (root, dataclasses.replace(child, continuation_delay_seconds=20)),
            (dataclasses.replace(root, footer_record_count=99), child),
            (dataclasses.replace(root, final_relative_seconds=999), child),
            (dataclasses.replace(root, finalized=False), child),
            (root, dataclasses.replace(child, continuation_kind="probable_power_restore")),
        ]
        for first, second in cases:
            with self.subTest(first=first.boot_id, child=second.continuation_delay_seconds):
                run = sauna_analysis.build_run([first, second])
                self.assertEqual(len(run.points), 10)
                self.assertEqual(len(run.breaks), 1)

    def test_run_rejects_duplicate_or_unlinked_segments(self):
        root = logs.parse_session(segment(10, 0, [0, 10]))
        with self.assertRaisesRegex(ValueError, "more than once"):
            sauna_analysis.build_run([root, root])
        with self.assertRaisesRegex(ValueError, "does not continue"):
            sauna_analysis.build_run([root, dataclasses.replace(root, session_id=11)])
