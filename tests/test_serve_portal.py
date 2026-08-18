from __future__ import annotations

import importlib.util
import fcntl
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "serve_portal.py"
SPEC = importlib.util.spec_from_file_location("serve_portal", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
serve_portal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(serve_portal)


def write_process(
    proc_root: Path,
    pid: int,
    *,
    arguments: list[str],
    cwd: Path,
    start_ticks: str = "4242",
) -> None:
    process = proc_root / str(pid)
    process.mkdir(parents=True)
    (process / "cmdline").write_bytes(b"\0".join(value.encode() for value in arguments) + b"\0")
    # Fields 3..21 comprise 19 tokens before starttime (field 22).
    fields = ["S"] + ["0"] * 18 + [start_ticks] + ["0"] * 4
    (process / "stat").write_text(f"{pid} (portal test) {' '.join(fields)}\n", encoding="ascii")
    (process / "cwd").symlink_to(cwd, target_is_directory=True)


class PortalServerPolicyTests(unittest.TestCase):
    def test_canonical_port_needs_no_override(self) -> None:
        self.assertEqual(
            serve_portal.validate_port(serve_portal.CANONICAL_PORT, False),
            serve_portal.CANONICAL_PORT,
        )
        self.assertEqual(serve_portal.canonical_url(), "http://localhost:8000/")

    def test_alternate_port_requires_explicit_override(self) -> None:
        with self.assertRaisesRegex(serve_portal.PortalServerError, "refusing alternate port"):
            serve_portal.validate_port(8001, False)
        self.assertEqual(serve_portal.validate_port(8001, True), 8001)

    def test_lock_reports_a_server_hidden_from_process_inspection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            lock_path = Path(temporary) / "instance.lock"
            lock_path.touch()
            original = serve_portal.LOCK_PATH
            owner = lock_path.open("a+b")
            try:
                fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                serve_portal.LOCK_PATH = lock_path
                self.assertTrue(serve_portal._instance_lock_held())
            finally:
                serve_portal.LOCK_PATH = original
                fcntl.flock(owner.fileno(), fcntl.LOCK_UN)
                owner.close()

    def test_finds_ad_hoc_http_server_for_portal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            portal = root / "repo" / "portal"
            portal.mkdir(parents=True)
            write_process(
                proc,
                101,
                arguments=["python3", "-m", "http.server", "8765", "--directory", "portal"],
                cwd=portal.parent,
            )
            write_process(
                proc,
                102,
                arguments=["python3", "-m", "http.server", "9000", "--directory", "elsewhere"],
                cwd=portal.parent,
            )
            matches = serve_portal.find_portal_servers(proc_root=proc, portal_dir=portal)
            self.assertEqual([pid for pid, _command in matches], [101])

    def test_state_identity_requires_start_time_script_and_token(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            proc = root / "proc"
            proc.mkdir()
            script = root / "repo" / "tools" / "serve_portal.py"
            script.parent.mkdir(parents=True)
            script.touch()
            token = "abc123"
            write_process(
                proc,
                203,
                arguments=[
                    "python3",
                    str(script),
                    "_serve",
                    "--port",
                    "8000",
                    "--owner-token",
                    token,
                ],
                cwd=script.parents[1],
            )
            state = {
                "pid": 203,
                "start_ticks": "4242",
                "owner_token": token,
                "script": str(script),
                "root": str(script.parents[1]),
            }
            original_root = serve_portal.ROOT
            try:
                serve_portal.ROOT = script.parents[1]
                self.assertTrue(
                    serve_portal._state_matches_process(
                        state, proc_root=proc, script_path=script.resolve()
                    )
                )
                state["owner_token"] = "wrong"
                self.assertFalse(
                    serve_portal._state_matches_process(
                        state, proc_root=proc, script_path=script.resolve()
                    )
                )
            finally:
                serve_portal.ROOT = original_root


if __name__ == "__main__":
    unittest.main()
