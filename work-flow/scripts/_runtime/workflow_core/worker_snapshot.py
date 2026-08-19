import errno
import hashlib
import json
import os
import shutil
import stat
import tempfile
from datetime import datetime
from pathlib import Path

from .locking import _validate_lock_document
from .worker_policy import LOCK_RELATIVE_PATH


class SnapshotLimitError(ValueError):
    def __init__(self, limit_bytes, required_bytes):
        self.limit_bytes = limit_bytes
        self.required_bytes = required_bytes
        super().__init__(
            f"snapshot backup limit exceeded: required {required_bytes} bytes, limit {limit_bytes} bytes"
        )


class SnapshotCleanupError(RuntimeError):
    def __init__(self, path, error):
        self.path = str(path)
        self.error = str(error)
        super().__init__(f"snapshot cleanup failed for {path}: {error}")


class SnapshotStorageError(OSError):
    def __init__(self, code, path, error):
        self.code = code
        self.path = str(path)
        self.error = str(error)
        super().__init__(f"{code} at {path}: {error}")


class SnapshotScanError(OSError):
    def __init__(self, path, error):
        self.path = str(path)
        self.error = str(error)
        super().__init__(f"snapshot scan failed at {path}: {error}")


def _storage_error(path, exc):
    exhausted = {errno.ENOSPC}
    if hasattr(errno, "EDQUOT"):
        exhausted.add(errno.EDQUOT)
    code = "snapshot_storage_exhausted" if exc.errno in exhausted else "snapshot_storage_unavailable"
    return SnapshotStorageError(code, path, exc)


class WorkspaceSnapshot(dict):
    def __init__(self, *args, backup_root=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.backup_root = Path(backup_root) if backup_root else None
        self.backup_bytes = 0
        self.file_count = 0
        self.preserved = False

    def preserve(self, workspace_root, reason):
        if self.backup_root is None:
            raise SnapshotCleanupError("unavailable", "snapshot has no backup root")
        self.preserved = True
        manifest_path = self.backup_root / "snapshot-manifest.json"
        manifest = {
            "schema_version": 1,
            "workspace_root": str(Path(workspace_root).resolve()),
            "reason": str(reason),
            "backup_bytes": self.backup_bytes,
            "file_count": self.file_count,
            "records": {
                relative: {key: value for key, value in record.items() if key != "content"}
                for relative, record in sorted(self.items())
            },
        }
        temporary = manifest_path.with_suffix(".json.tmp")
        try:
            temporary.write_text(
                json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            os.replace(temporary, manifest_path)
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise SnapshotCleanupError(self.backup_root, exc) from exc
        return manifest_path

    def close(self):
        if self.backup_root is not None and not self.preserved:
            root = self.backup_root
            try:
                shutil.rmtree(root)
            except OSError as exc:
                raise SnapshotCleanupError(root, exc) from exc
            self.backup_root = None


def stream_file_record(path, backup_path=None, inline_content=False):
    before = path.stat(follow_symlinks=False)
    digest = hashlib.sha256()
    size = 0
    inline = bytearray() if inline_content else None
    output = None
    try:
        if backup_path is not None:
            try:
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                output = backup_path.open("wb")
            except OSError as exc:
                raise _storage_error(backup_path, exc) from exc
        with path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
                if output is not None:
                    try:
                        output.write(chunk)
                    except OSError as exc:
                        raise _storage_error(backup_path, exc) from exc
                if inline is not None:
                    inline.extend(chunk)
    finally:
        if output is not None:
            try:
                output.close()
            except OSError as exc:
                raise _storage_error(backup_path, exc) from exc
    after = path.stat(follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise OSError(f"file changed while snapshotting: {path}")
    record = {
        "kind": "file",
        "sha256": digest.hexdigest(),
        "size": size,
        "mode": stat.S_IMODE(after.st_mode),
    }
    if backup_path is not None:
        record["backup_path"] = str(backup_path)
    if inline is not None:
        record["content"] = bytes(inline)
    return record


def path_record(path, backup_path=None, inline_content=False):
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return {
            "kind": "reparse",
            "target": os.readlink(path),
            "target_is_directory": True,
        }
    if path.is_symlink():
        return {
            "kind": "symlink",
            "target": os.readlink(path),
            "target_is_directory": path.is_dir(),
        }
    if path.is_dir():
        return {"kind": "directory"}
    if path.is_file():
        return stream_file_record(path, backup_path, inline_content)
    return {"kind": "other"}


def snapshot(root, ignore_result=None, capture_backups=False, max_backup_bytes=None):
    root = Path(root).resolve()
    try:
        backup_root = Path(tempfile.mkdtemp(prefix="workflow-worker-snapshot-")) if capture_backups else None
    except OSError as exc:
        raise _storage_error(tempfile.gettempdir(), exc) from exc
    if backup_root is not None:
        try:
            os.chmod(backup_root, 0o700)
        except OSError as exc:
            shutil.rmtree(backup_root, ignore_errors=True)
            raise _storage_error(backup_root, exc) from exc
    result = WorkspaceSnapshot(backup_root=backup_root)

    def visit(directory):
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name.casefold())
        except OSError as exc:
            raise SnapshotScanError(directory, exc) from exc
        for entry in entries:
            path = Path(entry.path)
            rel = path.relative_to(root).as_posix()
            if ignore_result and rel == ignore_result:
                continue
            backup_path = None
            is_junction = getattr(path, "is_junction", None)
            is_regular_file = (
                path.is_file()
                and not path.is_symlink()
                and not (callable(is_junction) and is_junction())
            )
            if backup_root is not None and is_regular_file:
                size = path.stat(follow_symlinks=False).st_size
                required = result.backup_bytes + size
                if max_backup_bytes is not None and required > max_backup_bytes:
                    raise SnapshotLimitError(max_backup_bytes, required)
                result.backup_bytes = required
                result.file_count += 1
                backup_path = backup_root / rel
            try:
                record = path_record(
                    path,
                    backup_path=backup_path,
                    inline_content=rel == LOCK_RELATIVE_PATH,
                )
            except SnapshotStorageError:
                raise
            except OSError as exc:
                raise SnapshotScanError(path, exc) from exc
            result[rel] = record
            if record.get("kind") == "directory":
                visit(path)

    try:
        visit(root)
        return result
    except Exception:
        result.close()
        raise


def record_identity(record):
    if record is None:
        return None
    return {key: value for key, value in record.items() if key not in {"backup_path", "content"}}


def record_bytes(record):
    if not record:
        raise ValueError("file record is missing")
    if "content" in record:
        return record["content"]
    backup_path = record.get("backup_path")
    if backup_path:
        return Path(backup_path).read_bytes()
    raise ValueError("file record has no recoverable content")


def parse_timestamp(value):
    if not isinstance(value, str) or not value:
        raise ValueError("missing timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def lock_parent_owned_mutation(root, before_value, after_value, operation_id):
    if not before_value or not after_value:
        return False
    if before_value.get("kind") != "file" or after_value.get("kind") != "file":
        return False
    try:
        before = json.loads(record_bytes(before_value).decode("utf-8"))
        after = json.loads(record_bytes(after_value).decode("utf-8"))
        if _validate_lock_document(root, before) or _validate_lock_document(root, after):
            return False
        before_revision = before.get("revision")
        after_revision = after.get("revision")
        if not isinstance(before_revision, int) or not isinstance(after_revision, int) or after_revision <= before_revision:
            return False
        before_locks = {item.get("operation_id"): item for item in before.get("locks", [])}
        after_locks = {item.get("operation_id"): item for item in after.get("locks", [])}
        if operation_id not in before_locks or operation_id not in after_locks:
            return False
        before_current = dict(before_locks[operation_id])
        after_current = dict(after_locks[operation_id])
        before_heartbeat = before_current.pop("heartbeat_at", None)
        after_heartbeat = after_current.pop("heartbeat_at", None)
        if before_current != after_current:
            return False
        return parse_timestamp(after_heartbeat) >= parse_timestamp(before_heartbeat)
    except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def changed_paths(root, before, after, operation_id):
    changed = sorted(
        rel for rel in set(before) | set(after)
        if record_identity(before.get(rel)) != record_identity(after.get(rel))
    )
    if LOCK_RELATIVE_PATH in changed and lock_parent_owned_mutation(
        root, before.get(LOCK_RELATIVE_PATH), after.get(LOCK_RELATIVE_PATH), operation_id
    ):
        changed.remove(LOCK_RELATIVE_PATH)
    return changed


def claimable_paths(before, after, changed):
    result = []
    for rel in changed:
        before_kind = (before.get(rel) or {}).get("kind")
        after_kind = (after.get(rel) or {}).get("kind")
        if {before_kind, after_kind}.issubset({None, "directory"}):
            continue
        result.append(rel)
    return result
