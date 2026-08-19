import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from .constants import RUNTIME_VERSION, TEMPLATE_VERSION
from .locking import _validate_lock_document
from .runtime_manifest import load_runtime_manifest
from .validation import validate_project


def _codex_check(run_fn=subprocess.run):
    executable = shutil.which("codex")
    if not executable:
        return {
            "passed": False,
            "available": False,
            "version": None,
            "message": "Codex CLI is not available; offline workflow commands remain usable.",
        }
    try:
        completed = run_fn(
            [executable, "--version"],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "passed": False,
            "available": True,
            "version": None,
            "message": f"Codex CLI version check failed: {type(exc).__name__}",
        }
    output = (completed.stdout or completed.stderr or "").strip().splitlines()
    return {
        "passed": completed.returncode == 0,
        "available": True,
        "version": output[0][:160] if output else None,
        "message": "Codex CLI is available." if completed.returncode == 0 else "Codex CLI returned a non-zero status.",
    }


def _lock_check(root):
    path = Path(root) / "work-flow/.runtime/operation-lock.json"
    if not path.is_file():
        return {"passed": False, "active_operations": None, "message": "Operation lock document is missing."}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        error = _validate_lock_document(root, document)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"passed": False, "active_operations": None, "message": f"Operation lock is unreadable: {type(exc).__name__}"}
    if error:
        return {"passed": False, "active_operations": None, "message": error}
    return {
        "passed": True,
        "active_operations": len(document.get("locks", [])),
        "message": "Operation lock document is valid.",
    }


def _runtime_check(root):
    root = Path(root)
    runtime_root = root / "work-flow/scripts/_runtime"
    config_path = root / "work-flow/config.json"
    observed = {
        "config_runtime_version": None,
        "config_template_version": None,
        "manifest_runtime_version": None,
        "manifest_template_version": None,
    }
    errors = []
    if not (runtime_root / "workflow_cli.py").is_file():
        errors.append("local_runtime_cli_missing")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        observed["config_runtime_version"] = config.get("runtime_version")
        observed["config_template_version"] = config.get("template_version")
    except (OSError, ValueError, json.JSONDecodeError):
        errors.append("local_runtime_config_unreadable")
    try:
        manifest = load_runtime_manifest(runtime_root)
        observed["manifest_runtime_version"] = manifest.get("runtime_version")
        observed["manifest_template_version"] = manifest.get("template_version")
    except (OSError, ValueError, json.JSONDecodeError):
        errors.append("local_runtime_manifest_unreadable")
    expected = {
        "config_runtime_version": RUNTIME_VERSION,
        "config_template_version": TEMPLATE_VERSION,
        "manifest_runtime_version": RUNTIME_VERSION,
        "manifest_template_version": TEMPLATE_VERSION,
    }
    mismatches = [name for name, value in observed.items() if value != expected[name]]
    errors.extend(f"{name}_mismatch" for name in mismatches)
    return {
        "passed": not errors,
        "executing_runtime_version": RUNTIME_VERSION,
        "executing_template_version": TEMPLATE_VERSION,
        "observed": observed,
        "version_match": not mismatches,
        "errors": errors,
    }


def doctor_project(root, strict=False, run_fn=subprocess.run):
    root = Path(root).resolve()
    validation = validate_project(root, strict=strict)
    codex = _codex_check(run_fn=run_fn)
    lock = _lock_check(root)
    guard_paths = [
        "work-flow/.runtime/.operation-lock.guard",
        "work-flow/.runtime/.operation-lock.mutex",
        "work-flow/.state-write.guard",
    ]
    guards = [relative for relative in guard_paths if (root / relative).exists() and not relative.endswith(".mutex")]
    checks = {
        "project_validation": {
            "passed": validation["valid"],
            "strict": bool(strict),
            "issue_count": len(validation.get("issues", [])),
        },
        "local_runtime": _runtime_check(root),
        "operation_lock": lock,
        "operation_guards": {
            "passed": not guards,
            "present": guards,
        },
        "codex_cli": codex,
    }
    blocking = [name for name in ("project_validation", "local_runtime", "operation_lock", "operation_guards") if not checks[name]["passed"]]
    if blocking:
        status = "blocked"
    elif not codex["passed"]:
        status = "degraded"
    else:
        status = "ready"
    next_steps = []
    if not validation["valid"]:
        next_steps.append("Run validate --strict and resolve the reported project issues.")
    if guards:
        next_steps.append("Inspect the exact guard identity before explicit recovery.")
    if not codex["passed"]:
        next_steps.append("Install or repair Codex CLI before running model workers; offline commands remain available.")
    if not next_steps:
        next_steps.append("The project workflow is ready.")
    return {
        "schema_version": 1,
        "status": status,
        "offline_ready": not blocking,
        "root": str(root),
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "python": platform.python_version(),
            "wsl": platform.system() == "Linux" and "microsoft" in platform.release().casefold(),
        },
        "checks": checks,
        "next_steps": next_steps,
    }


def doctor_command(args):
    payload = doctor_project(args.root, strict=bool(getattr(args, "strict", False)))
    return {"ready": 0, "blocked": 2, "degraded": 3}[payload["status"]], payload
