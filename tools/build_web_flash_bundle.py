#!/usr/bin/env python3
"""Build and validate the static firmware bundle used by the web flasher.

Flash offsets are read exclusively from ESP-IDF's generated
``flasher_args.json``.  The generated partition binary is decoded, including
its MD5 record, and compared exactly with the repository CSV before any image
is copied into the portal artifact.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


SCHEMA_VERSION = 2
COMMISSIONING_PROTOCOL = 1
COMMISSIONING_PROTOCOL_SENTINEL = b"SAUNA_COMMISSIONING_PROTOCOL=1"
PRODUCT = "sauna_logger"
CHIP = "ESP32-C3"
CHIP_ARGUMENT = "esp32c3"
BOARD = "seeed_xiao_esp32c3"
PLATFORMIO_ENVIRONMENT = "xiao_esp32c3"
FLASH_MODE = "dio"
FLASH_FREQUENCY = "80m"
FLASH_SIZE = 4 * 1024 * 1024
PARTITION_LAYOUT_ID = "sauna_ota_v1"
PARTITION_TABLE_SIZE = 0xC00
PARTITION_MAGIC = b"\xAA\x50"
PARTITION_MD5_MAGIC = b"\xEB\xEB" + b"\xFF" * 14
PARTITION_RECORD = struct.Struct("<2sBBII16sI")
VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}\Z")
COMMIT_RE = re.compile(r"(?:[0-9a-f]{40}(?:-dirty)?|unknown)\Z")
PUBLIC_COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")


TYPE_VALUES = {"app": 0x00, "data": 0x01}
SUBTYPE_VALUES = {
    ("app", "ota_0"): 0x10,
    ("app", "ota_1"): 0x11,
    ("data", "ota"): 0x00,
    ("data", "nvs"): 0x02,
    ("data", "coredump"): 0x03,
    ("data", "spiffs"): 0x82,
}

# This is the only supported flash layout.  Constants here are validation
# boundaries, never the source of an image's emitted flash offset.
EXPECTED_PARTITIONS = (
    ("nvs", "data", "nvs", 0x9000, 0x5000, 0),
    ("otadata", "data", "ota", 0xE000, 0x2000, 0),
    ("app0", "app", "ota_0", 0x10000, 0x140000, 0),
    ("app1", "app", "ota_1", 0x150000, 0x140000, 0),
    ("spiffs", "data", "spiffs", 0x290000, 0x160000, 0),
    ("coredump", "data", "coredump", 0x3F0000, 0x10000, 0),
)

ROLE_SECTIONS = {
    "bootloader": "bootloader",
    "partition_table": "partition-table",
    "ota_data": "otadata",
    "application": "app",
}
ROLE_BUILD_FILES = {
    "bootloader": "bootloader.bin",
    "partition_table": "partitions.bin",
    "ota_data": "ota_data_initial.bin",
    "application": "firmware.bin",
}


class BundleError(ValueError):
    """The build output is not safe or complete enough to publish."""


@dataclass(frozen=True)
class Partition:
    name: str
    type_name: str
    subtype_name: str
    type_value: int
    subtype_value: int
    offset: int
    size: int
    flags: int

    @property
    def end(self) -> int:
        return self.offset + self.size

    def manifest_entry(self) -> dict[str, object]:
        return {
            "name": self.name,
            "type": self.type_name,
            "subtype": self.subtype_name,
            "offset": self.offset,
            "size": self.size,
            "flags": self.flags,
        }


@dataclass(frozen=True)
class FlashImage:
    role: str
    offset: int
    source: Path
    output_name: str

    @property
    def size(self) -> int:
        return self.source.stat().st_size

    @property
    def end(self) -> int:
        return self.offset + self.size


def _integer(value: object, description: str) -> int:
    if isinstance(value, bool):
        raise BundleError(f"{description} is not an integer")
    if isinstance(value, int):
        result = value
    elif isinstance(value, str):
        try:
            result = int(value, 0)
        except ValueError as error:
            raise BundleError(f"invalid {description}: {value!r}") from error
    else:
        raise BundleError(f"invalid {description}: {value!r}")
    if result < 0:
        raise BundleError(f"{description} must not be negative")
    return result


def _canonical_type(value: str, mapping: dict[str, int], description: str) -> tuple[str, int]:
    token = value.strip().lower()
    if token in mapping:
        return token, mapping[token]
    numeric = _integer(token, description)
    for name, number in mapping.items():
        if number == numeric:
            return name, number
    raise BundleError(f"unsupported {description}: {value!r}")


def _canonical_subtype(type_name: str, value: str) -> tuple[str, int]:
    token = value.strip().lower()
    candidates = {
        name: number
        for (candidate_type, name), number in SUBTYPE_VALUES.items()
        if candidate_type == type_name
    }
    if token in candidates:
        return token, candidates[token]
    numeric = _integer(token, f"{type_name} partition subtype")
    for name, number in candidates.items():
        if number == numeric:
            return name, number
    raise BundleError(f"unsupported {type_name} partition subtype: {value!r}")


def parse_partition_csv(path: Path) -> tuple[Partition, ...]:
    partitions: list[Partition] = []
    with path.open("r", encoding="utf-8", newline="") as source:
        for line_number, row in enumerate(csv.reader(source), 1):
            if not row or not "".join(row).strip() or row[0].lstrip().startswith("#"):
                continue
            if len(row) < 5 or len(row) > 6:
                raise BundleError(f"{path}:{line_number}: expected five or six fields")
            row += [""] * (6 - len(row))
            name, raw_type, raw_subtype, raw_offset, raw_size, raw_flags = (
                field.strip() for field in row
            )
            if not name or not raw_offset or not raw_size:
                raise BundleError(f"{path}:{line_number}: name, offset, and size are required")
            type_name, type_value = _canonical_type(
                raw_type, TYPE_VALUES, "partition type"
            )
            subtype_name, subtype_value = _canonical_subtype(type_name, raw_subtype)
            partitions.append(
                Partition(
                    name=name,
                    type_name=type_name,
                    subtype_name=subtype_name,
                    type_value=type_value,
                    subtype_value=subtype_value,
                    offset=_integer(raw_offset, "partition offset"),
                    size=_integer(raw_size, "partition size"),
                    flags=_integer(raw_flags or "0", "partition flags"),
                )
            )
    return tuple(partitions)


def decode_partition_binary(path: Path) -> tuple[Partition, ...]:
    data = path.read_bytes()
    if len(data) != PARTITION_TABLE_SIZE:
        raise BundleError(
            f"partition binary must be exactly {PARTITION_TABLE_SIZE} bytes, found {len(data)}"
        )

    partitions: list[Partition] = []
    digest = hashlib.md5()  # ESP-IDF partition-table format requires MD5.
    checksum_seen = False
    for position in range(0, len(data), PARTITION_RECORD.size):
        record = data[position : position + PARTITION_RECORD.size]
        if record[:2] == PARTITION_MAGIC:
            if checksum_seen:
                raise BundleError("partition entry appears after the MD5 record")
            digest.update(record)
            magic, type_value, subtype_value, offset, size, label, flags = (
                PARTITION_RECORD.unpack(record)
            )
            del magic
            try:
                name = label.split(b"\0", 1)[0].decode("ascii")
            except UnicodeDecodeError as error:
                raise BundleError("partition label is not ASCII") from error
            if not name:
                raise BundleError("partition label is empty")
            try:
                type_name = next(
                    name for name, number in TYPE_VALUES.items() if number == type_value
                )
                subtype_name = next(
                    name
                    for (candidate_type, name), number in SUBTYPE_VALUES.items()
                    if candidate_type == type_name and number == subtype_value
                )
            except StopIteration as error:
                raise BundleError(
                    f"unsupported binary partition type/subtype {type_value:#x}/{subtype_value:#x}"
                ) from error
            partitions.append(
                Partition(
                    name=name,
                    type_name=type_name,
                    subtype_name=subtype_name,
                    type_value=type_value,
                    subtype_value=subtype_value,
                    offset=offset,
                    size=size,
                    flags=flags,
                )
            )
            continue
        if record[:16] == PARTITION_MD5_MAGIC:
            if checksum_seen:
                raise BundleError("partition binary contains multiple MD5 records")
            if record[16:] != digest.digest():
                raise BundleError("partition binary MD5 checksum does not match")
            checksum_seen = True
            continue
        if record == b"\xFF" * PARTITION_RECORD.size:
            if not checksum_seen:
                raise BundleError("partition binary padding appears before the MD5 record")
            continue
        raise BundleError(f"invalid partition-table record at byte {position:#x}")
    if not checksum_seen:
        raise BundleError("partition binary has no MD5 record")
    return tuple(partitions)


def _partition_identity(partition: Partition) -> tuple[object, ...]:
    return (
        partition.name,
        partition.type_name,
        partition.subtype_name,
        partition.offset,
        partition.size,
        partition.flags,
    )


def validate_partitions(
    csv_partitions: Sequence[Partition], binary_partitions: Sequence[Partition]
) -> tuple[Partition, ...]:
    csv_identities = tuple(map(_partition_identity, csv_partitions))
    binary_identities = tuple(map(_partition_identity, binary_partitions))
    if csv_identities != binary_identities:
        raise BundleError("partitions.bin does not exactly match partitions.csv")
    if binary_identities != EXPECTED_PARTITIONS:
        raise BundleError(
            f"partition layout is not the exact supported {PARTITION_LAYOUT_ID} layout"
        )
    if len({partition.name for partition in binary_partitions}) != len(binary_partitions):
        raise BundleError("partition names are not unique")
    ordered = sorted(binary_partitions, key=lambda partition: partition.offset)
    for previous, current in zip(ordered, ordered[1:]):
        if previous.end > current.offset:
            raise BundleError(f"partitions {previous.name} and {current.name} overlap")
    if not ordered or ordered[-1].end != FLASH_SIZE:
        raise BundleError("partition table does not describe the exact 4 MB flash boundary")
    return tuple(binary_partitions)


def read_build_metadata(path: Path, require_release: bool = False) -> dict[str, object]:
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BundleError(f"could not read PlatformIO build metadata: {path}") from error
    if metadata.get("schema_version") != 1:
        raise BundleError("unsupported PlatformIO build metadata schema")
    version = metadata.get("firmware_version")
    commit = metadata.get("source_commit")
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise BundleError("build metadata has an invalid firmware version")
    if not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit):
        raise BundleError("build metadata has an invalid source commit")
    if metadata.get("platformio_environment") != PLATFORMIO_ENVIRONMENT:
        raise BundleError("build metadata names the wrong PlatformIO environment")
    if metadata.get("board") != BOARD:
        raise BundleError("build metadata names the wrong board")
    if require_release and not PUBLIC_COMMIT_RE.fullmatch(commit):
        raise BundleError("public firmware requires an exact clean 40-character source commit")
    return metadata


def verify_public_repository(project_dir: Path, source_commit: object) -> None:
    """Prove that public metadata describes the exact clean checkout being built."""
    if not isinstance(source_commit, str) or not PUBLIC_COMMIT_RE.fullmatch(source_commit):
        raise BundleError("public firmware requires an exact clean 40-character source commit")
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().lower()
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BundleError("could not verify the public firmware source checkout") from error
    if not PUBLIC_COMMIT_RE.fullmatch(head):
        raise BundleError("repository HEAD is not an exact 40-character commit")
    if status.strip():
        raise BundleError("public firmware must be built from a clean worktree")
    if head != source_commit:
        raise BundleError("compiled source commit does not match repository HEAD")


def _safe_build_path(build_dir: Path, raw_path: str) -> Path | None:
    candidate = (build_dir / raw_path).resolve()
    try:
        candidate.relative_to(build_dir.resolve())
    except ValueError as error:
        raise BundleError(f"flasher_args.json path escapes the build directory: {raw_path}") from error
    return candidate if candidate.is_file() else None


def read_flash_images(build_dir: Path) -> tuple[FlashImage, ...]:
    args_path = build_dir / "flasher_args.json"
    try:
        arguments = json.loads(args_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BundleError(f"could not read generated flasher arguments: {args_path}") from error

    settings = arguments.get("flash_settings")
    if not isinstance(settings, dict):
        raise BundleError("flasher_args.json has no flash_settings object")
    if settings.get("flash_mode") != FLASH_MODE:
        raise BundleError("firmware was not built for DIO flash mode")
    if settings.get("flash_freq") != FLASH_FREQUENCY:
        raise BundleError("firmware was not built for 80 MHz flash")
    if settings.get("flash_size") not in {"detect", "4MB", "4mb"}:
        raise BundleError("firmware has an unexpected flash-size setting")
    extra = arguments.get("extra_esptool_args")
    if not isinstance(extra, dict) or extra.get("chip") != CHIP_ARGUMENT:
        raise BundleError("firmware was not built for ESP32-C3")

    flash_files = arguments.get("flash_files")
    if not isinstance(flash_files, dict) or len(flash_files) != len(ROLE_SECTIONS):
        raise BundleError("flasher_args.json must contain exactly four flash files")
    normalized_flash_files: dict[int, str] = {}
    for raw_offset, raw_path in flash_files.items():
        if not isinstance(raw_path, str) or not raw_path:
            raise BundleError("flasher_args.json contains an invalid flash-file path")
        offset = _integer(raw_offset, "flash-file offset")
        if offset in normalized_flash_files:
            raise BundleError("flasher_args.json contains duplicate flash offsets")
        normalized_flash_files[offset] = raw_path

    images: list[FlashImage] = []
    for role, section_name in ROLE_SECTIONS.items():
        section = arguments.get(section_name)
        if not isinstance(section, dict):
            raise BundleError(f"flasher_args.json has no {section_name} section")
        offset = _integer(section.get("offset"), f"{section_name} offset")
        raw_path = section.get("file")
        if not isinstance(raw_path, str) or not raw_path:
            raise BundleError(f"flasher_args.json has an invalid {section_name} file")
        encrypted = section.get("encrypted", False)
        if encrypted not in {False, "false"}:
            raise BundleError("encrypted firmware images are not supported by the web flasher")
        if normalized_flash_files.get(offset) != raw_path:
            raise BundleError(f"{section_name} does not match flash_files")

        source = _safe_build_path(build_dir, raw_path)
        if source is None:
            source = (build_dir / ROLE_BUILD_FILES[role]).resolve()
        if not source.is_file():
            raise BundleError(f"missing generated {role} image: {source}")
        images.append(
            FlashImage(
                role=role,
                offset=offset,
                source=source,
                output_name=ROLE_BUILD_FILES[role],
            )
        )
    if {image.offset for image in images} != set(normalized_flash_files):
        raise BundleError("flasher_args.json flash sections do not cover exactly flash_files")
    return tuple(sorted(images, key=lambda image: image.offset))


def _overlaps(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start < right_end and right_start < left_end


def validate_flash_images(
    images: Sequence[FlashImage], partitions: Sequence[Partition]
) -> None:
    by_role = {image.role: image for image in images}
    if set(by_role) != set(ROLE_SECTIONS) or len(images) != len(ROLE_SECTIONS):
        raise BundleError("flash bundle must contain each of the exact four image roles once")
    if any(image.size <= 0 for image in images):
        raise BundleError("flash images must not be empty")

    by_name = {partition.name: partition for partition in partitions}
    bootloader = by_role["bootloader"]
    table = by_role["partition_table"]
    ota_data = by_role["ota_data"]
    application = by_role["application"]

    if bootloader.offset != 0 or bootloader.end > table.offset:
        raise BundleError("bootloader exceeds its exact pre-partition-table range")
    if table.offset != 0x8000 or table.size != PARTITION_TABLE_SIZE:
        raise BundleError("partition-table image has an unexpected offset or size")
    if table.end > by_name["nvs"].offset:
        raise BundleError("partition-table image reaches the NVS partition")
    if (
        ota_data.offset != by_name["otadata"].offset
        or ota_data.size != by_name["otadata"].size
    ):
        raise BundleError("OTA-data image must exactly fill the otadata partition")
    if application.offset != by_name["app0"].offset or application.end > by_name["app0"].end:
        raise BundleError("application image exceeds the app0 partition")

    ordered = sorted(images, key=lambda image: image.offset)
    for previous, current in zip(ordered, ordered[1:]):
        if previous.end > current.offset:
            raise BundleError(f"flash images {previous.role} and {current.role} overlap")
    if any(image.end > FLASH_SIZE for image in images):
        raise BundleError("a flash image exceeds the 4 MB device boundary")

    protected = [by_name[name] for name in ("nvs", "app1", "spiffs", "coredump")]
    for image in images:
        for partition in protected:
            if _overlaps(image.offset, image.end, partition.offset, partition.end):
                raise BundleError(
                    f"{image.role} overlaps protected {partition.name} "
                    f"range {partition.offset:#x}-{partition.end - 1:#x}"
                )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _package_id(manifest: dict[str, object]) -> str:
    """Return a deterministic identity before paths gain their package prefix.

    The browser's package identity includes the final URLs.  This separate
    publication identity exists only to name an immutable directory and commits
    to the complete validated manifest plus every image digest.
    """
    canonical = json.dumps(
        manifest,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    return hashlib.sha256(b"sauna-web-flash-package-v1\0" + canonical).hexdigest()


def _verify_existing_package(staging: Path, published: Path) -> None:
    """Fail closed if a content-addressed destination is not byte-identical."""
    expected = {path.name for path in staging.iterdir()}
    try:
        actual = {path.name for path in published.iterdir()}
    except OSError as error:
        raise BundleError(f"could not inspect published firmware package: {published}") from error
    if actual != expected:
        raise BundleError("published firmware package identity collision")
    for name in sorted(expected):
        source = staging / name
        destination = published / name
        if destination.is_symlink() or not destination.is_file():
            raise BundleError("published firmware package contains an unsafe file")
        if source.stat().st_size != destination.stat().st_size:
            raise BundleError("published firmware package identity collision")
        if _sha256(source) != _sha256(destination):
            raise BundleError("published firmware package identity collision")


def _atomic_write(path: Path, contents: bytes) -> None:
    """Commit one complete file without exposing a truncated replacement."""
    descriptor, raw_temporary = tempfile.mkstemp(
        prefix=f".{path.name}-", suffix=".tmp", dir=path.parent
    )
    temporary = Path(raw_temporary)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(contents)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _ensure_compiled_identity(application: Path, metadata: dict[str, object]) -> None:
    contents = application.read_bytes()
    for field in ("firmware_version", "source_commit"):
        value = str(metadata[field]).encode("ascii")
        if value not in contents:
            raise BundleError(f"application binary does not contain compiled {field}")
    if COMMISSIONING_PROTOCOL_SENTINEL not in contents:
        raise BundleError(
            "application binary does not contain the required commissioning "
            "protocol sentinel"
        )


def build_bundle(
    build_dir: Path,
    partitions_csv: Path,
    output_dir: Path,
    *,
    require_release_metadata: bool = False,
    project_dir: Path | None = None,
) -> dict[str, object]:
    build_dir = build_dir.resolve()
    csv_partitions = parse_partition_csv(partitions_csv.resolve())
    binary_partitions = decode_partition_binary(build_dir / "partitions.bin")
    partitions = validate_partitions(csv_partitions, binary_partitions)
    images = read_flash_images(build_dir)
    validate_flash_images(images, partitions)
    metadata = read_build_metadata(
        build_dir / "sauna_build_metadata.json", require_release_metadata
    )
    if require_release_metadata:
        if project_dir is None:
            raise BundleError("public firmware validation requires the project directory")
        verify_public_repository(project_dir.resolve(), metadata["source_commit"])
    application = next(image.source for image in images if image.role == "application")
    _ensure_compiled_identity(application, metadata)

    manifest: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "commissioning_protocol": COMMISSIONING_PROTOCOL,
        "product": PRODUCT,
        "release": {
            "version": metadata["firmware_version"],
            "source_commit": metadata["source_commit"],
        },
        "target": {
            "chip": CHIP,
            "board": BOARD,
            "flash_mode": FLASH_MODE,
            "flash_frequency": FLASH_FREQUENCY,
            "flash_size": FLASH_SIZE,
            "partition_layout": PARTITION_LAYOUT_ID,
        },
        "partitions": [partition.manifest_entry() for partition in partitions],
        "files": [],
    }

    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    packages_dir = output_dir / "packages"
    packages_dir.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".package-", dir=packages_dir) as temporary:
        staging = Path(temporary)
        manifest_files: list[dict[str, object]] = []
        for image in images:
            destination = staging / image.output_name
            shutil.copyfile(image.source, destination)
            manifest_files.append(
                {
                    "role": image.role,
                    "path": f"./{image.output_name}",
                    "offset": image.offset,
                    "size": image.size,
                    "sha256": _sha256(destination),
                }
            )
        manifest["files"] = manifest_files
        package_id = _package_id(manifest)
        for image in manifest_files:
            image["path"] = f"./packages/{package_id}/{image['path'][2:]}"

        published = packages_dir / package_id
        if published.exists():
            if not published.is_dir() or published.is_symlink():
                raise BundleError("published firmware package path is unsafe")
            _verify_existing_package(staging, published)
        else:
            try:
                os.replace(staging, published)
            except OSError as error:
                # Another generator may have published the same immutable
                # package between the existence check and rename.
                if not published.is_dir() or published.is_symlink():
                    raise BundleError("could not publish immutable firmware package") from error
                _verify_existing_package(staging, published)

        manifest_contents = (
            f"{json.dumps(manifest, indent=2, ensure_ascii=True)}\n"
        ).encode("ascii")
        # This is the sole mutable pointer. It changes only after every image
        # is visible at its immutable path, and replacement is atomic.
        _atomic_write(output_dir / "manifest.json", manifest_contents)
    return manifest


def run_platformio(project_dir: Path) -> None:
    subprocess.run(
        [sys.executable, "-m", "platformio", "run", "-e", PLATFORMIO_ENVIRONMENT],
        cwd=project_dir,
        env=os.environ.copy(),
        check=True,
    )


def arguments(argv: Sequence[str] | None = None) -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build", action="store_true", help="run the pinned PlatformIO build first")
    parser.add_argument(
        "--output-dir", type=Path, default=root / "portal/generated/firmware"
    )
    parser.add_argument(
        "--require-release-metadata",
        action="store_true",
        help="reject unknown, dirty, or non-full source commits",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    options = arguments(argv)
    root = Path(__file__).resolve().parents[1]
    try:
        generated_root = (root / "portal/generated").resolve()
        output_dir = options.output_dir.resolve()
        try:
            relative_output = output_dir.relative_to(generated_root)
        except ValueError as error:
            raise BundleError(
                "--output-dir must be inside the repository's portal/generated directory"
            ) from error
        if relative_output == Path("."):
            raise BundleError("--output-dir must not replace portal/generated itself")
        if options.require_release_metadata and not options.build:
            raise BundleError("public firmware packaging requires a fresh --build")
        if options.build:
            run_platformio(root)
        manifest = build_bundle(
            root / ".pio/build" / PLATFORMIO_ENVIRONMENT,
            root / "partitions.csv",
            output_dir,
            require_release_metadata=options.require_release_metadata,
            project_dir=root,
        )
    except (BundleError, OSError, subprocess.CalledProcessError) as error:
        print(f"web flash bundle failed: {error}", file=sys.stderr)
        return 1
    release = manifest["release"]
    print(
        f"Web flash bundle: {output_dir / 'manifest.json'} "
        f"({release['version']}, {release['source_commit']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
