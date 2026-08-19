import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "scripts" / "_runtime"
sys.path.insert(0, str(RUNTIME_ROOT))

from workflow_core import initialization, locking  # noqa: E402
from workflow_core.worker_snapshot import snapshot  # noqa: E402


class ReviewRegressionTests(unittest.TestCase):
    def test_snapshot_tracks_git_and_node_modules_mutations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".git").mkdir()
            (root / ".git" / "HEAD").write_text("ref: refs/heads/test\n", encoding="utf-8")
            (root / "node_modules" / "example").mkdir(parents=True)
            (root / "node_modules" / "example" / "index.js").write_text("export {};\n", encoding="utf-8")

            result = snapshot(root)

            self.assertIn(".git/HEAD", result)
            self.assertIn("node_modules/example/index.js", result)

    def test_invalid_failure_injection_is_rejected(self):
        plan = {
            "public": {"plan_hash": "expected", "conflicts": [], "actions": []},
            "changes": [],
        }
        with tempfile.TemporaryDirectory() as temporary:
            with (
                patch.object(initialization, "_validate_existing_control_plane"),
                patch.object(initialization, "build_init_plan", return_value=plan),
                patch.object(initialization, "apply_file_changes", return_value={"changed": 0}),
                patch.dict(os.environ, {"WORKFLOW_CORE_FAIL_AFTER_ACTION": "invalid"}),
            ):
                with self.assertRaises(ValueError):
                    initialization.init_apply(
                        temporary,
                        "adopt",
                        "expected",
                        temporary,
                        temporary,
                        Path(temporary) / "workflow_cli.py",
                    )

    def test_guard_cleanup_reports_success_and_failure_without_raising(self):
        guard_id = "11111111-1111-4111-8111-111111111111"
        with tempfile.TemporaryDirectory() as temporary:
            guard = Path(temporary) / ".operation-lock.guard"
            guard.write_text(
                f'{{"schema_version":1,"guard_id":"{guard_id}","owner_session":"test",'
                '"operation_id":null,"acquired_at":"2026-08-19T00:00:00Z"}\n',
                encoding="utf-8",
            )
            self.assertTrue(locking._release_owned_guard(guard, guard_id))
            self.assertFalse(guard.exists())

            guard.write_text(
                f'{{"schema_version":1,"guard_id":"{guard_id}","owner_session":"test",'
                '"operation_id":null,"acquired_at":"2026-08-19T00:00:00Z"}\n',
                encoding="utf-8",
            )
            with patch.object(Path, "unlink", side_effect=OSError("denied")):
                self.assertFalse(locking._release_owned_guard(guard, guard_id))

    def test_lock_mutation_reports_committed_result_when_guard_cleanup_fails(self):
        args = SimpleNamespace(action="acquire", root="unused", owner="test", operation_id="operation")
        with (
            patch.object(locking, "guard_path", return_value=Path("unused.guard")),
            patch.object(locking.os, "open", return_value=1),
            patch.object(locking.os, "write"),
            patch.object(locking.os, "fsync"),
            patch.object(locking.os, "close"),
            patch.object(locking, "_lock_command_unguarded", return_value=(0, {"status": "acquired"})),
            patch.object(locking, "_release_owned_guard", return_value=False),
        ):
            code, payload = locking._lock_command_with_mutex(args)

        self.assertEqual(code, 6)
        self.assertEqual(payload["error"], "guard_cleanup_failed")
        self.assertEqual(payload["status"], "mutation_committed")


if __name__ == "__main__":
    unittest.main()
