"""
永豐 futures-account.json (issue #27, fetcher paths 1-8): the account
summary built from margin() / list_position_detail() / list_profit_loss()
through the fetcher's AccountFetcher, driven by a fake api and injected
clocks. Amounts are scaled and every dseq is made up.
"""
import datetime as dt
import importlib.util
import json
import subprocess
import sys
import textwrap
import time
import types
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "fetch-quotes-shioaji.py"
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji", MODULE_PATH)
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)

NS = types.SimpleNamespace
TODAY = dt.date(2026, 9, 29)
NOW_MS = 1790000000000

MARGIN_FIELDS = dict(
    risk_indicator=120.0, equity=600000, available_margin=100000, initial_margin=500000,
    maintenance_margin=385000, margin_call=0, today_balance=590000, yesterday_balance=541000,
    deposit_withdrawal=0, future_open_position=10000, today_future_open_position=4000,
    future_settle_profitloss=50000, fee=800, tax=100, plus_margin=0, plus_margin_indicator=0,
)
# margin() field -> payload key, spelled out so a renamed key is caught
MARGIN_KEYS = dict(
    risk_indicator="riskIndicator", equity="equity", available_margin="availableMargin",
    initial_margin="initialMargin", maintenance_margin="maintenanceMargin", margin_call="marginCall",
    today_balance="todayBalance", yesterday_balance="yesterdayBalance",
    deposit_withdrawal="depositWithdrawal", future_open_position="openPnl",
    today_future_open_position="todayOpenPnl", future_settle_profitloss="settledPnl",
    fee="fee", tax="tax", plus_margin="plusMargin", plus_margin_indicator="plusMarginIndicator",
)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeApi:
    def __init__(self, signed=True, account=True):
        self.futopt_account = NS(signed=signed, account_id="F-TEST") if account else None
        self.calls = []
        self.margin_result = NS(**MARGIN_FIELDS)
        self.margin_error = None
        self.details = {}   # position id -> [detail rows]
        self.pl_rows = {}   # (begin, end) -> rows; default []
        self.pl_error = None
        self.positions_result = []
        self.positions_error = None

    def margin(self, account):
        self.calls.append(("margin",))
        if self.margin_error:
            raise self.margin_error
        return self.margin_result

    def list_position_detail(self, account, detail_id=None):
        self.calls.append(("detail", detail_id))
        return self.details.get(detail_id, [])

    def list_profit_loss(self, account, begin_date="", end_date=""):
        self.calls.append(("pl", begin_date, end_date))
        if self.pl_error:
            raise self.pl_error
        return self.pl_rows.get((begin_date, end_date), self.pl_rows.get("*", []))

    def list_profit_loss_summary(self, *a, **k):
        self.calls.append(("summary",))  # recorded first: poll() swallows exceptions
        raise AssertionError("list_profit_loss_summary must never be called")

    def list_positions(self, account=None, *a, **k):
        # margin.ref: queried right after a successful margin(), on the futures account only
        self.calls.append(("positions",))
        assert account is self.futopt_account, "margin.ref reads the futures account's positions"
        if self.positions_error:
            raise self.positions_error
        return self.positions_result


def position(pos_id, code, qty, direction="Buy"):
    return NS(id=pos_id, code=code, quantity=qty, direction=direction, price=23400.0, last_price=23450.0, pnl=0)


def detail(dseq, qty, price, direction="Buy", date="2026-09-29", pnl=0):
    return NS(date=date, dseq=dseq, direction=direction, quantity=qty, entry_quantity=qty, price=price,
              last_price=price, pnl=pnl, fee=0)


def pl_row(date, pnl, fee=0, tax=0, entry=23300.0, cover=23350.0, direction="Buy", qty=1, code="TMFJ6"):
    return NS(id="x", code=code, date=date, direction=direction, quantity=qty, entry_price=entry,
              cover_price=cover, pnl=pnl, fee=fee, tax=tax)


def make(today=TODAY):
    fast, slow = Clock(), Clock()
    state = {"now": NOW_MS, "today": today}
    acct = fetcher.AccountFetcher(
        fast_clock=fetcher.PositionsClock(fetcher.POSITIONS_REFRESH_S, now=fast),
        slow_clock=fetcher.PositionsClock(fetcher.ACCOUNT_SLOW_REFRESH_S, now=slow),
        now_ms=lambda: state["now"],
        today=lambda: state["today"],
    )
    return acct, fast, slow, state


def queries(api, kind):
    return [c for c in api.calls if c[0] == kind]


# 1. margin fields map 1:1 ------------------------------------------------

def test_margin_maps_every_field_and_keeps_raw_risk_percentage():
    api, (acct, *_rest) = FakeApi(), make()
    payload = acct.poll(api, [])
    margin = payload["margin"]
    assert set(margin) == set(MARGIN_KEYS.values()) | {"asOf", "ref"}
    for sdk_name, key in MARGIN_KEYS.items():
        assert margin[key] == MARGIN_FIELDS[sdk_name], key
    assert margin["riskIndicator"] == 120  # a percentage number, not 1.05
    assert margin["asOf"] == NOW_MS
    assert payload["asOf"] == NOW_MS and payload["source"] == "永豐"


# 2. all-zero simulation margin still writes ----------------------------

def test_all_zero_simulation_margin_still_produces_a_payload():
    api, (acct, *_rest) = FakeApi(), make()
    api.margin_result = NS(**{k: 0 for k in MARGIN_FIELDS})
    payload = acct.poll(api, [])
    assert payload is not None
    assert payload["margin"]["equity"] == 0 and payload["margin"]["riskIndicator"] == 0
    assert set(payload["margin"]) == set(MARGIN_KEYS.values()) | {"asOf", "ref"}


# 3. fills ----------------------------------------------------------------

def test_fills_signed_for_sell_counted_and_repeated_dseq_kept():
    api, (acct, *_rest) = FakeApi(), make()
    api.details = {
        "p1": [detail("tA0x1", 3, 23400.0, "Sell"), detail("tA0x1", 2, 23400.0, "Sell"), detail("tA0x2", 5, 23520.0, "Sell")],
        "p2": [detail("tB0x1", 4, 17000.0, "Buy")],
    }
    positions = [position("p1", "TMFJ6", 10, "Sell"), position("p2", "TXFJ6", 4, "Buy")]
    fills = acct.poll(api, positions)["fills"]
    assert [f["qty"] for f in fills["TMFJ6"]] == [-3, -2, -5]   # Sell negative
    assert sum(f["qty"] for f in fills["TMFJ6"]) == -10          # = the signed position qty
    assert [f["dseq"] for f in fills["TMFJ6"]] == ["tA0x1", "tA0x1", "tA0x2"]  # split fill kept as two rows
    assert fills["TXFJ6"] == [{"date": "2026-09-29", "dseq": "tB0x1", "qty": 4, "price": 17000.0, "pnl": 0}]
    assert set(fills["TMFJ6"][0]) == {"date", "dseq", "qty", "price", "pnl"}
    assert ("detail", "p1") in api.calls  # queried with the position's own id


def test_fill_with_zero_price_stores_null_not_zero():
    api, (acct, *_rest) = FakeApi(), make()
    api.details = {"p1": [detail("tA0x1", 1, 0.0), detail("tA0x2", 1, 23450.0)]}
    fills = acct.poll(api, [position("p1", "TMFJ6", 2)])["fills"]["TMFJ6"]
    assert [f["price"] for f in fills] == [None, 23450.0]


def test_no_positions_gives_empty_fills_and_no_detail_query():
    api, (acct, *_rest) = FakeApi(), make()
    payload = acct.poll(api, [position("p0", "TMFJ6", 0)])
    assert payload["fills"] == {}
    assert queries(api, "detail") == []


# 4. realized windows ------------------------------------------------------

def test_window_ranges_passed_to_list_profit_loss():
    api, (acct, *_rest) = FakeApi(), make()
    acct.poll(api, [])
    assert set(queries(api, "pl")) == {
        ("pl", "2026-09-29", "2026-09-29"),
        ("pl", "2026-09-01", "2026-09-29"),
        ("pl", "2026-01-01", "2026-09-29"),
    }


def test_window_ranges_on_year_and_month_boundary():
    for today, month_start, year_start in [(dt.date(2027, 1, 1), "2027-01-01", "2027-01-01"),
                                           (dt.date(2026, 10, 1), "2026-10-01", "2026-01-01"),
                                           (dt.date(2026, 12, 31), "2026-12-01", "2026-01-01")]:
        api, (acct, *_rest) = FakeApi(), make(today)
        acct.poll(api, [])
        end = today.isoformat()
        assert set(queries(api, "pl")) == {("pl", end, end), ("pl", month_start, end), ("pl", year_start, end)}


def test_taipei_date_is_not_the_utc_date():
    utc_1700 = dt.datetime(2026, 9, 30, 17, 0, tzinfo=dt.timezone.utc).timestamp()
    assert fetcher.taipei_date(utc_1700) == dt.date(2026, 10, 1)  # 01:00 next day in Taipei
    utc_1559 = dt.datetime(2026, 9, 30, 15, 59, tzinfo=dt.timezone.utc).timestamp()
    assert fetcher.taipei_date(utc_1559) == dt.date(2026, 9, 30)


def test_window_aggregation_counts_wins_losses_and_sums():
    rows = [pl_row("20260929", 500, 10, 2), pl_row("20260929", -200, 10, 2), pl_row("20260929", 0, 5, 1)]
    w = fetcher.realized_window(rows, TODAY, TODAY, NOW_MS)
    assert w == {"asOf": NOW_MS, "pnl": 300, "fee": 25, "tax": 5, "trades": 3, "wins": 1, "losses": 1}


def test_window_bounds_inclusive_both_ends():
    start = dt.date(2026, 9, 1)
    rows = [pl_row("20260831", 1000), pl_row("20260901", 10), pl_row("20260929", 20), pl_row("20260930", 4000)]
    w = fetcher.realized_window(rows, start, TODAY, NOW_MS)
    assert (w["pnl"], w["trades"]) == (30, 2)


def test_zero_entry_and_cover_price_is_dropped_not_stored_but_pnl_counts():
    rows = [pl_row("20260929", 50000, entry=0.0, cover=0.0)]
    w = fetcher.realized_window(rows, TODAY, TODAY, NOW_MS)
    assert (w["pnl"], w["trades"], w["wins"]) == (50000, 1, 1)
    assert set(w) == {"asOf", "pnl", "fee", "tax", "trades", "wins", "losses"}  # no price key at all


def test_realized_sections_reach_the_payload():
    api, (acct, *_rest) = FakeApi(), make()
    api.pl_rows = {
        ("2026-09-29", "2026-09-29"): [pl_row("20260929", 500, 10, 2)],
        ("2026-09-01", "2026-09-29"): [pl_row("20260929", 500), pl_row("20260910", -100)],
        ("2026-01-01", "2026-09-29"): [pl_row("20260929", 500), pl_row("20260910", -100), pl_row("20260201", 900)],
    }
    r = acct.poll(api, [])["realized"]
    assert (r["today"]["pnl"], r["today"]["fee"], r["today"]["tax"]) == (500, 10, 2)
    assert (r["month"]["pnl"], r["month"]["wins"], r["month"]["losses"]) == (400, 1, 1)
    assert (r["year"]["pnl"], r["year"]["trades"]) == (1300, 3)


# 5. cadence ---------------------------------------------------------------

def test_cadence_fast_60s_slow_600s():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    acct.poll(api, [])
    assert len(queries(api, "margin")) == 1 and len(queries(api, "pl")) == 3
    fast.t += 59; slow.t += 59
    acct.poll(api, [])
    assert len(queries(api, "margin")) == 1 and len(queries(api, "pl")) == 3
    fast.t += 1; slow.t += 1   # 60 s: fast due, slow not
    acct.poll(api, [])
    assert len(queries(api, "margin")) == 2
    assert [c[1:] for c in queries(api, "pl")].count(("2026-09-29", "2026-09-29")) == 2
    assert [c[1:] for c in queries(api, "pl")].count(("2026-09-01", "2026-09-29")) == 1
    fast.t += 540; slow.t += 540   # slow at exactly 600 s
    acct.poll(api, [])
    assert [c[1:] for c in queries(api, "pl")].count(("2026-09-01", "2026-09-29")) == 2
    assert [c[1:] for c in queries(api, "pl")].count(("2026-01-01", "2026-09-29")) == 2


def test_clocks_are_independent_slow_advancing_does_not_hold_fast_back():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    acct.poll(api, [])
    fast.t += 60   # only the fast clock moved
    acct.poll(api, [])
    assert len(queries(api, "margin")) == 2 and len(queries(api, "pl")) == 4  # today again, month/year not


def test_poll_returns_none_when_no_section_was_queried_this_tick():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    assert acct.poll(api, []) is not None
    calls_after_first = len(api.calls)
    fast.t += 10; slow.t += 10   # a later tick inside both periods
    assert acct.poll(api, []) is None
    assert len(api.calls) == calls_after_first   # and nothing was queried
    fast.t += 50   # 60 s since the first fast poll
    assert acct.poll(api, [])["margin"]["asOf"] == NOW_MS


def test_poll_returns_payload_when_only_the_slow_clock_is_due():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    acct.poll(api, [])
    slow.t += 600   # only the slow clock moved
    assert acct.poll(api, []) is not None


# 6. a raising margin() ---------------------------------------------------

def test_raising_margin_keeps_last_value_and_asof_writes_rest_logs_once(capsys):
    api, (acct, fast, slow, state) = FakeApi(), make()
    first = acct.poll(api, [position("p1", "TMFJ6", 1)])
    api.details = {"p1": [detail("tA0x1", 1, 23450.0)]}
    api.margin_error = RuntimeError("boom")
    capsys.readouterr()
    for _ in range(3):
        fast.t += 60; slow.t += 60
        state["now"] += 60000
        payload = acct.poll(api, [position("p1", "TMFJ6", 1)])
        assert payload["margin"] == first["margin"]           # last value, its own old asOf
        assert payload["margin"]["asOf"] == NOW_MS
        assert payload["asOf"] == state["now"]
        assert "TMFJ6" in payload["fills"] and payload["realized"]["today"] is not None
    err = capsys.readouterr().err
    assert err.count("boom") == 1


def test_error_logged_again_when_message_changes_and_after_recovery(capsys):
    api, (acct, fast, _slow, _s) = FakeApi(), make()
    api.margin_error = RuntimeError("one")
    acct.poll(api, [])
    fast.t += 60; api.margin_error = RuntimeError("two"); acct.poll(api, [])
    fast.t += 60; api.margin_error = None; acct.poll(api, [])
    fast.t += 60; api.margin_error = RuntimeError("two"); acct.poll(api, [])
    err = capsys.readouterr().err
    assert (err.count("one"), err.count("two")) == (1, 2)


def test_margin_null_until_first_success_and_payload_still_written():
    api, (acct, *_rest) = FakeApi(), make()
    api.margin_error = RuntimeError("boom")
    payload = acct.poll(api, [])
    assert payload is not None and payload["margin"] is None
    assert payload["fills"] == {} and payload["realized"]["today"] is not None


def test_failing_realized_query_keeps_last_window_and_other_sections():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    api.pl_rows = {"*": [pl_row("20260929", 700)]}
    first = acct.poll(api, [])
    api.pl_error = RuntimeError("pl down")
    fast.t += 600; slow.t += 600
    payload = acct.poll(api, [])
    assert payload["realized"] == first["realized"]
    assert payload["margin"]["asOf"] == NOW_MS


def test_account_failures_do_not_count_as_a_failed_tick():
    # the loop only bumps `failed` from quote payloads; poll() must not raise
    # and must not be the way a failure leaks out, whatever the api does
    api, (acct, *_rest) = FakeApi(), make()
    api.margin_error = RuntimeError("x")
    api.pl_error = RuntimeError("y")
    assert acct.poll(api, [position("p1", "TMFJ6", 1)]) is not None


# 7. unsigned / absent account ---------------------------------------------

def test_unsigned_account_no_file_no_query():
    api, (acct, *_rest) = FakeApi(signed=False), make()
    assert acct.poll(api, [position("p1", "TMFJ6", 1)]) is None
    assert api.calls == []


def test_absent_account_no_file_no_query():
    api, (acct, *_rest) = FakeApi(account=False), make()
    assert acct.poll(api, []) is None
    assert api.calls == []


# 8. summary never called ---------------------------------------------------

def test_list_profit_loss_summary_never_called_across_a_full_cycle():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    api.details = {"p1": [detail("tA0x1", 1, 23450.0)]}
    for _ in range(3):
        acct.poll(api, [position("p1", "TMFJ6", 1)])
        fast.t += 600; slow.t += 600
    assert not any(c[0] == "summary" for c in api.calls)


def test_fills_keep_last_value_when_one_code_query_fails():
    api, (acct, fast, _slow, _s) = FakeApi(), make()
    api.details = {"p1": [detail("tA0x1", 1, 23450.0)], "p2": [detail("tB0x1", 2, 17000.0)]}
    positions = [position("p1", "TMFJ6", 1), position("p2", "TXFJ6", 2)]
    first = acct.poll(api, positions)["fills"]
    api.list_position_detail = lambda account, detail_id=None: (_ for _ in ()).throw(RuntimeError("detail down"))
    fast.t += 60
    again = acct.poll(api, positions)["fills"]
    assert again == first


def test_one_failing_code_keeps_its_own_last_fills_while_others_refresh():
    api, (acct, fast, _slow, _s) = FakeApi(), make()
    api.details = {"p1": [detail("tA0x1", 1, 23450.0)], "p2": [detail("tB0x1", 2, 17000.0)]}
    positions = [position("p1", "TMFJ6", 1), position("p2", "TXFJ6", 2)]
    acct.poll(api, positions)
    api.details = {"p2": [detail("tB0x1", 2, 17000.0), detail("tB0x2", 1, 17010.0)]}
    real = api.list_position_detail
    api.list_position_detail = lambda account, detail_id=None: (
        (_ for _ in ()).throw(RuntimeError("p1 down")) if detail_id == "p1" else real(account, detail_id=detail_id))
    fast.t += 60
    fills = acct.poll(api, positions)["fills"]
    assert [f["dseq"] for f in fills["TMFJ6"]] == ["tA0x1"]
    assert [f["dseq"] for f in fills["TXFJ6"]] == ["tB0x1", "tB0x2"]


def test_default_today_is_the_taipei_date(monkeypatch):
    utc_1700 = dt.datetime(2026, 9, 30, 17, 0, tzinfo=dt.timezone.utc).timestamp()  # 10-01 in Taipei
    monkeypatch.setattr(fetcher.time, "time", lambda: utc_1700)
    api = FakeApi()
    fetcher.AccountFetcher().poll(api, [])
    assert ("pl", "2026-10-01", "2026-10-01") in queries(api, "pl")


# 9. margin.ref: the positions the margin was read against --------------------

def ref_position(code, qty, direction="Buy", last_price=23450.0):
    return NS(id="x", code=code, quantity=qty, direction=direction, price=23400.0, last_price=last_price, pnl=0)


def test_ref_signed_by_direction_with_last_price():
    api, (acct, *_rest) = FakeApi(), make()
    api.positions_result = [ref_position("TMFJ6", 5, "Buy", 23450.0), ref_position("MXFJ6", 2, "Sell", 23460.5)]
    ref = acct.poll(api, [])["margin"]["ref"]
    assert ref == {"TMFJ6": {"qty": 5, "price": 23450}, "MXFJ6": {"qty": -2, "price": 23460.5}}
    assert api.calls.index(("positions",)) == api.calls.index(("margin",)) + 1  # right after margin()


def test_ref_skips_zero_quantity_rows():
    api, (acct, *_rest) = FakeApi(), make()
    api.positions_result = [ref_position("TMFJ6", 0), ref_position("MXFJ6", 1)]
    assert acct.poll(api, [])["margin"]["ref"] == {"MXFJ6": {"qty": 1, "price": 23450}}


def test_ref_empty_positions_is_an_empty_object_not_null():
    api, (acct, *_rest) = FakeApi(), make()
    assert acct.poll(api, [])["margin"]["ref"] == {}


def test_ref_sums_rows_of_one_code():
    api, (acct, *_rest) = FakeApi(), make()
    api.positions_result = [ref_position("TMFJ6", 3, "Buy", 23450.0), ref_position("TMFJ6", 1, "Sell", 23455.0)]
    assert acct.poll(api, [])["margin"]["ref"] == {"TMFJ6": {"qty": 2, "price": 23455}}


def test_ref_null_when_a_held_row_has_no_last_price():
    api, (acct, *_rest) = FakeApi(), make()
    api.positions_result = [ref_position("TMFJ6", 1), ref_position("MXFJ6", 1, last_price=0.0)]
    payload = acct.poll(api, [])
    assert payload["margin"]["ref"] is None and payload["margin"]["equity"] == MARGIN_FIELDS["equity"]


def test_ref_failure_is_null_margin_kept_and_logged_once(capsys):
    api, (acct, fast, _slow, state) = FakeApi(), make()
    api.positions_error = RuntimeError("positions down")
    for _ in range(3):
        payload = acct.poll(api, [])
        margin = payload["margin"]
        assert margin["ref"] is None
        assert margin["equity"] == MARGIN_FIELDS["equity"] and margin["asOf"] == state["now"]  # margin still stored
        fast.t += 60
        state["now"] += 60000
    assert capsys.readouterr().err.count("positions down") == 1


def test_ref_recovers_after_a_failure():
    api, (acct, fast, *_rest) = FakeApi(), make()
    api.positions_error = RuntimeError("positions down")
    assert acct.poll(api, [])["margin"]["ref"] is None
    api.positions_error = None
    api.positions_result = [ref_position("TMFJ6", 1)]
    fast.t += 60
    assert acct.poll(api, [])["margin"]["ref"] == {"TMFJ6": {"qty": 1, "price": 23450}}


def test_ref_not_queried_when_margin_fails():
    api, (acct, *_rest) = FakeApi(), make()
    api.margin_error = RuntimeError("boom")
    acct.poll(api, [])
    assert queries(api, "positions") == []


def test_ref_queried_only_in_the_fast_tick():
    api, (acct, fast, slow, _s) = FakeApi(), make()
    acct.poll(api, [])
    assert len(queries(api, "positions")) == 1
    slow.t += 600   # only the slow clock is due
    assert acct.poll(api, []) is not None
    assert len(queries(api, "positions")) == 1
    fast.t += 60
    acct.poll(api, [])
    assert len(queries(api, "positions")) == 2 and len(queries(api, "margin")) == 2


def test_ref_failure_after_margin_failure_keeps_last_margin_and_its_ref():
    api, (acct, fast, *_rest) = FakeApi(), make()
    api.positions_result = [ref_position("TMFJ6", 1)]
    first = acct.poll(api, [])["margin"]
    api.margin_error = RuntimeError("boom")
    fast.t += 60
    assert acct.poll(api, [])["margin"] == first  # last margin with the ref it was read against


# loop integration (subprocess against a stub shioaji, like test_give_up) ---

LOOP_SHIOAJI = textwrap.dedent(
    """
    import types

    class _Book:
        def __getitem__(self, code):
            if code != "TXFR1":
                return None
            return types.SimpleNamespace(code=code, name=code, target_code=code, reference=100.0)

    class Shioaji:
        def __init__(self):
            self.Contracts = types.SimpleNamespace(
                Stocks=_Book(), Futures=_Book(), Indexs=types.SimpleNamespace(TSE=_Book(), OTC=_Book()))
            self.stock_account = None
            self.futopt_account = types.SimpleNamespace(signed=__SIGNED__, account_id="F-TEST")
        def login(self, **kw): pass
        def logout(self): pass
        def snapshots(self, contracts): return []
        def list_positions(self, account=None, *a, **k):
            if account is self.futopt_account:
                return [types.SimpleNamespace(id="p1", code="MXFJ6", quantity=1, direction="Buy",
                                              price=1.0, last_price=1.0, pnl=0)]
            return []
        def margin(self, account): raise RuntimeError("margin down")
        def list_position_detail(self, account, detail_id=None): return []
        def list_profit_loss(self, account, begin_date="", end_date=""): return []
        def set_on_tick_stk_v1_callback(self, f): pass
        def set_on_tick_fop_v1_callback(self, f): pass
        def set_event_callback(self, f): pass

    class _Enum:
        def __getattr__(self, name): return name

    constant = types.SimpleNamespace(QuoteType=_Enum(), QuoteVersion=_Enum())
    """
)

LOOP_RUNNER = textwrap.dedent(
    """
    import runpy, sys
    scripts, fake = sys.argv[1], sys.argv[2]
    sys.path[:0] = [scripts, fake]
    import _common
    _common.GIVE_UP_AFTER_S = 0.3
    sys.argv = [scripts + "/fetch-quotes-shioaji.py"] + sys.argv[3:]
    runpy.run_path(sys.argv[0], run_name="__main__")
    """
)


def run_loop(tmp_path, signed):
    fake = tmp_path / "fake"
    (fake / "shioaji").mkdir(parents=True)
    (fake / "shioaji" / "__init__.py").write_text(LOOP_SHIOAJI.replace("__SIGNED__", str(signed)), encoding="utf-8")
    env_file = tmp_path / "sinobon.env"
    env_file.write_text("SINOBON_API_KEY=k\nSINOBON_SECRET_KEY=s\n", encoding="utf-8")
    heartbeat = tmp_path / "heartbeat.json"
    heartbeat.write_text(json.dumps({"ts": time.time() * 1000, "markets": ["tf"]}), encoding="utf-8")
    (tmp_path / "project").mkdir()
    out = tmp_path / "out"
    out.mkdir()
    scripts = str(Path(MODULE_PATH).parent)
    proc = subprocess.Popen(
        [sys.executable, "-c", LOOP_RUNNER, scripts, str(fake), "--project", str(tmp_path / "project"),
         "--out-dir", str(out), "--env", str(env_file), "--heartbeat", str(heartbeat), "--futures", "MXFJ6",
         "--interval", "0.1"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace",
    )
    try:
        proc.wait(timeout=3)
        alive = False
    except subprocess.TimeoutExpired:
        alive = True
    finally:
        if proc.poll() is None:
            proc.kill()
        output = proc.communicate()[0]
    return out, alive, output


def test_loop_writes_account_file_and_a_failing_margin_never_gives_up(tmp_path):
    out, alive, output = run_loop(tmp_path, signed=True)
    assert alive, output  # ~10x the give-up window: account errors did not count as failed ticks
    payload = json.loads((out / "futures-account.json").read_text(encoding="utf-8"))
    assert payload["margin"] is None and payload["realized"]["today"]["trades"] == 0
    assert output.count("margin down") == 1, output


def test_loop_unsigned_account_writes_no_account_file(tmp_path):
    out, alive, output = run_loop(tmp_path, signed=False)
    assert alive, output
    assert not (out / "futures-account.json").exists()
