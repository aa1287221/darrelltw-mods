#!/usr/bin/env python3
"""永豐 Shioaji 下單／查詢／取消 — 模擬（預設）或正式（user-level order.live + --live + CA 憑證）。"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_MAX_QTY = 1
RUNTIME_DIR = Path.home() / ".claude" / "stock-band"
ORDERS_LOG = RUNTIME_DIR / "orders.log"
USER_CONFIG_PATH = Path.home() / ".claude" / "stock-band.json"


def field(obj, name, default=None):
    """Same helper as fetch-quotes-shioaji.py - getattr with a None-safe default."""
    value = getattr(obj, name, default)
    return default if value is None else value


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


def load_env(path: Path) -> None:
    """Same shape as fetch-quotes-shioaji.py's load_env - setdefault, so an
    already-exported env var wins over the file."""
    if not path.exists():
        sys.exit(f"ERROR: {path} 不存在（要有 SINOBON_API_KEY / SINOBON_SECRET_KEY）")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


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
    user_live = bool(isinstance(user_order, dict) and user_order.get("live"))
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


def guard_price(contract, price: float):
    """('ok'|'reject'|'skip', message|None). 'skip' when the contract carries
    no usable limit_up/limit_down - never silently treated as in-band."""
    limit_up = field(contract, "limit_up", None)
    limit_down = field(contract, "limit_down", None)
    if not limit_up or not limit_down:
        return "skip", "合約沒有 limit_up/limit_down，略過漲跌停檢查"
    if price < limit_down or price > limit_up:
        return "reject", f"價格 {price} 超出漲跌停範圍 [{limit_down}, {limit_up}]"
    return "ok", None


def guard_qty(user_cfg: dict, qty: int):
    """None when qty is within order.maxQty (default 1), else a message naming both numbers."""
    order_cfg = user_cfg.get("order") if isinstance(user_cfg, dict) else None
    max_qty = (order_cfg or {}).get("maxQty", DEFAULT_MAX_QTY)
    if qty > max_qty:
        return f"數量 {qty} 超過上限 {max_qty}"
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

    if intent["kind"] == "stock":
        lot_name = "Odd" if intent.get("lot") == "odd" else "Common"
        unit = "股" if lot_name == "Odd" else "張"
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
        f"數量：{confirmation['qty']} {confirmation['unit']}",
        f"帳號：{confirmation['account_id']}",
        f"模式：{confirmation['mode']}",
    ]
    return "\n".join(lines)


def should_auto_confirm(auto_yes: bool, live: bool) -> bool:
    """--yes only auto-confirms in simulation - live always prompts, whatever --yes says."""
    return auto_yes and not live


def confirm(mode: str, auto_yes: bool) -> bool:
    if should_auto_confirm(auto_yes, mode == "live"):
        print("（--yes：模擬模式自動確認）")
        return True
    reply = input("輸入「確認」以送出委託：")
    return reply.strip() == "確認"


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


def ensure_contracts(api) -> None:
    """Blocks until Contracts finishes downloading - a one-shot script has no
    later tick to retry a still-empty lookup on."""
    api.fetch_contracts(contract_download=False, contracts_timeout=10000)


def resolve_contract(api, code: str):
    kind = classify_code(code)
    contract = api.Contracts.Stocks[code] if kind == "stock" else api.Contracts.Futures[code]
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
    api.update_status()
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
    mode = resolve_mode(user_cfg, project_cfg, args.live, ca_configured(user_cfg))
    if args.live and mode == "sim":
        print("--live 被忽略：user-level order.live 不是 true，仍為模擬", file=sys.stderr)
    if isinstance(mode, tuple):
        refuse(action, mode[1], extra)
        return None

    env_path = resolve_env_path(args, user_cfg)
    load_env(env_path)
    api_key, secret_key = require_keys()

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    # Shioaji writes its own shioaji.log into whatever directory the process
    # runs from - chdir here, before shioaji is imported anywhere, same
    # discipline as fetch-quotes-shioaji.py's module docstring.
    os.chdir(RUNTIME_DIR)
    import shioaji as sj

    api = do_login(sj, api_key, secret_key, simulation=(mode != "live"))
    ensure_contracts(api)

    if mode == "live" and not enforce_live_ca(api, user_cfg, action, extra):
        try:
            api.logout()
        except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
            pass
        return None

    return mode, api, sj


def cmd_place(args, user_cfg: dict, project_cfg: dict) -> None:
    qty_err = guard_qty(user_cfg, args.qty)
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

        price_status, price_message = guard_price(contract, args.price)
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

        if args.yes and mode == "live":
            print("--yes 被忽略：正式模式一律詢問確認", file=sys.stderr)
        if not confirm(mode, args.yes):
            print("已取消：沒有收到「確認」", file=sys.stderr)
            log_line(ORDERS_LOG, {"ts": now_ms(), "action": "place", "mode": mode, "code": args.code, "result": "cancelled_by_user"})
            return

        trade = submit_order(api, contract, sdk_order)
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
        for trade in trades:
            print(format_trade_line(trade))
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
        cancelled = do_cancel(api, trade)
        print(format_trade_line(cancelled))
        log_line(
            ORDERS_LOG,
            {"ts": now_ms(), "action": "cancel", "mode": mode, "id": args.order_id},
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
    place.add_argument("--lot", default="common", choices=["common", "odd"], help="stocks only")
    place.add_argument("--octype", default="auto", choices=["auto", "new", "cover"], help="futures only")

    status = sub.add_parser("status", help="update_status then list every open trade")
    add_common(status)

    cancel = sub.add_parser("cancel", help="cancel one order by id")
    add_common(cancel)
    cancel.add_argument("--id", required=True, dest="order_id")

    return parser


def main() -> None:
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
