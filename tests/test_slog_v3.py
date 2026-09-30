import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import logs

ROOT=Path(__file__).parents[1]
GOLDEN=ROOT/"tests/fixtures/v3_identity.slog"

class SlogV3Tests(unittest.TestCase):
    def test_production_encoder_matches_golden(self):
        with tempfile.TemporaryDirectory() as directory:
            binary=Path(directory)/"writer"
            output=Path(directory)/"actual.slog"
            subprocess.run(["g++","-std=c++11","-Wall","-Wextra","-Werror",
                            "-Ilib/saunan_link/src","-Ilib/saunan_wire/src",
                            "tests/write_v3_fixture.cpp","lib/saunan_link/src/radio_config.cpp",
                            "lib/saunan_wire/src/saunan_wire.cpp","-o",str(binary)],cwd=ROOT,check=True)
            subprocess.run([str(binary),str(output)],check=True)
            self.assertEqual(output.read_bytes(),GOLDEN.read_bytes())

    def test_python_browser_identity_parity_without_64bit_rounding(self):
        session=logs.parse_session(GOLDEN.read_bytes())
        self.assertEqual(session.source_id,"0000aabbccddeeff")
        self.assertEqual(session.boot_nonce,"fedcba9876543210")
        self.assertEqual(session.identity_flags,7)
        self.assertEqual(session.producer_commit,"0123456789abcdef0123456789abcdef01234567")
        self.assertEqual(session.producer_version,"0.4.0-dev")
        self.assertEqual(session.mapping_generation,9)
        self.assertEqual(session.samples[0].monotonic_ms,"9007199254740993")
        script="""import {readFileSync} from 'node:fs';
import {parseSlog} from './portal/js/log-analysis.js';
const s=parseSlog(readFileSync(process.argv[1])); console.log(JSON.stringify(s));"""
        browser=json.loads(subprocess.check_output(["node","--input-type=module","-e",script,str(GOLDEN)],cwd=ROOT,text=True))
        for js,py in [("sourceId","source_id"),("bootNonce","boot_nonce"),("mappingGeneration","mapping_generation"),("producerCommit","producer_commit"),("producerVersion","producer_version")]:
            self.assertEqual(browser[js],getattr(session,py))
        for actual,expected in zip(browser["samples"],session.samples):
            self.assertEqual(actual["acquisitionSequence"],expected.acquisition_sequence)
            self.assertEqual(actual["monotonicMs"],expected.monotonic_ms)
            self.assertEqual(actual["skippedScheduleCount"],expected.skipped_schedule_count)
        self.assertTrue(browser["finalized"])
        self.assertFalse(browser["warnings"])

    def test_all_truncations_preserve_only_complete_blocks(self):
        raw=GOLDEN.read_bytes()
        for cut in range(len(raw)+1):
            if cut<204:
                with self.assertRaises(ValueError): logs.parse_session(raw[:cut])
            else:
                session=logs.parse_session(raw[:cut])
                self.assertEqual(len(session.samples),4 if cut>=384 else 0)
                self.assertEqual(session.finalized,cut==404)

    def test_block_metadata_is_integrity_protected(self):
        for offset in [208,212,214,220,260]:
            raw=bytearray(GOLDEN.read_bytes()); raw[offset]^=1
            session=logs.parse_session(raw)
            self.assertFalse(session.finalized)
            self.assertEqual(len(session.samples),0)
            self.assertTrue(session.warnings)

    def test_invalid_identity_header_and_record_fail_closed(self):
        raw=bytearray(GOLDEN.read_bytes()); raw[138:146]=bytes(8)
        struct.pack_into("<I",raw,200,zlib.crc32(raw[:200]))
        with self.assertRaisesRegex(ValueError,"identity"): logs.parse_session(raw)
        raw=bytearray(GOLDEN.read_bytes())
        raw[220+41+25:220+41+29]=raw[220+25:220+29]  # Repeated acquisition identity.
        struct.pack_into("<I",raw,216,zlib.crc32(raw[204:216]+raw[220:384]))
        session=logs.parse_session(raw)
        self.assertFalse(session.samples)
        self.assertTrue(any("identity" in w for w in session.warnings))

    def test_monotonic_jitter_and_same_nonce_continuation_without_boot_counter(self):
        import sauna_analysis
        parent=bytearray(GOLDEN.read_bytes())
        struct.pack_into("<I",parent,46,0); parent[161]&=~1
        struct.pack_into("<I",parent,200,zlib.crc32(parent[:200]))
        parent[388]=2
        struct.pack_into("<I",parent,400,zlib.crc32(parent[384:400]))
        child=bytearray(parent)
        struct.pack_into("<I",child,12,8); struct.pack_into("<I",child,42,7)
        child[51]=3; child[53]=30
        struct.pack_into("<I",child,200,zlib.crc32(child[:200]))
        base=9007199254740993
        for index,(relative,sequence,elapsed) in enumerate([(-40,72,20000),(-30,73,30000),(-20,74,40000),(0,75,60001)]):
            offset=220+41*index
            struct.pack_into("<i",child,offset,relative)
            struct.pack_into("<8h",child,offset+4,*([2000+10*(sequence-70)]*8))
            struct.pack_into("<IQI",child,offset+25,sequence,base+elapsed,3 if index==3 else 2)
        struct.pack_into("<I",child,216,zlib.crc32(child[204:216]+child[220:384]))
        child[388]=1; struct.pack_into("<i",child,396,0)
        struct.pack_into("<I",child,400,zlib.crc32(child[384:400]))
        run=sauna_analysis.build_run([logs.parse_session(parent),logs.parse_session(child)])
        self.assertEqual(len(run.points),6)
        self.assertFalse(run.breaks)
        self.assertAlmostEqual(run.points[-1].observed_seconds,40.001)
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/"a.slog",Path(directory)/"b.slog"]
            for path,raw in zip(paths,[parent,child]): path.write_bytes(raw)
            script="""import {readFileSync} from 'node:fs';
import {parseSlog,buildRun} from './portal/js/log-analysis.js';
const run=buildRun(process.argv.slice(1).map(p=>parseSlog(readFileSync(p))));
console.log(JSON.stringify({times:run.points.map(p=>p.observedSeconds),gaps:run.breaks.length}));"""
            result=json.loads(subprocess.check_output(["node","--input-type=module","-e",script,*map(str,paths)],cwd=ROOT,text=True))
            self.assertEqual(result["gaps"],0)
            self.assertEqual(result["times"],[p.observed_seconds for p in run.points])
