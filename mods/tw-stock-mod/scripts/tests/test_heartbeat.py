"""
The heartbeat the band writes for fetch-quotes-shioaji.py (issue #5): a JSON
`{"ts": <ms>, "markets": [...]}` naming which markets the fetcher should work
this tick, with the pre-T4 bare-number form still accepted as "every market"
for one release. Pure parser in, (stale, wanted markets) out - no clock
patching beyond passing `now_ms` in.
"""
import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "fetch-quotes-shioaji.py"
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_hb", MODULE_PATH)
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)

NOW_MS = 1_789_696_800_000  # 2026-09-18 10:00 台北, an arbitrary fixed instant
FRESH = NOW_MS - 10_000
STALE = NOW_MS - 90_001  # one ms past HEARTBEAT_MAX_AGE_MS (90 s)


def test_legacy_bare_number_means_every_market():
    stale, wanted = fetcher.parse_heartbeat(str(FRESH), NOW_MS)
    assert stale is False
    assert wanted == frozenset({"tw", "tf"})


def test_legacy_bare_number_with_whitespace_and_float():
    stale, wanted = fetcher.parse_heartbeat(f" {FRESH}.0\n", NOW_MS)
    assert stale is False
    assert wanted == frozenset({"tw", "tf"})


def test_legacy_bare_number_stale():
    stale, _ = fetcher.parse_heartbeat(str(STALE), NOW_MS)
    assert stale is True


def test_json_lists_only_the_named_markets():
    stale, wanted = fetcher.parse_heartbeat('{"ts": %d, "markets": ["tf"]}' % FRESH, NOW_MS)
    assert stale is False
    assert wanted == frozenset({"tf"})


def test_json_both_markets():
    _, wanted = fetcher.parse_heartbeat('{"ts": %d, "markets": ["tw", "tf"]}' % FRESH, NOW_MS)
    assert wanted == frozenset({"tw", "tf"})


def test_json_unknown_market_is_ignored():
    _, wanted = fetcher.parse_heartbeat('{"ts": %d, "markets": ["tw", "us", 3]}' % FRESH, NOW_MS)
    assert wanted == frozenset({"tw"})


def test_json_stale_exits_whatever_it_names():
    stale, wanted = fetcher.parse_heartbeat('{"ts": %d, "markets": ["tw", "tf"]}' % STALE, NOW_MS)
    assert stale is True


def test_json_exactly_at_the_window_edge_is_fresh():
    stale, _ = fetcher.parse_heartbeat('{"ts": %d, "markets": ["tf"]}' % (NOW_MS - 90_000), NOW_MS)
    assert stale is False


def test_json_without_ts_is_stale():
    stale, _ = fetcher.parse_heartbeat('{"markets": ["tf"]}', NOW_MS)
    assert stale is True


def test_json_without_markets_wants_nothing_but_is_not_stale():
    # a fresh heartbeat that names no market: the band is alive but wants no work
    stale, wanted = fetcher.parse_heartbeat('{"ts": %d}' % FRESH, NOW_MS)
    assert stale is False
    assert wanted == frozenset()


def test_garbage_is_stale():
    for text in ("", "   ", "not a number", "[1, 2]", "{", "null"):
        stale, wanted = fetcher.parse_heartbeat(text, NOW_MS)
        assert stale is True, text
        assert wanted == frozenset(), text


def test_read_heartbeat_missing_file_is_stale(tmp_path):
    stale, wanted = fetcher.read_heartbeat(tmp_path / "nope.heartbeat")
    assert stale is True
    assert wanted == frozenset()


def test_read_heartbeat_reads_the_file(tmp_path):
    import time

    path = tmp_path / "stock-band.heartbeat"
    path.write_text('{"ts": %d, "markets": ["tf"]}' % int(time.time() * 1000), encoding="utf-8")
    stale, wanted = fetcher.read_heartbeat(path)
    assert stale is False
    assert wanted == frozenset({"tf"})
