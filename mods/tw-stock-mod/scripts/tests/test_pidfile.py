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
import subprocess
import sys
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
        "read_env_file", "load_env", "read_watchlist", "write_atomic", "field",
    ],
    "fetch-quotes-capital.py": [
        "claim_pidfile", "release_pidfile", "failed_ticks_limit", "runtime_dir", "user_home",
        "read_env_file", "load_env", "read_watchlist", "write_atomic",
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


def test_claim_refuses_a_live_owner(tmp_path):
    # a child of our own, so it is alive and ours whatever PID the runner has
    owner = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        pidfile = tmp_path / "stock.pid"
        pidfile.write_text(str(owner.pid), encoding="utf-8")
        assert not _common.claim_pidfile(pidfile)
    finally:
        owner.kill()
        owner.wait()


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
    _common.write_atomic(out, {"quotes": {"2330": {"name": "台積電", "bars": [1, 2]}}})
    assert out.read_text(encoding="utf-8") == '{"quotes":{"2330":{"name":"台積電","bars":[1,2]}}}'
    assert not (tmp_path / "stock-quotes.json.tmp").exists()


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
