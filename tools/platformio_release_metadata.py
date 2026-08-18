"""Inject reproducible release identity into PlatformIO firmware builds.

PlatformIO executes this file as a pre-build SCons script.  The same resolved
values are written beside the build products so the web-flash bundle generator
cannot label a binary independently from the values compiled into SYS INFO.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

Import("env")  # type: ignore[name-defined]  # Supplied by PlatformIO/SCons.


VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}\Z")
COMMIT_RE = re.compile(r"(?:[0-9a-f]{40}(?:-dirty)?|unknown)\Z")


def _git_source_commit(project_dir: Path) -> str:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip().lower()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return f"{commit}-dirty" if dirty else commit


def _validated(name: str, value: str, pattern: re.Pattern[str]) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(f"invalid {name}: {value!r}")
    return value


project_dir = Path(env.subst("$PROJECT_DIR")).resolve()  # type: ignore[name-defined]
build_dir = Path(env.subst("$BUILD_DIR")).resolve()  # type: ignore[name-defined]

version = _validated(
    "firmware version",
    (project_dir / "firmware-version.txt").read_text(encoding="ascii").strip(),
    VERSION_RE,
)
source_commit = _validated(
    "source commit",
    os.environ.get("SAUNA_SOURCE_COMMIT", _git_source_commit(project_dir)).lower(),
    COMMIT_RE,
)

# Backslash-escaped quotes must survive SCons' command construction so the
# preprocessor values remain C string literals rather than bare identifiers.
env.Append(  # type: ignore[name-defined]
    CPPDEFINES=[
        ("SAUNA_FIRMWARE_VERSION", f'\\"{version}\\"'),
        ("SAUNA_SOURCE_COMMIT", f'\\"{source_commit}\\"'),
    ]
)

metadata = {
    "schema_version": 1,
    "firmware_version": version,
    "source_commit": source_commit,
    "platformio_environment": env.subst("$PIOENV"),  # type: ignore[name-defined]
    "board": env.subst("$BOARD"),  # type: ignore[name-defined]
}
contents = f"{json.dumps(metadata, indent=2, sort_keys=True)}\n"
build_dir.mkdir(parents=True, exist_ok=True)
metadata_path = build_dir / "sauna_build_metadata.json"
if not metadata_path.exists() or metadata_path.read_text(encoding="utf-8") != contents:
    metadata_path.write_text(contents, encoding="utf-8")
