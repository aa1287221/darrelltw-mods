"""
fetch-quotes-shioaji.py's main loop against a fake `shioaji`, one scripted
list_positions answer per tick (POSITIONS_REFRESH_S patched to 0): a held
code outside the watchlist is priced and tick-subscribed while it is held,
dropped once two answers agree it was sold, and selling everything writes an
empty holdings file instead of leaving the old positions on screen.
"""
import importlib.util
import json
import signal
import sys
import types
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji_positions", SCRIPTS / "fetch-quotes-shioaji.py")
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)

PRICES = {"2330": 1100.0, "2454": 1500.0, "0050": 190.0}


def pos(code, qty=1000):
    return types.SimpleNamespace(code=code, quantity=qty, direction="Buy", price=PRICES[code], last_price=PRICES[code])


def fake_shioaji(answers, events):
    """A `shioaji` module whose list_positions answers answers[n] on its n-th
    call; the call after the last one ends the run."""

    class Book:
        def __getitem__(self, code):
            return types.SimpleNamespace(code=code, name=code, reference=PRICES.get(code, 100.0), target_code=None)

    class Shioaji:
        def __init__(self):
            self.Contracts = types.SimpleNamespace(Stocks=Book(), Futures=Book(), Indexs=types.SimpleNamespace(TSE=Book(), OTC=Book()))
            self.stock_account = "stock"
            self.futopt_account = None
            self.calls = 0

        def login(self, **kw):
            pass

        def logout(self):
            pass

        def list_positions(self, account, **kw):
            if self.calls >= len(answers):
                raise KeyboardInterrupt
            self.calls += 1
            return answers[self.calls - 1]

        def snapshots(self, contracts):
            events.append(("priced", sorted(c.code for c in contracts)))
            return [
                types.SimpleNamespace(code=c.code, close=PRICES.get(c.code, 100.0), change_price=0.0, ts=1_790_000_000_000_000_000)
                for c in contracts
            ]

        def subscribe(self, contract, **kw):
            events.append(("sub", contract.code))

        def unsubscribe(self, contract, **kw):
            events.append(("unsub", contract.code))

        def set_on_tick_stk_v1_callback(self, f):
            pass

        def set_on_tick_fop_v1_callback(self, f):
            pass

        def set_event_callback(self, f):
            pass

    class Enum:
        def __getattr__(self, name):
            return name

    return types.SimpleNamespace(
        Shioaji=Shioaji,
        QuoteType=Enum(),
        QuoteVersion=Enum(),
        constant=types.SimpleNamespace(Unit=Enum(), QuoteType=Enum(), QuoteVersion=Enum()),
    )


def run(tmp_path, monkeypatch, answers):
    events: list = []
    monkeypatch.setitem(sys.modules, "shioaji", fake_shioaji(answers, events))
    monkeypatch.setattr(fetcher, "POSITIONS_REFRESH_S", 0.0)
    env = tmp_path / "sinobon.env"
    env.write_text("SINOBON_API_KEY=k\nSINOBON_SECRET_KEY=s\n", encoding="utf-8")
    out = tmp_path / "out"
    monkeypatch.setattr(sys, "argv", [
        "fetch-quotes-shioaji.py", "--project", str(tmp_path), "--out-dir", str(out), "--env", str(env),
        "--codes", "2330", "--interval", "0.01",
    ])
    handlers = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        with pytest.raises(KeyboardInterrupt):  # the fake's way of ending the run
            fetcher.main()
    finally:
        for s, h in handlers.items():
            signal.signal(s, h)
    return events, out


def priced(events):
    """The stock codes each snapshot priced (indices left out), consecutive repeats collapsed."""
    out: list = []
    for kind, codes in events:
        stocks = [c for c in codes if c in PRICES] if kind == "priced" else None
        if stocks and (not out or out[-1] != stocks):
            out.append(stocks)
    return out


def test_a_sold_code_stops_being_priced_once_two_answers_agree(tmp_path, monkeypatch):
    # the first tick fetches again before its first snapshot (the refresh
    # period is 0 here), so answers[1] is the first one a snapshot follows
    events, out = run(tmp_path, monkeypatch, [
        [pos("2454")],  # startup
        [pos("2454")],
        [],  # sold: one answer is not enough
        [],  # the second agrees
        [],
    ])
    assert priced(events) == [["2330", "2454"], ["2330"]]
    assert ("unsub", "2454") in events
    held = json.loads((out / "stock-holdings.json").read_text(encoding="utf-8"))
    assert held["holdings"] == []  # sold everything: the old position is gone from the file


def test_a_lone_glitched_answer_changes_nothing(tmp_path, monkeypatch):
    events, out = run(tmp_path, monkeypatch, [
        [pos("2454")],
        [],  # one empty answer between two full ones
        [pos("2454")],
        [pos("2454")],
    ])
    assert priced(events) == [["2330", "2454"]]
    assert ("unsub", "2454") not in events
    held = json.loads((out / "stock-holdings.json").read_text(encoding="utf-8"))
    assert [row["code"] for row in held["holdings"]] == ["2454"]


def test_a_new_holding_is_priced_at_once(tmp_path, monkeypatch):
    events, _ = run(tmp_path, monkeypatch, [
        [],  # startup
        [],
        [pos("0050")],
        [pos("0050")],
    ])
    assert priced(events) == [["2330"], ["0050", "2330"]]
