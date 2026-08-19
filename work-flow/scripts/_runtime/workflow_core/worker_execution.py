import json
import subprocess
import tempfile

from .locking import get_operation
from .scanning import scan_project
from .state import read_state
from .worker_attempts import run_worker_attempts
from .worker_finalize import finalize_timeout, finalize_worker
from .worker_heartbeat import OperationHeartbeat
from .worker_policy import LOCK_RELATIVE_PATH, READ_ROLES, non_git_workspace_is_trusted
from .worker_preflight import WorkerPreflightError, prepare_worker
from .worker_recovery import WorkerRollbackError, restore_unauthorized
from .worker_results import worker_output_schema
from .worker_snapshot import (
    SnapshotLimitError,
    SnapshotScanError,
    SnapshotStorageError,
    changed_paths,
    snapshot,
)


def build_worker_command(root, route, prompt_file, output_schema, result_file):
    command = [
        "codex", "exec", "--ephemeral", "--json", "--model", route["requested_model"],
        "--config", f'model_reasoning_effort="{route["effective_effort"]}"',
        "--disable", "multi_agent", "--config", "agents.enabled=false",
        "--sandbox", "read-only" if route["role"] in READ_ROLES else "workspace-write",
        "--cd", str(root), "--output-last-message", str(result_file),
    ]
    if output_schema:
        command.extend(["--output-schema", str(output_schema)])
    if not scan_project(root)["is_git"]:
        if not non_git_workspace_is_trusted(root):
            raise ValueError(
                "non-Git worker requires workspace-bound trust in work-flow/config.local.json"
            )
        command.append("--skip-git-repo-check")
    command.append("-")
    return command


def _preserve_unverified(before, context, cause, **details):
    recovery_manifest = before.preserve(context.root, cause)
    return 6, {
        "error": "worker_workspace_unverified",
        "status": "failed",
        "cause": cause,
        "recovery_path": str(recovery_manifest),
        **details,
    }


def _rollback_failure(before, context, error):
    failed_paths = set(error.paths)
    recovery_manifest = before.preserve(context.root, "worker_rollback_incomplete") if before else None
    if before is not None:
        try:
            current = snapshot(context.root, context.result_rel)
            changed = changed_paths(context.root, before, current, context.operation_id)
            restore_unauthorized(
                context.root,
                before,
                [path for path in changed if path != LOCK_RELATIVE_PATH],
                ["__rollback_incomplete_cleanup__"],
            )
        except WorkerRollbackError as cleanup_error:
            failed_paths.update(cleanup_error.paths)
        except (OSError, ValueError) as cleanup_error:
            failed_paths.add(f"cleanup:{type(cleanup_error).__name__}")
    return 6, {
        "error": "worker_rollback_incomplete",
        "status": "failed",
        "paths": sorted(failed_paths),
        "recovery_path": str(recovery_manifest) if recovery_manifest else None,
    }


def run_worker_command(args, *, run_process, lock_command_runner):
    before = None
    context = None
    heartbeat = None
    worker_started = False
    try:
        context = prepare_worker(args)
        context.result_file.parent.mkdir(parents=True, exist_ok=True)
        context.result_file.unlink(missing_ok=True)
        heartbeat = OperationHeartbeat(
            context.root,
            context.operation,
            context.heartbeat_interval,
            context.heartbeat_stall,
            lock_command_runner,
        )
        heartbeat.start()
        before = snapshot(
            context.root,
            context.result_rel,
            capture_backups=True,
            max_backup_bytes=context.snapshot_max_bytes,
        )
        if heartbeat.failures:
            return 3, {
                "error": "operation_heartbeat_failed",
                "status": "blocked",
                "blockers": ["operation_heartbeat_failed"],
                "heartbeat": heartbeat.result(),
            }
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".schema.json", delete=False
        ) as schema_handle:
            json.dump(worker_output_schema(), schema_handle)
            schema_path = schema_handle.name
        try:
            worker_started = True
            outcome = run_worker_attempts(
                context,
                before,
                schema_path,
                run_process,
                build_worker_command,
                snapshot,
            )
        except subprocess.TimeoutExpired as error:
            heartbeat.stop()
            return finalize_timeout(context, before, heartbeat, error, snapshot)
        finally:
            heartbeat.stop()
            from pathlib import Path
            Path(schema_path).unlink(missing_ok=True)
        return finalize_worker(
            context,
            before,
            heartbeat,
            outcome,
            snapshot,
            read_state,
            get_operation,
        )
    except WorkerPreflightError as error:
        return error.exit_code, error.payload
    except SnapshotLimitError as error:
        return 3, {
            "error": "snapshot_limit_exceeded",
            "status": "blocked",
            "limit_bytes": error.limit_bytes,
            "required_bytes": error.required_bytes,
        }
    except SnapshotStorageError as error:
        if before is not None and worker_started:
            return _preserve_unverified(
                before,
                context,
                error.code,
                message=error.error,
            )
        return 3, {
            "error": error.code,
            "status": "blocked",
            "path": error.path,
            "message": error.error,
        }
    except SnapshotScanError as error:
        if before is not None and worker_started:
            return _preserve_unverified(
                before,
                context,
                "snapshot_scan_failed",
                path=error.path,
                message=error.error,
            )
        return 3, {
            "error": "snapshot_scan_failed",
            "status": "blocked",
            "path": error.path,
            "message": error.error,
        }
    except WorkerRollbackError as error:
        return _rollback_failure(before, context, error)
    except (OSError, ValueError) as error:
        if before is not None and worker_started:
            return _preserve_unverified(
                before,
                context,
                "worker_post_execution_error",
                message=str(error),
            )
        return 3, {"error": "worker_blocked", "message": str(error)}
    finally:
        if heartbeat is not None:
            heartbeat.stop()
        if before is not None:
            before.close()
