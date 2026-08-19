import json
from dataclasses import dataclass

from .routing import classify_worker_error, next_effort
from .worker_results import json_events
from .worker_snapshot import changed_paths


@dataclass
class WorkerAttempts:
    completed: object
    attempts: list[dict]


def run_worker_attempts(context, before, schema_path, run_process, build_command, snapshot_func):
    attempts = []
    while True:
        command = build_command(
            context.root,
            context.route,
            context.prompt_file,
            schema_path,
            context.result_file,
        )
        completed = run_process(
            command,
            input=context.prompt,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
            timeout=context.timeout_seconds,
        )
        _, attempt_errors, _ = json_events(completed.stdout)
        combined_error = completed.stderr + "\n" + json.dumps(attempt_errors, ensure_ascii=False)
        category = classify_worker_error(combined_error) if completed.returncode != 0 else None
        attempts.append({
            "model": context.route["requested_model"],
            "reasoning_effort": context.route["effective_effort"],
            "exit_code": completed.returncode,
            "error_category": category,
        })
        if completed.returncode == 0:
            return WorkerAttempts(completed=completed, attempts=attempts)
        after_attempt = snapshot_func(context.root, context.result_rel)
        changed = changed_paths(context.root, before, after_attempt, context.operation_id)
        fallback = next_effort(
            context.route,
            context.route["effective_effort"],
            combined_error,
        )
        if category != "unsupported_effort" or not fallback or changed:
            return WorkerAttempts(completed=completed, attempts=attempts)
        context.route["effective_effort"] = fallback
        context.route["effort_fallback_reason"] = "explicit_unsupported_effort"
        context.result_file.unlink(missing_ok=True)
