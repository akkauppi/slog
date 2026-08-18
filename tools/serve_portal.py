#!/usr/bin/env python3
"""Run exactly one repository-local portal development server.

The server is foreground-only and loopback-only. A repository lock prevents a
second managed instance, while Linux /proc inspection catches the common
accidental escape hatch of starting ``python -m http.server`` on another port
for the same portal directory.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import time
from typing import Any, BinaryIO, Iterable


ROOT = Path(__file__).resolve().parents[1]
PORTAL_DIR = ROOT / "portal"
SCRIPT_PATH = Path(__file__).resolve()
STATE_DIR = ROOT / ".portal-server"
LOCK_PATH = STATE_DIR / "instance.lock"
STATE_PATH = STATE_DIR / "state.json"
CANONICAL_PORT = 8000
BIND_HOST = "127.0.0.1"
DISPLAY_HOST = "localhost"
PROC_ROOT = Path("/proc")


class PortalServerError(RuntimeError):
    """A safe, user-facing server-control failure."""


def canonical_url(port: int = CANONICAL_PORT) -> str:
    return f"http://{DISPLAY_HOST}:{port}/"


def validate_port(port: int, allow_alternate_port: bool) -> int:
    if not 1 <= port <= 65535:
        raise PortalServerError("port must be between 1 and 65535")
    if port != CANONICAL_PORT and not allow_alternate_port:
        raise PortalServerError(
            f"refusing alternate port {port}; use canonical {CANONICAL_PORT}, or pass "
            "--allow-alternate-port only with explicit user approval"
        )
    return port


def _read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None


def _process_cmdline(pid: int, proc_root: Path = PROC_ROOT) -> tuple[str, ...] | None:
    raw = _read_bytes(proc_root / str(pid) / "cmdline")
    if not raw:
        return None
    return tuple(part.decode("utf-8", "replace") for part in raw.split(b"\0") if part)


def _process_cwd(pid: int, proc_root: Path = PROC_ROOT) -> Path | None:
    try:
        return (proc_root / str(pid) / "cwd").resolve(strict=True)
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None


def _process_start_ticks(pid: int, proc_root: Path = PROC_ROOT) -> str | None:
    raw = _read_bytes(proc_root / str(pid) / "stat")
    if not raw:
        return None
    text = raw.decode("ascii", "replace")
    close = text.rfind(")")
    if close < 0:
        return None
    fields = text[close + 1 :].strip().split()
    # The first item after the process name is field 3; starttime is field 22.
    return fields[19] if len(fields) > 19 else None


def _resolved_command_path(argument: str, cwd: Path | None) -> Path | None:
    if not argument.endswith(".py"):
        return None
    candidate = Path(argument)
    if not candidate.is_absolute():
        if cwd is None:
            return None
        candidate = cwd / candidate
    try:
        return candidate.resolve(strict=False)
    except OSError:
        return None


def _option_value(arguments: tuple[str, ...], name: str) -> str | None:
    for index, argument in enumerate(arguments):
        if argument == name and index + 1 < len(arguments):
            return arguments[index + 1]
        prefix = f"{name}="
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    return None


def _http_server_directory(arguments: tuple[str, ...], cwd: Path | None) -> Path | None:
    try:
        module_index = arguments.index("-m")
    except ValueError:
        return None
    if module_index + 1 >= len(arguments) or arguments[module_index + 1] != "http.server":
        return None
    directory = _option_value(arguments, "--directory")
    candidate = Path(directory) if directory is not None else cwd
    if candidate is None:
        return None
    if not candidate.is_absolute():
        if cwd is None:
            return None
        candidate = cwd / candidate
    try:
        return candidate.resolve(strict=False)
    except OSError:
        return None


def _is_owned_server_command(
    arguments: tuple[str, ...], cwd: Path | None, script_path: Path = SCRIPT_PATH
) -> bool:
    return any(_resolved_command_path(argument, cwd) == script_path for argument in arguments) and (
        "_serve" in arguments
    )


def find_portal_servers(
    *,
    proc_root: Path = PROC_ROOT,
    portal_dir: Path = PORTAL_DIR,
    exclude_pids: Iterable[int] = (),
) -> list[tuple[int, str]]:
    """Find managed or ad-hoc processes serving this exact portal directory."""

    excluded = set(exclude_pids)
    if not proc_root.is_dir():
        return []
    matches: list[tuple[int, str]] = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in excluded:
            continue
        arguments = _process_cmdline(pid, proc_root)
        if not arguments:
            continue
        cwd = _process_cwd(pid, proc_root)
        served = _http_server_directory(arguments, cwd)
        owned = _is_owned_server_command(arguments, cwd)
        if (served is not None and served == portal_dir.resolve()) or owned:
            matches.append((pid, " ".join(arguments)))
    return sorted(matches)


def _read_state() -> dict[str, Any] | None:
    try:
        value = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _write_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = STATE_DIR / f"state.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, STATE_PATH)


def _state_matches_process(
    state: dict[str, Any], *, proc_root: Path = PROC_ROOT, script_path: Path = SCRIPT_PATH
) -> bool:
    try:
        pid = int(state["pid"])
        expected_ticks = str(state["start_ticks"])
        expected_token = str(state["owner_token"])
        expected_script = Path(str(state["script"])).resolve(strict=False)
        expected_root = Path(str(state["root"])).resolve(strict=False)
    except (KeyError, TypeError, ValueError, OSError):
        return False
    if expected_script != script_path or expected_root != ROOT:
        return False
    if _process_start_ticks(pid, proc_root) != expected_ticks:
        return False
    arguments = _process_cmdline(pid, proc_root)
    cwd = _process_cwd(pid, proc_root)
    if not arguments or not _is_owned_server_command(arguments, cwd, script_path):
        return False
    return _option_value(arguments, "--owner-token") == expected_token


def _remove_matching_state(owner_token: str) -> None:
    state = _read_state()
    if state is not None and state.get("owner_token") == owner_token:
        with contextlib.suppress(FileNotFoundError):
            STATE_PATH.unlink()


def _acquire_instance_lock() -> BinaryIO:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    handle = LOCK_PATH.open("a+b")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as cause:
        handle.close()
        state = _read_state()
        if state and _state_matches_process(state):
            raise PortalServerError(
                f"portal already running at {canonical_url(int(state['port']))} "
                f"(pid {state['pid']})"
            ) from cause
        raise PortalServerError("portal server lock is held; refusing a second instance") from cause
    return handle


def _instance_lock_held() -> bool:
    """Report a live instance even when a sandbox hides its /proc entry."""

    if not LOCK_PATH.exists():
        return False
    handle = LOCK_PATH.open("a+b")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return False
    finally:
        handle.close()


class PortalRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PORTAL_DIR), **kwargs)


class PortalHttpServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _serve(port: int, owner_token: str) -> int:
    lock = _acquire_instance_lock()
    try:
        others = find_portal_servers(exclude_pids={os.getpid()})
        if others:
            details = "; ".join(f"pid {pid}: {command}" for pid, command in others)
            raise PortalServerError(f"another process already serves this portal: {details}")
        try:
            server = PortalHttpServer((BIND_HOST, port), PortalRequestHandler)
        except OSError as cause:
            raise PortalServerError(
                f"cannot bind {BIND_HOST}:{port}; resolve the existing listener instead of changing ports"
            ) from cause

        start_ticks = _process_start_ticks(os.getpid())
        if start_ticks is None:
            server.server_close()
            raise PortalServerError("cannot verify this server process identity")
        state = {
            "pid": os.getpid(),
            "start_ticks": start_ticks,
            "owner_token": owner_token,
            "port": port,
            "bind_host": BIND_HOST,
            "url": canonical_url(port),
            "root": str(ROOT),
            "script": str(SCRIPT_PATH),
        }
        _write_state(state)

        def terminate(_signum: int, _frame: Any) -> None:
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        print(f"Portal server: {canonical_url(port)} (pid {os.getpid()})", flush=True)
        print("Press Ctrl-C to stop it.", flush=True)
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            _remove_matching_state(owner_token)
        return 0
    finally:
        lock.close()


def _start(port: int, allow_alternate_port: bool) -> int:
    validate_port(port, allow_alternate_port)
    state = _read_state()
    if state is not None and (_state_matches_process(state) or _instance_lock_held()):
        raise PortalServerError(
            f"portal already running at {canonical_url(int(state['port']))} (pid {state['pid']})"
        )
    if _instance_lock_held():
        raise PortalServerError("portal server lock is held; refusing a second instance")
    others = find_portal_servers(exclude_pids={os.getpid()})
    if others:
        details = "; ".join(f"pid {pid}: {command}" for pid, command in others)
        raise PortalServerError(f"another process already serves this portal: {details}")
    owner_token = secrets.token_hex(16)
    arguments = [
        sys.executable,
        str(SCRIPT_PATH),
        "_serve",
        "--port",
        str(port),
        "--owner-token",
        owner_token,
    ]
    if allow_alternate_port:
        arguments.append("--allow-alternate-port")
    os.execv(sys.executable, arguments)
    raise AssertionError("os.execv returned")


def _status() -> int:
    state = _read_state()
    if state is not None and (_state_matches_process(state) or _instance_lock_held()):
        print(f"running {state['url']} pid={state['pid']}")
        return 0
    if _instance_lock_held():
        print("portal server lock is held, but its state record is unavailable")
        return 2
    others = find_portal_servers(exclude_pids={os.getpid()})
    if others:
        for pid, command in others:
            print(f"unmanaged pid={pid} command={command}")
        return 2
    print("stopped")
    return 1


def _stop() -> int:
    state = _read_state()
    if state is None:
        raise PortalServerError("no managed portal server is recorded")
    if not _state_matches_process(state):
        raise PortalServerError("recorded process identity does not match; refusing to signal it")
    pid = int(state["pid"])
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if _process_start_ticks(pid) != str(state["start_ticks"]):
            _remove_matching_state(str(state["owner_token"]))
            print(f"stopped pid={pid}")
            return 0
        time.sleep(0.05)
    raise PortalServerError(f"pid {pid} did not stop; no stronger signal was sent")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    start = subparsers.add_parser("start", help="serve portal in the foreground")
    start.add_argument("--port", type=int, default=CANONICAL_PORT)
    start.add_argument(
        "--allow-alternate-port",
        action="store_true",
        help="explicit override; requires prior user approval when used by an agent",
    )
    subparsers.add_parser("status", help="show the managed or unmanaged portal server")
    subparsers.add_parser("stop", help="safely stop the managed portal server")

    internal = subparsers.add_parser("_serve", help=argparse.SUPPRESS)
    internal.add_argument("--port", type=int, required=True)
    internal.add_argument("--owner-token", required=True)
    internal.add_argument("--allow-alternate-port", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "start":
            return _start(args.port, args.allow_alternate_port)
        if args.command == "status":
            return _status()
        if args.command == "stop":
            return _stop()
        if args.command == "_serve":
            validate_port(args.port, args.allow_alternate_port)
            return _serve(args.port, args.owner_token)
    except PortalServerError as error:
        print(f"Portal server error: {error}", file=sys.stderr)
        return 2
    raise AssertionError(f"unhandled command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
