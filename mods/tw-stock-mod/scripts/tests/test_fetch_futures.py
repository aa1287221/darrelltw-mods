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

    row = fetcher.futures_quote_row(TXF_CONTRACT, snap, [], "TXFJ6")

    assert row["ts"] == utc_ms(2026, 9, 18, 6, 30)


# ---------------------------------------------------------------------------
# path 15: payload fields built from canned contract + snapshot + kbars
# ---------------------------------------------------------------------------

def test_futures_quote_row_multiplier_and_decimals_come_from_contract():
    snap_txf = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    snap_srf = make_snapshot("SRFJ6", 109.5, utc_ns(2026, 9, 18, 10, 0))

    txf_row = fetcher.futures_quote_row(TXF_CONTRACT, snap_txf, [], "TXFJ6")
    srf_row = fetcher.futures_quote_row(SRF_CONTRACT, snap_srf, [], "SRFJ6")

    assert txf_row["multiplier"] == 200
    assert txf_row["decimals"] == 0
    assert txf_row["prevClose"] == 17000.0
    assert srf_row["multiplier"] == 1000
    assert srf_row["decimals"] == 2
    assert srf_row["prevClose"] == 108.3


def test_futures_quote_row_resolved_only_for_alias():
    snap = make_snapshot("TXFR1", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    alias_row = fetcher.futures_quote_row(TXF_ALIAS_CONTRACT, snap, [], "TXFR1")
    assert alias_row["resolved"] == "TXFJ6"

    snap_month = make_snapshot("TXFJ6", 17010.0, utc_ns(2026, 9, 18, 10, 0))
    month_row = fetcher.futures_quote_row(TXF_CONTRACT, snap_month, [], "TXFJ6")
    assert "resolved" not in month_row


def test_futures_quote_row_invalid_snapshot_is_dropped():
    snap = make_snapshot("TXFJ6", 0, utc_ns(2026, 9, 18, 10, 0))
    assert fetcher.futures_quote_row(TXF_CONTRACT, snap, [], "TXFJ6") is None


def test_bars_5min_keeps_last_40():
    n = 250  # 50 five-minute buckets
    raw_ts = [utc_ns(2026, 9, 18, 0, 0) + i * 60_000_000_000 for i in range(n)]
    kbars = types.SimpleNamespace(
        ts=raw_ts,
        Open=[float(i) for i in range(n)], High=[float(i) for i in range(n)],
        Low=[float(i) for i in range(n)], Close=[float(i) for i in range(n)],
        Volume=[1] * n,
    )

    bars = fetcher.bars_5min(kbars)

    assert len(bars) == 40
    # bucket #10 (0-indexed) is the oldest kept: rows 50..54 -> O=50,H=54,L=50,C=54
    assert bars[0] == [50.0, 54.0, 50.0, 54.0]
    assert bars[-1] == [245.0, 249.0, 245.0, 249.0]


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


def test_bars_5min_empty_kbars_is_empty_list():
    empty = types.SimpleNamespace(ts=[], Open=[], High=[], Low=[], Close=[], Volume=[])
    assert fetcher.bars_5min(empty) == []


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
