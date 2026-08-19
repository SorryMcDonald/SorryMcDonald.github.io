import json

from .routing import classify_worker_error
from .worker_policy import READ_ROLES, redact, sanitize
from .worker_recovery import restore_unauthorized
from .worker_results import apply_agent_result, json_events, result_schema
from .worker_snapshot import changed_paths, claimable_paths


VALIDATION_BLOCKERS = {
    "result_schema_incomplete",
    "result_schema_invalid",
    "result_identity_mismatch",
    "result_backend_mismatch",
    "result_model_mismatch",
    "result_effort_mismatch",
    "workspace_fingerprint_mismatch",
    "result_not_object",
    "invalid_result_json",
    "revision_changed_during_worker",
    "operation_changed_during_worker",
    "validation_evidence_missing",
    "validation_evidence_invalid",
}


def finalize_timeout(context, before, heartbeat, error, snapshot_func):
    after = snapshot_func(context.root, context.result_rel)
    changed = changed_paths(context.root, before, after, context.operation_id)
    restored = restore_unauthorized(
        context.root,
        before,
        changed,
        ["__timeout_restore_all__"],
    )
    return 3, {
        "schema_version": 1,
        "error": "worker_timeout",
        "status": "blocked",
        "backend": "codex-exec",
        "role": context.route["role"],
        "requested_model": context.route["requested_model"],
        "requested_effort": context.route["requested_effort"],
        "reasoning_effort": context.route["effective_effort"],
        "effort_fallback_reason": context.route["effort_fallback_reason"],
        "error_category": "blocked_external",
        "task_id": context.task_id,
        "operation_id": context.operation_id,
        "changed_files": claimable_paths(before, after, changed),
        "workspace_changes": changed,
        "restored_files": restored,
        "heartbeat": heartbeat.result(),
        "stderr_tail": redact(error.stderr or "")[-4000:],
    }


def finalize_worker(context, before, heartbeat, outcome, snapshot_func, state_reader, operation_reader):
    completed = outcome.completed
    after = snapshot_func(context.root, context.result_rel)
    changed = changed_paths(context.root, before, after, context.operation_id)
    changed_files = claimable_paths(before, after, changed)
    unauthorized = (
        changed
        if context.route["role"] in READ_ROLES
        else restore_unauthorized(context.root, before, changed, context.allowed)
    )
    if context.route["role"] in READ_ROLES:
        restore_unauthorized(context.root, before, changed, ["__read_only_never__"])
    events, errors, warnings = json_events(completed.stdout)
    payload = result_schema(context.task_id, context.operation_id, context.route)
    payload.update({
        "status": "blocked" if errors or completed.returncode != 0 or unauthorized else "completed",
        "exit_code": completed.returncode,
        "changed_files": changed_files,
        "workspace_changes": changed,
        "errors": sanitize(errors),
        "warnings": sanitize(warnings),
        "unauthorized_changes": unauthorized,
        "stderr_tail": redact(completed.stderr)[-4000:],
        "result_file": str(context.result_file),
        "effective_effort": context.route["effective_effort"],
        "effort_fallback_reason": context.route["effort_fallback_reason"],
        "start_revision": context.start_revision,
        "attempts": outcome.attempts,
        "heartbeat": heartbeat.result(),
        "snapshot": {"backup_bytes": before.backup_bytes, "file_count": before.file_count},
    })
    if heartbeat.failures:
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("operation_heartbeat_failed")
    apply_agent_result(
        payload,
        context.result_file,
        context.task_id,
        context.operation_id,
        context.route,
        changed_files,
        events,
    )
    if state_reader(context.root).get("revision", 0) != context.start_revision:
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("revision_changed_during_worker")
    operation = operation_reader(context.root, context.operation_id)
    if (
        not operation
        or operation.get("task_id") != context.task_id
        or operation.get("role") != context.route["role"]
    ):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("operation_changed_during_worker")
    if payload["status"] != "completed":
        restored = restore_unauthorized(
            context.root,
            before,
            changed,
            ["__restore_no_worker_paths__"],
        )
        payload["restored_files"] = sorted(
            set(payload.get("restored_files", [])) | set(restored)
        )
    if payload["status"] == "completed":
        return 0, payload
    if payload["status"] == "failed":
        return 2, payload
    if completed.returncode != 0:
        category = classify_worker_error(
            completed.stderr + "\n" + json.dumps(errors, ensure_ascii=False)
        )
        payload["error_category"] = category
        return (3 if category == "blocked_external" else 2), payload
    blockers = set(payload.get("blockers", []))
    return (2 if VALIDATION_BLOCKERS.intersection(blockers) or unauthorized else 3), payload
