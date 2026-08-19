"""Compatibility facade for the worker runtime.

Worker behavior lives in focused modules. This facade keeps the established
import surface and supplies the two process-level dependencies at call time.
"""

import subprocess

from .locking import lock_command
from .worker_execution import build_worker_command, run_worker_command
from .worker_heartbeat import OperationHeartbeat
from .worker_policy import (
    LOCK_RELATIVE_PATH,
    PROTECTED_PATHS,
    PROTECTED_PREFIXES,
    READ_ROLES,
    allowed_changed as _allowed_changed,
    allowed_path_conflicts_protected as _allowed_path_conflicts_protected,
    is_protected as _is_protected,
    non_git_workspace_is_trusted as _non_git_workspace_is_trusted,
    redact as _redact,
    sanitize as _sanitize,
    trust_command,
)
from .worker_process import run_process_tree
from .worker_recovery import (
    WorkerRollbackError,
    remove_path as _remove_path,
    restore_record as _restore_record,
    restore_unauthorized as _restore_unauthorized,
)
from .worker_results import (
    json_events as _json_events,
    observed_model_from_events as _observed_model_from_events,
    result_schema as _result_schema,
    validate_completed_evidence as _validate_completed_evidence,
    worker_output_schema as _worker_output_schema,
)
from .worker_snapshot import (
    SnapshotCleanupError,
    SnapshotLimitError,
    SnapshotScanError,
    SnapshotStorageError,
    WorkspaceSnapshot,
    changed_paths as _changed_paths,
    claimable_paths as _claimable_paths,
    lock_parent_owned_mutation as _lock_parent_owned_mutation,
    parse_timestamp as _parse_timestamp,
    path_record as _path_record,
    record_bytes as _record_bytes,
    record_identity as _record_identity,
    snapshot as _snapshot,
    stream_file_record as _stream_file_record,
)


class _OperationHeartbeat(OperationHeartbeat):
    def __init__(self, root, operation, interval_seconds, stall_seconds):
        super().__init__(root, operation, interval_seconds, stall_seconds, lock_command)


def _worker_command_impl(args):
    return run_worker_command(
        args,
        run_process=lambda command, **kwargs: run_process_tree(
            command, run_override=subprocess.run, **kwargs
        ),
        lock_command_runner=lock_command,
    )


def worker_command(args):
    try:
        return _worker_command_impl(args)
    except SnapshotCleanupError as exc:
        return 6, {
            "error": "snapshot_cleanup_incomplete",
            "status": "failed",
            "recovery_path": exc.path,
            "message": exc.error,
        }
