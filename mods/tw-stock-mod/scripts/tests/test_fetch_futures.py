"""
永豐 futures side of fetch-quotes-shioaji.py: pure functions only, canned
SDK-shaped objects in, no login. See docs/agents (issue #3, path matrix rows
12/13/15) for the acceptance criteria these map to.

Every fixture pairs a non-index contract (SRF, multiplier 1000, 2 decimals)
with an index contract (TXF, multiplier 200, 0 decimals) so a hardcoded
constant standing in for either field cannot satisfy both.
"""
import datetime as dt
import importlib.util
import sys
import types
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "fetch-quotes-shioaji.py"
spec = importlib.util.spec_from_file_location("fetch_quotes_shioaji", MODULE_PATH)
fetcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fetcher
spec.loader.exec_module(fetcher)


def utc_ms(year, month, day, hour, minute, second=0):
    """An independent literal source: stdlib datetime, not the production formula."""
    return int(dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc).timestamp() * 1000)


def utc_ns(year, month, day, hour, minute, second=0):
    return utc_ms(year, month, day, hour, minute, second) * 1_000_000


def make_contract(code, multiplier, decimal_locator, reference, name, target_code=None):
    return types.SimpleNamespace(
        code=code, multiplier=multiplier, decimal_locator=decimal_locator,
        reference=reference, name=name, target_code=target_code,
    )


def make_snapshot(code, close, ts_ns):
    return types.SimpleNamespace(code=code, close=close, ts=ts_ns)


TXF_CONTRACT = make_contract("TXFJ6", 200, 0, 17000.0, "臺股期貨 202610")
SRF_CONTRACT = make_contract("SRFJ6", 1000, 2, 108.3, "小型元大台灣50ETF期貨 202610")
TXF_ALIAS_CONTRACT = make_contract("TXFR1", 200, 0, 17000.0, "臺股期貨 近月", target_code="TXFJ6")


# ---------------------------------------------------------------------------
# path 12: 5-minute resample - bucket edges, partial trailing bar, midnight
# ---------------------------------------------------------------------------

def test_resample_bucket_boundaries():
    rows = [
        {"ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 5},
        {"ts": utc_ms(2026, 9, 18, 9, 2), "Open": 102, "High": 104, "Low": 98, "Close": 101, "Volume": 3},
        {"ts": utc_ms(2026, 9, 18, 9, 4), "Open": 101, "High": 105, "Low": 100, "Close": 104, "Volume": 6},
        # exactly on the boundary -> the NEXT bucket, not the previous one
        {"ts": utc_ms(2026, 9, 18, 9, 5), "Open": 104, "High": 106, "Low": 103, "Close": 105, "Volume": 4},
        {"ts": utc_ms(2026, 9, 18, 9, 7), "Open": 105, "High": 107, "Low": 104, "Close": 106, "Volume": 2},
    ]

    buckets = fetcher.resample_5min(rows)

    assert len(buckets) == 2
    assert buckets[0] == {
        "ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 105, "Low": 98, "Close": 104, "Volume": 14,
    }
    assert buckets[1] == {
        "ts": utc_ms(2026, 9, 18, 9, 5), "Open": 104, "High": 107, "Low": 103, "Close": 106, "Volume": 6,
    }


def test_resample_keeps_partial_trailing_bucket():
    rows = [
        {"ts": utc_ms(2026, 9, 18, 9, i), "Open": 100 + i, "High": 100 + i, "Low": 100 + i, "Close": 100 + i, "Volume": 1}
        for i in range(5)
    ] + [
        # the live, still-forming bar: one row, kept as its own bucket
        {"ts": utc_ms(2026, 9, 18, 9, 5), "Open": 200, "High": 202, "Low": 199, "Close": 201, "Volume": 9},
    ]

    buckets = fetcher.resample_5min(rows)

    assert len(buckets) == 2
    assert buckets[-1] == {
        "ts": utc_ms(2026, 9, 18, 9, 5), "Open": 200, "High": 202, "Low": 199, "Close": 201, "Volume": 9,
    }


def test_resample_midnight_crossing():
    rows = [
        {"ts": utc_ms(2026, 9, 18, 23, 58), "Open": 10, "High": 12, "Low": 9, "Close": 11, "Volume": 1},
        {"ts": utc_ms(2026, 9, 18, 23, 59), "Open": 11, "High": 13, "Low": 10, "Close": 12, "Volume": 2},
        {"ts": utc_ms(2026, 9, 19, 0, 0), "Open": 20, "High": 21, "Low": 19, "Close": 20, "Volume": 3},
        {"ts": utc_ms(2026, 9, 19, 0, 1), "Open": 20, "High": 22, "Low": 20, "Close": 21, "Volume": 4},
        {"ts": utc_ms(2026, 9, 19, 0, 2), "Open": 21, "High": 23, "Low": 20, "Close": 22, "Volume": 5},
        {"ts": utc_ms(2026, 9, 19, 0, 3), "Open": 22, "High": 24, "Low": 21, "Close": 23, "Volume": 6},
    ]

    buckets = fetcher.resample_5min(rows)

    assert len(buckets) == 2
    assert buckets[0] == {
        "ts": utc_ms(2026, 9, 18, 23, 55), "Open": 10, "High": 13, "Low": 9, "Close": 12, "Volume": 3,
    }
    assert buckets[1] == {
        "ts": utc_ms(2026, 9, 19, 0, 0), "Open": 20, "High": 24, "Low": 19, "Close": 23, "Volume": 18,
    }


# ---------------------------------------------------------------------------
# resample_minutes: resample_5min's general form (issue #12) - 1/15/60
# minute timeframes over the same bucket math, proven independently per
# timeframe so a constant standing in for one width cannot satisfy the rest
# ---------------------------------------------------------------------------

def test_resample_minutes_1_is_one_bucket_per_row():
    # minutes=1 goes through the same bucket math as 5/15/60 here (the
    # fetcher's own 1-minute timeframe skips this path entirely - see
    # test_minute_buckets_1_is_the_raw_rows_unresampled below)
    rows = [
        {"ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 5},
        {"ts": utc_ms(2026, 9, 18, 9, 1), "Open": 101, "High": 103, "Low": 100, "Close": 102, "Volume": 3},
    ]

    buckets = fetcher.resample_minutes(rows, 1)

    assert buckets == [
        {"ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 5},
        {"ts": utc_ms(2026, 9, 18, 9, 1), "Open": 101, "High": 103, "Low": 100, "Close": 102, "Volume": 3},
    ]


def test_resample_minutes_15_bucket_boundaries():
    rows = [
        {"ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 101, "Low": 99, "Close": 100, "Volume": 5},
        {"ts": utc_ms(2026, 9, 18, 9, 7), "Open": 100, "High": 106, "Low": 95, "Close": 103, "Volume": 4},
        {"ts": utc_ms(2026, 9, 18, 9, 14), "Open": 103, "High": 108, "Low": 102, "Close": 107, "Volume": 6},
        # exactly on the boundary -> the NEXT 15-min bucket, not the previous one
        {"ts": utc_ms(2026, 9, 18, 9, 15), "Open": 107, "High": 109, "Low": 106, "Close": 108, "Volume": 2},
    ]

    buckets = fetcher.resample_minutes(rows, 15)

    assert len(buckets) == 2
    assert buckets[0] == {
        "ts": utc_ms(2026, 9, 18, 9, 0), "Open": 100, "High": 108, "Low": 95, "Close": 107, "Volume": 15,
    }
    assert buckets[1] == {
        "ts": utc_ms(2026, 9, 18, 9, 15), "Open": 107, "High": 109, "Low": 106, "Close": 108, "Volume": 2,
    }


def test_resample_minutes_60_aligns_to_the_hour():
    # a tick just after 22:00 and one just before 23:00 must land in the SAME
    # bucket (22:00), and one at exactly 23:00 opens the next - 60-min bucket
    # math has to floor to the top of the (Taipei, since epoch ms is already
    # a whole multiple of hours apart from UTC) hour, not an arbitrary offset
    rows = [
        {"ts": utc_ms(2026, 9, 18, 22, 3), "Open": 200, "High": 202, "Low": 199, "Close": 201, "Volume": 1},
        {"ts": utc_ms(2026, 9, 18, 22, 58), "Open": 201, "High": 205, "Low": 198, "Close": 204, "Volume": 2},
        {"ts": utc_ms(2026, 9, 18, 23, 0), "Open": 204, "High": 206, "Low": 203, "Close": 205, "Volume": 3},
    ]

    buckets = fetcher.resample_minutes(rows, 60)

    assert len(buckets) == 2
    assert buckets[0] == {
        "ts": utc_ms(2026, 9, 18, 22, 0), "Open": 200, "High": 205, "Low": 198, "Close": 204, "Volume": 3,
    }
    assert buckets[1] == {
        "ts": utc_ms(2026, 9, 18, 23, 0), "Open": 204, "High": 206, "Low": 203, "Close": 205, "Volume": 3,
    }


def test_resample_minutes_partial_trailing_bucket_kept_for_every_width():
    # the live, still-forming bar is kept even with one row, at every width -
    # generalises resample_5min's own version of this test
    rows = [{"ts": utc_ms(2026, 9, 18, 9, 0), "Open": 1, "High": 1, "Low": 1, "Close": 1, "Volume": 1}]
    for minutes in (1, 5, 15, 60):
        buckets = fetcher.resample_minutes(rows, minutes)
        assert len(buckets) == 1
        assert buckets[0]["ts"] == utc_ms(2026, 9, 18, 9, 0)


# ---------------------------------------------------------------------------
# path 13: 8-hour Taipei-labelled-as-UTC correction, kbar side and snapshot
# side are two independent call sites (see mutation checks in the report)
# ---------------------------------------------------------------------------

def test_kbars_to_rows_applies_taipei_offset():
    # SDK raw ts: Taipei wall clock 10:00/10:01 stamped as if it were UTC
    raw_ts = [utc_ns(2026, 9, 18, 10, 0), utc_ns(2026, 9, 18, 10, 1)]
    kbars = types.SimpleNamespace(
        ts=raw_ts,
        Open=[100.0, 101.0], High=[102.0, 103.0], Low=[99.0, 100.0], Close=[101.0, 102.0], Volume=[5, 6],
    )

    rows = fetcher.kbars_to_rows(kbars)

    # the true UTC instant is 8h earlier: 02:00/02:01
    assert rows[0]["ts"] == utc_ms(2026, 9, 18, 2, 0)
    assert rows[1]["ts"] == utc_ms(2026, 9, 18, 2, 1)
    assert rows[0]["Open"] == 100.0 and rows[0]["Volume"] == 5
    assert rows[1]["Close"] == 102.0 and rows[1]["Volume"] == 6


def test_futures_quote_row_applies_taipei_offset_to_snapshot():
    snap = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 14, 30))

    row = fetcher.futures_quote_row(TXF_CONTRACT, snap, {}, "TXFJ6")

    assert row["ts"] == utc_ms(2026, 9, 18, 6, 30)


# ---------------------------------------------------------------------------
# path 15: payload fields built from canned contract + snapshot + kbars
# ---------------------------------------------------------------------------

def test_futures_quote_row_multiplier_and_decimals_come_from_contract():
    snap_txf = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    snap_srf = make_snapshot("SRFJ6", 109.5, utc_ns(2026, 9, 18, 10, 0))

    txf_row = fetcher.futures_quote_row(TXF_CONTRACT, snap_txf, {}, "TXFJ6")
    srf_row = fetcher.futures_quote_row(SRF_CONTRACT, snap_srf, {}, "SRFJ6")

    assert txf_row["multiplier"] == 200
    assert txf_row["decimals"] == 0
    assert txf_row["prevClose"] == 17000.0
    assert srf_row["multiplier"] == 1000
    assert srf_row["decimals"] == 2
    assert srf_row["prevClose"] == 108.3


def test_futures_quote_row_resolved_only_for_alias():
    snap = make_snapshot("TXFR1", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    alias_row = fetcher.futures_quote_row(TXF_ALIAS_CONTRACT, snap, {}, "TXFR1")
    assert alias_row["resolved"] == "TXFJ6"

    snap_month = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    month_row = fetcher.futures_quote_row(TXF_CONTRACT, snap_month, {}, "TXFJ6")
    assert "resolved" not in month_row


def test_futures_quote_row_invalid_snapshot_is_dropped():
    snap = make_snapshot("TXFJ6", 0, utc_ns(2026, 9, 18, 10, 0))
    assert fetcher.futures_quote_row(TXF_CONTRACT, snap, {}, "TXFJ6") is None


def test_futures_quote_row_barsby_shape():
    # issue #12 payload shape: barsBy carries every timeframe with a `ts` on
    # every bar, capped at FUTURES_BAR_LIMIT each, and `bars` is exactly
    # barsBy["5"] - the SAME object, not merely an equal copy (see the
    # identity assertion in test_ticks.py for why that matters to ticks)
    bars_by = {
        "1": [[100.0, 101.0, 99.0, 100.5, 1.0, utc_ms(2026, 9, 18, 9, 0)]],
        "5": [[100.0, 105.0, 98.0, 104.0, 5.0, utc_ms(2026, 9, 18, 9, 0)]],
        "15": [[100.0, 108.0, 95.0, 107.0, 15.0, utc_ms(2026, 9, 18, 9, 0)]],
        "60": [[100.0, 110.0, 90.0, 108.0, 60.0, utc_ms(2026, 9, 18, 9, 0)]],
    }
    snap = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 10, 0))

    row = fetcher.futures_quote_row(TXF_CONTRACT, snap, bars_by, "TXFJ6")

    assert set(row["barsBy"]) == {"1", "5", "15", "60"}
    for tf, bars in row["barsBy"].items():
        assert len(bars) <= fetcher.FUTURES_BAR_LIMIT
        for bar in bars:
            assert len(bar) == 6  # o, h, l, c, v, ts
    assert "bars" not in row  # barsBy["5"] is the 5-minute set; no second copy


def test_bucket_to_bar_shape_is_o_h_l_c_v_ts():
    bucket = {"ts": utc_ms(2026, 9, 18, 9, 5), "Open": 100.0, "High": 105.0, "Low": 98.0, "Close": 104.0, "Volume": 14.0}
    assert fetcher.bucket_to_bar(bucket) == [100.0, 105.0, 98.0, 104.0, 14.0, utc_ms(2026, 9, 18, 9, 5)]


def test_buckets_to_bars_keeps_last_120():
    n = 750  # 150 five-minute buckets
    raw_ts = [utc_ns(2026, 9, 18, 0, 0) + i * 60_000_000_000 for i in range(n)]
    kbars = types.SimpleNamespace(
        ts=raw_ts,
        Open=[float(i) for i in range(n)], High=[float(i) for i in range(n)],
        Low=[float(i) for i in range(n)], Close=[float(i) for i in range(n)],
        Volume=[1] * n,
    )
    buckets = fetcher.resample_minutes(fetcher.kbars_to_rows(kbars), 5)

    bars, trailing_ts = fetcher.buckets_to_bars(buckets)

    assert len(bars) == 120
    # bucket #30 (0-indexed) is the oldest kept: rows 150..154 -> O=150,H=154,L=150,C=154
    assert bars[0][:4] == [150.0, 154.0, 150.0, 154.0]
    assert bars[-1][:4] == [745.0, 749.0, 745.0, 749.0]
    assert bars[-1][5] == trailing_ts == buckets[-1]["ts"]


def test_build_futures_payload_shape():
    # rows hand-built (not via futures_quote_row) so this test only exercises
    # build_futures_payload's own job - pop ts / max / assemble - and stays
    # independent of the multiplier/decimals/offset mutations elsewhere
    rows = {
        "TXFR1": {
            "price": 17010.0, "prevClose": 17000.0, "name": "臺股期貨 近月",
            "multiplier": 200, "decimals": 0, "resolved": "TXFJ6",
            "bars": [[17000.0, 17010.0, 16990.0, 17005.0]],
            "ts": utc_ms(2026, 9, 18, 2, 5),
        },
        "SRFJ6": {
            "price": 109.5, "prevClose": 108.3, "name": "小型元大台灣50ETF期貨 202610",
            "multiplier": 1000, "decimals": 2,
            "bars": [[108.0, 109.0, 107.5, 108.5]],
            "ts": utc_ms(2026, 9, 18, 2, 0),
        },
    }

    payload = fetcher.build_futures_payload(rows)

    assert payload["market"] == "tf"
    assert payload["source"] == "永豐"
    assert payload["barLabel"] == "5 分 K（永豐）"
    assert payload["dataAt"] == utc_ms(2026, 9, 18, 2, 5)  # the later of the two
    assert payload["quotes"]["TXFR1"]["resolved"] == "TXFJ6"
    assert payload["quotes"]["SRFJ6"]["multiplier"] == 1000
    assert "ts" not in payload["quotes"]["TXFR1"]
    assert "ts" not in payload["quotes"]["SRFJ6"]
    assert len(payload["quotes"]["TXFR1"]["bars"]) <= 40


def test_build_futures_payload_empty_rows_is_none():
    assert fetcher.build_futures_payload({}) is None


def test_buckets_to_bars_empty_is_empty_list_and_zero_trailing_ts():
    assert fetcher.buckets_to_bars([]) == ([], 0)


# ---------------------------------------------------------------------------
# --futures CLI parsing
# ---------------------------------------------------------------------------

def test_split_futures_codes_empty_does_no_futures_work():
    assert fetcher.split_futures_codes("") == []
    assert fetcher.split_futures_codes("   ") == []


def test_split_futures_codes_trims_and_drops_blanks():
    assert fetcher.split_futures_codes("TXFR1, SRFJ6 ,") == ["TXFR1", "SRFJ6"]


# ---------------------------------------------------------------------------
# calendar-day kbars range: a 夜盤 tick past midnight still needs yesterday's
# bars, since api.kbars(start, end) filters by Taipei calendar day
# ---------------------------------------------------------------------------

EMPTY_KBARS = types.SimpleNamespace(ts=[], Open=[], High=[], Low=[], Close=[], Volume=[])


class FakeApi:
    """Records every api.kbars(contract, start=, end=) call; snapshots() answers from a canned map."""

    def __init__(self, snapshot_by_code):
        self.snapshot_by_code = snapshot_by_code
        self.kbars_calls = []

    def snapshots(self, contracts):
        return [self.snapshot_by_code[c.code] for c in contracts if c.code in self.snapshot_by_code]

    def kbars(self, contract, start=None, end=None):
        self.kbars_calls.append({"code": contract.code, "start": start, "end": end})
        return EMPTY_KBARS


def test_fetch_futures_rows_requests_yesterday_through_today():
    snap = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 19, 1, 0))
    api = FakeApi(snapshot_by_code={"TXFJ6": snap})

    fetcher.fetch_futures_rows(api, {"TXFJ6": TXF_CONTRACT}, ["TXFJ6"], "2026-09-19")

    assert api.kbars_calls == [{"code": "TXFJ6", "start": "2026-09-18", "end": "2026-09-19"}]


class FakeApiWithMinutes:
    """Like FakeApi, but kbars() answers `n` real ascending 1-minute rows so
    the full refresh_futures_kbars -> futures_quote_row pipeline can be
    exercised end to end (issue #12's payload-shape story)."""

    def __init__(self, snapshot_by_code, n):
        self.snapshot_by_code = snapshot_by_code
        raw_ts = [utc_ns(2026, 9, 18, 0, 0) + i * 60_000_000_000 for i in range(n)]
        self._kbars = types.SimpleNamespace(
            ts=raw_ts,
            Open=[float(i) for i in range(n)], High=[float(i) for i in range(n)],
            Low=[float(i) for i in range(n)], Close=[float(i) for i in range(n)],
            Volume=[1.0] * n,
        )

    def snapshots(self, contracts):
        return [self.snapshot_by_code[c.code] for c in contracts if c.code in self.snapshot_by_code]

    def kbars(self, contract, start=None, end=None):
        return self._kbars


def test_fetch_futures_rows_end_to_end_payload_shape():
    snap = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 12, 0))
    api = FakeApiWithMinutes(snapshot_by_code={"TXFJ6": snap}, n=750)  # > 120 for every timeframe

    rows = fetcher.fetch_futures_rows(api, {"TXFJ6": TXF_CONTRACT}, ["TXFJ6"], "2026-09-18")

    row = rows["TXFJ6"]
    assert set(row["barsBy"]) == {"1", "5", "15", "60"}
    assert "bars" not in row  # barsBy["5"] is the 5-minute set; no second copy
    for tf_minutes, bars in ((1, row["barsBy"]["1"]), (5, row["barsBy"]["5"]), (15, row["barsBy"]["15"]), (60, row["barsBy"]["60"])):
        assert 0 < len(bars) <= fetcher.FUTURES_BAR_LIMIT
        for bar in bars:
            assert len(bar) == 6
        # bars are ascending by their own ts (bucket start), every ts aligned to its width
        tses = [bar[5] for bar in bars]
        assert tses == sorted(tses)
        for ts in tses:
            assert ts % (tf_minutes * 60_000) == 0
    # 1-minute timeframe is unresampled: as many bars as raw rows kept (capped at 120)
    assert len(row["barsBy"]["1"]) == fetcher.FUTURES_BAR_LIMIT


class FakeClock:
    """Fake monotonic clock - fetch_futures_rows takes `now` as an injectable
    callable so a test can move time without sleeping."""

    def __init__(self, start=0.0):
        self.t = start

    def __call__(self):
        return self.t


def test_fetch_futures_rows_kbars_cadence_5min():
    # two contracts (index + non-index, per the module docstring's pairing
    # rule) so the cache is proven per-contract, not one shared timestamp
    snaps = {
        "TXFJ6": make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 19, 1, 0)),
        "SRFJ6": make_snapshot("SRFJ6", 109.5, utc_ns(2026, 9, 19, 1, 0)),
    }
    api = FakeApi(snapshot_by_code=snaps)
    contracts = {"TXFJ6": TXF_CONTRACT, "SRFJ6": SRF_CONTRACT}
    codes = ["TXFJ6", "SRFJ6"]
    clock = FakeClock(0.0)
    cache: dict = {}

    for t in (0.0, 60.0, 120.0):  # three ticks inside the 5-minute window
        clock.t = t
        fetcher.fetch_futures_rows(api, contracts, codes, "2026-09-19", kbars_cache=cache, now=clock)

    calls_by_code = [c["code"] for c in api.kbars_calls]
    assert calls_by_code.count("TXFJ6") == 1
    assert calls_by_code.count("SRFJ6") == 1

    clock.t = 300.0  # exactly +5 min from the first fetch -> must refresh
    fetcher.fetch_futures_rows(api, contracts, codes, "2026-09-19", kbars_cache=cache, now=clock)

    calls_by_code = [c["code"] for c in api.kbars_calls]
    assert calls_by_code.count("TXFJ6") == 2
    assert calls_by_code.count("SRFJ6") == 2


# ---------------------------------------------------------------------------
# path 14: position -> holding row (Sell negative qty, multiplier carried,
# cost = price) and the SDK pnl cross-check
# ---------------------------------------------------------------------------

class FakeAction:
    """str(sj.Action.X) == 'Action.X' (verified 2026-09-18) - a plain
    "Buy"/"Sell" string fixture would let a direction mutation pass by accident."""

    def __init__(self, name):
        self._name = name

    def __str__(self):
        return f"Action.{self._name}"


BUY = FakeAction("Buy")
SELL = FakeAction("Sell")


def make_position(code, direction, quantity, price, last_price, pnl):
    return types.SimpleNamespace(
        id=1, code=code, direction=direction, quantity=quantity,
        price=price, last_price=last_price, pnl=pnl,
    )


def test_futures_holding_row_buy_is_positive_qty():
    pos = make_position("TXFJ6", BUY, 2, 17000.0, 17050.0, 20000.0)

    row = fetcher.futures_holding_row(pos, TXF_CONTRACT)

    assert row["code"] == "TXFJ6"
    assert row["direction"] == "Buy"
    assert row["qty"] == 2
    assert row["cost"] == 17000.0
    assert row["price"] == 17050.0
    assert row["prevClose"] == 17000.0
    assert row["multiplier"] == 200


def test_futures_holding_row_sell_is_negative_qty():
    pos = make_position("SRFJ6", SELL, 3, 109.0, 108.0, -300.0)

    row = fetcher.futures_holding_row(pos, SRF_CONTRACT)

    assert row["direction"] == "Sell"
    assert row["qty"] == -3
    assert row["cost"] == 109.0
    assert row["price"] == 108.0
    assert row["prevClose"] == 108.3
    assert row["multiplier"] == 1000


def test_futures_holding_row_drops_zero_quantity():
    pos = make_position("TXFJ6", BUY, 0, 17000.0, 17050.0, 0.0)
    assert fetcher.futures_holding_row(pos, TXF_CONTRACT) is None


def test_check_futures_pnl_matches_sdk_value_within_float_noise():
    # (109.5 - 108.3) * 1 * 1000 lands on 1200.0000000000027 in Python float
    # math, not 1200.0 - an `==` check would fail this "matching" fixture for
    # the wrong reason, which is the point of this test.
    pos = make_position("SRFJ6", BUY, 1, 108.3, 109.5, 1200.0)
    assert fetcher.check_futures_pnl(pos, SRF_CONTRACT) is None


def test_check_futures_pnl_accepts_the_sdk_rounding_to_the_dollar():
    # seen live 2026-09-18: SDK=195950.0 vs 算出=195951.00000000017 - the SDK
    # rounds its pnl, so a whole-dollar gap is not a mismatch
    pos = make_position("TXFJ6", BUY, 1, 17000.0, 17979.755, 195950.0)
    assert fetcher.check_futures_pnl(pos, TXF_CONTRACT) is None


def test_check_futures_pnl_still_flags_999_off_at_that_magnitude():
    # 195951 - 999: rel_tol=1e-6 is ~0.2 here, abs_tol 2.0 - neither absorbs it
    pos = make_position("TXFJ6", BUY, 1, 17000.0, 17979.755, 194952.0)
    assert fetcher.check_futures_pnl(pos, TXF_CONTRACT) is not None


def test_check_futures_pnl_flags_mismatch():
    # (17050 - 17000) * 2 * 200 = 20000, not 999 - wrong on purpose
    pos = make_position("TXFJ6", BUY, 2, 17000.0, 17050.0, 999.0)

    mismatch = fetcher.check_futures_pnl(pos, TXF_CONTRACT)

    assert mismatch is not None
    assert "999" in mismatch
    assert "20000" in mismatch


# ---------------------------------------------------------------------------
# path 15 (holdings half): futures-holdings.json payload from canned rows
# ---------------------------------------------------------------------------

def test_build_futures_holdings_payload_shape():
    rows = [
        fetcher.futures_holding_row(make_position("TXFJ6", BUY, 2, 17000.0, 17050.0, 20000.0), TXF_CONTRACT),
        fetcher.futures_holding_row(make_position("SRFJ6", SELL, 3, 109.0, 108.0, -300.0), SRF_CONTRACT),
    ]

    payload = fetcher.build_futures_holdings_payload(rows)

    assert payload["market"] == "tf"
    assert payload["source"] == "永豐 期貨"
    assert len(payload["holdings"]) == 2
    codes = {h["code"] for h in payload["holdings"]}
    assert codes == {"TXFJ6", "SRFJ6"}
    directions = {h["code"]: h["direction"] for h in payload["holdings"]}
    assert directions == {"TXFJ6": "Buy", "SRFJ6": "Sell"}


def test_build_futures_holdings_payload_empty_rows_still_has_shape():
    # unsigned/missing futopt_account: an empty payload, never None, is
    # written every tick so the band can tell "no positions" from "fetcher
    # dead" from asOf alone.
    payload = fetcher.build_futures_holdings_payload([])

    assert payload["market"] == "tf"
    assert payload["source"] == "永豐 期貨"
    assert payload["holdings"] == []
    assert "asOf" in payload


# ---------------------------------------------------------------------------
# fetch_futures_positions: unsigned / missing futopt_account is a normal
# shape (one clear log line, empty result), never a guess
# ---------------------------------------------------------------------------

def test_fetch_futures_positions_missing_account_logs_one_line(capsys):
    api = types.SimpleNamespace(futopt_account=None)

    result = fetcher.fetch_futures_positions(api)

    assert result == []
    err = capsys.readouterr().err
    assert err.count("\n") == 1
    assert "futopt_account" in err


def test_fetch_futures_positions_unsigned_account_skips_the_sdk_call(capsys):
    # list_positions must never be called for an unsigned account - it would
    # only raise HTTP 406, so the `signed` guard is meant to short-circuit
    # before that network round trip, not merely catch the resulting error.
    def raise_if_called(*args, **kwargs):
        raise AssertionError("list_positions should not be called for an unsigned account")

    account = types.SimpleNamespace(signed=False, account_id="X")
    api = types.SimpleNamespace(futopt_account=account, list_positions=raise_if_called)

    result = fetcher.fetch_futures_positions(api)

    assert result == []
    err = capsys.readouterr().err
    assert err.count("\n") == 1
    assert "signed=False" in err


def test_fetch_futures_positions_signed_account_passes_through():
    canned = [make_position("SRFJ6", BUY, 67, 107.2276, 110.35, 205100.0)]
    account = types.SimpleNamespace(signed=True, account_id="Y")

    def list_positions(acct):
        assert acct is account
        return canned

    api = types.SimpleNamespace(futopt_account=account, list_positions=list_positions)

    result = fetcher.fetch_futures_positions(api)

    assert result is canned
