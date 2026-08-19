import os
import shutil
from pathlib import Path

from .worker_policy import LOCK_RELATIVE_PATH, allowed_changed, is_protected
from .worker_snapshot import record_identity, snapshot


class WorkerRollbackError(RuntimeError):
    def __init__(self, paths):
        self.paths = sorted(paths)
        super().__init__("worker rollback incomplete: " + ", ".join(self.paths))


def remove_path(path):
    is_junction = getattr(path, "is_junction", None)
    if path.is_symlink() or (callable(is_junction) and is_junction()) or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists() and path.is_dir():
        shutil.rmtree(path)


def is_allowed_parent_directory(root, relative, allowed):
    path = Path(relative).as_posix().rstrip("/")
    normalized = [Path(item).as_posix().rstrip("/") for item in allowed]
    if not any(item.startswith(path + "/") for item in normalized):
        return False
    candidate = Path(root) / relative
    is_junction = getattr(candidate, "is_junction", None)
    return (
        candidate.is_dir()
        and not candidate.is_symlink()
        and not (callable(is_junction) and is_junction())
    )


def restore_record(path, record):
    kind = record.get("kind")
    if kind == "directory":
        path.mkdir(parents=True, exist_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind in {"symlink", "reparse"}:
        os.symlink(
            record["target"],
            path,
            target_is_directory=bool(record.get("target_is_directory")),
        )
        return
    if kind == "file":
        backup_path = record.get("backup_path")
        if not backup_path or not Path(backup_path).is_file():
            raise WorkerRollbackError([str(path)])
        shutil.copyfile(backup_path, path)
        if record.get("mode") is not None:
            try:
                os.chmod(path, record["mode"])
            except OSError:
                pass


def restore_unauthorized(root, before, changed, allowed):
    unauthorized = [
        rel for rel in changed
        if is_protected(rel)
        or (
            not allowed_changed([rel], allowed)
            and not is_allowed_parent_directory(root, rel, allowed)
        )
    ]
    restorable = [rel for rel in unauthorized if rel != LOCK_RELATIVE_PATH]
    for rel in sorted(restorable, key=lambda item: len(Path(item).parts), reverse=True):
        remove_path(Path(root) / rel)
    for rel in sorted(
        (item for item in restorable if (before.get(item) or {}).get("kind") == "directory"),
        key=lambda item: len(Path(item).parts),
    ):
        restore_record(Path(root) / rel, before[rel])
    for rel in sorted(
        (item for item in restorable if item in before and before[item].get("kind") != "directory"),
        key=lambda item: len(Path(item).parts),
    ):
        restore_record(Path(root) / rel, before[rel])
    restored_snapshot = snapshot(root)
    failed = [
        rel for rel in unauthorized
        if record_identity(restored_snapshot.get(rel)) != record_identity(before.get(rel))
    ]
    if failed:
        raise WorkerRollbackError(failed)
    return unauthorized
