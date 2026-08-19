import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .scanning import scan_project
from .schema import workspace_identity


READ_ROLES = {"pm", "plan-reviewer", "explorer", "code-reviewer", "risk-reviewer"}
PROTECTED_PATHS = {
    "work-flow/state.md",
    "work-flow/.state-write.guard",
    "work-flow/.runtime/operation-lock.json",
    "work-flow/.runtime/.operation-lock.guard",
}
PROTECTED_PREFIXES = (
    ".git/",
    "work-flow/.runtime/worker-results/",
    "work-flow/.runtime/transactions/",
)
LOCK_RELATIVE_PATH = "work-flow/.runtime/operation-lock.json"


def redact(value):
    text = str(value or "")
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:access|refresh|api)[_-]?token|api[_-]?key|secret)(\s*[:=]\s*)[^\s,;]+", r"\1\2[REDACTED]", text)
    return text


def sanitize(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    return value


def is_protected(relative):
    path = Path(relative).as_posix()
    while path.startswith("./"):
        path = path[2:]
    path = path.lstrip("/")
    return path in PROTECTED_PATHS or any(
        path == prefix.rstrip("/") or path.startswith(prefix)
        for prefix in PROTECTED_PREFIXES
    )


def allowed_changed(changed, allowed):
    if any(is_protected(path) for path in changed):
        return False
    if not allowed:
        return True
    normalized = [Path(item).as_posix().rstrip("/") for item in allowed]
    return all(
        not is_protected(path) and any(path == root or path.startswith(root + "/") for root in normalized)
        for path in changed
    )


def allowed_path_conflicts_protected(relative):
    path = Path(relative).as_posix().strip("/")
    protected_roots = set(PROTECTED_PATHS) | {prefix.rstrip("/") for prefix in PROTECTED_PREFIXES}
    return any(
        path == protected or path.startswith(protected + "/") or protected.startswith(path + "/")
        for protected in protected_roots
    )


def non_git_workspace_is_trusted(root):
    local_path = Path(root) / "work-flow" / "config.local.json"
    try:
        local = json.loads(local_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    trust = local.get("non_git_trust") if isinstance(local, dict) else None
    return bool(
        isinstance(trust, dict)
        and trust.get("trusted") is True
        and trust.get("workspace_id") == workspace_identity(root)
    )


def trust_command(args):
    root = Path(args.root).resolve()
    local_path = root / "work-flow" / "config.local.json"
    try:
        local = json.loads(local_path.read_text(encoding="utf-8")) if local_path.is_file() else {}
    except (OSError, json.JSONDecodeError) as exc:
        return 2, {"error": "local_config_invalid", "message": str(exc)}
    if not isinstance(local, dict):
        return 2, {"error": "local_config_invalid"}
    workspace_id = workspace_identity(root)
    if args.action == "status":
        return 0, {
            "workspace_id": workspace_id,
            "is_git": scan_project(root)["is_git"],
            "non_git_trusted": non_git_workspace_is_trusted(root),
        }
    if args.action == "grant-non-git":
        if scan_project(root)["is_git"]:
            return 2, {"error": "non_git_trust_not_applicable"}
        local["non_git_trust"] = {
            "trusted": True,
            "workspace_id": workspace_id,
            "granted_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }
    elif args.action == "revoke-non-git":
        local.pop("non_git_trust", None)
    else:
        return 2, {"error": "unsupported_trust_action"}
    local_path.parent.mkdir(parents=True, exist_ok=True)
    temp = local_path.with_name(f".{local_path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    temp.write_text(json.dumps(local, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temp, local_path)
    return 0, {
        "status": "granted" if args.action == "grant-non-git" else "revoked",
        "workspace_id": workspace_id,
        "non_git_trusted": non_git_workspace_is_trusted(root),
    }
