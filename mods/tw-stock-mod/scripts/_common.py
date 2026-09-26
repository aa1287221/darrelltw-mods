"""
What fetch-quotes-shioaji.py, fetch-quotes-capital.py and order-shioaji.py
share: the runtime-dir rule (which must match runtimeDir() in
hooks/constants.ts), env-file parsing, the watchlist read, the pidfile
protocol, the heartbeat age, the atomic file write, the give-up threshold,
the log line and the held-codes tracker. Each script imports it from
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
    either fails from a console-less (DETACHED_PROCESS) fetcher or sends the
    target a Ctrl-C. Ask the kernel instead, and answer "not ours" whenever
    the process cannot be ours:
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


def pid_alive(pid: int, since: float | None = None) -> bool:
    """
    Whether the pid a pidfile names is a fetcher still feeding; `since` is the
    pidfile's mtime, used on Windows to spot a reused pid (see
    _windows_pid_alive). Elsewhere kill -0 answers, and any error - no such
    process, or EPERM for a pid a reboot handed to another user's process -
    means it is not ours and not feeding. A stopped (T/t) or zombie owner is
    not feeding either: kill -0 still says alive, so the band would skip
    respawning for as long as it stays that way (a Ctrl-Z'd claude session
    drags the fetcher down with it). Kill a stopped one so it cannot wake
    later and double-write the runtime dir. No /proc (macOS) reads as alive,
    as kill -0 said.
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
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return True
    if state in ("T", "t", "Z"):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        return False
    return True


def claim_pidfile(pidfile: Path) -> bool:
    """
    True: this process owns the pidfile and should run. False: another live
    process already owns it for this project, so the caller exits quietly
    (0) rather than double-fetching - see each fetcher's module docstring,
    `--pidfile`.
    """
    if pidfile.exists():
        try:
            existing = int(pidfile.read_text(encoding="utf-8").strip())
            written = pidfile.stat().st_mtime
        except (ValueError, OSError):
            existing = None
        if existing and existing != os.getpid() and pid_alive(existing, written):
            return False
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    pidfile.write_text(str(os.getpid()), encoding="utf-8")
    return True


def release_pidfile(pidfile: Path) -> None:
    """Unlink the pidfile only while it still names this process: a successor
    that already claimed it (after this one was judged dead) keeps its claim."""
    try:
        if pidfile.read_text(encoding="utf-8").strip() == str(os.getpid()):
            pidfile.unlink()
    except (OSError, ValueError):
        pass


# --- output ------------------------------------------------------------------


def write_atomic(path: Path, payload: dict) -> None:
    """
    Write through a temp file and replace: the band polls this file every few
    seconds and a half-written JSON would read as malformed and drop it back
    to demo prices. Compact, because futures-quotes.json carries every K bar
    and is rewritten up to once a second; `python -m json.tool FILE` reads it
    back for a human.
    """
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


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
