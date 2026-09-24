"""
release_pidfile in both fetchers: the pidfile goes away on exit only while it
still names this process, so a successor that already claimed it (after this
one was judged dead) keeps its claim. Also pins failed_ticks_limit(): the
give-up lands inside the band's 120 s staleness window at any --interval.
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


FETCHERS = [
    load("fetch-quotes-shioaji.py", "fetch_quotes_shioaji_pid"),
    load("fetch-quotes-capital.py", "fetch_quotes_capital_pid"),
]


@pytest.fixture(params=FETCHERS, ids=["shioaji", "capital"])
def fetcher(request):
    return request.param


def test_release_removes_our_own_pidfile(fetcher, tmp_path):
    pidfile = tmp_path / "stock.pid"
    assert fetcher.claim_pidfile(pidfile)
    fetcher.release_pidfile(pidfile)
    assert not pidfile.exists()


def test_release_leaves_a_successors_pidfile(fetcher, tmp_path):
    pidfile = tmp_path / "stock.pid"
    pidfile.write_text(str(os.getpid() + 1), encoding="utf-8")
    fetcher.release_pidfile(pidfile)
    assert pidfile.read_text(encoding="utf-8") == str(os.getpid() + 1)


def test_release_is_a_noop_when_already_gone(fetcher, tmp_path):
    fetcher.release_pidfile(tmp_path / "missing.pid")  # must not raise


def test_release_twice_is_safe(fetcher, tmp_path):
    # the loop's finally and atexit both call cleanup()
    pidfile = tmp_path / "stock.pid"
    assert fetcher.claim_pidfile(pidfile)
    fetcher.release_pidfile(pidfile)
    fetcher.release_pidfile(pidfile)
    assert not pidfile.exists()


@pytest.mark.parametrize("interval", [1, 2, 10, 30, 60])
def test_give_up_is_time_based_and_inside_the_band_staleness(fetcher, interval):
    band_stale_s = 120
    ticks = fetcher.failed_ticks_limit(interval)
    assert ticks * interval >= fetcher.GIVE_UP_AFTER_S  # a blip never forces a re-login
    assert ticks * interval < band_stale_s + interval  # nor does a dead session outlive the band's patience by a tick


def test_give_up_limit_counts_ticks(fetcher):
    assert fetcher.failed_ticks_limit(10) == 6
    assert fetcher.failed_ticks_limit(1) == 60
    assert fetcher.failed_ticks_limit(30) == 2
    assert fetcher.failed_ticks_limit(0) == 1  # --interval 0 writes once and exits
