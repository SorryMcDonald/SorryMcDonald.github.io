import json
from pathlib import PurePosixPath

from .worker_policy import READ_ROLES, sanitize


def json_events(stdout):
    events, errors, warnings = [], [], []
    for line in stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append(value)
        if isinstance(value, dict):
            if value.get("type") == "error":
                errors.append(value)
            item = value.get("item")
            if value.get("type") == "item.completed" and isinstance(item, dict) and item.get("type") == "error":
                warnings.append(item)
            if value.get("type") in {"turn.failed", "thread.error"}:
                errors.append(value)
    return events, errors, warnings


def observed_model_from_events(events):
    """Extract only CLI event metadata, never the model's response body."""
    for event in events:
        if not isinstance(event, dict):
            continue
        for key in ("model", "model_name"):
            value = event.get(key)
            if isinstance(value, str) and value:
                return value
        thread = event.get("thread")
        if isinstance(thread, dict):
            for key in ("model", "model_name"):
                value = thread.get(key)
                if isinstance(value, str) and value:
                    return value
    return None


def result_schema(task_id, operation_id, route):
    return {
        "schema_version": 1,
        "task_id": task_id,
        "operation_id": operation_id,
        "role": route["role"],
        "backend": "codex-exec",
        "requested_model": route["requested_model"],
        "configured_model": route["requested_model"],
        "cli_reported_model": None,
        "provider_observed_model": None,
        "provider_attestation": "unavailable",
        "requested_effort": route["requested_effort"],
        "configured_effort": route["effective_effort"],
        "provider_observed_effort": None,
        "reasoning_effort": route["effective_effort"],
        "status": "blocked",
        "summary": "",
        "changed_files": [],
        "validation": [],
        "findings": [],
        "new_backlog_items": [],
        "blockers": [],
    }


def worker_output_schema():
    validation_item = {
        "type": "object",
        "anyOf": [
            {
                "required": ["command", "exit_code"],
                "properties": {
                    "command": {"type": "string", "minLength": 1},
                    "exit_code": {"const": 0},
                },
            },
            {
                "required": ["evidence", "status"],
                "properties": {
                    "evidence": {"type": "string", "minLength": 1},
                    "status": {"const": "not_applicable"},
                },
            },
        ],
    }
    return {
        "type": "object",
        "additionalProperties": True,
        "required": ["schema_version", "task_id", "operation_id", "role", "backend", "model", "reasoning_effort", "status", "summary", "changed_files", "validation", "findings", "new_backlog_items", "blockers"],
        "properties": {
            "schema_version": {"const": 1}, "task_id": {"type": "string"}, "operation_id": {"type": "string"},
            "role": {"type": "string"}, "backend": {"enum": ["native", "codex-exec"]}, "model": {"type": "string"},
            "reasoning_effort": {"type": "string"}, "status": {"enum": ["completed", "blocked", "failed"]},
            "summary": {"type": "string"}, "changed_files": {"type": "array", "items": {"type": "string"}},
            "validation": {"type": "array", "items": {"type": "object"}}, "findings": {"type": "array"}, "new_backlog_items": {"type": "array"}, "blockers": {"type": "array"},
        },
        "allOf": [{
            "if": {"properties": {"status": {"const": "completed"}}, "required": ["status"]},
            "then": {"properties": {"validation": {"type": "array", "minItems": 1, "items": validation_item}}},
        }],
    }


def validate_completed_evidence(validation, role):
    if not isinstance(validation, list) or not validation:
        return False
    for item in validation:
        if not isinstance(item, dict) or not item:
            return False
        command = item.get("command")
        exit_code = item.get("exit_code")
        if isinstance(command, str) and command.strip() and isinstance(exit_code, int) and not isinstance(exit_code, bool) and exit_code == 0:
            continue
        evidence = item.get("evidence")
        if role in READ_ROLES and isinstance(evidence, str) and evidence.strip() and item.get("status") == "not_applicable":
            continue
        return False
    return True


def apply_agent_result(payload, result_file, task_id, operation_id, route, changed_files, events):
    if not result_file.exists():
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_file_missing")
        return
    try:
        agent_result = json.loads(result_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("invalid_result_json")
        return
    if not isinstance(agent_result, dict):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_not_object")
        return

    required = {
        "schema_version", "task_id", "operation_id", "role", "backend", "model",
        "reasoning_effort", "status", "summary", "changed_files", "validation",
        "findings", "new_backlog_items", "blockers",
    }
    shape_invalid = False
    if not required.issubset(agent_result):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_schema_incomplete")
        shape_invalid = True
    if agent_result.get("schema_version") != 1 or agent_result.get("status") not in {"completed", "blocked", "failed"}:
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_schema_invalid")
        shape_invalid = True
    list_keys = ("changed_files", "validation", "findings", "new_backlog_items", "blockers")
    claimed_values = agent_result.get("changed_files")
    if (
        not isinstance(agent_result.get("summary"), str)
        or any(not isinstance(agent_result.get(key), list) for key in list_keys)
        or any(not isinstance(value, str) for value in (claimed_values if isinstance(claimed_values, list) else []))
    ):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_schema_invalid")
        shape_invalid = True
    if (
        agent_result.get("task_id", task_id) != task_id
        or agent_result.get("operation_id", operation_id) != operation_id
        or agent_result.get("role", route["role"]) != route["role"]
    ):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_identity_mismatch")
    if agent_result.get("backend") != "codex-exec":
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_backend_mismatch")
    if agent_result.get("model") != route["requested_model"]:
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_model_mismatch")
    if (
        agent_result.get("reasoning_effort") not in route["requested_efforts"]
        or agent_result.get("reasoning_effort") != route["effective_effort"]
    ):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("result_effort_mismatch")
    if agent_result.get("status") == "completed":
        if not agent_result.get("validation"):
            payload["status"] = "blocked"
            payload.setdefault("blockers", []).append("validation_evidence_missing")
        elif not validate_completed_evidence(agent_result.get("validation"), route["role"]):
            payload["status"] = "blocked"
            payload.setdefault("blockers", []).append("validation_evidence_invalid")
    claimed_changes = sorted(
        PurePosixPath(str(value).replace("\\", "/")).as_posix()
        for value in (claimed_values if isinstance(claimed_values, list) else [])
    )
    if claimed_changes != sorted(changed_files):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("workspace_fingerprint_mismatch")
    if not shape_invalid and agent_result.get("status") in {"blocked", "failed"}:
        payload["status"] = agent_result["status"]
    payload["agent_result"] = sanitize(agent_result)
    payload["cli_reported_model"] = observed_model_from_events(events)
    if (
        payload["status"] == "completed"
        and payload["cli_reported_model"]
        and payload["cli_reported_model"] != route["requested_model"]
    ):
        payload["status"] = "blocked"
        payload.setdefault("blockers", []).append("cli_reported_model_mismatch")
