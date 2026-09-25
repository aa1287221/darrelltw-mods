"""
Tick overlay of fetch-quotes-shioaji.py (issue #10): the pure functions the
main loop drains a tick queue through - apply_tick, update_trailing_bar,
should_write - with canned SDK-shaped ticks, no login, no threads.

Tick `datetime` is Taipei wall-clock (verified 2026-09-18 - no 8-hour quirk,
unlike snapshot/kbars), so every expected epoch here is the same instant
written as UTC by stdlib datetime, independent of the production conversion.
"""
import datetime as dt
import importlib.util
import queue
import sys
from decimal import Decimal
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "fetch-quotes-shioaji.py"
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_ticks", MODULE_PATH)
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)


def utc_ms(year, month, day, hour, minute, second=0):
    return int(dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc).timestamp() * 1000)


# ---------------------------------------------------------------------------
# write throttle: at most one write per second, and only when dirty
# ---------------------------------------------------------------------------

def test_ten_dirty_ticks_in_one_second_produce_one_write():
    last_write = 0
    writes = 0
    for now in range(100, 1100, 100):  # ten ticks, 0.1 s apart, inside one second
        if fetcher.should_write(last_write, now, dirty=True):
            writes += 1
            last_write = now
    assert writes == 1


def test_a_clean_second_produces_no_write():
    assert fetcher.should_write(0, 5_000, dirty=False) is False


def test_dirty_but_too_soon_waits():
    assert fetcher.should_write(1_000, 1_999, dirty=True) is False
    assert fetcher.should_write(1_000, 2_000, dirty=True) is True


# ---------------------------------------------------------------------------
# apply_tick: one tick -> the requested row(s) it resolves to
# ---------------------------------------------------------------------------

T0 = utc_ms(2026, 9, 18, 13, 0, 0)  # 21:00:00 Taipei, the snapshot's dataAt


def taipei(hour, minute, second):
    """A tick's `datetime` as the SDK hands it over: naive Taipei wall-clock."""
    return dt.datetime(2026, 9, 18, hour, minute, second)


def make_tick(code, at, close, simtrade=False, market="tf"):
    return fetcher.TickEvent(
        market=market, code=code, at=at, close=close,
        price_chg=Decimal("132"), pct_chg=Decimal("0.28"), total_volume=100, simtrade=simtrade,
    )


def make_overlay():
    return {
        "TXFR1": {"price": 47557.0, "prevClose": 47428.0, "name": "臺股期貨 近月", "resolved": "TXFJ6", "dataAt": T0},
        "SRFJ6": {"price": 110.35, "prevClose": 108.3, "name": "小型元大台灣50ETF期貨 202610", "dataAt": T0},
    }


CODE_MAP = {"TXFJ6": ["TXFR1"], "SRFJ6": ["SRFJ6"]}


def test_tick_for_the_resolved_month_updates_the_alias_row():
    rows = make_overlay()

    changed = fetcher.apply_tick(rows, make_tick("TXFJ6", taipei(21, 0, 5), Decimal("47560")), CODE_MAP)

    assert changed == ["TXFR1"]
    assert rows["TXFR1"]["price"] == 47560.0
    assert type(rows["TXFR1"]["price"]) is float  # Decimal must not reach json.dumps
    assert rows["TXFR1"]["dataAt"] == utc_ms(2026, 9, 18, 13, 0, 5)  # Taipei 21:00:05, no 8 h subtraction
    assert rows["TXFR1"]["prevClose"] == 47428.0
    assert rows["SRFJ6"] == make_overlay()["SRFJ6"]


def test_one_month_can_update_two_requested_rows():
    rows = make_overlay()
    rows["TXFJ6"] = {"price": 47557.0, "prevClose": 47428.0, "name": "臺股期貨 202610", "dataAt": T0}

    changed = fetcher.apply_tick(rows, make_tick("TXFJ6", taipei(21, 0, 5), Decimal("47561")), {"TXFJ6": ["TXFR1", "TXFJ6"]})

    assert sorted(changed) == ["TXFJ6", "TXFR1"]
    assert rows["TXFR1"]["price"] == 47561.0
    assert rows["TXFJ6"]["price"] == 47561.0


def test_simtrade_tick_changes_nothing():
    rows = make_overlay()

    changed = fetcher.apply_tick(rows, make_tick("TXFJ6", taipei(21, 0, 5), Decimal("47999"), simtrade=True), CODE_MAP)

    assert changed == []
    assert rows == make_overlay()


def test_tick_older_than_the_row_changes_nothing():
    rows = make_overlay()

    changed = fetcher.apply_tick(rows, make_tick("TXFJ6", taipei(20, 59, 59), Decimal("47999")), CODE_MAP)

    assert changed == []
    assert rows == make_overlay()


def test_tick_at_exactly_the_row_time_still_applies():
    rows = make_overlay()

    changed = fetcher.apply_tick(rows, make_tick("TXFJ6", taipei(21, 0, 0), Decimal("47558")), CODE_MAP)

    assert changed == ["TXFR1"]
    assert rows["TXFR1"]["price"] == 47558.0


def test_tick_for_an_unknown_code_is_dropped():
    rows = make_overlay()

    changed = fetcher.apply_tick(rows, make_tick("MXFJ6", taipei(21, 0, 5), Decimal("47560")), CODE_MAP)

    assert changed == []
    assert rows == make_overlay()


def test_stock_tick_uses_the_same_path():
    rows = {"2330": {"price": 1000.0, "prevClose": 990.0, "name": "台積電", "dataAt": T0}}

    changed = fetcher.apply_tick(rows, make_tick("2330", taipei(21, 0, 5), Decimal("1005"), market="tw"), {"2330": ["2330"]})

    assert changed == ["2330"]
    assert rows["2330"]["price"] == 1005.0


# ---------------------------------------------------------------------------
# update_trailing_bar: ticks advance the live 5-minute bar between kbars
# refreshes; the kbars cache entry carries the bars AND the bucket they end on
# ---------------------------------------------------------------------------

BUCKET_2100 = utc_ms(2026, 9, 18, 13, 0)  # Taipei 21:00 bucket
BUCKET_2105 = utc_ms(2026, 9, 18, 13, 5)


def make_entry(bars, bucket):
    return {"at": 0.0, "bars": bars, "bucket": bucket}


def test_tick_inside_the_bucket_moves_high_low_close_not_open():
    # v (index 4) is left alone by a tick - see update_trailing_bar's
    # docstring on why there is no reliable per-trade volume to add here
    entry = make_entry([[100.0, 105.0, 98.0, 104.0, 12.0, BUCKET_2100]], BUCKET_2100)

    assert fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 13, 2, 10), 106.0) is True
    assert entry["bars"] == [[100.0, 106.0, 98.0, 106.0, 12.0, BUCKET_2100]]

    fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 13, 3, 0), 97.0)
    assert entry["bars"] == [[100.0, 106.0, 97.0, 97.0, 12.0, BUCKET_2100]]
    assert entry["bucket"] == BUCKET_2100


def test_tick_in_a_new_bucket_opens_a_bar():
    entry = make_entry([[100.0, 105.0, 98.0, 104.0, 12.0, BUCKET_2100]], BUCKET_2100)

    fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 13, 5, 0), 104.5)

    # a freshly opened bar carries v=0.0 - the next kbars refresh fills the real volume
    assert entry["bars"] == [
        [100.0, 105.0, 98.0, 104.0, 12.0, BUCKET_2100],
        [104.5, 104.5, 104.5, 104.5, 0.0, BUCKET_2105],
    ]
    assert entry["bucket"] == BUCKET_2105


def test_bar_count_is_capped_at_120():
    bars = [[float(i), float(i), float(i), float(i), 0.0, 0] for i in range(120)]
    entry = make_entry(bars, BUCKET_2100)

    fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 13, 5, 0), 999.0)

    assert len(entry["bars"]) == 120
    assert entry["bars"][0] == [1.0, 1.0, 1.0, 1.0, 0.0, 0]  # the oldest fell off
    assert entry["bars"][-1] == [999.0, 999.0, 999.0, 999.0, 0.0, BUCKET_2105]


def test_tick_from_an_older_bucket_changes_nothing():
    entry = make_entry([[100.0, 105.0, 98.0, 104.0, 12.0, BUCKET_2100]], BUCKET_2100)

    assert fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 12, 59, 59), 50.0) is False
    assert entry["bars"] == [[100.0, 105.0, 98.0, 104.0, 12.0, BUCKET_2100]]


def test_empty_bars_open_a_bar():
    entry = make_entry([], 0)

    fetcher.update_trailing_bar(entry, utc_ms(2026, 9, 18, 13, 2, 0), 104.5)

    assert entry["bars"] == [[104.5, 104.5, 104.5, 104.5, 0.0, BUCKET_2100]]
    assert entry["bucket"] == BUCKET_2100


# ---------------------------------------------------------------------------
# update_trailing_bar at other widths, and advance_trailing_bars folding one
# tick into every timeframe's entry at once (issue #12 path: "a 22:31 tick
# lands in the 22:30 5-min bar, the 22:30 15-min bar, the 22:00 60-min bar,
# and opens a new 1-min bar")
# ---------------------------------------------------------------------------

TICK_2231 = utc_ms(2026, 9, 18, 14, 31)  # Taipei 22:31 -> UTC 14:31 (no offset on tick datetimes)


def make_by_entry() -> dict:
    """One code's kbars_cache["by"]: each timeframe already has a bar
    covering the bucket just before TICK_2231, so the tick's job is to
    extend three of them and open a new one in the fourth (1-min)."""
    return {
        1: {"bars": [[100.0, 100.0, 100.0, 100.0, 1.0, utc_ms(2026, 9, 18, 14, 30)]], "bucket": utc_ms(2026, 9, 18, 14, 30)},
        5: {"bars": [[100.0, 100.0, 100.0, 100.0, 5.0, utc_ms(2026, 9, 18, 14, 30)]], "bucket": utc_ms(2026, 9, 18, 14, 30)},
        15: {"bars": [[100.0, 100.0, 100.0, 100.0, 15.0, utc_ms(2026, 9, 18, 14, 30)]], "bucket": utc_ms(2026, 9, 18, 14, 30)},
        60: {"bars": [[100.0, 100.0, 100.0, 100.0, 60.0, utc_ms(2026, 9, 18, 14, 0)]], "bucket": utc_ms(2026, 9, 18, 14, 0)},
    }


def test_advance_trailing_bars_opens_new_1min_extends_the_rest():
    entry = {"at": 0.0, "by": make_by_entry()}

    fetcher.advance_trailing_bars(entry, TICK_2231, 108.0)

    # 1-min: a new bucket (Taipei 22:31) was opened
    assert entry["by"][1]["bucket"] == TICK_2231
    assert len(entry["by"][1]["bars"]) == 2
    assert entry["by"][1]["bars"][-1] == [108.0, 108.0, 108.0, 108.0, 0.0, TICK_2231]
    # 5-min and 15-min: the tick is still inside the Taipei 22:30 bucket - extended, not opened
    assert entry["by"][5]["bucket"] == utc_ms(2026, 9, 18, 14, 30)
    assert entry["by"][5]["bars"] == [[100.0, 108.0, 100.0, 108.0, 5.0, utc_ms(2026, 9, 18, 14, 30)]]
    assert entry["by"][15]["bucket"] == utc_ms(2026, 9, 18, 14, 30)
    assert entry["by"][15]["bars"] == [[100.0, 108.0, 100.0, 108.0, 15.0, utc_ms(2026, 9, 18, 14, 30)]]
    # 60-min: still inside the Taipei 22:00 bucket
    assert entry["by"][60]["bucket"] == utc_ms(2026, 9, 18, 14, 0)
    assert entry["by"][60]["bars"] == [[100.0, 108.0, 100.0, 108.0, 60.0, utc_ms(2026, 9, 18, 14, 0)]]


# --- the kbars cache carries the bucket, and tick updates survive a snapshot --

import types


def raw_ns(year, month, day, hour, minute):
    """kbars/snapshot ts as the SDK stamps it: the Taipei wall-clock digits read as UTC."""
    return utc_ms(year, month, day, hour, minute) * 1_000_000


KBARS = types.SimpleNamespace(
    # Taipei 21:00, 21:01, 21:06 -> buckets 21:00 and 21:05
    ts=[raw_ns(2026, 9, 18, 21, 0), raw_ns(2026, 9, 18, 21, 1), raw_ns(2026, 9, 18, 21, 6)],
    Open=[100, 101, 110], High=[102, 103, 111], Low=[99, 100, 109], Close=[101, 102, 110], Volume=[1, 1, 1],
)
TXF = types.SimpleNamespace(code="TXFJ6", multiplier=200, decimal_locator=0, reference=17000.0, name="臺股期貨 202610", target_code=None)


class FakeApi:
    def __init__(self):
        self.kbars_calls = 0

    def snapshots(self, contracts):
        return [types.SimpleNamespace(code=c.code, close=17010.0, ts=raw_ns(2026, 9, 18, 21, 6)) for c in contracts]

    def kbars(self, contract, start=None, end=None):
        self.kbars_calls += 1
        return KBARS


def test_kbars_refresh_records_the_trailing_bucket():
    cache = {}

    fetcher.refresh_futures_kbars(FakeApi(), TXF, "TXFJ6", "2026-09-17", "2026-09-18", cache, 0.0)

    five_min = cache["TXFJ6"]["by"][5]
    assert five_min["bars"] == [
        [100.0, 103.0, 99.0, 102.0, 2.0, BUCKET_2100],
        [110.0, 111.0, 109.0, 110.0, 1.0, BUCKET_2105],
    ]
    assert five_min["bucket"] == BUCKET_2105
    # timeframe 1 is the raw rows, unresampled - three rows in, three bars out
    assert len(cache["TXFJ6"]["by"][1]["bars"]) == 3


def test_tick_updated_bars_survive_the_next_snapshot_inside_the_kbars_window():
    api = FakeApi()
    cache = {}
    clock = lambda: 60.0  # noqa: E731 - inside the 5-minute window either call
    fetcher.fetch_futures_rows(api, {"TXFJ6": TXF}, ["TXFJ6"], "2026-09-18", kbars_cache=cache, now=clock)

    fetcher.update_trailing_bar(cache["TXFJ6"]["by"][5], utc_ms(2026, 9, 18, 13, 7, 0), 115.0)
    rows = fetcher.fetch_futures_rows(api, {"TXFJ6": TXF}, ["TXFJ6"], "2026-09-18", kbars_cache=cache, now=clock)

    assert api.kbars_calls == 1
    assert rows["TXFJ6"]["barsBy"]["5"][-1] == [110.0, 115.0, 109.0, 115.0, 1.0, BUCKET_2105]
    # barsBy["5"] IS the cache list, not a copy - a tick that mutated the
    # cache is visible through the file's payload
    assert rows["TXFJ6"]["barsBy"]["5"] is cache["TXFJ6"]["by"][5]["bars"]


# ---------------------------------------------------------------------------
# per-row dataAt: the stale-tick guard's state, written into the file so a
# reader can see which row moved (jq .quotes.TXFR1.dataAt)
# ---------------------------------------------------------------------------

def test_futures_payload_stamps_each_row_with_its_own_data_at():
    rows = {
        "TXFR1": {"price": 17010.0, "prevClose": 17000.0, "name": "n", "multiplier": 200, "decimals": 0, "bars": [], "ts": utc_ms(2026, 9, 18, 2, 5)},
        "SRFJ6": {"price": 109.5, "prevClose": 108.3, "name": "n", "multiplier": 1000, "decimals": 2, "bars": [], "ts": utc_ms(2026, 9, 18, 2, 0)},
    }

    payload = fetcher.build_futures_payload(rows)

    assert payload["quotes"]["TXFR1"]["dataAt"] == utc_ms(2026, 9, 18, 2, 5)
    assert payload["quotes"]["SRFJ6"]["dataAt"] == utc_ms(2026, 9, 18, 2, 0)
    assert payload["dataAt"] == utc_ms(2026, 9, 18, 2, 5)


class FakeStockApi:
    def snapshots(self, contracts):
        return [types.SimpleNamespace(code=c.code, close=1005.0, change_price=15.0, ts=raw_ns(2026, 9, 18, 10, 30)) for c in contracts]


def test_stock_payload_stamps_each_row_with_its_own_data_at():
    contract = types.SimpleNamespace(code="2330", reference=990.0, name="台積電")

    payload = fetcher.build_payload(FakeStockApi(), {"2330": contract}, [], {})

    assert payload["quotes"]["2330"]["dataAt"] == utc_ms(2026, 9, 18, 2, 30)  # Taipei 10:30 corrected
    assert payload["dataAt"] == utc_ms(2026, 9, 18, 2, 30)


# ---------------------------------------------------------------------------
# QuotesOverlay.absorb: a snapshot replaces the overlay, except a row whose
# tick is newer than the snapshot's own stamp keeps the tick
# ---------------------------------------------------------------------------

def snapshot_payload(price, data_at):
    return {"asOf": 1, "dataAt": data_at, "market": "tf", "source": "永豐",
            "quotes": {"TXFR1": {"price": price, "prevClose": 47428.0, "name": "n", "dataAt": data_at}}}


def test_absorb_keeps_a_tick_newer_than_the_snapshot():
    overlay = fetcher.QuotesOverlay(Path("/nonexistent/futures-quotes.json"))
    overlay.absorb(snapshot_payload(47557.0, T0), now_ms=T0)
    fetcher.apply_tick(overlay.rows, make_tick("TXFJ6", taipei(21, 0, 5), Decimal("47560")), CODE_MAP)

    written = overlay.absorb(snapshot_payload(47550.0, T0 + 3_000), now_ms=T0 + 6_000)  # snapshot stamped before the tick

    assert written["quotes"]["TXFR1"]["price"] == 47560.0
    assert written["quotes"]["TXFR1"]["dataAt"] == T0 + 5_000
    assert written["dataAt"] == T0 + 5_000
    assert overlay.dirty is False


def test_absorb_takes_a_newer_snapshot():
    overlay = fetcher.QuotesOverlay(Path("/nonexistent/futures-quotes.json"))
    overlay.absorb(snapshot_payload(47557.0, T0), now_ms=T0)
    fetcher.apply_tick(overlay.rows, make_tick("TXFJ6", taipei(21, 0, 5), Decimal("47560")), CODE_MAP)

    written = overlay.absorb(snapshot_payload(47550.0, T0 + 8_000), now_ms=T0 + 9_000)

    assert written["quotes"]["TXFR1"]["price"] == 47550.0
    assert written["dataAt"] == T0 + 8_000


def test_overlay_payload_after_ticks_advances_data_at_and_as_of():
    overlay = fetcher.QuotesOverlay(Path("/nonexistent/futures-quotes.json"))
    overlay.absorb(snapshot_payload(47557.0, T0), now_ms=T0)
    fetcher.apply_tick(overlay.rows, make_tick("TXFJ6", taipei(21, 0, 7), Decimal("47570")), CODE_MAP)

    payload = overlay.payload(now_ms=T0 + 7_500)

    assert payload["asOf"] == T0 + 7_500
    assert payload["dataAt"] == T0 + 7_000
    assert payload["quotes"]["TXFR1"]["price"] == 47570.0
    assert payload["market"] == "tf" and payload["source"] == "永豐"


# ---------------------------------------------------------------------------
# drain_ticks: the main loop's wiring from the tick queue to BOTH the
# overlay row and every timeframe's trailing bar - untested until issue #12,
# and the one place that would KeyError at runtime if the kbars-cache shape
# changed but this call site didn't follow
# ---------------------------------------------------------------------------

def test_drain_ticks_advances_every_timeframe_of_the_tick_code():
    tick_queue: queue.Queue = queue.Queue()
    tick_queue.put(make_tick("TXFJ6", taipei(22, 31, 0), Decimal("108")))
    overlays = {"tf": fetcher.QuotesOverlay(Path("/nonexistent/futures-quotes.json"))}
    overlays["tf"].absorb(
        {"asOf": 1, "dataAt": T0, "market": "tf", "source": "永豐", "quotes": {"TXFR1": {"price": 100.0, "prevClose": 99.0, "name": "n", "dataAt": T0}}},
        now_ms=T0,
    )
    # kbars_cache is keyed by the REQUESTED code (TXFR1), same as changed's
    # entries - apply_tick resolves the tick's resolved-month code (TXFJ6)
    # to the requested codes it drives, and drain_ticks looks the cache up
    # by those, not by the tick's own code
    kbars_cache = {"TXFR1": {"at": 0.0, "by": make_by_entry()}}
    stats = fetcher.new_tick_stats()

    fetcher.drain_ticks(tick_queue, overlays, {"tf": CODE_MAP}, kbars_cache, stats)

    assert overlays["tf"].rows["TXFR1"]["price"] == 108.0
    by = kbars_cache["TXFR1"]["by"]
    assert by[1]["bucket"] == TICK_2231 and len(by[1]["bars"]) == 2
    assert by[5]["bars"][-1][:4] == [100.0, 108.0, 100.0, 108.0]
    assert by[15]["bars"][-1][:4] == [100.0, 108.0, 100.0, 108.0]
    assert by[60]["bars"][-1][:4] == [100.0, 108.0, 100.0, 108.0]
