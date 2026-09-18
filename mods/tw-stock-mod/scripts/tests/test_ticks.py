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
