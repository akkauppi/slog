import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import archive_logs
from test_logs import fixture


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "session.slog"
        self.source.write_bytes(fixture(version=2))
        self.output = self.root / "archive"

    def create(self, sources=None):
        return archive_logs.create_archive(sources or [self.source], self.output,
                                           {"installation_id": "lapland-1", "notes": "eight probes"})

    def test_round_trip_preserves_raw_context_and_versions(self):
        old = self.root / "old.slog"
        old.write_bytes(fixture(version=1))
        manifest = self.create([old, self.source])
        self.assertEqual(archive_logs.verify_archive(self.output), manifest)
        self.assertEqual(manifest["context"]["installation_id"], "lapland-1")
        self.assertEqual({e["inspection"]["format_version"] for e in manifest["files"]}, {1, 2})
        for source in [old, self.source]:
            raw = source.read_bytes()
            self.assertEqual((self.output / "raw" / (hashlib.sha256(raw).hexdigest() + ".slog")).read_bytes(), raw)
        self.assertNotIn(str(self.root), (self.output / "manifest.json").read_text())

    def test_duplicate_bytes_deduplicate_but_session_id_collisions_do_not(self):
        duplicate = self.root / "copy.slog"
        duplicate.write_bytes(self.source.read_bytes())
        other = self.root / "another-device.slog"
        other.write_bytes(fixture(version=1))  # Same local session ID, different bytes.
        manifest = self.create([self.source, duplicate, other])
        self.assertEqual(len(manifest["files"]), 2)
        self.assertEqual(sorted(len(e["source_names"]) for e in manifest["files"]), [1, 2])

    def test_corrupt_and_torn_sources_are_preserved_and_identified(self):
        broken = self.root / "broken.slog"
        broken.write_bytes(b"unreadable header")
        self.source.write_bytes(fixture(torn=True, version=2))
        manifest = self.create([self.source, broken])
        self.assertEqual({e["inspection"]["state"] for e in manifest["files"]}, {"recoverable", "unreadable"})
        archive_logs.verify_archive(self.output)

    def test_changed_missing_and_extra_raw_files_fail_verification(self):
        manifest = self.create()
        path = self.output / manifest["files"][0]["path"]
        raw = path.read_bytes()
        path.write_bytes(bytes([raw[0] ^ 1]) + raw[1:])
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            archive_logs.verify_archive(self.output)
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            archive_logs.verify_archive(self.output)
        path.write_bytes(raw)
        (self.output / "raw" / "extra.slog").write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "unlisted"):
            archive_logs.verify_archive(self.output)

    def test_refuses_existing_destination_and_does_not_change_source(self):
        raw = self.source.read_bytes()
        self.create()
        with self.assertRaises(FileExistsError):
            self.create()
        self.assertEqual(self.source.read_bytes(), raw)

    def test_failed_publication_leaves_recoverable_files_but_no_valid_archive(self):
        with patch.object(archive_logs.os, "rename", side_effect=OSError("power cut")):
            with self.assertRaises(OSError):
                self.create()
        self.assertTrue(list((self.output / "raw").glob("*.slog")))
        self.assertTrue((self.output / "manifest.pending").exists())
        with self.assertRaises(FileNotFoundError):
            archive_logs.verify_archive(self.output)

    def test_manifest_paths_versions_duplicates_and_symlinks_rejected(self):
        original = self.create()
        manifest_path = self.output / "manifest.json"
        for mutation in ["path", "schema", "duplicate"]:
            manifest = json.loads(json.dumps(original))
            if mutation == "path": manifest["files"][0]["path"] = "../session.slog"
            if mutation == "schema": manifest["schema"] = "future"
            if mutation == "duplicate": manifest["files"] *= 2
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                archive_logs.verify_archive(self.output)
        manifest_path.write_text(json.dumps(original))
        path = self.output / original["files"][0]["path"]
        path.unlink()
        path.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "unsafe"):
            archive_logs.verify_archive(self.output)

    def test_context_validation_and_cli(self):
        with self.assertRaises(ValueError):
            archive_logs.strict_json('{"notes":1,"notes":2}')
        with self.assertRaises(ValueError):
            archive_logs.create_archive([self.source], self.output, {"bad": float("nan")})
        self.assertFalse(self.output.exists())
        self.assertEqual(archive_logs.main(["create", str(self.source), "--output", str(self.output)]), 0)
        self.assertEqual(archive_logs.main(["verify", str(self.output)]), 0)
        self.assertEqual(archive_logs.main(["create", str(self.source), "--output", str(self.output)]), 1)


if __name__ == "__main__":
    unittest.main()
