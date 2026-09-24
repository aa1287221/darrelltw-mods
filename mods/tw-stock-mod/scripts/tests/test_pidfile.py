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
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text(str(os.getppid()), encoding="utf-8")  # the test runner's parent is alive
    assert not _common.claim_pidfile(pidfile)


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
