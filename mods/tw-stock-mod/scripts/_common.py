"""
What fetch-quotes-shioaji.py, fetch-quotes-capital.py and order-shioaji.py
share: the runtime-dir rule (which must match runtimeDir() in
hooks/constants.ts), env-file parsing, the watchlist read, the pidfile
protocol, the heartbeat age, the atomic file write, the give-up threshold,
the log line and its size cap, `--detach`'s self-relaunch, and the held-codes
tracker. Each script imports it from
its own folder - running `python scripts/<script>.py` puts that folder first
on sys.path.

Kept runnable on the oldest Python the fetchers' `--check` still diagnoses
(3.9): `from __future__ import annotations` defers the `X | None` hints.
"""
from __future__ import annotations

import json
import math
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

RUNTIME_DIR_ROOT = ".claude/stock-band"

# A fetcher exits once the band's heartbeat file is older than this: the band
# closed, or stopped wanting the fetcher's markets.
HEARTBEAT_MAX_AGE_MS = 90_000

# How long every snapshot may keep failing before a fetcher gives up and
# exits for a fresh login - well inside the band's own 120 s staleness window,
# so the band's respawn finds the pidfile free. See failed_ticks_limit().
GIVE_UP_AFTER_S = 60

# A fetcher's log (the band appends its stderr to stock-shioaji.log, and the
# SDK keeps its own shioaji.log) grows by several MB a day with nothing to cut
# it back. Past LOG_MAX_BYTES it is cut to its last LOG_KEEP_BYTES - see
# cap_log().
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_KEEP_BYTES = 1024 * 1024


# --- runtime dir -------------------------------------------------------------


def user_home() -> str:
    """
    Same rule as userHome() in hooks/register.tsx: `HOME` first, then
    `USERPROFILE`. Windows does not set `HOME` for a normal process, so without the second one every
    runtime file would fall back into the project's own `.claude/` - exactly
    what the runtime dir exists to avoid.
    """
    return os.environ.get("HOME") or os.environ.get("USERPROFILE") or ""


def runtime_slug(project: str) -> str:
    """
    Same rule as runtimeDir() in hooks/constants.ts: the project path with its
    leading separators dropped and every remaining separator turned into "-".
    `\\` and `:` count as separators alongside `/` so a Windows path becomes a
    legal directory name (`D:\\app` -> `D--app`); a POSIX path is unaffected by
    those two characters (`/Users/x/app` -> `Users-x-app`).
    """
    return re.sub(r"[/\\:]", "-", project.lstrip("/\\"))


def runtime_dir(home: str, project: str) -> Path:
    """
    `home` falls back to the project's own `.claude/` only when neither HOME
    nor USERPROFILE is set, matching the TS side. `project` must already be
    the same normalized absolute string the band would compute (see each
    main()'s use of this) - a symlink-resolved or otherwise reshaped string
    here would land manual runs and the band in two different directories.
    """
    if not home:
        return Path(project) / ".claude"
    return Path(home) / RUNTIME_DIR_ROOT / runtime_slug(project)


# --- output streams -------------------------------------------------------------


def utf8_stdio() -> None:
    """
    Every script here prints Chinese. Written to a pipe or a file - the band's
    spawn, `--detach`'s log, a test - Python encodes stdout/stderr with the
    locale's codepage, which on an English Windows is cp1252: stdout then
    raises UnicodeEncodeError on the first CJK character (`--help`, `--check`,
    order confirmations) and stderr turns the log into \\uXXXX escapes. UTF-8
    always, escaping anything that still cannot be written. A real console is
    unaffected: Python writes it as Unicode whatever this says.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass  # not a TextIOWrapper (replaced, or closed): leave it be
    # stdin too: order-shioaji.py reads the literal 確認 from it, and a piped
    # stdin on Windows decodes with the ANSI codepage, so the UTF-8 bytes of
    # 確認 would never compare equal - live orders could never be confirmed
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


# --- env file and config -----------------------------------------------------


def read_env_file(path: Path) -> dict:
    """key=value lines, `#` comments and blanks skipped, surrounding quotes
    dropped, the first value of a repeated key kept. utf-8-sig so a file
    Notepad saved with a BOM still reads its first key. Values are never
    printed."""
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


def load_env(path: Path, needs: str) -> None:
    """Exports the env file's keys with setdefault, so an already-exported env
    var wins over the file. A missing file exits, naming the keys it `needs`."""
    if not path.exists():
        sys.exit(f"ERROR: {path} 不存在（要有 {needs}）")
    for key, value in read_env_file(path).items():
        os.environ.setdefault(key, value)


def read_watchlist(config_path: Path) -> list[dict]:
    """The band's own config is the list, so there is only ever one watchlist."""
    if not config_path.exists():
        return []
    try:
        root = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        sys.exit(f"ERROR: {config_path} 不是合法 JSON: {err}")
    rows = root.get("tw") if isinstance(root, dict) else None
    out = []
    for row in rows or []:
        code = str(row.get("code", "")).strip()
        if code:
            out.append({"code": code, "name": row.get("name") or code})
    return out


def field(obj, name, default=None):
    """getattr with a None-safe default - an SDK object's unset field reads as `default`."""
    value = getattr(obj, name, default)
    return default if value is None else value


# --- pidfile -----------------------------------------------------------------


# A pidfile is written by its owner after the owner starts, so the owner's
# creation time is never later than the file's mtime. One created more than
# this after it is a process that got the pid later (Windows reuses them
# soon) - the slack only covers the two clocks' granularity.
PID_REUSE_SLACK_S = 2.0

# What every fetcher's command line carries: `python .../fetch-quotes-*.py`.
# A pid whose command line lacks it is not a fetcher, whatever the pidfile says.
FETCHER_MARK = b"fetch-quotes-"

# A claim holds its lock for a few milliseconds. One older than this was left
# by a claimant that died mid-claim, and is taken over.
PIDFILE_LOCK_STALE_S = 10.0


def _windows_kernel32():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    return kernel32


def _windows_pid_alive(pid: int, since: float | None = None, kernel32=None) -> bool:
    """
    Windows has no `kill -0`: os.kill(pid, 0) there is not a probe at all -
    signal 0 is CTRL_C_EVENT, so it calls GenerateConsoleCtrlEvent, which
    never asks whether the pid lives: it fails from a process with no
    console, and from one with a console (a detached fetcher has a
    window-less one of its own, see relaunch_detached) it can deliver a
    Ctrl-C rather than answer. Ask the kernel instead, and answer "not
    ours" whenever the process cannot be ours:
      - it cannot be opened: gone, or another user's or a protected process
        (ERROR_ACCESS_DENIED) - a fetcher this user started always opens,
        the same reasoning as EPERM on POSIX;
      - it has exited (WaitForSingleObject signalled);
      - it was created after `since`, the pidfile's mtime: a reboot or hard
        kill left the pidfile behind and Windows handed the pid to someone
        else (see PID_REUSE_SLACK_S).
    `kernel32` is injectable so tests can stand in for the kernel.
    """
    from ctypes import byref
    from ctypes import wintypes

    synchronize = 0x00100000
    process_query_limited_information = 0x1000
    wait_timeout = 0x102
    filetime_epoch = 116444736000000000  # 1601-01-01 -> 1970-01-01, in 100 ns ticks

    if kernel32 is None:
        kernel32 = _windows_kernel32()
    handle = kernel32.OpenProcess(synchronize | process_query_limited_information, False, pid)
    if not handle:
        return False
    try:
        if kernel32.WaitForSingleObject(handle, 0) != wait_timeout:
            return False
        if since is None:
            return True
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, byref(created), byref(exited), byref(kernel), byref(user)):
            return True  # running, and no creation time to prove the pid was reused
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        created_at = (ticks - filetime_epoch) / 10_000_000
        return created_at <= since + PID_REUSE_SLACK_S
    finally:
        kernel32.CloseHandle(handle)


def _proc_is_fetcher(pid: int, proc: str = "/proc") -> bool | None:
    """Whether /proc says `pid` runs a fetcher script: None when there is no
    /proc to ask (macOS). `proc` is injectable for tests."""
    try:
        return FETCHER_MARK in Path(f"{proc}/{pid}/cmdline").read_bytes()
    except OSError:
        return None


def pid_alive(pid: int, since: float | None = None, proc: str = "/proc") -> bool:
    """
    Whether the pid a pidfile names is a fetcher still feeding; `since` is the
    pidfile's mtime, used on Windows to spot a reused pid (see
    _windows_pid_alive). Elsewhere kill -0 answers, and any error - no such
    process, or EPERM for a pid a reboot handed to another user's process -
    means it is not ours and not feeding.

    A pidfile outlives a fetcher that was SIGKILLed or lost to a reboot, and
    Linux hands its pid to the next process: a same-user process whose
    command line is not a fetcher's (FETCHER_MARK) is not ours. It is never
    signalled - it may be the user's own Ctrl-Z'd vim - and it does not hold
    the pidfile, or the band could never respawn.

    A stopped (T/t) or zombie fetcher is not feeding either: kill -0 still
    says alive, so the band would skip respawning for as long as it stays
    that way (a Ctrl-Z'd claude session drags the fetcher down with it).
    Kill a stopped one - only once it is known to be a fetcher - so it cannot
    wake later and double-write the runtime dir. No /proc (macOS) reads as
    alive, as kill -0 said, and nothing is killed.
    """
    if os.name == "nt":
        try:
            return _windows_pid_alive(pid, since)
        except (OSError, AttributeError, ValueError):
            return False  # no answer from the kernel: take the pidfile over rather than never respawn
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        state = Path(f"{proc}/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return True
    if state == "Z":
        return False  # already dead; its parent just has not reaped it
    if not _proc_is_fetcher(pid, proc):
        return False
    if state in ("T", "t"):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        return False
    return True


def _take_lock(lock: Path) -> bool:
    """Create `lock` exclusively (O_EXCL): True when this process now holds it.
    A lock older than PIDFILE_LOCK_STALE_S is a dead claimant's and is
    cleared once; a fresh one means another claim is in progress."""
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                seen = lock.stat()
            except OSError:
                continue  # released between the two calls: try again
            if time.time() - seen.st_mtime < PIDFILE_LOCK_STALE_S:
                return False
            # Unlink only the stale lock that was looked at: two claimants can
            # both find it stale, and the slower one must not remove the lock
            # the faster one has just created in its place.
            try:
                if lock.stat().st_ino == seen.st_ino:
                    lock.unlink()
            except OSError:
                pass
            continue
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    return False


def claim_pidfile(pidfile: Path) -> bool:
    """
    True: this process owns the pidfile and should run. False: another live
    process already owns it for this project, or is claiming it right now,
    so the caller exits quietly (0) rather than double-fetching - see each
    fetcher's module docstring, `--pidfile`.

    The check and the write happen under a lock file taken with O_EXCL: two
    sessions spawning at the same moment used to both see "no live owner",
    both write the pidfile and both log in. The pid is written through a
    temp file and a replace, so a reader never sees the half-written (empty)
    file that used to read as "no owner".
    """
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    lock = pidfile.with_name(pidfile.name + ".lock")
    if not _take_lock(lock):
        return False
    try:
        if pidfile.exists():
            try:
                existing = int(pidfile.read_text(encoding="utf-8").strip())
                written = pidfile.stat().st_mtime
            except (ValueError, OSError):
                existing = None
            if existing and existing != os.getpid() and pid_alive(existing, written):
                return False
        tmp = pidfile.with_name(f"{pidfile.name}.{os.getpid()}.tmp")
        tmp.write_text(str(os.getpid()), encoding="utf-8")
        tmp.replace(pidfile)
        return True
    finally:
        try:
            lock.unlink()
        except OSError:
            pass


def release_pidfile(pidfile: Path) -> None:
    """Unlink the pidfile only while it still names this process: a successor
    that already claimed it (after this one was judged dead) keeps its claim."""
    try:
        if pidfile.read_text(encoding="utf-8").strip() == str(os.getpid()):
            pidfile.unlink()
    except (OSError, ValueError):
        pass


# --- output ------------------------------------------------------------------


# How many times a replace refused with PermissionError is retried: on
# Windows an antivirus scan or a reader holding the target open refuses it
# for a moment (a sharing violation).
WRITE_RETRIES = 3
WRITE_RETRY_WAIT_S = 0.05


def write_atomic(path: Path, payload: dict, sleep=time.sleep) -> bool:
    """
    Write through a temp file and replace: the band polls this file every few
    seconds and a half-written JSON would read as malformed and drop it back
    to demo prices. Compact, because futures-quotes.json carries every K bar
    and is rewritten up to once a second; `python -m json.tool FILE` reads it
    back for a human.

    A write that still fails (a sharing violation that outlasts the retries,
    a full disk) is logged and answers False, leaving the last file in
    place - the same as a failed snapshot. It used to raise out of the
    fetcher's loop and kill it, and a respawn means a fresh broker login.
    """
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        for attempt in range(WRITE_RETRIES):
            try:
                tmp.replace(path)
                return True
            except PermissionError:
                if attempt == WRITE_RETRIES - 1:
                    raise
                sleep(WRITE_RETRY_WAIT_S)
    except OSError as err:
        log(f"寫入 {path.name} 失敗（保留上一份檔案）: {type(err).__name__}: {err}")
    return False


def failed_ticks_limit(interval: float) -> int:
    """How many failed ticks in a row mean the session is dead: GIVE_UP_AFTER_S
    worth at whatever --interval this run uses, never less than one tick. A
    fixed tick count gave up after 3 minutes at interval 30 (past the band's
    120 s staleness, so its respawns all bounced off our pidfile) and after
    6 s at interval 1 (a blip forcing a full re-login)."""
    return max(1, math.ceil(GIVE_UP_AFTER_S / interval)) if interval > 0 else 1


# --- log ---------------------------------------------------------------------


def log(message: str) -> None:
    """
    One line to stderr, stamped with the local date and time. A spawned
    fetcher's stderr is appended to stock-shioaji.log / stock-capital.log in
    the runtime dir across every run, so an unstamped line there could be
    from any day. sys.stderr is looked up per call, which is what lets a test
    capture it.
    """
    print(f"{time.strftime('%m-%d %H:%M:%S')} {message}", file=sys.stderr, flush=True)


def cap_log(path: Path, max_bytes: int = LOG_MAX_BYTES, keep_bytes: int = LOG_KEEP_BYTES) -> bool:
    """
    Cut a log past `max_bytes` down to its last `keep_bytes`, starting at a
    whole line: True when it was cut. The file is rewritten in place, never
    renamed - the band's shell and the SDK both hold it open for append
    (O_APPEND), so their next line lands at the new end rather than in a
    renamed file nobody reads. A missing or unreadable log is left alone.
    """
    try:
        if path.stat().st_size <= max_bytes:
            return False
        with open(path, "r+b") as f:
            f.seek(-keep_bytes, os.SEEK_END)
            tail = f.read()
            newline = tail.find(b"\n")
            tail = tail[newline + 1:] if newline >= 0 else tail
            f.seek(0)
            f.write(tail)
            f.truncate()
        return True
    except OSError:
        return False


# --- --detach ----------------------------------------------------------------


def open_append_log(path: Path):
    """
    The log a detached fetcher's stdout/stderr are pointed at, opened so that
    every write lands at the file's CURRENT end - what cap_log() relies on
    when it cuts the file back in place.

    POSIX: plain `ab` is O_APPEND in the kernel, the same as the band's own
    `>>"$log"`. Windows has no kernel O_APPEND: Python's `a` mode is the C
    runtime seeking to the end before each write of its OWN fd, and a child
    handed that handle writes wherever the shared file pointer was left. Cut
    the file back and the child's next line lands at the old offset, padding
    the gap with NULs (measured: a 100 KB log cut to 20 bytes came back as
    100 KB of NULs). A handle opened with FILE_APPEND_DATA and no
    FILE_WRITE_DATA is the kernel's own append - every write goes to the
    end - and DuplicateHandle (how Popen hands it over) keeps that access.
    """
    if os.name != "nt":
        return open(path, "ab")
    import ctypes
    import msvcrt
    from ctypes import wintypes

    file_append_data = 0x0004
    synchronize = 0x00100000
    share_all = 0x1 | 0x2 | 0x4  # read, write, delete: cap_log and readers still open it
    open_always = 4
    file_attribute_normal = 0x80
    invalid_handle = wintypes.HANDLE(-1).value

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    handle = kernel32.CreateFileW(str(path), file_append_data | synchronize, share_all, None, open_always, file_attribute_normal, None)
    if not handle or handle == invalid_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    return open(msvcrt.open_osfhandle(handle, os.O_APPEND | os.O_WRONLY), "ab")


def relaunch_detached(script: str, log_path: Path, cwd: str | None = None, argv: list[str] | None = None, popen=subprocess.Popen) -> None:
    """
    `--detach`: hand the real work to a detached child and return, so the
    band's one-shot `$.process.run` resolves at once instead of waiting out a
    long-lived fetcher's pipes. Windows' counterpart of the `nohup ... &`
    wrapper hooks/register.tsx uses on macOS/Linux: there is no `nohup` (nor
    `/bin/sh`) there, and `start /b` would put the quoting of a python path
    with spaces in cmd.exe's hands, so the child is launched from Python where
    the argument list stays a list.

    `script` is the caller's own absolute path - this file is not the one to
    re-run. The child gets the same arguments minus `--detach` (`argv`
    defaults to sys.argv[1:]), its stdin from /dev/null and its output
    appended to `log_path` (see open_append_log). On Windows it gets a
    console of its own with no window (CREATE_NO_WINDOW) rather than none at
    all (DETACHED_PROCESS): a venv's Scripts\\python.exe is not the
    interpreter but a stub that starts the base one as its own child, and a
    console program started by a console-less parent is handed a brand-new
    console - a visible window (Windows Terminal, on Windows 11) for the
    fetcher's whole life. The base interpreter inherits the window-less one
    instead. It is still a new process group, and still nothing the
    launching process's exit takes down with it. Elsewhere - only a by-hand
    `--detach`, the band never asks for one there - a new session does the
    same job. close_fds keeps the launcher's own stdout/stderr pipes out of
    the child, which is what lets the band's run() see them close.

    `cwd` is where the child starts, before it chdir()s into its out dir:
    by default the log's folder (群益's historic choice); the caller's own cwd
    keeps a relative --env / --out-dir meaning the same in the child as it
    did here. `popen` is injectable for tests.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    child = [sys.executable, script] + [a for a in args if a != "--detach"]
    log_path.parent.mkdir(parents=True, exist_ok=True)
    options: dict = {}
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        options["start_new_session"] = True
    with open_append_log(log_path) as log_file:
        popen(
            child,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            close_fds=True,
            cwd=cwd if cwd is not None else str(log_path.parent),
            **options,
        )


# --- held codes --------------------------------------------------------------


class HeldCodes:
    """
    The held codes the quote subscription carries on top of the watchlist.

    A code the latest answer adds is taken at once - it needs a live price
    now. A code it drops is only let go once two answers in a row agree: a
    partial or glitched answer (群益's pump window can end while
    OnProfitLossGWReport rows are still arriving) must not unsubscribe a
    position for one answer and subscribe it again on the next. Feed it
    fresh answers only - a cached one repeated would "agree" with itself.
    """

    def __init__(self) -> None:
        self.codes: list[str] = []
        self._dropping: list[str] | None = None  # the last answer that dropped codes

    def update(self, seen: list[str]) -> bool:
        """Fold one answer's held codes in; True when `codes` changed."""
        if all(code in seen for code in self.codes):
            self._dropping = None
            if seen == self.codes:
                return False
            self.codes = list(seen)
            return True
        confirmed = self._dropping == seen
        self._dropping = None if confirmed else list(seen)
        new = list(seen) if confirmed else self.codes + [c for c in seen if c not in self.codes]
        if new == self.codes:
            return False
        self.codes = new
        return True
