"""
fetch-quotes-capital.py's pure functions: the 未實現損益 row parser, the quotes
payload built off SKCOM's SKSTOCKLONG fields, the exchange-clock stamp, the
index/heartbeat parsers, and the runtime-dir slug both fetchers must share
with runtimeDir() in hooks/constants.ts. No SKCOM, no Windows - `api.stock()`
is a canned SimpleNamespace per code.
"""
import calendar
import importlib.util
import sys
import types
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


capital = load("fetch-quotes-capital.py", "fetch_quotes_capital_t")
shioaji = load("fetch-quotes-shioaji.py", "fetch_quotes_shioaji_rt")


# ---------------------------------------------------------------------------
# runtime dir: both fetchers and runtimeDir() in hooks/constants.ts must agree
# (`project.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')`)
# ---------------------------------------------------------------------------

RUNTIME_CASES = [
    ("/Users/x/app", "Users-x-app"),
    ("/home/u/my proj", "home-u-my proj"),
    ("D:\\app", "D--app"),
    ("C:\\Users\\x\\code\\band", "C--Users-x-code-band"),
    ("//server/share", "server-share"),
]


@pytest.mark.parametrize("fetcher", [capital, shioaji], ids=["capital", "shioaji"])
@pytest.mark.parametrize("project,slug", RUNTIME_CASES)
def test_runtime_dir_matches_register_tsx(fetcher, project, slug):
    assert fetcher.runtime_dir("/h", project) == Path("/h") / ".claude/stock-band" / slug


@pytest.mark.parametrize("fetcher", [capital, shioaji], ids=["capital", "shioaji"])
def test_runtime_dir_without_home_falls_back_to_project(fetcher):
    assert fetcher.runtime_dir("", "/p/app") == Path("/p/app") / ".claude"


# ---------------------------------------------------------------------------
# small parsers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [("1,188.50", 1188.5), (" 42 ", 42.0), ("-3", -3.0), ("", 0.0), ("--", 0.0), (None, 0.0)],
)
def test_to_float(raw, expected):
    assert capital.to_float(raw) == expected


def test_divisor_reads_sdecimal():
    assert capital.divisor(types.SimpleNamespace(sDecimal=2)) == 100.0
    assert capital.divisor(types.SimpleNamespace(sDecimal=4)) == 10000.0
    assert capital.divisor(types.SimpleNamespace(sDecimal=0)) == 1.0
    # the examples' own hardcoded /100 is the default when the field is missing
    assert capital.divisor(types.SimpleNamespace()) == 100.0


def test_stock_traded_at_is_taipei_time_whatever_the_machine_zone():
    stock = types.SimpleNamespace(nTradingDay=20260922, nDealTime=103015)
    expected = (calendar.timegm((2026, 9, 22, 10, 30, 15, 0, 0, 0)) - 8 * 3600) * 1000
    assert capital.stock_traded_at(stock) == expected


def test_stock_traded_at_pre_open_is_zero():
    assert capital.stock_traded_at(types.SimpleNamespace(nTradingDay=0, nDealTime=0)) == 0
    assert capital.stock_traded_at(types.SimpleNamespace(nTradingDay=20261399, nDealTime=0)) == 0


def test_parse_indices_string_and_list_forms():
    assert capital.parse_indices("TSEA:TAIEX, OTCA") == [("TSEA", "TAIEX"), ("OTCA", "OTCA")]
    assert capital.parse_indices([{"code": "TSEA", "name": "加權"}, {"name": "no code"}]) == [("TSEA", "加權")]


@pytest.mark.parametrize("value", ["", ",,", [], [{}], None, 5])
def test_parse_indices_unusable_falls_back_to_defaults(value):
    assert capital.parse_indices(value) == capital.DEFAULT_INDICES


def test_heartbeat_ts_reads_both_shapes():
    assert capital.heartbeat_ts("1789696800000") == 1789696800000.0
    assert capital.heartbeat_ts('{"ts": 1789696800000, "markets": ["tw"]}') == 1789696800000.0
    assert capital.heartbeat_ts('{"markets": ["tw"]}') is None
    assert capital.heartbeat_ts("garbage") is None


def test_read_env_file_strips_quotes_bom_and_comments(tmp_path):
    env = tmp_path / "capital.env"
    env.write_text('\ufeff# comment\nCAPITAL_USER_ID="A1"\n\nCAPITAL_PASSWORD=\'p=w\'\nCAPITAL_USER_ID=ignored\n', encoding="utf-8")
    assert capital.read_env_file(env) == {"CAPITAL_USER_ID": "A1", "CAPITAL_PASSWORD": "p=w"}


# ---------------------------------------------------------------------------
# build_holdings_payload: OnProfitLossGWReport 未實現彙總 rows
# ---------------------------------------------------------------------------


def pl_row(code, name, qty, price, change, cost, trade_type="0"):
    fields = [""] * capital.PL_MIN_FIELDS
    fields[capital.PL_NAME] = name
    fields[capital.PL_CODE] = code
    fields[capital.PL_QTY] = qty
    fields[capital.PL_PRICE] = price
    fields[capital.PL_CHANGE] = change
    fields[capital.PL_COST] = cost
    fields[capital.PL_TRADE_TYPE] = trade_type
    return ",".join(fields)


def test_holdings_fallback_prices_come_from_the_report():
    payload = capital.build_holdings_payload([pl_row("2330", "台積電", "2000", "1188", "12", "900.5")], {})
    assert payload["market"] == "tw" and payload["source"] == capital.HOLDINGS_LABEL
    [row] = payload["holdings"]
    assert row == {"code": "2330", "name": "台積電", "qty": 2000.0, "cost": 900.5, "price": 1188.0, "prevClose": 1176.0}


def test_holdings_prefer_the_live_quote():
    quotes = {"2330": {"price": 1200.0, "prevClose": 1180.0}}
    [row] = capital.build_holdings_payload([pl_row("2330", "台積電", "1000", "1188", "12", "900")], quotes)["holdings"]
    assert (row["price"], row["prevClose"]) == (1200.0, 1180.0)


@pytest.mark.parametrize("trade_type", sorted(capital.SHORT_TRADE_TYPES))
def test_holdings_short_trade_types_carry_a_negative_qty(trade_type):
    [row] = capital.build_holdings_payload([pl_row("2603", "長榮", "1000", "200", "-1", "210", trade_type)], {})["holdings"]
    assert row["qty"] == -1000.0


def test_holdings_skip_short_rows_zero_qty_and_blank_code():
    rows = ["2330,台積電,short", pl_row("2330", "台積電", "0", "1188", "0", "900"), pl_row("", "x", "1000", "1", "0", "1")]
    assert capital.build_holdings_payload(rows, {}) is None


def test_holdings_blank_name_falls_back_to_code():
    [row] = capital.build_holdings_payload([pl_row("0050", "", "1000", "100", "1", "90")], {})["holdings"]
    assert row["name"] == "0050"


# ---------------------------------------------------------------------------
# build_payload: SKSTOCKLONG -> the quotes file
# ---------------------------------------------------------------------------


class FakeApi:
    def __init__(self, stocks):
        self.stocks = stocks

    def stock(self, code):
        return self.stocks.get(code)


def sk(close, ref, name="", decimals=2, day=20260922, deal=103000):
    scale = 10**decimals
    return types.SimpleNamespace(
        nClose=int(round(close * scale)),
        nRef=int(round(ref * scale)),
        bstrStockName=name,
        sDecimal=decimals,
        nTradingDay=day,
        nDealTime=deal,
    )


def test_build_payload_prices_names_and_indices():
    api = FakeApi({"2330": sk(1188, 1176, "台積電"), "TSEA": sk(20010, 19900, "加權指")})
    payload = capital.build_payload(api, ["2330"], [("TSEA", "TAIEX")], {"2330": "watch name"})
    assert payload["source"] == capital.SOURCE_LABEL
    assert payload["quotes"] == {"2330": {"price": 1188.0, "prevClose": 1176.0, "name": "台積電"}}
    assert payload["dataAt"] == capital.stock_traded_at(sk(0, 0))
    assert payload["indices"] == [{"name": "TAIEX", "value": 20010.0, "change": 110.0, "pct": 0.55}]
    assert payload["index"] == {"value": 20010.0, "change": 110.0, "pct": 0.55}


def test_build_payload_drops_unpriced_codes_and_falls_back_on_names():
    api = FakeApi({"2330": sk(0, 1176, "台積電"), "2317": sk(150, 148)})
    payload = capital.build_payload(api, ["2330", "2317", "9999"], [("TSEA", "TAIEX")], {"2317": "鴻海"})
    assert list(payload["quotes"]) == ["2317"]  # pre-open 0 is not a 平盤 trade
    assert payload["quotes"]["2317"]["name"] == "鴻海"
    assert "indices" not in payload and "index" not in payload


def test_build_payload_nothing_priced_is_none():
    assert capital.build_payload(FakeApi({}), ["2330"], [], {}) is None
