"""
How many broker calls one fetch-quotes-shioaji.py tick costs. 永豐 meters API
usage, and every tick used to pay separately for the stock snapshots, the
index snapshots and both position lists:

  - build_payload prices the watchlist and the footer indices with ONE
    api.snapshots call, split back apart afterwards (two calls only if an
    index code ever collided with a stock code);
  - the position lists are refreshed on their own slower clock
    (PositionsClock), not every tick - positions change when the user trades,
    not every 10 s.
"""
import importlib.util
import sys
import types
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "fetch-quotes-shioaji.py"
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_calls", MODULE_PATH)
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)


def contract(code, name, reference):
    return types.SimpleNamespace(code=code, name=name, reference=reference)


def snap(code, close, change=0.0, ts=1_790_000_000_000_000_000):
    return types.SimpleNamespace(code=code, close=close, change_price=change, ts=ts)


class CountingApi:
    def __init__(self, closes):
        self.closes = closes
        self.calls = []

    def snapshots(self, contracts):
        self.calls.append([c.code for c in contracts])
        return [snap(c.code, self.closes[c.code]) for c in contracts if c.code in self.closes]


STOCKS = {"2330": contract("2330", "台積電", 1000.0), "2317": contract("2317", "鴻海", 150.0)}
INDEXES = [("TAIEX", contract("001", "加權指數", 20000.0)), ("TPEx", contract("101", "櫃買指數", 250.0))]


def test_watchlist_and_indices_cost_one_snapshot_call():
    api = CountingApi({"2330": 1010.0, "2317": 151.5, "001": 20100.0, "101": 252.5})
    payload = fetcher.build_payload(api, STOCKS, INDEXES, {})
    assert len(api.calls) == 1
    assert sorted(api.calls[0]) == ["001", "101", "2317", "2330"]
    assert sorted(payload["quotes"]) == ["2317", "2330"]  # an index never lands in the table
    assert [row["name"] for row in payload["indices"]] == ["TAIEX", "TPEx"]
    assert payload["indices"][0]["value"] == 20100.0
    assert payload["indices"][0]["change"] == 100.0
    assert payload["index"] == {"value": 20100.0, "change": 100.0, "pct": 0.5}


def test_an_index_code_colliding_with_a_stock_code_falls_back_to_two_calls():
    stocks = {**STOCKS, "001": contract("001", "a stock that shares the code", 10.0)}
    api = CountingApi({"2330": 1010.0, "2317": 151.5, "001": 20100.0, "101": 252.5})
    payload = fetcher.build_payload(api, stocks, INDEXES, {})
    assert len(api.calls) == 2
    assert "001" in payload["quotes"]  # the stock keeps its own row
    assert [row["name"] for row in payload["indices"]] == ["TAIEX", "TPEx"]


def test_no_priced_stock_is_still_none_even_when_indices_answer():
    api = CountingApi({"001": 20100.0, "101": 252.5})
    assert fetcher.build_payload(api, STOCKS, INDEXES, {}) is None
    assert len(api.calls) == 1


def test_positions_clock_fetches_first_then_every_period():
    now = [100.0]
    clock = fetcher.PositionsClock(60.0, now=lambda: now[0])
    assert clock.due() is True  # the first tick always fetches
    clock.fetched()
    now[0] += 59.0
    assert clock.due() is False
    now[0] += 1.0
    assert clock.due() is True
    clock.fetched()
    assert clock.due() is False


def test_positions_clock_retries_next_tick_after_a_failed_fetch():
    now = [100.0]
    clock = fetcher.PositionsClock(60.0, now=lambda: now[0])
    assert clock.due() is True
    # the fetch raised: fetched() never ran, so the very next tick tries again
    now[0] += 10.0
    assert clock.due() is True
