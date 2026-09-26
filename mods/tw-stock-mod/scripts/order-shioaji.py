#!/usr/bin/env python3
"""永豐 Shioaji 下單／查詢／取消 — 模擬（預設）或正式（user-level order.live + --live + CA 憑證）。"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import warnings
from pathlib import Path

# the helpers every script here shares - scripts/_common.py, next to this file
from _common import RUNTIME_DIR_ROOT, field, load_env, utf8_stdio

DEFAULT_MAX_QTY = 1  # order.maxQty: 張 (common stock) or 口 (futures)
DEFAULT_MAX_ODD_SHARES = 999  # order.maxOddShares: 股, for either odd-lot kind
SHARES_PER_LOT = 1000  # 1 張 - an odd-lot order of this many shares is a whole 張, not an odd lot
# --lot -> (sj.StockOrderLot member, what the confirmation calls it). `odd`
# is 盤後零股 (after-hours, 13:40-14:30), which is what shioaji's `Odd` is;
# an odd lot during the session is `intraday-odd`.
LOTS = {
    "common": ("Common", "整股"),
    "intraday-odd": ("IntradayOdd", "盤中零股"),
    "odd": ("Odd", "盤後零股"),
}
RUNTIME_DIR = Path.home() / RUNTIME_DIR_ROOT  # orders.log is per user, not per project
ORDERS_LOG = RUNTIME_DIR / "orders.log"
USER_CONFIG_PATH = Path.home() / ".claude" / "stock-band.json"


def now_ms() -> int:
    return int(time.time() * 1000)


def read_json_config(path: Path) -> dict:
    """{} for a missing or malformed file - never raises."""
    if not path.exists():
        return {}
    try:
        root = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return root if isinstance(root, dict) else {}


def resolve_env_path(args, user_cfg: dict) -> Path:
    """--env, else user-level stock-band.json's shioaji.env, else ~/.sinobon.env."""
    if args.env:
        return Path(args.env).expanduser()
    shioaji_cfg = user_cfg.get("shioaji") if isinstance(user_cfg, dict) else None
    env_value = shioaji_cfg.get("env") if isinstance(shioaji_cfg, dict) else None
    return Path(env_value).expanduser() if env_value else Path("~/.sinobon.env").expanduser()


def require_keys() -> tuple[str, str]:
    api_key = os.environ.get("SINOBON_API_KEY")
    secret_key = os.environ.get("SINOBON_SECRET_KEY")
    if not api_key or not secret_key:
        sys.exit("ERROR: SINOBON_API_KEY / SINOBON_SECRET_KEY 沒設")
    return api_key, secret_key


def classify_code(code: str) -> str:
    """'stock' when the leading character is a digit (covers 00631L/00632R too), else 'futures' (TXFR1, SRFJ6, ...)."""
    code = code.strip().upper()
    return "stock" if code and code[0].isdigit() else "futures"


def resolve_mode(user_cfg: dict, project_cfg: dict, cli_live: bool, ca_ok: bool):
    """'sim' | 'live' | ('refuse', reason). project_cfg is accepted but never
    read: the two-key live gate is user-level only, so a checked-in project
    config can never enable live trading."""
    del project_cfg
    user_order = user_cfg.get("order") if isinstance(user_cfg, dict) else None
    # `is True`, not truthiness: "live": "false" (a string) must not count as on
    user_live = isinstance(user_order, dict) and user_order.get("live") is True
    if not (cli_live and user_live):
        return "sim"
    if not ca_ok:
        return ("refuse", "需要 CA 憑證")
    return "live"


def ca_configured(user_cfg: dict) -> bool:
    """True once order.ca names a cert path AND order.caPasswordEnv names a set env var."""
    order_cfg = user_cfg.get("order") if isinstance(user_cfg, dict) else None
    if not isinstance(order_cfg, dict):
        return False
    ca_path = order_cfg.get("ca")
    password_env = order_cfg.get("caPasswordEnv")
    return bool(ca_path) and bool(password_env) and bool(os.environ.get(password_env))


def guard_price(contract, price: float, live: bool = False):
    """('ok'|'reject'|'skip', message|None). A price that is not a positive
    finite number is rejected outright (`--price nan` compares False against
    every bound). 'skip' when the contract carries no usable
    limit_up/limit_down - never silently treated as in-band - and in live
    mode that is a 'reject' instead: a real order is never sent unchecked."""
    if not (isinstance(price, (int, float)) and math.isfinite(price) and price > 0):
        return "reject", f"價格 {price} 不是正數"
    limit_up = field(contract, "limit_up", None)
    limit_down = field(contract, "limit_down", None)
    if not limit_up or not limit_down:
        if live:
            return "reject", "合約沒有 limit_up/limit_down，正式模式不送沒檢查過漲跌停的委託"
        return "skip", "合約沒有 limit_up/limit_down，略過漲跌停檢查"
    if price < limit_down or price > limit_up:
        return "reject", f"價格 {price} 超出漲跌停範圍 [{limit_down}, {limit_up}]"
    return "ok", None


def guard_qty(user_cfg: dict, qty: int, odd_lot: bool = False):
    """None when the quantity is within its cap, else a message.

    The cap has a unit, because the quantities do: `order.maxQty` (default 1)
    counts 張 for a common-lot stock order and 口 for futures, and
    `order.maxOddShares` (default 999) counts 股 for an odd-lot order. One
    number for both would force a choice between refusing "買 50 股" and
    letting 50 張 through. An odd-lot order of 1000 shares or more is a
    whole 張 and is refused outright. A cap that is not a positive whole
    number refuses every order rather than crashing or guessing."""
    if qty < 1:
        return f"數量 {qty} 至少要 1"
    order_cfg = user_cfg.get("order") if isinstance(user_cfg, dict) else None
    key, default, unit = ("maxOddShares", DEFAULT_MAX_ODD_SHARES, "股") if odd_lot else ("maxQty", DEFAULT_MAX_QTY, "張／口")
    cap = (order_cfg if isinstance(order_cfg, dict) else {}).get(key, default)
    if isinstance(cap, bool) or not isinstance(cap, int) or cap < 1:
        return f"order.{key} 設定不是正整數（{cap!r}），不下單"
    if odd_lot and qty >= SHARES_PER_LOT:
        return f"零股數量 {qty} 股已經是整張（{SHARES_PER_LOT} 股以上），請用 --lot common 以張下單"
    if qty > cap:
        return f"數量 {qty} {unit} 超過上限 {cap}（order.{key}）"
    return None


def build_order(intent: dict, contract, accounts):
    """intent + a resolved contract + accounts (api.stock_account/futopt_account)
    -> (a real sj.StockOrder/FuturesOrder, its printable confirmation dict).
    Constructing an order costs no network call, so this needs no login."""
    import shioaji as sj

    action = sj.Action.Buy if intent["side"] == "buy" else sj.Action.Sell
    code = field(contract, "code", intent["code"])
    name = field(contract, "name", None) or code
    price = intent["price"]
    qty = intent["qty"]

    lot_label = None
    if intent["kind"] == "stock":
        lot_name, lot_label = LOTS[intent.get("lot", "common")]
        unit = "張" if lot_name == "Common" else "股"
        account = accounts.stock_account
        sdk_order = sj.StockOrder(
            action=action,
            price=price,
            quantity=qty,
            price_type=sj.StockPriceType.LMT,
            order_type=sj.OrderType.ROD,
            order_lot=getattr(sj.StockOrderLot, lot_name),
            account=account,
        )
    else:
        octype_name = {"auto": "Auto", "new": "New", "cover": "Cover"}[intent.get("octype", "auto")]
        unit = "口"
        account = accounts.futopt_account
        sdk_order = sj.FuturesOrder(
            action=action,
            price=price,
            quantity=qty,
            price_type=sj.FuturesPriceType.LMT,
            order_type=sj.OrderType.ROD,
            octype=getattr(sj.FuturesOCType, octype_name),
            account=account,
        )

    confirmation = {
        "code": code,
        "resolved_code": field(contract, "target_code", None),
        "name": name,
        "side": "買進" if intent["side"] == "buy" else "賣出",
        "price_type": "LMT",
        "price": price,
        "qty": qty,
        "unit": unit,
        "lot": lot_label,
        "account_id": field(account, "account_id", "?"),
        "mode": None,
    }
    return sdk_order, confirmation


def format_confirmation(confirmation: dict) -> str:
    code_label = confirmation["code"]
    if confirmation.get("resolved_code"):
        code_label += f"（{confirmation['resolved_code']}）"
    lines = [
        f"合約：{code_label} {confirmation['name']}",
        f"方向：{confirmation['side']}",
        f"價格：{confirmation['price_type']} {confirmation['price']}",
        f"數量：{confirmation['qty']} {confirmation['unit']}" + (f"（{confirmation['lot']}）" if confirmation.get("lot") else ""),
        f"帳號：{confirmation['account_id']}",
        f"模式：{confirmation['mode']}",
    ]
    return "\n".join(lines)


CONFIRMATION_CODE_FIELDS = ("mode", "code", "resolved_code", "side", "price_type", "price", "qty", "unit", "lot", "account_id")


def confirmation_code(confirmation: dict) -> str:
    """8 hex-char sha256 over CONFIRMATION_CODE_FIELDS of `confirmation`,
    canonical JSON so field order never changes the code. Binds a piped 確認
    to the exact content it was answering - a re-resolved contract (rolling
    alias rolled to a new month), a different account or a different price
    changes the code. Not `name` (display-only) or `octype` (not in this
    dict - format_confirmation never shows it either)."""
    bound = {key: confirmation[key] for key in CONFIRMATION_CODE_FIELDS if key in confirmation}
    canonical = json.dumps(bound, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


def should_auto_confirm(auto_yes: bool, live: bool) -> bool:
    """--yes only auto-confirms in simulation - live always prompts, whatever --yes says."""
    return auto_yes and not live


def confirm(mode: str, auto_yes: bool) -> bool:
    if should_auto_confirm(auto_yes, mode == "live"):
        print("（--yes：模擬模式自動確認）")
        return True
    try:
        reply = input("輸入「確認」以送出委託：")
    except EOFError:
        # no stdin at all (the model's first call, before it has a 確認 to pipe in) -
        # "not confirmed", not an unlogged traceback
        return False
    # a stray BOM or a CRLF from a Windows pipe must not turn 確認 into a refusal
    return reply.strip().lstrip("\ufeff") == "確認"


def find_trade_by_id(trades, order_id: str):
    for trade in trades:
        trade_order = field(trade, "order", None)
        if trade_order is not None and field(trade_order, "id", None) == order_id:
            return trade
    return None


def format_trade_line(trade) -> str:
    """One status/cancel-listing line: id / code / side / price / qty / status / filled."""
    trade_order = field(trade, "order", None)
    status = field(trade, "status", None)
    contract = field(trade, "contract", None)
    order_id = field(trade_order, "id", "?")
    code = field(contract, "code", "?")
    action = field(trade_order, "action", None)
    action_value = field(action, "value", None) if action is not None else None
    side = "買" if action_value == "Buy" else "賣" if action_value == "Sell" else "?"
    price = field(trade_order, "price", "?")
    qty = field(trade_order, "quantity", "?")
    status_enum = field(status, "status", None)
    status_text = str(field(status_enum, "value", status_enum)) if status_enum is not None else "?"
    filled = field(status, "deal_quantity", 0)
    return f"{order_id}  {code}  {side}  {price}  {qty}  {status_text}  已成 {filled}"


PENDING_STATUSES = ("PendingSubmit", "PreSubmitted", "Submitted")


def format_status_lines(trades, mode: str) -> list[str]:
    """One line per trade; an explicit 沒有委託 line when there is none, so an
    empty listing is never mistaken for a silent failure."""
    if not trades:
        return [f"沒有委託（{'正式' if mode == 'live' else '模擬'}）"]
    return [format_trade_line(t) for t in trades]


def settle_after_cancel(refresh, order_id: str, tries: int = 5, delay: float = 1.0, sleep=time.sleep):
    """(trade, settled). cancel_order() returns the pre-cancel snapshot, so
    poll `refresh()` until the order leaves a pending status; the last
    snapshot is returned either way so the caller still has a line to print."""
    trade = None
    for attempt in range(tries):
        trade = find_trade_by_id(refresh(), order_id) or trade
        status_enum = field(field(trade, "status", None), "status", None) if trade is not None else None
        status_text = str(field(status_enum, "value", status_enum)) if status_enum is not None else ""
        if trade is not None and status_text not in PENDING_STATUSES:
            return trade, True
        if attempt < tries - 1:
            sleep(delay)
    return trade, False


def log_line(log_path: Path, record: dict) -> None:
    """Append one JSON line - orders.log is append-only, never rewritten."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# SDK-facing (thin, takes `api`): none of these run under pytest
# ---------------------------------------------------------------------------


def do_login(sj, api_key: str, secret_key: str, simulation: bool):
    api = sj.Shioaji(simulation=simulation)
    api.login(api_key=api_key, secret_key=secret_key, subscribe_trade=False)
    return api


def resolve_contract(api, code: str, retries: int = 10, delay: float = 1.0):
    """Contracts populate in the background right after login - retry the
    lookup a few times rather than calling fetch_contracts(), which the SDK
    treats as an exclusive op and rejects while another session (e.g. the
    band's own fetcher) already has one in flight (measured 2026-09-18:
    ShioajiTimeoutError: exclusive access lost)."""
    kind = classify_code(code)
    contract = None
    for _ in range(retries):
        contract = api.Contracts.Stocks[code] if kind == "stock" else api.Contracts.Futures[code]
        if contract is not None:
            break
        time.sleep(delay)
    return kind, contract


def do_activate_ca(api, ca_path: str, ca_passwd: str, person_id):
    try:
        return bool(api.activate_ca(ca_path=ca_path, ca_passwd=ca_passwd, person_id=person_id))
    except Exception as err:  # noqa: BLE001 - any SDK failure here just means "not activated"
        print(f"CA 啟用失敗：{type(err).__name__}: {err}", file=sys.stderr)
        return False


def submit_order(api, contract, sdk_order):
    return api.place_order(contract, sdk_order)


def fetch_trades(api):
    """update_status() with no account only refreshes ONE default account
    (measured 2026-09-18: a futures order stayed invisible until
    update_status(api.futopt_account) ran) - call it once per signed account."""
    for account in (field(api, "stock_account", None), field(api, "futopt_account", None)):
        if account is not None:
            api.update_status(account)
    return api.list_trades()


def do_cancel(api, trade):
    return api.cancel_order(trade)


def enforce_live_ca(api, user_cfg: dict, action: str, extra: dict) -> bool:
    """True: CA activated. False: refused and already logged/printed - caller must stop."""
    order_cfg = user_cfg.get("order") if isinstance(user_cfg, dict) else {}
    ca_path = os.path.expanduser((order_cfg or {}).get("ca", ""))
    ca_passwd = os.environ.get((order_cfg or {}).get("caPasswordEnv", ""), "")
    person_id = field(api.stock_account, "person_id", None) or field(api.futopt_account, "person_id", None)
    if do_activate_ca(api, ca_path, ca_passwd, person_id):
        return True
    print("需要 CA 憑證", file=sys.stderr)
    log_line(ORDERS_LOG, {"ts": now_ms(), "action": action, "mode": "refuse", "reason": "需要 CA 憑證", **extra})
    return False


def refuse(action: str, reason: str, extra: dict) -> None:
    print(reason, file=sys.stderr)
    log_line(ORDERS_LOG, {"ts": now_ms(), "action": action, "mode": "refuse", "reason": reason, **extra})


def enter_session(args, user_cfg: dict, project_cfg: dict, action: str, extra: dict):
    """Shared place/status/cancel prologue: resolve mode, refuse or log the
    --live/--yes-ignored notices, load the env, chdir + import shioaji, log
    in. Returns (mode, api, sj) or None if refused (already printed/logged)."""
    # the env file first: order.caPasswordEnv may name a variable that only
    # it sets, and ca_configured() reads the environment
    env_path = resolve_env_path(args, user_cfg)
    load_env(env_path, "SINOBON_API_KEY / SINOBON_SECRET_KEY")
    api_key, secret_key = require_keys()

    mode = resolve_mode(user_cfg, project_cfg, args.live, ca_configured(user_cfg))
    if args.live and mode == "sim":
        print("--live 被忽略：user-level order.live 不是 true，仍為模擬", file=sys.stderr)
    if isinstance(mode, tuple):
        refuse(action, mode[1], extra)
        return None

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    # Shioaji writes its own shioaji.log into whatever directory the process
    # runs from - chdir here, before shioaji is imported anywhere, same
    # discipline as fetch-quotes-shioaji.py's module docstring.
    os.chdir(RUNTIME_DIR)
    import shioaji as sj

    # api.Contracts is deprecated in favour of api.contracts (v2: get()/info(),
    # no Stocks/Futures maps) - still works, and the fetcher shares the same
    # v1 path; migrate both together rather than half of one.
    warnings.filterwarnings("ignore", message="api.Contracts is deprecated", category=DeprecationWarning)

    api = do_login(sj, api_key, secret_key, simulation=(mode != "live"))

    if mode == "live" and not enforce_live_ca(api, user_cfg, action, extra):
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass
        return None

    return mode, api, sj


def cmd_place(args, user_cfg: dict, project_cfg: dict) -> None:
    # the lot only means anything for a stock; a futures code is always 口
    odd_lot = classify_code(args.code) == "stock" and args.lot != "common"
    qty_err = guard_qty(user_cfg, args.qty, odd_lot=odd_lot)
    if qty_err:
        refuse("place", qty_err, {"code": args.code})
        return

    session = enter_session(args, user_cfg, project_cfg, "place", {"code": args.code})
    if session is None:
        return
    mode, api, _sj = session
    try:
        kind, contract = resolve_contract(api, args.code)
        if contract is None:
            refuse("place", f"查不到合約：{args.code}", {"code": args.code})
            return

        price_status, price_message = guard_price(contract, args.price, live=(mode == "live"))
        if price_status == "skip":
            print(f"SKIPPED：{price_message}", file=sys.stderr)
        elif price_status == "reject":
            refuse("place", price_message, {"code": args.code})
            return

        intent = {
            "code": args.code,
            "side": args.side,
            "price": args.price,
            "qty": args.qty,
            "kind": kind,
            "lot": args.lot,
            "octype": args.octype,
        }
        sdk_order, confirmation = build_order(intent, contract, api)
        confirmation["mode"] = "正式" if mode == "live" else "模擬"
        print(format_confirmation(confirmation))
        code = confirmation_code(confirmation)
        print(f"確認碼：{code}")

        if args.yes and mode == "live":
            print("--yes 被忽略：正式模式一律詢問確認", file=sys.stderr)

        if args.confirm_code and args.confirm_code != code:
            # the content someone confirmed no longer matches what would be sent
            # (rolling alias rolled to a new month, account or price changed) -
            # never submit on a stale code, whatever it was piped from
            print(
                "確認碼不符：確認後內容已改變（例如合約換月、帳號或價格範圍變了），這筆沒有送出。"
                "請把上面新的確認內容給使用者重新確認。",
                file=sys.stderr,
            )
            log_line(ORDERS_LOG, {"ts": now_ms(), "action": "place", "mode": mode, "code": args.code, "result": "confirm_code_mismatch"})
            sys.exit(1)

        # no --confirm-code and stdin is not a person typing - a bare piped
        # 確認 with no code to bind it to must never be read as an answer.
        # sys.stdin can be None (a fully closed stdin, e.g. `<&-`), which has
        # no .isatty() to call - that counts as "not a person typing" too.
        stdin_is_tty = sys.stdin is not None and sys.stdin.isatty()
        if not args.confirm_code and not should_auto_confirm(args.yes, mode == "live") and not stdin_is_tty:
            print(
                f"等待使用者確認：請使用者回覆「確認」後，用同樣參數加上 --confirm-code {code} 重新執行。",
                file=sys.stderr,
            )
            log_line(ORDERS_LOG, {"ts": now_ms(), "action": "place", "mode": mode, "code": args.code, "result": "awaiting_confirmation"})
            return

        if not confirm(mode, args.yes):
            print("已取消：沒有收到「確認」", file=sys.stderr)
            log_line(ORDERS_LOG, {"ts": now_ms(), "action": "place", "mode": mode, "code": args.code, "result": "cancelled_by_user"})
            return

        # Written BEFORE the call: place_order can raise (timeout, dropped
        # connection) after the broker already has the order, and a retry
        # would then place it twice. orders.log keeps the attempt either way.
        attempt = {"ts": now_ms(), "action": "place", "mode": mode, "code": confirmation["code"], "side": confirmation["side"],
                   "price": confirmation["price"], "qty": confirmation["qty"], "unit": confirmation["unit"], "result": "submitting"}
        log_line(ORDERS_LOG, attempt)
        try:
            trade = submit_order(api, contract, sdk_order)
        except BaseException as err:  # noqa: BLE001 - Ctrl-C included: any way out of place_order leaves the order's fate unknown
            # the warning first: a log write that fails must not swallow it
            print(
                f"送單時出錯：{type(err).__name__}: {err}\n"
                "狀態未知：委託可能已經送到券商。先跑 status 確認，不要直接重下這筆單。",
                file=sys.stderr,
            )
            try:
                log_line(ORDERS_LOG, {**attempt, "ts": now_ms(), "result": "error", "error": f"{type(err).__name__}: {err}"})
            finally:
                sys.exit(1)
        print(format_trade_line(trade))
        log_line(
            ORDERS_LOG,
            {
                "ts": now_ms(),
                "action": "place",
                "mode": mode,
                "code": confirmation["code"],
                "resolved_code": confirmation["resolved_code"],
                "side": confirmation["side"],
                "price": confirmation["price"],
                "qty": confirmation["qty"],
                "unit": confirmation["unit"],
                "account_id": confirmation["account_id"],
                "order_id": field(field(trade, "order", None), "id", None),
            },
        )
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass


def cmd_status(args, user_cfg: dict, project_cfg: dict) -> None:
    session = enter_session(args, user_cfg, project_cfg, "status", {})
    if session is None:
        return
    mode, api, _sj = session
    try:
        trades = fetch_trades(api)
        for line in format_status_lines(trades, mode):
            print(line)
        log_line(
            ORDERS_LOG,
            {
                "ts": now_ms(),
                "action": "status",
                "mode": mode,
                "count": len(trades),
                "ids": [field(field(t, "order", None), "id", None) for t in trades],
            },
        )
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass


def cmd_cancel(args, user_cfg: dict, project_cfg: dict) -> None:
    session = enter_session(args, user_cfg, project_cfg, "cancel", {"id": args.order_id})
    if session is None:
        return
    mode, api, _sj = session
    try:
        trades = fetch_trades(api)
        trade = find_trade_by_id(trades, args.order_id)
        if trade is None:
            refuse("cancel", f"查不到委託：{args.order_id}", {"id": args.order_id})
            return
        do_cancel(api, trade)
        settled_trade, settled = settle_after_cancel(lambda: fetch_trades(api), args.order_id)
        print(format_trade_line(settled_trade or trade))
        if not settled:
            print("取消已送出，但狀態還沒更新——稍後用 status 再查一次", file=sys.stderr)
        log_line(
            ORDERS_LOG,
            {"ts": now_ms(), "action": "cancel", "mode": mode, "id": args.order_id, "settled": settled},
        )
    finally:
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p):
        p.add_argument(
            "--env",
            default=None,
            help="env file holding SINOBON_API_KEY / SINOBON_SECRET_KEY; defaults to shioaji.env in "
            "~/.claude/stock-band.json, falling back to ~/.sinobon.env",
        )
        p.add_argument(
            "--live",
            action="store_true",
            help="trade for real - also needs user-level order.live:true and an activated CA cert, else refused",
        )
        p.add_argument("--yes", action="store_true", help="skip the 確認 prompt - ignored in live mode, which always prompts")

    place = sub.add_parser("place", help="place a LMT order")
    add_common(place)
    place.add_argument("--code", required=True)
    place.add_argument("--side", required=True, choices=["buy", "sell"])
    place.add_argument("--price", required=True, type=float)
    place.add_argument("--qty", required=True, type=int)
    place.add_argument(
        "--lot",
        default="common",
        choices=list(LOTS),
        help="stocks only: common = 整股 (張), intraday-odd = 盤中零股 (股, during the session), odd = 盤後零股 (股, 13:40-14:30)",
    )
    place.add_argument("--octype", default="auto", choices=["auto", "new", "cover"], help="futures only")
    place.add_argument(
        "--confirm-code",
        default=None,
        help="the 確認碼 printed by a prior run of this same command - required to actually submit; "
        "a piped 確認 with no matching code, or a code that no longer matches (contract re-resolved, "
        "account or price changed), never submits",
    )

    status = sub.add_parser("status", help="update_status then list every open trade")
    add_common(status)

    cancel = sub.add_parser("cancel", help="cancel one order by id")
    add_common(cancel)
    cancel.add_argument("--id", required=True, dest="order_id")

    return parser


def main() -> None:
    utf8_stdio()  # before argparse, so even --help survives a cp1252 pipe
    args = build_arg_parser().parse_args()
    user_cfg = read_json_config(USER_CONFIG_PATH)
    # Read-only: its `order` block is never consulted (resolve_mode ignores
    # this parameter outright) - a checked-in project config can never
    # enable live trading, see README's Orders section.
    project_cfg = read_json_config(Path.cwd() / ".claude" / "stock-band.json")

    if args.command == "place":
        cmd_place(args, user_cfg, project_cfg)
    elif args.command == "status":
        cmd_status(args, user_cfg, project_cfg)
    elif args.command == "cancel":
        cmd_cancel(args, user_cfg, project_cfg)


if __name__ == "__main__":
    main()
