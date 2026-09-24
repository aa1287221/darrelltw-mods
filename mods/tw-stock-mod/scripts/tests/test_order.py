"""order-shioaji.py: pure functions only, canned objects, no login. See docs/agents
(issue #11) for the acceptance criteria these map to - AC bullet 1's sub-cases."""
import importlib.util
import json
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
# machine without it skips them instead of reporting 13 failures that say
# nothing about order-shioaji.py's own logic.
needs_shioaji = pytest.mark.skipif(
    importlib.util.find_spec("shioaji") is None, reason="shioaji SDK not installed"
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
