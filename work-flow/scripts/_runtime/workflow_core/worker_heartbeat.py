import threading
import time
from pathlib import Path
from types import SimpleNamespace


class OperationHeartbeat:
    def __init__(self, root, operation, interval_seconds, stall_seconds, lock_command_runner):
        self.root = Path(root)
        self.operation = dict(operation)
        self.interval_seconds = float(interval_seconds)
        self.stall_seconds = float(stall_seconds)
        self.lock_command_runner = lock_command_runner
        self.stop_event = threading.Event()
        self.thread = None
        self.successful = 0
        self.transient_busy = 0
        self.failures = []
        self.last_success = time.monotonic()

    def start(self):
        self.thread = threading.Thread(target=self._run, name="workflow-lock-heartbeat", daemon=True)
        self.thread.start()

    def _run(self):
        while not self.stop_event.wait(self.interval_seconds):
            try:
                code, payload = self.lock_command_runner(SimpleNamespace(
                    action="heartbeat",
                    root=str(self.root),
                    task_id=self.operation["task_id"],
                    role=self.operation["role"],
                    workspace_id=self.operation["workspace_id"],
                    owner=self.operation["owner_session"],
                    operation_id=self.operation["operation_id"],
                    reason=None,
                    guard_id=None,
                    force_stale=False,
                    stale_after_seconds=300.0,
                ))
            except Exception as exc:
                self.failures.append({"exit_code": 10, "error": "heartbeat_exception", "message": str(exc)})
                self.stop_event.set()
                return
            payload = payload if isinstance(payload, dict) else {}
            if code == 0:
                self.successful += 1
                self.last_success = time.monotonic()
            elif code == 4 and payload.get("error") == "lock_mutation_busy":
                self.transient_busy += 1
                if time.monotonic() - self.last_success >= self.stall_seconds:
                    self.failures.append({"exit_code": 4, "error": "heartbeat_stalled"})
                    self.stop_event.set()
            else:
                self.failures.append({"exit_code": code, "error": payload.get("error", "heartbeat_failed")})
                self.stop_event.set()

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=max(1.0, self.interval_seconds * 2))

    def result(self):
        return {
            "interval_seconds": self.interval_seconds,
            "stall_seconds": self.stall_seconds,
            "successful": self.successful,
            "transient_busy": self.transient_busy,
            "failures": list(self.failures),
        }
