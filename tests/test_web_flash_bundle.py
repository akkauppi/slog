import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import build_web_flash_bundle as bundle


VERSION = "0.3.0-dev"
SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567"


def partition_binary() -> bytes:
    records = bytearray()
    for name, type_name, subtype_name, offset, size, flags in bundle.EXPECTED_PARTITIONS:
        label = name.encode("ascii").ljust(16, b"\0")
        records.extend(
            bundle.PARTITION_RECORD.pack(
                bundle.PARTITION_MAGIC,
                bundle.TYPE_VALUES[type_name],
                bundle.SUBTYPE_VALUES[(type_name, subtype_name)],
                offset,
                size,
                label,
                flags,
            )
        )
    digest = hashlib.md5(records).digest()
    records.extend(bundle.PARTITION_MD5_MAGIC)
    records.extend(digest)
    records.extend(b"\xff" * (bundle.PARTITION_TABLE_SIZE - len(records)))
    return bytes(records)


def write_fixture(root: Path) -> tuple[Path, Path, Path]:
    build_dir = root / "build"
    output_dir = root / "output"
    build_dir.mkdir(parents=True)
    partitions_csv = root / "partitions.csv"
    partitions_csv.write_text(
        "# Name, Type, SubType, Offset, Size, Flags\n"
        "nvs,data,nvs,0x9000,0x5000,\n"
        "otadata,data,ota,0xe000,0x2000,\n"
        "app0,app,ota_0,0x10000,0x140000,\n"
        "app1,app,ota_1,0x150000,0x140000,\n"
        "spiffs,data,spiffs,0x290000,0x160000,\n"
        "coredump,data,coredump,0x3f0000,0x10000,\n",
        encoding="ascii",
    )
    (build_dir / "bootloader.bin").write_bytes(b"bootloader")
    (build_dir / "partitions.bin").write_bytes(partition_binary())
    (build_dir / "ota_data_initial.bin").write_bytes(b"ota-data")
    (build_dir / "firmware.bin").write_bytes(
        b"application\0" + VERSION.encode("ascii") + b"\0" + SOURCE_COMMIT.encode("ascii")
    )
    arguments = {
        "flash_settings": {
            "flash_mode": "dio",
            "flash_size": "detect",
            "flash_freq": "80m",
        },
        "flash_files": {
            "0x0": "bootloader/bootloader.bin",
            "0x10000": "sauna_logger.bin",
            "0x8000": "partition_table/partition-table.bin",
            "0xe000": "ota_data_initial.bin",
        },
        "bootloader": {
            "offset": "0x0",
            "file": "bootloader/bootloader.bin",
            "encrypted": "false",
        },
        "app": {
            "offset": "0x10000",
            "file": "sauna_logger.bin",
            "encrypted": "false",
        },
        "partition-table": {
            "offset": "0x8000",
            "file": "partition_table/partition-table.bin",
            "encrypted": "false",
        },
        "otadata": {
            "offset": "0xe000",
            "file": "ota_data_initial.bin",
            "encrypted": "false",
        },
        "extra_esptool_args": {"chip": "esp32c3"},
    }
    (build_dir / "flasher_args.json").write_text(
        json.dumps(arguments), encoding="utf-8"
    )
    metadata = {
        "schema_version": 1,
        "firmware_version": VERSION,
        "source_commit": SOURCE_COMMIT,
        "platformio_environment": "xiao_esp32c3",
        "board": "seeed_xiao_esp32c3",
    }
    (build_dir / "sauna_build_metadata.json").write_text(
        json.dumps(metadata), encoding="utf-8"
    )
    return build_dir, partitions_csv, output_dir


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.build_dir, self.partitions_csv, self.output_dir = write_fixture(self.root)

    def build(self):
        return bundle.build_bundle(
            self.build_dir, self.partitions_csv, self.output_dir
        )

    def test_builds_exact_deterministic_bundle(self):
        manifest = self.build()
        first_manifest = (self.output_dir / "manifest.json").read_bytes()
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["product"], "sauna_logger")
        self.assertEqual(
            manifest["release"],
            {"version": VERSION, "source_commit": SOURCE_COMMIT},
        )
        self.assertEqual(
            manifest["target"],
            {
                "chip": "ESP32-C3",
                "board": "seeed_xiao_esp32c3",
                "flash_mode": "dio",
                "flash_frequency": "80m",
                "flash_size": 4 * 1024 * 1024,
                "partition_layout": "sauna_ota_v1",
            },
        )
        self.assertEqual(
            [partition["name"] for partition in manifest["partitions"]],
            [partition[0] for partition in bundle.EXPECTED_PARTITIONS],
        )
        self.assertEqual(
            [image["role"] for image in manifest["files"]],
            ["bootloader", "partition_table", "ota_data", "application"],
        )
        self.assertEqual(
            [image["path"] for image in manifest["files"]],
            [
                "./bootloader.bin",
                "./partitions.bin",
                "./ota_data_initial.bin",
                "./firmware.bin",
            ],
        )
        self.assertEqual(
            [image["offset"] for image in manifest["files"]],
            [0, 0x8000, 0xE000, 0x10000],
        )
        for image in manifest["files"]:
            path = self.output_dir / image["path"][2:]
            self.assertEqual(image["size"], path.stat().st_size)
            self.assertEqual(image["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(
            {path.name for path in self.output_dir.iterdir()},
            {
                "manifest.json",
                "bootloader.bin",
                "partitions.bin",
                "ota_data_initial.bin",
                "firmware.bin",
            },
        )

        self.build()
        self.assertEqual((self.output_dir / "manifest.json").read_bytes(), first_manifest)

    def test_rejects_corrupt_partition_binary_checksum(self):
        contents = bytearray((self.build_dir / "partitions.bin").read_bytes())
        contents[8] ^= 1
        (self.build_dir / "partitions.bin").write_bytes(contents)
        with self.assertRaisesRegex(bundle.BundleError, "MD5 checksum"):
            self.build()

    def test_rejects_partition_padding_before_checksum(self):
        contents = (self.build_dir / "partitions.bin").read_bytes()
        checksum_offset = len(bundle.EXPECTED_PARTITIONS) * bundle.PARTITION_RECORD.size
        malformed = (
            contents[:checksum_offset]
            + b"\xff" * bundle.PARTITION_RECORD.size
            + contents[checksum_offset : checksum_offset + bundle.PARTITION_RECORD.size]
            + contents[checksum_offset + 2 * bundle.PARTITION_RECORD.size :]
        )
        self.assertEqual(len(malformed), bundle.PARTITION_TABLE_SIZE)
        (self.build_dir / "partitions.bin").write_bytes(malformed)
        with self.assertRaisesRegex(bundle.BundleError, "padding appears before"):
            self.build()

    def test_rejects_partition_csv_binary_mismatch(self):
        contents = self.partitions_csv.read_text(encoding="ascii")
        self.partitions_csv.write_text(
            contents.replace("0x5000", "0x4000", 1), encoding="ascii"
        )
        with self.assertRaisesRegex(bundle.BundleError, "does not exactly match"):
            self.build()

    def test_rejects_any_fifth_flash_image(self):
        arguments_path = self.build_dir / "flasher_args.json"
        arguments = json.loads(arguments_path.read_text(encoding="utf-8"))
        arguments["flash_files"]["0x3f0000"] = "coredump.bin"
        arguments_path.write_text(json.dumps(arguments), encoding="utf-8")
        (self.build_dir / "coredump.bin").write_bytes(b"never package this")
        with self.assertRaisesRegex(bundle.BundleError, "exactly four flash files"):
            self.build()

    def test_rejects_flasher_path_outside_build_directory(self):
        arguments_path = self.build_dir / "flasher_args.json"
        arguments = json.loads(arguments_path.read_text(encoding="utf-8"))
        arguments["bootloader"]["file"] = "../../bootloader.bin"
        arguments["flash_files"]["0x0"] = "../../bootloader.bin"
        arguments_path.write_text(json.dumps(arguments), encoding="utf-8")
        with self.assertRaisesRegex(bundle.BundleError, "escapes the build directory"):
            self.build()

    def test_rejects_images_beyond_each_role_boundary(self):
        cases = {
            "bootloader.bin": (0x8001, "bootloader"),
            "partitions.bin": (bundle.PARTITION_TABLE_SIZE + 1, "partition binary"),
            "ota_data_initial.bin": (0x2001, "OTA-data"),
            "firmware.bin": (0x140001, "application"),
        }
        for index, (filename, (size, message)) in enumerate(cases.items()):
            with self.subTest(filename=filename):
                case_root = self.root / f"boundary-{index}"
                build_dir, partitions_csv, output_dir = write_fixture(case_root)
                (build_dir / filename).write_bytes(b"x" * size)
                with self.assertRaisesRegex(bundle.BundleError, message):
                    bundle.build_bundle(build_dir, partitions_csv, output_dir)

    def test_rejects_release_metadata_not_compiled_into_application(self):
        (self.build_dir / "firmware.bin").write_bytes(b"no release identity")
        with self.assertRaisesRegex(bundle.BundleError, "compiled firmware_version"):
            self.build()

    def test_public_metadata_rejects_dirty_or_unknown_commit(self):
        metadata_path = self.build_dir / "sauna_build_metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        for source_commit in (f"{SOURCE_COMMIT}-dirty", "unknown"):
            with self.subTest(source_commit=source_commit):
                metadata["source_commit"] = source_commit
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                with self.assertRaisesRegex(bundle.BundleError, "exact clean"):
                    bundle.read_build_metadata(metadata_path, require_release=True)


class PublicRepositoryTests(unittest.TestCase):
    def test_accepts_matching_clean_head(self):
        responses = [SimpleNamespace(stdout=f"{SOURCE_COMMIT}\n"), SimpleNamespace(stdout="")]
        with mock.patch.object(bundle.subprocess, "run", side_effect=responses):
            bundle.verify_public_repository(Path("/repository"), SOURCE_COMMIT)

    def test_rejects_untracked_worktree_file(self):
        responses = [
            SimpleNamespace(stdout=f"{SOURCE_COMMIT}\n"),
            SimpleNamespace(stdout="?? src/untracked.cpp\n"),
        ]
        with mock.patch.object(bundle.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(bundle.BundleError, "clean worktree"):
                bundle.verify_public_repository(Path("/repository"), SOURCE_COMMIT)

    def test_rejects_metadata_commit_different_from_head(self):
        head = "fedcba9876543210fedcba9876543210fedcba98"
        responses = [SimpleNamespace(stdout=f"{head}\n"), SimpleNamespace(stdout="")]
        with mock.patch.object(bundle.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(bundle.BundleError, "does not match"):
                bundle.verify_public_repository(Path("/repository"), SOURCE_COMMIT)


class CommandLineSafetyTests(unittest.TestCase):
    def test_refuses_output_outside_generated_subtree(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(
                bundle.main(["--output-dir", str(Path(directory) / "firmware")]),
                1,
            )

    def test_refuses_to_replace_generated_root(self):
        generated_root = Path(bundle.__file__).resolve().parents[1] / "portal/generated"
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bundle.main(["--output-dir", str(generated_root)]), 1)

    def test_public_mode_requires_a_fresh_build(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bundle.main(["--require-release-metadata"]), 1)


if __name__ == "__main__":
    unittest.main()
