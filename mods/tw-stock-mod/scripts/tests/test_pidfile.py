"""
The pidfile protocol and the give-up threshold in scripts/_common.py: the
pidfile goes away on exit only while it still names this process, so a
successor that already claimed it (after this one was judged dead) keeps its
claim; and failed_ticks_limit() lands the give-up inside the band's 120 s
staleness window at any --interval. Also pins that every script uses this
one copy rather than a drifting local one.
"""
import importlib.util
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

import _common

SCRIPTS = Path(__file__).resolve().parents[1]


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT_MODULES = {
    "fetch-quotes-shioaji.py": load("fetch-quotes-shioaji.py", "fetch_quotes_shioaji_pid"),
    "fetch-quotes-capital.py": load("fetch-quotes-capital.py", "fetch_quotes_capital_pid"),
    "order-shioaji.py": load("order-shioaji.py", "order_shioaji_pid"),
}

SHARED_BY = {
    "fetch-quotes-shioaji.py": [
        "claim_pidfile", "release_pidfile", "failed_ticks_limit", "runtime_dir", "user_home",
        "read_env_file", "load_env", "read_watchlist", "write_atomic", "field", "relaunch_detached",
    ],
    "fetch-quotes-capital.py": [
        "claim_pidfile", "release_pidfile", "failed_ticks_limit", "runtime_dir", "user_home",
        "read_env_file", "load_env", "read_watchlist", "write_atomic", "relaunch_detached",
    ],
    "order-shioaji.py": ["field", "load_env"],
}


@pytest.mark.parametrize(
    "script,name", [(script, name) for script, names in SHARED_BY.items() for name in names]
)
def test_scripts_use_the_shared_copy(script, name):
    assert getattr(SCRIPT_MODULES[script], name) is getattr(_common, name)


def test_release_removes_our_own_pidfile(tmp_path):
    pidfile = tmp_path / "stock.pid"
    assert _common.claim_pidfile(pidfile)
    _common.release_pidfile(pidfile)
    assert not pidfile.exists()


def test_release_leaves_a_successors_pidfile(tmp_path):
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text(str(os.getpid() + 1), encoding="utf-8")
    _common.release_pidfile(pidfile)
    assert pidfile.read_text(encoding="utf-8") == str(os.getpid() + 1)


def test_release_is_a_noop_when_already_gone(tmp_path):
    _common.release_pidfile(tmp_path / "missing.pid")  # must not raise


def test_release_twice_is_safe(tmp_path):
    # the loop's finally and atexit both call cleanup()
    pidfile = tmp_path / "stock.pid"
    assert _common.claim_pidfile(pidfile)
    _common.release_pidfile(pidfile)
    _common.release_pidfile(pidfile)
    assert not pidfile.exists()


# A stand-in fetcher: a child of our own (alive and ours whatever PID the
# runner has) whose command line carries the fetcher mark, the way
# `python .../fetch-quotes-shioaji.py` does. NOT_A_FETCHER is the same child
# without it - the pid a pidfile names after Linux handed it to something else.
FETCHER = [sys.executable, "-c", "import time; time.sleep(30)", "fetch-quotes-stand-in"]
NOT_A_FETCHER = [sys.executable, "-c", "import time; time.sleep(30)"]
needs_proc = pytest.mark.skipif(not Path("/proc/self/cmdline").exists(), reason="needs /proc")


def test_claim_refuses_a_live_owner(tmp_path):
    owner = subprocess.Popen(FETCHER)
    try:
        pidfile = tmp_path / "stock.pid"
        pidfile.write_text(str(owner.pid), encoding="utf-8")
        assert not _common.claim_pidfile(pidfile)
    finally:
        owner.kill()
        owner.wait()


@needs_proc
def test_a_reused_pid_running_something_else_is_not_ours_and_is_left_alone(tmp_path):
    # the pidfile outlived a SIGKILLed fetcher and the pid now runs the
    # user's own program: it neither holds the pidfile nor gets signalled
    other = subprocess.Popen(NOT_A_FETCHER)
    try:
        pidfile = tmp_path / "stock.pid"
        pidfile.write_text(str(other.pid), encoding="utf-8")
        assert _common.claim_pidfile(pidfile)
        assert other.poll() is None
    finally:
        other.kill()
        other.wait()


@needs_proc
@pytest.mark.skipif(os.name == "nt", reason="POSIX job control")
def test_a_stopped_process_that_is_not_a_fetcher_is_never_killed():
    # a Ctrl-Z'd vim on a reused pid: the old code SIGKILLed any stopped owner
    other = subprocess.Popen(NOT_A_FETCHER)
    try:
        os.kill(other.pid, signal.SIGSTOP)
        wait_for_state(other.pid, "T")
        assert _common.pid_alive(other.pid) is False
        time.sleep(0.2)
        assert other.poll() is None
    finally:
        other.kill()
        other.wait()


@needs_proc
@pytest.mark.skipif(os.name == "nt", reason="POSIX job control")
def test_a_stopped_fetcher_is_killed_and_not_alive():
    owner = subprocess.Popen(FETCHER)
    try:
        os.kill(owner.pid, signal.SIGSTOP)
        wait_for_state(owner.pid, "T")
        assert _common.pid_alive(owner.pid) is False
        assert owner.wait(timeout=5) == -signal.SIGKILL
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait()


@needs_proc
@pytest.mark.skipif(os.name == "nt", reason="POSIX zombies")
def test_a_zombie_fetcher_is_not_alive():
    # exited but not yet reaped: kill -0 still answers, /proc says Z
    owner = subprocess.Popen([sys.executable, "-c", "pass", "fetch-quotes-stand-in"])
    try:
        wait_for_state(owner.pid, "Z")
        assert _common.pid_alive(owner.pid) is False
    finally:
        owner.wait()


def wait_for_state(pid, state, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == state:
            return
        time.sleep(0.02)
    raise AssertionError(f"pid {pid} never reached state {state}")


def test_claim_backs_off_while_another_claim_holds_the_lock(tmp_path):
    pidfile = tmp_path / "stock.pid"
    (tmp_path / "stock.pid.lock").write_text("4242", encoding="utf-8")
    assert _common.claim_pidfile(pidfile) is False
    assert not pidfile.exists()


def test_claim_takes_over_a_lock_left_by_a_dead_claimant(tmp_path):
    pidfile = tmp_path / "stock.pid"
    lock = tmp_path / "stock.pid.lock"
    lock.write_text("4242", encoding="utf-8")
    old = time.time() - _common.PIDFILE_LOCK_STALE_S - 5
    os.utime(lock, (old, old))
    assert _common.claim_pidfile(pidfile)
    assert pidfile.read_text(encoding="utf-8") == str(os.getpid())
    assert not lock.exists()
    assert list(tmp_path.iterdir()) == [pidfile]  # no lock or temp file left behind


CLAIMANT = """
import sys, time
sys.path.insert(0, {scripts!r})
import _common
from pathlib import Path
while time.time() < {start}:
    time.sleep(0.001)
print(_common.claim_pidfile(Path({pidfile!r})), flush=True)
time.sleep(3)
"""


def test_claimants_starting_together_get_exactly_one_owner(tmp_path):
    # two sessions spawning at the same moment used to both claim and log in
    pidfile = tmp_path / "stock.pid"
    code = CLAIMANT.format(scripts=str(SCRIPTS), start=time.time() + 1.0, pidfile=str(pidfile))
    procs = [
        subprocess.Popen([sys.executable, "-c", code, "fetch-quotes-stand-in"], stdout=subprocess.PIPE, text=True)
        for _ in range(8)
    ]
    try:
        answers = [p.stdout.readline().strip() for p in procs]
    finally:
        for p in procs:
            p.kill()
            p.wait()
    assert answers.count("True") == 1, answers


def test_claim_takes_over_an_owner_that_exited(tmp_path):
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text(str(gone.pid), encoding="utf-8")
    assert _common.claim_pidfile(pidfile)


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="needs a pid we may not signal")
def test_a_pid_we_may_not_signal_is_not_our_fetcher():
    # PID 1 belongs to root: kill -0 answers EPERM, which after a reboot is
    # exactly a stale pidfile naming someone else's process
    assert _common.pid_alive(1) is False


def test_claim_takes_over_a_dead_or_garbled_owner(tmp_path):
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text("not a pid", encoding="utf-8")
    assert _common.claim_pidfile(pidfile)
    assert pidfile.read_text(encoding="utf-8") == str(os.getpid())


@pytest.mark.parametrize("interval", [1, 2, 10, 30, 60])
def test_give_up_is_time_based_and_inside_the_band_staleness(interval):
    band_stale_s = 120
    ticks = _common.failed_ticks_limit(interval)
    assert ticks * interval >= _common.GIVE_UP_AFTER_S  # a blip never forces a re-login
    assert ticks * interval < band_stale_s + interval  # nor does a dead session outlive the band's patience by a tick


def test_give_up_limit_counts_ticks():
    assert _common.failed_ticks_limit(10) == 6
    assert _common.failed_ticks_limit(1) == 60
    assert _common.failed_ticks_limit(30) == 2
    assert _common.failed_ticks_limit(0) == 1  # --interval 0 writes once and exits


def test_load_env_keeps_exported_values_and_names_what_it_needs(tmp_path, monkeypatch):
    env = tmp_path / "x.env"
    env.write_text("TWSM_A=file\nTWSM_B=file\n", encoding="utf-8")
    monkeypatch.setenv("TWSM_A", "exported")
    monkeypatch.delenv("TWSM_B", raising=False)
    _common.load_env(env, "TWSM_A / TWSM_B")
    assert os.environ["TWSM_A"] == "exported"
    assert os.environ["TWSM_B"] == "file"
    with pytest.raises(SystemExit, match="TWSM_A / TWSM_B"):
        _common.load_env(tmp_path / "missing.env", "TWSM_A / TWSM_B")


def test_write_atomic_is_compact_and_leaves_no_tmp(tmp_path):
    out = tmp_path / "stock-quotes.json"
    assert _common.write_atomic(out, {"quotes": {"2330": {"name": "台積電", "bars": [1, 2]}}}) is True
    assert out.read_text(encoding="utf-8") == '{"quotes":{"2330":{"name":"台積電","bars":[1,2]}}}'
    assert not (tmp_path / "stock-quotes.json.tmp").exists()


def refuse_replace(monkeypatch, times):
    """Path.replace raising PermissionError (a Windows sharing violation) `times` times, then working."""
    real = Path.replace
    calls = {"n": 0}

    def replace(self, target):
        calls["n"] += 1
        if calls["n"] <= times:
            raise PermissionError(13, "The process cannot access the file")
        return real(self, target)

    monkeypatch.setattr(Path, "replace", replace)
    return calls


def test_write_atomic_retries_a_passing_sharing_violation(tmp_path, monkeypatch):
    out = tmp_path / "stock-quotes.json"
    calls = refuse_replace(monkeypatch, 2)  # an antivirus scan holding it for two tries
    assert _common.write_atomic(out, {"asOf": 1}, sleep=lambda s: None) is True
    assert calls["n"] == 3
    assert out.read_text(encoding="utf-8") == '{"asOf":1}'


def test_write_atomic_that_keeps_failing_logs_and_keeps_the_last_file(tmp_path, monkeypatch, capsys):
    # it used to raise out of the fetcher's loop, and a respawn is a fresh login
    out = tmp_path / "stock-quotes.json"
    out.write_text('{"asOf":0}', encoding="utf-8")
    refuse_replace(monkeypatch, 99)
    assert _common.write_atomic(out, {"asOf": 1}, sleep=lambda s: None) is False
    assert out.read_text(encoding="utf-8") == '{"asOf":0}'
    assert "寫入 stock-quotes.json 失敗" in capsys.readouterr().err


def test_write_atomic_survives_a_failed_temp_write(tmp_path):
    missing = tmp_path / "gone" / "stock-quotes.json"  # the runtime dir was removed under us
    assert _common.write_atomic(missing, {"asOf": 1}) is False


# --- log size cap ------------------------------------------------------------


def test_cap_log_leaves_a_small_log_alone(tmp_path):
    path = tmp_path / "stock-shioaji.log"
    path.write_bytes(b"one\ntwo\n")
    assert _common.cap_log(path, max_bytes=100, keep_bytes=4) is False
    assert path.read_bytes() == b"one\ntwo\n"


def test_cap_log_keeps_the_last_whole_lines(tmp_path):
    path = tmp_path / "stock-shioaji.log"
    lines = [f"line {i:03d}\n".encode() for i in range(100)]  # 9 bytes each
    path.write_bytes(b"".join(lines))
    assert _common.cap_log(path, max_bytes=500, keep_bytes=40) is True
    kept = path.read_bytes()
    assert kept == b"".join(lines[-4:])  # 40 bytes back lands mid-line; the partial one is dropped


def test_cap_log_keeps_an_appending_writer_at_the_new_end(tmp_path):
    # the band's shell holds the log open with O_APPEND (>>): its next line
    # must land after the kept tail, not at the old offset
    path = tmp_path / "stock-shioaji.log"
    path.write_bytes(b"x" * 90 + b"\nkept line\n")
    with open(path, "ab", buffering=0) as writer:
        assert _common.cap_log(path, max_bytes=50, keep_bytes=20) is True
        writer.write(b"next line\n")
    assert path.read_bytes() == b"kept line\nnext line\n"


def test_cap_log_ignores_a_missing_log(tmp_path):
    assert _common.cap_log(tmp_path / "missing.log") is False


# --- Windows: _windows_pid_alive against a stubbed kernel32 -------------------
# Runs on any OS: the kernel is a fake that answers the three questions the
# probe asks (can the pid be opened, has it exited, when was it created).

WAIT_OBJECT_0 = 0x0
WAIT_TIMEOUT = 0x102
FILETIME_EPOCH = 116444736000000000  # 1601-01-01 -> 1970-01-01, in 100 ns ticks


class FakeKernel32:
    """One process table entry: `pid` -> (created epoch seconds, exited?)."""

    def __init__(self, processes, openable=True):
        self.processes = processes
        self.openable = openable
        self.closed = []

    def OpenProcess(self, access, inherit, pid):
        if not self.openable or pid not in self.processes:
            return 0  # ERROR_INVALID_PARAMETER / ERROR_ACCESS_DENIED: no handle either way
        return 1000 + pid

    def WaitForSingleObject(self, handle, ms):
        _, exited = self.processes[handle - 1000]
        return WAIT_OBJECT_0 if exited else WAIT_TIMEOUT

    def GetProcessTimes(self, handle, created, exited, kernel, user):
        ticks = int(self.processes[handle - 1000][0] * 10_000_000) + FILETIME_EPOCH
        created._obj.dwLowDateTime = ticks & 0xFFFFFFFF
        created._obj.dwHighDateTime = ticks >> 32
        return 1

    def CloseHandle(self, handle):
        self.closed.append(handle)
        return 1


PIDFILE_WRITTEN = 1_790_000_000.0  # the pidfile's mtime


def test_windows_owner_running_since_before_its_pidfile_is_alive():
    k = FakeKernel32({42: (PIDFILE_WRITTEN - 5, False)})
    assert _common._windows_pid_alive(42, PIDFILE_WRITTEN, kernel32=k) is True
    assert k.closed == [1042]


def test_windows_pid_reused_after_the_pidfile_was_written_is_not_ours():
    # a reboot or hard kill left the pidfile; Windows handed 42 to svchost later
    k = FakeKernel32({42: (PIDFILE_WRITTEN + 3600, False)})
    assert _common._windows_pid_alive(42, PIDFILE_WRITTEN, kernel32=k) is False
    assert k.closed == [1042]


def test_windows_exited_owner_is_dead():
    k = FakeKernel32({42: (PIDFILE_WRITTEN - 5, True)})
    assert _common._windows_pid_alive(42, PIDFILE_WRITTEN, kernel32=k) is False


def test_windows_pid_that_cannot_be_opened_is_not_ours():
    # gone, or another user's / a protected process: our own fetcher always opens
    assert _common._windows_pid_alive(42, PIDFILE_WRITTEN, kernel32=FakeKernel32({})) is False
    k = FakeKernel32({42: (PIDFILE_WRITTEN - 5, False)}, openable=False)
    assert _common._windows_pid_alive(42, PIDFILE_WRITTEN, kernel32=k) is False


def test_windows_without_a_pidfile_time_only_asks_whether_it_runs():
    k = FakeKernel32({42: (PIDFILE_WRITTEN + 3600, False)})
    assert _common._windows_pid_alive(42, None, kernel32=k) is True


def test_claim_passes_the_pidfile_mtime_to_pid_alive(tmp_path, monkeypatch):
    seen = {}

    def fake_alive(pid, since=None):
        seen["args"] = (pid, since)
        return True

    monkeypatch.setattr(_common, "pid_alive", fake_alive)
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text("4242", encoding="utf-8")
    os.utime(pidfile, (PIDFILE_WRITTEN, PIDFILE_WRITTEN))
    assert _common.claim_pidfile(pidfile) is False
    assert seen["args"] == (4242, PIDFILE_WRITTEN)


# --- Windows: the same probe against the real kernel ---------------------------
# The two claim tests above (a live child, an exited one) already go through
# the real _windows_pid_alive on Windows; these add the cases only the real
# kernel can answer. CI runs them on windows-latest.
on_windows = pytest.mark.skipif(os.name != "nt", reason="needs the real kernel32")


@on_windows
def test_windows_real_kernel_reused_pid_reads_as_not_ours(tmp_path):
    # a running process created AFTER the pidfile was written: the pidfile's
    # pid was handed to someone else, so the pidfile is stale
    owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        pidfile = tmp_path / "stock.pid"
        pidfile.write_text(str(owner.pid), encoding="utf-8")
        an_hour_ago = pidfile.stat().st_mtime - 3600
        os.utime(pidfile, (an_hour_ago, an_hour_ago))
        assert _common.pid_alive(owner.pid, an_hour_ago) is False
        assert _common.claim_pidfile(pidfile) is True
    finally:
        owner.kill()
        owner.wait()


@on_windows
def test_windows_real_kernel_running_owner_is_alive():
    owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert _common.pid_alive(owner.pid) is True
        assert _common.pid_alive(owner.pid, time.time() + 1) is True
    finally:
        owner.kill()
        owner.wait()


@on_windows
def test_windows_real_kernel_pid_that_does_not_exist_is_not_ours():
    assert _common.pid_alive(0x7FFFFFF0) is False


@pytest.mark.parametrize("script", ["fetch-quotes-capital.py", "fetch-quotes-shioaji.py", "order-shioaji.py"])
def test_scripts_run_as_scripts_on_a_cp1252_pipe(script, tmp_path):
    # The band runs each script as `python <path>` from the project's cwd, so
    # `_common` must import from the script's own folder. And an English
    # Windows hands a pipe or a log file the cp1252 codepage, which has no
    # CJK: --help (all Chinese) used to die with UnicodeEncodeError there.
    env = {**os.environ, "PYTHONIOENCODING": "cp1252"}
    env.pop("PYTHONPATH", None)
    done = subprocess.run(
        [sys.executable, str(SCRIPTS / script), "--help"],
        capture_output=True, cwd=tmp_path, env=env,
    )
    assert done.returncode == 0, (script, done.stderr.decode("utf-8", "replace"))
    out = done.stdout.decode("utf-8")
    assert out.startswith("usage:") and ("永豐" in out or "群益" in out), out[:200]


def test_log_lines_carry_the_date_and_time(capsys):
    _common.log("群益 已離線")
    err = capsys.readouterr().err
    assert re.fullmatch(r"\d\d-\d\d \d\d:\d\d:\d\d 群益 已離線\n", err), err
