import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .locking import get_operation
from .routing import resolve_route
from .scanning import scan_project
from .schema import safe_join, workspace_identity
from .state import read_state
from .worker_policy import READ_ROLES, allowed_path_conflicts_protected, non_git_workspace_is_trusted


class WorkerPreflightError(ValueError):
    def __init__(self, exit_code, payload):
        self.exit_code = exit_code
        self.payload = payload
        super().__init__(payload.get("error", "worker_preflight_failed"))


@dataclass
class WorkerRunContext:
    root: Path
    task_id: str
    operation_id: str
    route: dict
    operation: dict
    start_revision: int
    result_file: Path
    result_rel: str
    prompt: str
    prompt_file: str | None
    allowed: list[str]
    timeout_seconds: int
    heartbeat_interval: float
    heartbeat_stall: float
    snapshot_max_bytes: int


def _reject(exit_code, error, **details):
    raise WorkerPreflightError(exit_code, {"error": error, **details})


def _validated_number(args, name, default, *, minimum, maximum, integer=False):
    try:
        value = int(getattr(args, name, default)) if integer else float(getattr(args, name, default))
    except (TypeError, ValueError):
        _reject(2, f"invalid_{name}")
    if value < minimum or value > maximum:
        _reject(2, f"invalid_{name}")
    return value


def _normalize_allowed(root, values):
    allowed = []
    for raw in values or []:
        value = raw
        candidate = Path(value)
        if candidate.is_absolute():
            try:
                value = candidate.resolve().relative_to(root).as_posix()
            except ValueError:
                _reject(2, "allowed_path_escape", path=raw)
        normalized_text = str(value).replace("\\", "/")
        if normalized_text.strip() in {"", "."} or ".." in PurePosixPath(normalized_text).parts:
            _reject(2, "allowed_path_escape", path=raw)
        normalized = Path(value).as_posix().rstrip("/")
        if allowed_path_conflicts_protected(normalized):
            _reject(2, "allowed_path_protected", path=raw)
        try:
            safe_join(root, normalized)
        except ValueError:
            _reject(2, "allowed_path_escape", path=raw)
        allowed.append(normalized)
    return allowed


def _read_prompt(root, prompt_file):
    if not prompt_file:
        return "Execute the assigned leaf workflow role and return a concise structured result."
    prompt_path = Path(prompt_file)
    prompt_path = prompt_path.resolve() if prompt_path.is_absolute() else (root / prompt_path).resolve()
    try:
        prompt_path.relative_to(root)
    except ValueError:
        _reject(2, "prompt_file_escape")
    try:
        return prompt_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        _reject(2, "prompt_file_unreadable", message=str(exc))


def prepare_worker(args):
    root = Path(args.root).resolve()
    timeout_seconds = _validated_number(
        args, "timeout_seconds", 300, minimum=1, maximum=1800, integer=True
    )
    heartbeat_interval = _validated_number(
        args, "heartbeat_interval_seconds", 60.0, minimum=0.000001, maximum=120
    )
    heartbeat_stall = _validated_number(
        args, "heartbeat_stall_seconds", 240.0, minimum=0.000001, maximum=299.999999
    )
    if heartbeat_stall <= heartbeat_interval:
        _reject(2, "invalid_heartbeat_stall_seconds")
    snapshot_max_bytes = _validated_number(
        args, "snapshot_max_bytes", 8 * 1024 * 1024 * 1024,
        minimum=1, maximum=2**63 - 1, integer=True,
    )
    operation = get_operation(root, args.operation_id)
    if not operation:
        _reject(4, "operation_lock_required")
    try:
        uuid.UUID(args.task_id)
    except (ValueError, AttributeError):
        _reject(2, "invalid_task_id")
    route = resolve_route(args.role)
    if operation.get("task_id") != args.task_id or operation.get("role") != route["role"]:
        _reject(4, "operation_identity_mismatch")
    start_revision = read_state(root).get("revision", 0)
    if start_revision != args.expected_revision:
        _reject(4, "revision_conflict", current_revision=start_revision)
    allowed = _normalize_allowed(root, args.allowed_path)
    if route["role"] not in READ_ROLES and not allowed:
        _reject(2, "allowed_path_required_for_write_worker")
    if not scan_project(root)["is_git"] and not non_git_workspace_is_trusted(root):
        _reject(
            3,
            "non_git_workspace_not_trusted",
            message=(
                "Record explicit workspace-bound trust in work-flow/config.local.json "
                "before using --skip-git-repo-check."
            ),
            workspace_id=workspace_identity(root),
        )
    prompt = _read_prompt(root, args.prompt_file)
    context = (
        "WORKFLOW_WORKER_CONTEXT\n"
        "schema_version: 1\n"
        f"task_id: {args.task_id}\noperation_id: {args.operation_id}\nrole: {route['role']}\n"
        "allowed_paths:\n" + "\n".join(f"  - {item}" for item in allowed) +
        "\nEND_WORKFLOW_WORKER_CONTEXT\n"
        "You are a leaf worker. Do not spawn agents, invoke codex workers, or modify "
        "state.md, operation locks, or aggregate result files.\n"
    )
    runtime_dir = root / "work-flow" / ".runtime" / "worker-results"
    result_file = runtime_dir / f"{args.task_id}-{args.operation_id}.json"
    return WorkerRunContext(
        root=root,
        task_id=args.task_id,
        operation_id=args.operation_id,
        route=route,
        operation=operation,
        start_revision=start_revision,
        result_file=result_file,
        result_rel=result_file.relative_to(root).as_posix(),
        prompt=context + prompt,
        prompt_file=args.prompt_file,
        allowed=allowed,
        timeout_seconds=timeout_seconds,
        heartbeat_interval=heartbeat_interval,
        heartbeat_stall=heartbeat_stall,
        snapshot_max_bytes=snapshot_max_bytes,
    )
