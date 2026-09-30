#!/usr/bin/env python3
"""Create and verify offline archives without rewriting raw sauna logs."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

from logs import parse_session

SCHEMA = "saunan.archive.v1"


def strict_json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    def invalid(value):
        raise ValueError(f"non-finite JSON number: {value}")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)


def inspection(raw: bytes) -> dict:
    """Describe recovery, without promoting a recoverable prefix to clean data."""
    try:
        session = parse_session(raw)
    except (ValueError, OverflowError) as error:
        return {"state": "unreadable", "error": str(error)}
    return {
        "state": "finalized" if session.finalized and not session.warnings else "recoverable",
        "format_version": session.version,
        "source_id": session.source_id,
        "boot_nonce": session.boot_nonce,
        "producer_commit": session.producer_commit,
        "producer_version": session.producer_version,
        "session_id": session.session_id,
        "boot_id": session.boot_id or None,
        "continuation_of": session.continuation_of or None,
        "sample_count": len(session.samples),
        "finish_reason": session.finish_reason,
        "warnings": session.warnings,
    }


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path: Path, data: bytes) -> None:
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def create_archive(inputs: list[Path], output: Path, context: dict | None = None) -> dict:
    if not inputs:
        raise ValueError("at least one raw file is required")
    if context is None:
        context = {}
    if not isinstance(context, dict):
        raise ValueError("context must be a JSON object")
    # Validate before creating anything, including callers outside the CLI.
    json.dumps(context, allow_nan=False)
    output.mkdir()  # Exclusive: never merge into or overwrite an existing archive.
    raw_dir = output / "raw"
    raw_dir.mkdir()
    entries = {}
    for source in inputs:
        raw = source.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest not in entries:
            write_new(raw_dir / f"{digest}.slog", raw)
            entries[digest] = {
                "sha256": digest, "bytes": len(raw),
                "path": f"raw/{digest}.slog", "source_names": [],
                "inspection": inspection(raw),
            }
        # Basenames only: do not disclose the laptop's directory structure.
        if source.name not in entries[digest]["source_names"]:
            entries[digest]["source_names"].append(source.name)
    manifest = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "context": context,
        "files": [entries[key] for key in sorted(entries)],
    }
    sync_directory(raw_dir)
    write_new(output / "manifest.pending", (json.dumps(manifest, indent=2, allow_nan=False) + "\n").encode())
    os.rename(output / "manifest.pending", output / "manifest.json")
    sync_directory(output)
    sync_directory(output.parent)
    verify_archive(output)
    return manifest


def verify_archive(root: Path) -> dict:
    manifest_path = root / "manifest.json"
    if root.is_symlink() or manifest_path.is_symlink() or (root / "raw").is_symlink():
        raise ValueError("archive paths must not be symlinks")
    manifest = strict_json(manifest_path.read_text())
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise ValueError("unsupported archive schema")
    if not isinstance(manifest.get("context"), dict):
        raise ValueError("invalid context object")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise ValueError("archive has no file entries")
    expected = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid file entry")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid SHA-256 identity")
        relative = f"raw/{digest}.slog"
        if entry.get("path") != relative or relative in expected:
            raise ValueError("invalid or duplicate raw path")
        expected.add(relative)
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing or unsafe raw file: {relative}")
        raw = path.read_bytes()
        if type(entry.get("bytes")) is not int or len(raw) != entry["bytes"]:
            raise ValueError(f"size mismatch: {relative}")
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError(f"SHA-256 mismatch: {relative}")
        if not isinstance(entry.get("inspection"), dict):
            raise ValueError("missing creation-time inspection")
    actual = {f"raw/{path.name}" for path in (root / "raw").iterdir()}
    if actual != expected:
        raise ValueError("raw directory contains unlisted files")
    # Stored inspection is historical. Reader upgrades may recover more facts;
    # integrity verification must not depend on a future parser's wording.
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("inputs", nargs="+", type=Path)
    create.add_argument("--output", required=True, type=Path)
    create.add_argument("--context", type=Path, help="JSON object of user-supplied experiment notes")
    verify = sub.add_parser("verify")
    verify.add_argument("archive", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            context = strict_json(args.context.read_text()) if args.context else {}
            manifest = create_archive(args.inputs, args.output, context)
        else:
            manifest = verify_archive(args.archive)
    except (OSError, ValueError, TypeError) as error:
        print(f"archive error: {error}", file=sys.stderr)
        return 1
    print(f"Verified {len(manifest['files'])} unique raw file(s); SHA-256 integrity only.")
    for entry in manifest["files"]:
        print(f"{entry['sha256']} {entry['bytes']} bytes: {entry['inspection'].get('state', 'unknown')} (creation-time inspection)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
