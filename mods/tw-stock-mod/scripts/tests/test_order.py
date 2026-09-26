"""order-shioaji.py: pure functions only, canned objects, no login. See docs/agents
(issue #11) for the acceptance criteria these map to - AC bullet 1's sub-cases."""
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "order-shioaji.py"
spec = importlib.util.spec_from_file_location("order_shioaji", MODULE_PATH)
order = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = order
spec.loader.exec_module(order)

# These build real sj order/Account objects, so they need the SDK itself. A
# machine without it skips them instead of reporting failures that say
# nothing about order-shioaji.py's own logic - except where REQUIRE_SHIOAJI
# is set (CI's `checks` job), where the order path must actually run.
needs_shioaji = pytest.mark.skipif(
    importlib.util.find_spec("shioaji") is None and not os.environ.get("REQUIRE_SHIOAJI"),
    reason="shioaji SDK not installed",
)


@pytest.fixture(autouse=True)
def _chdir_tmp(tmp_path, monkeypatch):
    """order.build_order() imports shioaji lazily, and importing it writes a
    shioaji.log into cwd on first import - keep that out of the repo/worktree."""
    monkeypatch.chdir(tmp_path)


def make_contract(code, name, limit_up, limit_down, target_code=None):
    return types.SimpleNamespace(code=code, name=name, limit_up=limit_up, limit_down=limit_down, target_code=target_code)


TXF_CONTRACT = make_contract("TXFJ6", "臺股期貨 202610", 18000.0, 16000.0)
TXF_ALIAS_CONTRACT = make_contract("TXFR1", "臺股期貨 近月", 18000.0, 16000.0, target_code="TXFJ6")
STOCK_CONTRACT = make_contract("2330", "台積電", 1300.0, 1060.0)


def make_accounts():
    """Real sj.Account instances, not SimpleNamespace - sj.StockOrder/FuturesOrder's
    `account` field is a typed native binding that rejects a duck-typed fake
    (verified: TypeError 'SimpleNamespace object is not an instance of Account')."""
    import shioaji as sj

    stock_account = sj.Account(
        account_type=sj.AccountType.Stock, person_id="p", broker_id="9A95", account_id="acct-stock", signed=True, username="u"
    )
    futopt_account = sj.Account(
        account_type=sj.AccountType.Future, person_id="p", broker_id="F002", account_id="acct-fut", signed=True, username="u"
    )
    return types.SimpleNamespace(stock_account=stock_account, futopt_account=futopt_account)


# ---------------------------------------------------------------------------
# build_order: intent -> (real sj order object, printable confirmation dict)
# ---------------------------------------------------------------------------

@needs_shioaji
def test_build_order_stock_buy_common_lot():
    import shioaji as sj

    accounts = make_accounts()
    intent = {"code": "2330", "side": "buy", "price": 1188.0, "qty": 2, "kind": "stock", "lot": "common", "octype": "auto"}

    sdk_order, confirmation = order.build_order(intent, STOCK_CONTRACT, accounts)

    assert sdk_order.action == sj.Action.Buy
    assert sdk_order.price == 1188.0
    assert sdk_order.quantity == 2
    assert sdk_order.price_type == sj.StockPriceType.LMT
    assert sdk_order.order_type == sj.OrderType.ROD
    assert sdk_order.order_lot == sj.StockOrderLot.Common
    assert sdk_order.account.account_id == "acct-stock"
    assert confirmation["unit"] == "張"
    assert confirmation["account_id"] == "acct-stock"
    assert confirmation["side"] == "買進"


@needs_shioaji
def test_build_order_stock_sell_odd_lot_selects_odd_and_share_unit():
    import shioaji as sj

    accounts = make_accounts()
    intent = {"code": "2330", "side": "sell", "price": 1188.0, "qty": 500, "kind": "stock", "lot": "odd", "octype": "auto"}

    sdk_order, confirmation = order.build_order(intent, STOCK_CONTRACT, accounts)

    assert sdk_order.action == sj.Action.Sell
    assert sdk_order.order_lot == sj.StockOrderLot.Odd
    assert confirmation["unit"] == "股"
    assert confirmation["side"] == "賣出"


@needs_shioaji
@pytest.mark.parametrize("octype,expected", [("auto", "Auto"), ("new", "New"), ("cover", "Cover")])
def test_build_order_futures_octype_maps_to_sdk_enum(octype, expected):
    import shioaji as sj

    accounts = make_accounts()
    intent = {"code": "TXFJ6", "side": "buy", "price": 17000.0, "qty": 1, "kind": "futures", "lot": "common", "octype": octype}

    sdk_order, confirmation = order.build_order(intent, TXF_CONTRACT, accounts)

    assert sdk_order.octype == getattr(sj.FuturesOCType, expected)
    assert sdk_order.price_type == sj.FuturesPriceType.LMT
    assert sdk_order.account.account_id == "acct-fut"
    assert confirmation["unit"] == "口"


@needs_shioaji
def test_build_order_futures_alias_shows_resolved_month():
    accounts = make_accounts()
    intent = {"code": "TXFR1", "side": "buy", "price": 17000.0, "qty": 1, "kind": "futures", "lot": "common", "octype": "auto"}

    _, confirmation = order.build_order(intent, TXF_ALIAS_CONTRACT, accounts)

    assert confirmation["code"] == "TXFR1"
    assert confirmation["resolved_code"] == "TXFJ6"


@needs_shioaji
def test_build_order_stock_has_no_resolved_code():
    accounts = make_accounts()
    intent = {"code": "2330", "side": "buy", "price": 1188.0, "qty": 1, "kind": "stock", "lot": "common", "octype": "auto"}

    _, confirmation = order.build_order(intent, STOCK_CONTRACT, accounts)

    assert confirmation["resolved_code"] is None


# ---------------------------------------------------------------------------
# format_confirmation: unit label + every printed field
# ---------------------------------------------------------------------------

def test_format_confirmation_includes_unit_and_mode():
    confirmation = {
        "code": "TXFR1", "resolved_code": "TXFJ6", "name": "臺股期貨 近月", "side": "買進",
        "price_type": "LMT", "price": 17000.0, "qty": 1, "unit": "口", "account_id": "acct-fut", "mode": "模擬",
    }
    text = order.format_confirmation(confirmation)
    assert "1 口" in text
    assert "TXFR1" in text and "TXFJ6" in text
    assert "買進" in text
    assert "acct-fut" in text
    assert "模擬" in text


# ---------------------------------------------------------------------------
# guard_price: limit-up/limit-down band, both edges inclusive, band printed
# ---------------------------------------------------------------------------

def test_guard_price_in_band_is_ok():
    status, message = order.guard_price(TXF_CONTRACT, 17000.0)
    assert status == "ok"
    assert message is None


def test_guard_price_exactly_on_limit_up_is_ok():
    status, _ = order.guard_price(TXF_CONTRACT, 18000.0)
    assert status == "ok"


def test_guard_price_exactly_on_limit_down_is_ok():
    status, _ = order.guard_price(TXF_CONTRACT, 16000.0)
    assert status == "ok"


def test_guard_price_above_limit_up_rejects_with_band_printed():
    status, message = order.guard_price(TXF_CONTRACT, 18500.0)
    assert status == "reject"
    assert "18000" in message and "16000" in message


def test_guard_price_below_limit_down_rejects_with_band_printed():
    status, message = order.guard_price(TXF_CONTRACT, 15000.0)
    assert status == "reject"
    assert "18000" in message and "16000" in message


def test_guard_price_missing_band_is_skipped_not_silently_ok():
    contract = make_contract("XXXX", "沒有漲跌停資料", None, None)
    status, message = order.guard_price(contract, 100.0)
    assert status == "skip"
    assert message


# ---------------------------------------------------------------------------
# guard_qty: order.maxQty, default 1
# ---------------------------------------------------------------------------

def test_guard_qty_default_cap_is_one():
    assert order.guard_qty({}, 1) is None
    message = order.guard_qty({}, 2)
    assert message is not None
    assert "1" in message and "2" in message


def test_guard_qty_respects_configured_max_qty():
    cfg = {"order": {"maxQty": 5}}
    assert order.guard_qty(cfg, 5) is None
    message = order.guard_qty(cfg, 6)
    assert message is not None
    assert "5" in message


# ---------------------------------------------------------------------------
# resolve_mode: the two-key live gate, CA gate, project-level order ignored
# ---------------------------------------------------------------------------

def test_resolve_mode_defaults_to_sim_with_no_flags_or_config():
    assert order.resolve_mode({}, {}, cli_live=False, ca_ok=False) == "sim"


def test_resolve_mode_config_says_live_but_no_cli_flag_stays_sim():
    user_cfg = {"order": {"live": True}}
    assert order.resolve_mode(user_cfg, {}, cli_live=False, ca_ok=True) == "sim"


def test_resolve_mode_cli_flag_but_no_config_stays_sim():
    assert order.resolve_mode({}, {}, cli_live=True, ca_ok=True) == "sim"


def test_resolve_mode_project_level_order_block_is_ignored():
    # --live is passed and the PROJECT file says live:true, but the user-level
    # file does not - must still be sim, proving project_cfg's `order` is never read.
    user_cfg = {"order": {"live": False}}
    project_cfg = {"order": {"live": True}}
    assert order.resolve_mode(user_cfg, project_cfg, cli_live=True, ca_ok=True) == "sim"


def test_resolve_mode_both_keys_true_but_no_ca_refuses():
    user_cfg = {"order": {"live": True}}
    result = order.resolve_mode(user_cfg, {}, cli_live=True, ca_ok=False)
    assert result == ("refuse", "需要 CA 憑證")


def test_resolve_mode_both_keys_true_and_ca_ok_is_live():
    user_cfg = {"order": {"live": True}}
    assert order.resolve_mode(user_cfg, {}, cli_live=True, ca_ok=True) == "live"


# ---------------------------------------------------------------------------
# ca_configured: both order.ca and a set order.caPasswordEnv are required
# ---------------------------------------------------------------------------

def test_ca_configured_false_with_no_order_block():
    assert order.ca_configured({}) is False


def test_ca_configured_false_when_password_env_unset(monkeypatch):
    monkeypatch.delenv("SINOBON_CA_PASSWORD", raising=False)
    cfg = {"order": {"ca": "~/ca.pfx", "caPasswordEnv": "SINOBON_CA_PASSWORD"}}
    assert order.ca_configured(cfg) is False


def test_ca_configured_true_when_both_present(monkeypatch):
    monkeypatch.setenv("SINOBON_CA_PASSWORD", "secret")
    cfg = {"order": {"ca": "~/ca.pfx", "caPasswordEnv": "SINOBON_CA_PASSWORD"}}
    assert order.ca_configured(cfg) is True


# ---------------------------------------------------------------------------
# classify_code: stock (leading digit, incl. 00631L-style) vs futures
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("code", ["2330", "0050", "006208", "00631L", "00632R"])
def test_classify_code_stock(code):
    assert order.classify_code(code) == "stock"


@pytest.mark.parametrize("code", ["TXFR1", "MXFR1", "SRFJ6", "srfj6"])
def test_classify_code_futures(code):
    assert order.classify_code(code) == "futures"


# ---------------------------------------------------------------------------
# should_auto_confirm: --yes only auto-confirms in simulation
# ---------------------------------------------------------------------------

def test_should_auto_confirm_true_in_sim_with_yes():
    assert order.should_auto_confirm(auto_yes=True, live=False) is True


def test_should_auto_confirm_false_in_live_even_with_yes():
    assert order.should_auto_confirm(auto_yes=True, live=True) is False


def test_should_auto_confirm_false_without_yes():
    assert order.should_auto_confirm(auto_yes=False, live=False) is False


# ---------------------------------------------------------------------------
# find_trade_by_id / format_trade_line: status/cancel listing
# ---------------------------------------------------------------------------

def make_trade(order_id, code, action, price, qty, status, deal_qty):
    return types.SimpleNamespace(
        contract=types.SimpleNamespace(code=code),
        order=types.SimpleNamespace(id=order_id, action=action, price=price, quantity=qty),
        status=types.SimpleNamespace(status=status, deal_quantity=deal_qty),
    )


@needs_shioaji
def test_find_trade_by_id_matches():
    import shioaji as sj

    trades = [
        make_trade("A1", "2330", sj.Action.Buy, 1188.0, 1, sj.OrderStatus.Filled, 1),
        make_trade("A2", "TXFJ6", sj.Action.Sell, 17000.0, 1, sj.OrderStatus.Submitted, 0),
    ]
    found = order.find_trade_by_id(trades, "A2")
    assert found is trades[1]


def test_find_trade_by_id_missing_returns_none():
    assert order.find_trade_by_id([], "nope") is None


@needs_shioaji
def test_format_trade_line_stock_buy_filled():
    import shioaji as sj

    trade = make_trade("A1", "2330", sj.Action.Buy, 1188.0, 1, sj.OrderStatus.Filled, 1)
    line = order.format_trade_line(trade)
    assert "A1" in line and "2330" in line and "買" in line and "1188.0" in line
    assert "Filled" in line
    assert "已成 1" in line


@needs_shioaji
def test_format_trade_line_futures_sell_submitted():
    import shioaji as sj

    trade = make_trade("A2", "TXFJ6", sj.Action.Sell, 17000.0, 1, sj.OrderStatus.Submitted, 0)
    line = order.format_trade_line(trade)
    assert "賣" in line
    assert "Submitted" in line
    assert "已成 0" in line


# ---------------------------------------------------------------------------
# log_line: one JSON line appended, never rewrites earlier lines
# ---------------------------------------------------------------------------

def test_log_line_appends_one_json_line_per_call(tmp_path):
    log_path = tmp_path / "orders.log"
    order.log_line(log_path, {"action": "place", "code": "2330"})
    order.log_line(log_path, {"action": "status"})

    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0]) == {"action": "place", "code": "2330"}
    assert json.loads(lines[1]) == {"action": "status"}


# ---------------------------------------------------------------------------
# format_status_lines / settle_after_cancel: status says so when empty, cancel
# reports the settled state rather than the pre-cancel snapshot
# ---------------------------------------------------------------------------

def test_format_status_lines_empty_says_no_orders():
    assert order.format_status_lines([], "sim") == ["沒有委託（模擬）"]


@needs_shioaji
def test_format_status_lines_lists_each_trade():
    import shioaji as sj

    trades = [make_trade("A1", "2330", sj.Action.Buy, 1188.0, 1, sj.OrderStatus.Filled, 1)]
    lines = order.format_status_lines(trades, "sim")
    assert len(lines) == 1 and "A1" in lines[0] and "Filled" in lines[0]


@needs_shioaji
def test_settle_after_cancel_returns_first_non_pending_snapshot():
    import shioaji as sj

    snapshots = [
        [make_trade("A1", "2330", sj.Action.Buy, 2300.0, 1, sj.OrderStatus.Submitted, 0)],
        [make_trade("A1", "2330", sj.Action.Buy, 2300.0, 1, sj.OrderStatus.Submitted, 0)],
        [make_trade("A1", "2330", sj.Action.Buy, 2300.0, 1, sj.OrderStatus.Cancelled, 0)],
    ]
    calls = []
    trade, settled = order.settle_after_cancel(lambda: snapshots[len(calls)], "A1", tries=5, sleep=lambda s: calls.append(s))
    assert settled is True
    assert trade.status.status == sj.OrderStatus.Cancelled
    assert len(calls) == 2  # slept twice, then the third snapshot settled


@needs_shioaji
def test_settle_after_cancel_gives_up_after_tries_and_says_so():
    import shioaji as sj

    stuck = [make_trade("A1", "2330", sj.Action.Buy, 2300.0, 1, sj.OrderStatus.Submitted, 0)]
    trade, settled = order.settle_after_cancel(lambda: stuck, "A1", tries=3, sleep=lambda s: None)
    assert settled is False
    assert trade is stuck[0]


# ---------------------------------------------------------------------------
# audit hardening: what a malformed price, quantity or config can no longer do
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("price", [float("nan"), float("inf"), 0.0, -1.0])
def test_guard_price_rejects_a_price_that_is_not_a_positive_finite_number(price):
    # nan compares False against both bounds, so it used to pass as in-band
    status, message = order.guard_price(TXF_CONTRACT, price)
    assert status == "reject" and message


def test_guard_price_missing_band_is_a_reject_in_live_mode():
    contract = make_contract("XXXX", "沒有漲跌停資料", None, None)
    assert order.guard_price(contract, 100.0, live=False)[0] == "skip"
    status, message = order.guard_price(contract, 100.0, live=True)
    assert status == "reject" and "正式" in message


@pytest.mark.parametrize("qty", [0, -5])
def test_guard_qty_rejects_less_than_one(qty):
    assert order.guard_qty({"order": {"maxQty": 10}}, qty) is not None


@pytest.mark.parametrize("max_qty", ["5", 2.5, True, 0, None])
def test_guard_qty_refuses_when_max_qty_is_not_a_positive_whole_number(max_qty):
    # "5" used to raise TypeError; True used to mean a cap of 1
    message = order.guard_qty({"order": {"maxQty": max_qty}}, 1)
    assert message is not None and "maxQty" in message


@pytest.mark.parametrize("live", ["false", "true", 1, "yes"])
def test_resolve_mode_live_must_be_the_json_true(live):
    # any truthy value used to count, so "live": "false" switched live trading on
    assert order.resolve_mode({"order": {"live": live}}, {}, cli_live=True, ca_ok=True) == "sim"


@needs_shioaji
def test_build_order_intraday_odd_lot_and_the_confirmation_names_the_lot():
    import shioaji as sj

    intent = {"code": "2330", "side": "buy", "price": 1188.0, "qty": 50, "kind": "stock", "lot": "intraday-odd", "octype": "auto"}
    sdk_order, confirmation = order.build_order(intent, STOCK_CONTRACT, make_accounts())
    assert sdk_order.order_lot == sj.StockOrderLot.IntradayOdd
    assert confirmation["unit"] == "股"
    confirmation["mode"] = "模擬"
    assert "50 股（盤中零股）" in order.format_confirmation(confirmation)


@needs_shioaji
def test_build_order_odd_is_named_as_after_hours():
    intent = {"code": "2330", "side": "buy", "price": 1188.0, "qty": 50, "kind": "stock", "lot": "odd", "octype": "auto"}
    _, confirmation = order.build_order(intent, STOCK_CONTRACT, make_accounts())
    confirmation["mode"] = "模擬"
    assert "（盤後零股）" in order.format_confirmation(confirmation)


def test_confirm_accepts_the_word_with_a_bom_or_crlf(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda _prompt: "﻿確認\r")
    assert order.confirm("live", auto_yes=False) is True
    monkeypatch.setattr("builtins.input", lambda _prompt: "好")
    assert order.confirm("live", auto_yes=False) is False


def test_confirm_treats_eof_as_not_confirmed(monkeypatch):
    # the model's first call has no stdin at all - input() raising EOFError
    # must read as "not confirmed", not propagate as an unlogged traceback
    def raise_eof(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", raise_eof)
    assert order.confirm("sim", auto_yes=False) is False


# ---------------------------------------------------------------------------
# confirmation_code: an 8 hex-char sha256 over the fields the confirmation
# text shows, binding a piped 確認 to what the user actually saw
# ---------------------------------------------------------------------------

BASE_CONFIRMATION_FOR_CODE = {
    "code": "2330", "resolved_code": None, "name": "台積電", "side": "買進",
    "price_type": "LMT", "price": 1188.0, "qty": 1, "unit": "張", "lot": "整股",
    "account_id": "acct-stock", "mode": "模擬",
}


def confirmation_for_code(**overrides):
    conf = dict(BASE_CONFIRMATION_FOR_CODE)
    conf.update(overrides)
    return conf


def test_confirmation_code_is_eight_hex_chars():
    code = order.confirmation_code(confirmation_for_code())
    assert len(code) == 8
    assert all(c in "0123456789abcdef" for c in code)


def test_confirmation_code_is_stable_for_identical_confirmations():
    assert order.confirmation_code(confirmation_for_code()) == order.confirmation_code(confirmation_for_code())


def test_confirmation_code_ignores_the_display_only_name_field():
    # `name` is shown in the confirmation text but is not one of the fields
    # that defines the order - changing it must not change the code
    assert order.confirmation_code(confirmation_for_code()) == order.confirmation_code(
        confirmation_for_code(name="不同名字")
    )


@pytest.mark.parametrize("field,new_value", [
    ("mode", "正式"),
    ("code", "2317"),
    ("resolved_code", "TXFJ6"),
    ("side", "賣出"),
    ("price_type", "MKT"),
    ("price", 1200.0),
    ("qty", 2),
    ("unit", "股"),
    ("lot", "盤中零股"),
    ("account_id", "acct-other"),
])
def test_confirmation_code_changes_when_a_bound_field_changes(field, new_value):
    base = order.confirmation_code(confirmation_for_code())
    changed = order.confirmation_code(confirmation_for_code(**{field: new_value}))
    assert base != changed


def place_args(**kw):
    base = dict(
        code="2330", side="buy", price=1188.0, qty=1, lot="common", octype="auto",
        yes=True, live=False, env=None, confirm_code=None,
    )
    base.update(kw)
    return types.SimpleNamespace(**base)


def test_a_place_order_that_raises_is_logged_and_says_the_state_is_unknown(tmp_path, monkeypatch, capsys):
    log = tmp_path / "orders.log"
    monkeypatch.setattr(order, "ORDERS_LOG", log)
    api = types.SimpleNamespace(logout=lambda: None)
    monkeypatch.setattr(order, "enter_session", lambda *a: ("sim", api, None))
    monkeypatch.setattr(order, "resolve_contract", lambda api, code: ("stock", STOCK_CONTRACT))
    monkeypatch.setattr(order, "build_order", lambda intent, contract, accounts: (object(), {
        "code": "2330", "resolved_code": None, "name": "台積電", "side": "買進", "price_type": "LMT",
        "price": 1188.0, "qty": 1, "unit": "張", "lot": "整股", "account_id": "acct", "mode": None,
    }))

    def boom(api, contract, sdk_order):
        raise TimeoutError("broker did not answer")

    monkeypatch.setattr(order, "submit_order", boom)
    with pytest.raises(SystemExit) as exit_info:
        order.cmd_place(place_args(), {}, {})
    assert exit_info.value.code == 1
    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert [r["result"] for r in records] == ["submitting", "error"]
    assert "TimeoutError" in records[1]["error"]
    assert "狀態未知" in capsys.readouterr().err


def test_the_env_file_is_loaded_before_the_ca_check(tmp_path, monkeypatch):
    # order.caPasswordEnv may name a variable only the env file sets: loading
    # it after resolve_mode refused live with 需要 CA 憑證
    env = tmp_path / "sinobon.env"
    env.write_text("SINOBON_API_KEY=k\nSINOBON_SECRET_KEY=s\nMY_CA_PW=pw\n", encoding="utf-8")
    # load_env writes os.environ with setdefault: give it a copy that the
    # monkeypatch puts back, so nothing it exports outlives this test
    monkeypatch.setattr(os, "environ", {k: v for k, v in os.environ.items() if k not in ("SINOBON_API_KEY", "SINOBON_SECRET_KEY", "MY_CA_PW")})
    monkeypatch.setattr(order, "RUNTIME_DIR", tmp_path / "runtime")
    monkeypatch.setattr(order, "ORDERS_LOG", tmp_path / "runtime" / "orders.log")
    monkeypatch.setitem(sys.modules, "shioaji", types.SimpleNamespace())
    api = types.SimpleNamespace(stock_account=None, futopt_account=None, logout=lambda: None)
    monkeypatch.setattr(order, "do_login", lambda sj, key, secret, simulation: api)
    monkeypatch.setattr(order, "do_activate_ca", lambda api, path, passwd, person_id: passwd == "pw")
    user_cfg = {"order": {"live": True, "ca": "~/ca.pfx", "caPasswordEnv": "MY_CA_PW"}}
    session = order.enter_session(place_args(live=True, env=str(env)), user_cfg, {}, "place", {})
    assert session is not None and session[0] == "live"


# ---------------------------------------------------------------------------
# quantity caps carry a unit: 張／口 (maxQty) apart from odd-lot 股 (maxOddShares)
# ---------------------------------------------------------------------------

def test_an_odd_lot_order_is_capped_in_shares_not_by_max_qty():
    cfg = {"order": {"maxQty": 1}}
    assert order.guard_qty(cfg, 50, odd_lot=True) is None  # 50 股 under the default 999
    assert order.guard_qty(cfg, 50, odd_lot=False) is not None  # ...but 50 張 is still over 1


def test_max_odd_shares_is_its_own_setting():
    cfg = {"order": {"maxQty": 1000, "maxOddShares": 100}}
    assert order.guard_qty(cfg, 100, odd_lot=True) is None
    assert "maxOddShares" in order.guard_qty(cfg, 101, odd_lot=True)


def test_an_odd_lot_of_a_thousand_shares_or_more_is_refused():
    cfg = {"order": {"maxOddShares": 5000}}
    assert "整張" in order.guard_qty(cfg, 1000, odd_lot=True)


def test_a_bad_max_odd_shares_refuses_odd_lots():
    assert "maxOddShares" in order.guard_qty({"order": {"maxOddShares": "50"}}, 1, odd_lot=True)


# ---------------------------------------------------------------------------
# cmd_place wiring: the guards are actually called, with the session's mode
# ---------------------------------------------------------------------------

def wire_place(monkeypatch, tmp_path, mode, contract, reached):
    """cmd_place with the SDK edges stubbed; `reached` records which of
    enter_session / submit_order it got to."""
    monkeypatch.setattr(order, "ORDERS_LOG", tmp_path / "orders.log")
    api = types.SimpleNamespace(logout=lambda: None)

    def enter(*a):
        reached.append("enter_session")
        return (mode, api, None)

    monkeypatch.setattr(order, "enter_session", enter)
    monkeypatch.setattr(order, "resolve_contract", lambda api, code: ("stock", contract))
    monkeypatch.setattr(order, "build_order", lambda intent, contract, accounts: (object(), {
        "code": "2330", "resolved_code": None, "name": "台積電", "side": "買進", "price_type": "LMT",
        "price": intent["price"], "qty": intent["qty"], "unit": "張", "lot": "整股", "account_id": "acct", "mode": None,
    }))
    monkeypatch.setattr(order, "confirm", lambda mode, auto_yes: True)
    monkeypatch.setattr(order, "submit_order", lambda api, contract, sdk_order: reached.append("submit_order") or types.SimpleNamespace())
    monkeypatch.setattr(order, "format_trade_line", lambda trade: "trade")


def wire_place_confirmable(monkeypatch, tmp_path, mode, contract, reached, confirmation_extra=None):
    """Like wire_place, but leaves `confirm` real so the --confirm-code and
    non-interactive-stdin gates in cmd_place actually run."""
    monkeypatch.setattr(order, "ORDERS_LOG", tmp_path / "orders.log")
    api = types.SimpleNamespace(logout=lambda: None)

    def enter(*a):
        reached.append("enter_session")
        return (mode, api, None)

    monkeypatch.setattr(order, "enter_session", enter)
    monkeypatch.setattr(order, "resolve_contract", lambda api, code: ("stock", contract))

    def fake_build_order(intent, contract, accounts):
        built = {
            "code": "2330", "resolved_code": None, "name": "台積電", "side": "買進", "price_type": "LMT",
            "price": intent["price"], "qty": intent["qty"], "unit": "張", "lot": "整股", "account_id": "acct", "mode": None,
        }
        built.update(confirmation_extra or {})
        return object(), built

    monkeypatch.setattr(order, "build_order", fake_build_order)
    monkeypatch.setattr(order, "submit_order", lambda api, contract, sdk_order: reached.append("submit_order") or types.SimpleNamespace())
    monkeypatch.setattr(order, "format_trade_line", lambda trade: "trade")


# what fake_build_order above produces, minus "mode" (cmd_place fills that in
# from the session) - tests compute the expected code from this
STUB_PLACE_CONFIRMATION = {
    "code": "2330", "resolved_code": None, "side": "買進", "price_type": "LMT",
    "price": 1188.0, "qty": 1, "unit": "張", "lot": "整股", "account_id": "acct",
}


def _unexpected_input(_prompt):
    raise AssertionError("stdin must not be read here")


def test_a_live_order_on_a_contract_with_no_band_never_reaches_the_broker(tmp_path, monkeypatch):
    reached = []
    wire_place(monkeypatch, tmp_path, "live", make_contract("2330", "台積電", None, None), reached)
    order.cmd_place(place_args(live=True), {"order": {"live": True}}, {})
    assert reached == ["enter_session"]


def test_a_sim_order_on_a_contract_with_no_band_is_still_placed(tmp_path, monkeypatch):
    reached = []
    wire_place(monkeypatch, tmp_path, "sim", make_contract("2330", "台積電", None, None), reached)
    order.cmd_place(place_args(), {}, {})
    assert reached == ["enter_session", "submit_order"]


def test_a_rejected_price_never_reaches_the_broker(tmp_path, monkeypatch):
    reached = []
    wire_place(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    order.cmd_place(place_args(price=float("nan")), {}, {})
    assert reached == ["enter_session"]


def test_an_over_cap_quantity_never_logs_in(tmp_path, monkeypatch):
    reached = []
    wire_place(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    order.cmd_place(place_args(qty=2), {}, {})  # default maxQty 1 張
    assert reached == []


def test_an_odd_lot_quantity_is_capped_in_shares_at_the_command(tmp_path, monkeypatch):
    reached = []
    wire_place(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    order.cmd_place(place_args(qty=50, lot="intraday-odd"), {}, {})
    assert reached == ["enter_session", "submit_order"]
    reached.clear()
    order.cmd_place(place_args(qty=50, lot="common"), {}, {})  # 50 張 is still over maxQty 1
    assert reached == []


def test_sim_yes_auto_confirms_without_reading_stdin_even_non_interactive(tmp_path, monkeypatch):
    # bullet 1 of the spec: sim + --yes stays unchanged even now that a
    # non-interactive stdin normally triggers the awaiting-confirmation gate
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", _unexpected_input)

    order.cmd_place(place_args(yes=True, confirm_code=None), {}, {})

    assert reached == ["enter_session", "submit_order"]


def test_live_yes_is_ignored_even_with_a_matching_confirm_code(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "live", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "確認")
    code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "正式"})

    order.cmd_place(place_args(yes=True, live=True, confirm_code=code), {"order": {"live": True}}, {})

    assert reached == ["enter_session", "submit_order"]
    assert "--yes 被忽略" in capsys.readouterr().err


def test_matching_confirm_code_with_piped_reply_submits_once(tmp_path, monkeypatch):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "確認")
    code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "模擬"})

    order.cmd_place(place_args(yes=False, confirm_code=code), {}, {})

    assert reached == ["enter_session", "submit_order"]
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    # a successful submit logs "submitting" then a final line with order_id,
    # not any of the refuse/wait/cancel outcomes
    assert [r.get("result") for r in records] == ["submitting", None]
    assert "order_id" in records[-1]


def test_mismatching_confirm_code_refuses_and_never_submits(tmp_path, monkeypatch):
    # the contract re-resolved to a different month (resolved_code changed)
    # since the code the user confirmed was computed
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached, confirmation_extra={"resolved_code": "TXFJ6"})
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", _unexpected_input)
    stale_code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "模擬"})

    with pytest.raises(SystemExit) as exit_info:
        order.cmd_place(place_args(yes=False, confirm_code=stale_code), {}, {})

    assert exit_info.value.code != 0
    assert reached == ["enter_session"]
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert records[-1]["result"] == "confirm_code_mismatch"


def test_no_confirm_code_on_non_interactive_stdin_waits_without_reading_it(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "live", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", _unexpected_input)

    order.cmd_place(place_args(yes=True, live=True, confirm_code=None), {"order": {"live": True}}, {})

    assert reached == ["enter_session"]
    out, err = capsys.readouterr()
    assert "等待使用者確認" in err
    assert "確認碼：" in out
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert records[-1]["result"] == "awaiting_confirmation"


def test_matching_code_but_a_different_reply_is_cancelled_without_a_traceback(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "好")
    code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "模擬"})

    order.cmd_place(place_args(yes=False, confirm_code=code), {}, {})

    assert reached == ["enter_session"]
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert records[-1]["result"] == "cancelled_by_user"
    assert "Traceback" not in capsys.readouterr().err


def test_matching_code_but_an_empty_reply_is_cancelled_without_a_traceback(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr("builtins.input", lambda _prompt: "")
    code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "模擬"})

    order.cmd_place(place_args(yes=False, confirm_code=code), {}, {})

    assert reached == ["enter_session"]
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert records[-1]["result"] == "cancelled_by_user"
    assert "Traceback" not in capsys.readouterr().err


def test_matching_code_but_eof_on_stdin_is_cancelled_without_a_traceback(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place_confirmable(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)

    def raise_eof(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", raise_eof)
    code = order.confirmation_code({**STUB_PLACE_CONFIRMATION, "mode": "模擬"})

    order.cmd_place(place_args(yes=False, confirm_code=code), {}, {})

    assert reached == ["enter_session"]
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert records[-1]["result"] == "cancelled_by_user"
    assert "Traceback" not in capsys.readouterr().err


def test_an_interrupted_place_order_is_logged_as_unknown(tmp_path, monkeypatch, capsys):
    reached = []
    wire_place(monkeypatch, tmp_path, "sim", STOCK_CONTRACT, reached)

    class Interrupted(BaseException):
        """stands in for Ctrl-C: a BaseException that `except Exception` misses
        (a real KeyboardInterrupt would abort pytest itself on that mutation)"""

    def interrupted(api, contract, sdk_order):
        raise Interrupted

    monkeypatch.setattr(order, "submit_order", interrupted)
    with pytest.raises(SystemExit) as exit_info:
        order.cmd_place(place_args(), {}, {})
    assert exit_info.value.code == 1
    records = [json.loads(line) for line in (tmp_path / "orders.log").read_text(encoding="utf-8").splitlines()]
    assert [r["result"] for r in records] == ["submitting", "error"]
    assert "狀態未知" in capsys.readouterr().err
