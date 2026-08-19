import os
import signal
import subprocess


_ORIGINAL_RUN = subprocess.run


def _terminate_process_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        killer = subprocess.Popen(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            killer.wait(timeout=10)
        except subprocess.TimeoutExpired:
            killer.kill()
            try:
                killer.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass


def run_process_tree(command, *, run_override=None, **kwargs):
    """Run a leaf worker in its own process group and reap descendants on timeout."""
    if run_override is not None and run_override is not _ORIGINAL_RUN:
        return run_override(command, **kwargs)

    input_value = kwargs.pop("input", None)
    timeout = kwargs.pop("timeout", None)
    check = bool(kwargs.pop("check", False))
    capture_output = bool(kwargs.pop("capture_output", False))
    if capture_output:
        if "stdout" in kwargs or "stderr" in kwargs:
            raise ValueError("stdout and stderr arguments may not be used with capture_output")
        kwargs["stdout"] = subprocess.PIPE
        kwargs["stderr"] = subprocess.PIPE
    if input_value is not None:
        if "stdin" in kwargs:
            raise ValueError("stdin and input arguments may not both be used")
        kwargs["stdin"] = subprocess.PIPE
    if os.name == "nt":
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    process = subprocess.Popen(command, **kwargs)
    try:
        stdout, stderr = process.communicate(input_value, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_tree(process)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired as drain_error:
            stdout, stderr = drain_error.stdout, drain_error.stderr
        exc.stdout = stdout
        exc.stderr = stderr
        raise
    completed = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
    if check:
        completed.check_returncode()
    return completed
