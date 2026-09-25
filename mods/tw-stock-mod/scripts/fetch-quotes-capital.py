#!/usr/bin/env python3
"""
群益 Capital API (SKCOM) -> the runtime dir's stock-quotes.json and
stock-holdings.json (the band's override seams).

Where it writes: --out-dir, which defaults to the same runtime dir
hooks/register.tsx computes for --project (`<home>/.claude/stock-band/<project
-slug>/`, see runtimeDir() there and runtime_dir() below - the two must keep
computing the same string, including the Windows rules: `HOME` falls back to
`USERPROFILE`, and a slug turns `\\` and `:` into `-` the same way it turns
`/` into `-`). Every machine-written file - stock-quotes.json,
stock-holdings.json, the heartbeat, the log, the pid file, and SKCOM's own
CapitalLog folder - lives there, never in the project's `.claude/`.
--project only supplies the `tw` watchlist from
`<project>/.claude/stock-band.json` and, when --out-dir is not given, the
string the slug is built from.

Why a script and not another branch of the feed: SKCOM is an in-process COM
server with a login that holds a session and a quote subscription that only
updates while a Windows message pump is running. None of that can happen
inside the hooks module's JS sandbox the way Yahoo's and the exchange's plain
HTTP endpoints can. This logs in once, subscribes once, pumps messages on a
loop, and writes both files - a fresh quotes file wins over the built-in feed
(footer says 群益 即時), and the holdings file feeds the 損益 view (源 群益 庫存).

Windows only. SKCOM is a 32/64-bit COM DLL with no macOS or Linux build, so
this route simply does not exist off Windows - use 永豐 Shioaji there
(scripts/fetch-quotes-shioaji.py), which is the mirror image: POSIX only,
because the band spawns it with `nohup`.

Three ways to run it:
  * by hand - stop it with Ctrl-C, the band falls back to its own feed 120s
    later:

      python mods/tw-stock-mod/scripts/fetch-quotes-capital.py \
        --project . --interval 10

  * a one-off diagnostic - checks the platform, the interpreter's bitness,
    comtypes, the SKCOM registration, the env file, a real login, the quote
    host, every watchlist and index code, and the 證券 account behind the
    holdings query, then exits. Writes nothing but SKCOM's own log:

      python mods/tw-stock-mod/scripts/fetch-quotes-capital.py --check

  * spawned BY the band itself, when `stock-band.json` puts `"capital"` in
    `twSources` (hooks/register.tsx's feedTwCapital). That path always passes
    `--out-dir`, `--log`, `--detach`, `--heartbeat` and `--pidfile`:
      - `--detach`: this process re-launches itself detached (a real
        Windows DETACHED_PROCESS, since there is no `nohup` here) with its
        output pointed at --log, and returns at once. It is what lets the
        band's one-shot `$.process.run` resolve while the fetcher keeps
        going past it.
      - `--heartbeat FILE`: the band rewrites this file on every tick it
        wants the 群益 route. Once FILE is missing or more than 90s old this
        process exits by itself - the band closed, or moved to the US board,
        and nothing is watching anymore. It also exits (1) once the quote
        host has been down (or no snapshot has priced anything) for
        GIVE_UP_AFTER_S (60 s), so the band's respawn logs in again;
        while the host is down it writes no quotes at all, since SKCOM's
        cache would otherwise pass frozen prices off as fresh.
      - `--pidfile FILE`: if FILE already holds another live process's pid,
        this run exits at once (0) rather than double-fetching for the same
        project; otherwise it writes its own pid there and removes it on
        every way out. Two Claude Code sessions on the same project then share one
        fetcher instead of racing two logins - which matters more here than
        it does for 永豐, because SKCOM counts concurrent quote connections
        per account.

What you need:
  * a 群益 account with API 權限 開通 (證券帳戶 included - without one you
    cannot subscribe to 上市櫃 quotes at all, see the manual's 4-4-2 note)
  * the SKCOM 元件 registered once, as Administrator, from the SDK's
    `元件\\x64` folder (or `x86` for a 32-bit Python):

      regsvr32 SKCOM.dll

  * `pip install comtypes`, on the SAME bitness as the registered 元件
  * CAPITAL_USER_ID / CAPITAL_PASSWORD in an env file (never in the repo;
    --env, when not given, reads capital.env out of
    <home>/.claude/stock-band.json or --project's stock-band.json (project
    wins), falling back to ~/.capital.env when neither sets it)
  * --check verifies every line of the above, including a real login
"""
from __future__ import annotations  # defers `X | None` annotations so --check's own probe of "is this Python new enough" can run first

import argparse
import atexit
import calendar
import ctypes
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# the helpers every script here shares - scripts/_common.py, next to this file
from _common import (
    HEARTBEAT_MAX_AGE_MS,
    claim_pidfile,
    failed_ticks_limit,
    load_env,
    log,
    read_env_file,
    read_watchlist,
    release_pidfile,
    runtime_dir,
    user_home,
    utf8_stdio,
    write_atomic,
)


# What the band's footer calls this route, and what the 損益 view calls the
# positions. Both travel through the files as `source`.
SOURCE_LABEL = "群益 即時"
HOLDINGS_LABEL = "群益 庫存"

# OnConnection's nKind: 3001 connected, 3002 disconnected, 3003 stocks ready,
# 3021 connect error. Nothing may be subscribed or read before 3003 (manual
# 4-4-2's own 備註), so the startup below waits for that one.
CONNECTION_CONNECTED = 3001
CONNECTION_DISCONNECTED = 3002
CONNECTION_STOCKS_READY = 3003
CONNECTION_ERROR = 3021

# SKQuoteLib_IsConnected(): 0 斷線, 1 連線中, 2 下載中. The second readiness
# signal, and the useful one while waiting: after EnterMonitorLONG the SDK
# downloads the whole 商品檔 before it fires 3003, and this is what says so
# rather than leaving the wait looking hung.
QUOTE_STATE_DISCONNECTED = 0
QUOTE_STATE_READY = 1
QUOTE_STATE_DOWNLOADING = 2

PM_REMOVE = 0x0001  # PeekMessage: dispatch and remove, see Capital.pump()

# How long to give EnterMonitorLONG before calling it a failure. Measured
# 2026-09-18 with the pump in Capital.pump(): 2.5 s from EnterMonitorLONG to
# `IsConnected() == 1`. The budget is wide anyway - a first connect also
# downloads the 商品檔 (上市/上櫃/興櫃/期貨/選擇權), and a route that is merely
# slow to come up must not look like one that is broken.
CONNECT_TIMEOUT_DEFAULT = 90.0

# SKQuoteLib_RequestStocks takes a page number and a comma-joined code list.
# The manual pins both: "請固定帶1" for the page, and 100 codes per page
# ("如果帶入的股票數超過100檔，則僅以100檔處理"). The band caps a watchlist at
# 20, so the union with a portfolio is the only thing that could ever come
# near this.
QUOTE_PAGE_NO = 1
MAX_SUBSCRIBED_CODES = 100

# 發行量加權股價指數 / 櫃買指數, as SKCOM's own 商品代號. Latin names because
# the board flaps one character at a time and a Chinese character has no drum
# to riffle through.
#
# 群益's manual documents no index codes at all, so these were found by
# dumping `SKQuoteLib_RequestStockList` and verified against the exchange's
# own MIS endpoint (2026-09-18): TSEA 加權指 read 47004.27 against t00's
# 47001.67, OTCA 櫃檯指 read 409.11 against o00's 409.12, both with
# sDecimal 2. Do not "fix" these to TSE01/OTC01 - TSE01 is 水泥類股 (a sector
# index) and OTC01 does not resolve at all.
#
# An index only fills `nClose` once it has been SUBSCRIBED like any other
# product, which is why main() adds these to the RequestStocks list rather
# than just reading them out of the cache. Each is still probed at startup
# and dropped with a log line if it does not resolve, rather than written
# into the footer as a zero. `capital.indices` replaces the whole list.
DEFAULT_INDICES = [("TSEA", "TAIEX"), ("OTCA", "TPEx")]

# 未實現損益彙總's 交易種類代號 (field 27): 0 現股, 3 融資(自), 4 融券(自),
# 8 券差, 9 無券賣出. The last two are short positions, and the band's
# Holding.qty carries a short as a negative share count.
SHORT_TRADE_TYPES = {"4", "9"}

# OnProfitLossGWReport's first row is the query's own result: "000,訊息" on
# success, an error code and message otherwise.
PL_STATUS_OK = "000"

# GetProfitLossGWReport 未實現彙總 field positions, 0-based off the manual's
# own 1-based table (4-2-p OnProfitLossGWReport, 彙總資料格式).
PL_NAME = 0  # 股票名稱
PL_CODE = 1  # 股票代號
PL_QTY = 4  # 庫存股數
PL_PRICE = 5  # 市價
PL_CHANGE = 6  # 今日市價漲跌
PL_COST = 10  # 平均買進(券賣)成本
PL_TRADE_TYPE = 26  # 交易種類代號
PL_MIN_FIELDS = 27


def read_config_capital(*config_paths: Path) -> dict:
    """
    The `capital` block out of one or more stock-band.json files, same merge
    order as register.tsx's poll() (user-level file first, project file
    second - a later path's value wins). This is what keeps `--check` and a
    by-hand run with no flags honest about the dll path, env file and index
    codes a real spawn would actually use, instead of a fixed default that no
    configured project matches.
    """
    merged: dict = {}
    for config_path in config_paths:
        if not config_path.exists():
            continue
        try:
            root = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        block = root.get("capital") if isinstance(root, dict) else None
        if isinstance(block, dict):
            merged.update(block)
    return merged


def parse_indices(value) -> list[tuple[str, str]]:
    """`capital.indices` / --indices -> [(code, name)]; anything unusable falls back to DEFAULT_INDICES."""
    out: list[tuple[str, str]] = []
    if isinstance(value, str):
        # "TSEA:TAIEX,OTCA:TPEx" - what --indices takes on the command line
        for part in value.split(","):
            part = part.strip()
            if not part:
                continue
            code, _, name = part.partition(":")
            code = code.strip()
            if code:
                out.append((code, (name.strip() or code)))
    elif isinstance(value, list):
        for row in value:
            if isinstance(row, dict):
                code = str(row.get("code", "")).strip()
                if code:
                    out.append((code, str(row.get("name") or code)))
    return out or list(DEFAULT_INDICES)


# --- SKCOM plumbing ---------------------------------------------------------


class Capital:
    """
    One logged-in SKCOM session: the four lib objects, their event sinks, and
    the small amount of state the sinks collect. Everything that touches COM
    lives here so main() and run_check() can share the same startup without
    either one re-deriving the order the SDK insists on (SetLogPath ->
    Login -> EnterMonitorLONG -> wait for 3003 -> RequestStocks).
    """

    def __init__(self, dll_path: Path, log_dir: Path):
        self.dll_path = dll_path
        self.log_dir = log_dir
        self.connected = False
        self.connection_error = ""
        # every OnConnection nKind this session saw, in order - the one thing
        # that separates "the SDK is still downloading" from "the event sink
        # is not wired up at all", which look identical from a timeout
        self.connection_events: list[int] = []
        # OnProfitLossGWReport arrives one row per event with no documented
        # end-of-data marker, so rows are collected into a buffer that the
        # caller clears right before each query and reads after the pump
        # window closes - the window itself is the boundary.
        self.pl_rows: list[str] = []
        self.pl_status = ""
        self.accounts: list[tuple[str, str]] = []  # (市場, 分公司代碼+帳號)
        self._handlers: list = []

    def load(self) -> None:
        """Import comtypes, generate the SKCOMLib wrapper, create the objects."""
        import comtypes.client

        # Win32 message-pump plumbing, set up here rather than at module level
        # so `--help` and `--check`'s "wrong platform" line still work on a
        # machine where `ctypes.wintypes` cannot even be imported.
        import ctypes.wintypes as wintypes

        class MSG(ctypes.Structure):
            _fields_ = [
                ("hwnd", wintypes.HWND),
                ("message", wintypes.UINT),
                ("wParam", wintypes.WPARAM),
                ("lParam", wintypes.LPARAM),
                ("time", wintypes.DWORD),
                ("pt", wintypes.POINT),
            ]

        self._user32 = ctypes.windll.user32
        self._msg = MSG()

        # SKCOM.dll loads SecuCompx64.dll / libsolclient_64.dll / SKTradeLib.dll
        # out of its own folder. A COM server created through the registry is
        # loaded by the COM runtime, not by Python, so add_dll_directory alone
        # does not cover it - PATH does, and both are cheap.
        dll_dir = str(self.dll_path.parent)
        os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory") and self.dll_path.parent.exists():
            self._handlers.append(os.add_dll_directory(dll_dir))

        comtypes.client.GetModule(str(self.dll_path))
        import comtypes.gen.SKCOMLib as sk

        self.sk = sk
        self.client = comtypes.client
        self.center = comtypes.client.CreateObject(sk.SKCenterLib, interface=sk.ISKCenterLib)
        self.quote = comtypes.client.CreateObject(sk.SKQuoteLib, interface=sk.ISKQuoteLib)
        self.reply = comtypes.client.CreateObject(sk.SKReplyLib, interface=sk.ISKReplyLib)
        self.order = comtypes.client.CreateObject(sk.SKOrderLib, interface=sk.ISKOrderLib)

        owner = self

        class ReplyEvent:
            # SKCOM refuses to deliver quotes at all unless something is
            # sinking SKReplyLib - the examples register this before anything
            # else for that reason, not for the announcements themselves.
            def OnReplyMessage(self, bstrUserID, bstrMessages):
                return -1

        class QuoteEvent:
            def OnConnection(self, nKind, nCode):
                owner.connection_events.append(nKind)
                if nKind == CONNECTION_STOCKS_READY:
                    owner.connected = True
                elif nKind in (CONNECTION_DISCONNECTED, CONNECTION_ERROR):
                    owner.connected = False
                    owner.connection_error = owner.message(nKind)

        class OrderEvent:
            def OnAccount(self, bstrLogInID, bstrAccountData):
                # 『市場,分公司代碼,分公司,帳號,身份證字號,姓名』 - 證券 is
                # market "TS", and its account is 分公司代碼(4) + 帳號(7).
                parts = bstrAccountData.split(",")
                if len(parts) >= 4:
                    owner.accounts.append((parts[0].strip(), parts[1].strip() + parts[3].strip()))

            def OnProfitLossGWReport(self, bstrData):
                # The first row back is the query's own result ("000,訊息" on
                # success, an error code otherwise); every row after it is data.
                if not owner.pl_status:
                    owner.pl_status = bstrData
                else:
                    owner.pl_rows.append(bstrData)

        self._handlers.append(comtypes.client.GetEvents(self.reply, ReplyEvent()))
        self._handlers.append(comtypes.client.GetEvents(self.quote, QuoteEvent()))
        self._handlers.append(comtypes.client.GetEvents(self.order, OrderEvent()))

    def message(self, code: int) -> str:
        """SKCOM's own words for a return code - always worth printing over the bare number."""
        try:
            return f"{code} {self.center.SKCenterLib_GetReturnCodeMessage(code)}"
        except Exception:  # noqa: BLE001 - a code we cannot name is still a code
            return str(code)

    def pump(self, seconds: float) -> None:
        """
        Run the Windows message pump for `seconds`. Nothing from SKCOM
        happens without this: every callback (OnConnection, OnNotifyQuoteLONG,
        OnProfitLossGWReport) is delivered as a window message, the SDK's own
        商品檔 download is driven by them, and SKQuoteLib_GetStockByNoLONG only
        reads a cache those callbacks fill.

        🔴 This is a raw PeekMessage/DispatchMessage loop, NOT
        `comtypes.client.PumpEvents`, and the difference is not cosmetic.
        PumpEvents waits in `CoWaitForMultipleHandles`, and measured against
        SKCOM (2026-09-18) that delivers NOTHING: `IsConnected()` sat at 2
        (下載中) for a full 180 s and not one OnConnection arrived, while this
        loop reached 3003/`IsConnected() == 1` in 2.5 s with the same account
        on the same machine. 群益's own examples never hit this because they
        run inside Tkinter's `mainloop()`, which is exactly this loop.
        """
        # monotonic, not time.time(): this wait IS the fetcher's tick, and a
        # wall clock stepped back (NTP, a manual fix, resume from sleep)
        # would stretch it by the size of the step
        deadline = time.monotonic() + max(seconds, 0.0)
        msg = self._msg
        while True:
            while self._user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                self._user32.TranslateMessage(ctypes.byref(msg))
                self._user32.DispatchMessageW(ctypes.byref(msg))
            if time.monotonic() >= deadline:
                return
            # a short sleep rather than a spin: the callbacks that matter here
            # arrive on the order of seconds, not microseconds
            time.sleep(0.02)

    def login(self, user_id: str, password: str) -> None:
        self.center.SKCenterLib_SetLogPath(str(self.log_dir))
        code = self.center.SKCenterLib_Login(user_id, password)
        if code != 0:
            raise RuntimeError(f"SKCenterLib_Login 失敗: {self.message(code)}")

    def quote_state(self) -> int:
        """SKQuoteLib_IsConnected(): 0 斷線 / 1 連線中 / 2 下載中."""
        try:
            return int(self.quote.SKQuoteLib_IsConnected())
        except Exception:  # noqa: BLE001 - a state we cannot read reads as disconnected
            return QUOTE_STATE_DISCONNECTED

    def enter_monitor(self, timeout: float = CONNECT_TIMEOUT_DEFAULT, progress=None) -> None:
        """
        Connect the quote host and wait until it can actually answer.

        TWO signals, because either one alone has a failure mode: the
        `OnConnection` 3003 event is the documented one, and
        `SKQuoteLib_IsConnected() == 1` is the one that still works if the
        event is missed. Between EnterMonitorLONG and 3003 the SDK downloads
        the whole 商品檔 (上市/上櫃/興櫃/期貨/選擇權) and `IsConnected()`
        reports 2 the entire time - so `progress` gets called with that state
        and the wait says "還在下載商品檔" instead of looking hung.
        """
        code = self.quote.SKQuoteLib_EnterMonitorLONG()
        if code != 0:
            raise RuntimeError(f"SKQuoteLib_EnterMonitorLONG 失敗: {self.message(code)}")
        started = time.monotonic()
        deadline = started + timeout
        state = QUOTE_STATE_DISCONNECTED
        last_reported = None
        while time.monotonic() < deadline:
            self.pump(0.5)
            state = self.quote_state()
            if self.connected or state == QUOTE_STATE_READY:
                self.connected = True
                if progress and last_reported is not None:
                    progress(state, time.monotonic() - started)
                return
            if progress and state != last_reported:
                progress(state, time.monotonic() - started)
                last_reported = state
        seen = ",".join(str(k) for k in self.connection_events) or "（一個都沒有）"
        raise RuntimeError(
            f"等不到報價主機（等了 {timeout:.0f} 秒）。IsConnected={state}（0 斷線/1 連線中/2 下載中），"
            f"收到的 OnConnection nKind：{seen}。{self.connection_error}"
        )

    def subscribe(self, codes: list[str]) -> None:
        """
        One RequestStocks call covers the whole list. Unknown codes are
        skipped by the server without an error (manual 4-4-2), so a typo in
        the watchlist shows up as a missing row rather than a failed tick.
        """
        if not codes:
            return
        _, code = self.quote.SKQuoteLib_RequestStocks(QUOTE_PAGE_NO, ",".join(codes[:MAX_SUBSCRIBED_CODES]))
        if code != 0:
            raise RuntimeError(f"SKQuoteLib_RequestStocks 失敗: {self.message(code)}")

    def stock(self, code: str):
        """The SDK's cached SKSTOCKLONG for one code, or None if it has nothing."""
        page = self.sk.SKSTOCKLONG()
        page, ret = self.quote.SKQuoteLib_GetStockByNoLONG(code, page)
        return page if ret == 0 else None

    def init_order(self, user_id: str) -> str:
        """
        Bring SKOrderLib up far enough to run the holdings query, and return
        the 證券 account it found (empty string when there is none). The 憑證
        read is best-effort on purpose: 群益 requires it to place an order,
        and the query below may or may not depending on the account's own
        setup, so a failure here is logged and the query is still attempted -
        it either works or names its own reason.
        """
        code = self.order.SKOrderLib_Initialize()
        if code != 0:
            raise RuntimeError(f"SKOrderLib_Initialize 失敗: {self.message(code)}")
        cert = self.order.ReadCertByID(user_id)
        if cert != 0:
            log(f"ReadCertByID: {self.message(cert)}（只有下單一定要憑證，庫存查詢先照樣試）")
        self.accounts = []
        code = self.order.GetUserAccount()
        if code != 0:
            raise RuntimeError(f"GetUserAccount 失敗: {self.message(code)}")
        deadline = time.monotonic() + 10
        while not self.accounts and time.monotonic() < deadline:
            self.pump(0.2)
        for market, account in self.accounts:
            if market == "TS":
                return account
        return ""

    def request_holdings(self, user_id: str, account: str) -> None:
        """Fire 未實現損益彙總; the rows land in `pl_rows` during the next pump."""
        query = self.sk.TSPROFITLOSSGWQUERY()
        query.bstrFullAccount = account
        query.nTPQueryType = 0  # 未實現損益
        query.nFunc = 0  # 彙總
        query.bstrStockNo = ""
        query.bstrTradeType = ""
        self.pl_status = ""
        self.pl_rows = []
        code = self.order.GetProfitLossGWReport(user_id, query)
        if code != 0:
            raise RuntimeError(f"GetProfitLossGWReport 失敗: {self.message(code)}")

    def logout(self) -> None:
        try:
            self.quote.SKQuoteLib_LeaveMonitor()
        except Exception:  # noqa: BLE001 - leaving on the way out changes nothing
            pass


# --- payloads ---------------------------------------------------------------


def connect_progress(state: int, elapsed: float) -> None:
    """What `enter_monitor` prints while the 商品檔 download runs."""
    if state == QUOTE_STATE_DOWNLOADING:
        log(f"連上報價主機了，正在下載商品檔…（{elapsed:.0f} 秒）")
    elif state == QUOTE_STATE_READY:
        log(f"報價主機就緒（{elapsed:.0f} 秒）")
    elif state == QUOTE_STATE_DISCONNECTED:
        log(f"還沒連上報價主機…（{elapsed:.0f} 秒）")


def to_float(value: str) -> float:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return 0.0


def divisor(stock) -> float:
    """
    SKSTOCKLONG carries every price as an integer plus `sDecimal`, the number
    of decimal places it was scaled by - 台積電 at 1188.0 comes back as
    118800 with sDecimal 2. The examples hardcode /100.0; reading sDecimal
    instead is what keeps a 4-decimal product (匯率類, sDecimal 4) right.
    """
    places = int(getattr(stock, "sDecimal", 2) or 0)
    return float(10 ** places) if places > 0 else 1.0


def stock_traded_at(stock) -> int:
    """
    `nTradingDay` (YYYYMMDD) + `nDealTime` (hhmmss) in exchange-local terms ->
    epoch ms. Taipei is UTC+8 all year, so the conversion is one subtraction
    off UTC and does not depend on the machine's own timezone - the band
    prints this as 更新, and a laptop set to another zone must not move it.
    Returns 0 when the SDK has no trade stamped yet (pre-open), and the
    caller falls back to its own clock.
    """
    day = int(getattr(stock, "nTradingDay", 0) or 0)
    if day < 19700101:
        return 0
    deal = int(getattr(stock, "nDealTime", 0) or 0)
    year, month, dom = day // 10000, (day // 100) % 100, day % 100
    hour, minute, second = deal // 10000, (deal // 100) % 100, deal % 100
    try:
        utc = calendar.timegm((year, month, dom, hour, minute, second, 0, 0, 0))
    except (ValueError, OverflowError):
        return 0
    return (utc - 8 * 3600) * 1000


def quote_rows(api: Capital, codes: list[str], watchlist_names: dict) -> dict:
    """code -> {price, prevClose, name, ts}. A code the SDK has no price for is left out."""
    out: dict = {}
    for code in codes:
        stock = api.stock(code)
        if stock is None:
            continue
        scale = divisor(stock)
        price = float(getattr(stock, "nClose", 0) or 0) / scale
        if price <= 0:
            # Pre-open, or a code the server skipped: writing 昨收 here would
            # look like a 平盤 trade that never happened, so the row is
            # dropped and the band falls through to its next source instead.
            continue
        out[code] = {
            "price": price,
            "prevClose": float(getattr(stock, "nRef", 0) or 0) / scale,
            # the SDK's own 商品名稱 is the one source that is always right
            # when it has an answer; the watchlist's name is the fallback,
            # and the bare code the last resort
            "name": str(getattr(stock, "bstrStockName", "") or "") or watchlist_names.get(code) or code,
            "ts": stock_traded_at(stock),
        }
    return out


def build_payload(api: Capital, codes: list[str], indices: list[tuple[str, str]], watchlist_names: dict) -> dict | None:
    quotes = quote_rows(api, codes, watchlist_names)
    if not quotes:
        return None

    now_ms = int(time.time() * 1000)
    traded = max((row.pop("ts", 0) for row in quotes.values()), default=0)

    index_rows = []
    for code, name in indices:
        row = quote_rows(api, [code], {}).get(code)
        if not row:
            continue
        prev = row["prevClose"] or row["price"]
        index_rows.append(
            {
                "name": name,
                "value": round(row["price"], 2),
                "change": round(row["price"] - prev, 2),
                "pct": round((row["price"] - prev) / prev * 100, 2) if prev else 0,
            }
        )

    payload = {
        "asOf": now_ms,
        "dataAt": traded or now_ms,
        "market": "tw",
        "source": SOURCE_LABEL,
        "quotes": {
            code: {"price": round(row["price"], 4), "prevClose": round(row["prevClose"], 4), "name": row["name"]}
            for code, row in quotes.items()
        },
    }
    if index_rows:
        payload["indices"] = index_rows
        payload["index"] = {k: v for k, v in index_rows[0].items() if k != "name"}
    return payload


def pl_report_problem(status: str, rows: list[str]) -> str | None:
    """
    What is wrong with one 未實現損益 answer, as a log line, or None when
    nothing is. A report with rows is used whatever its status says (the
    rows are the evidence); one with no rows is only fine when the status
    says the query succeeded - a holder with nothing held.
    """
    if rows:
        return None
    if not status:
        return "庫存查詢這輪沒有回應（保留上一份檔案）"
    if status.split(",", 1)[0].strip() != PL_STATUS_OK:
        return f"庫存查詢失敗（保留上一份檔案）: {status.strip()}"
    return None


def pl_answered_empty(status: str, rows: list[str]) -> bool:
    """A successful 未實現損益 answer with no rows: nothing is held."""
    return not rows and status.split(",", 1)[0].strip() == PL_STATUS_OK


class HeldCodes:
    """
    The held codes the quote subscription carries on top of the watchlist.

    A code the latest answer adds is taken at once - it needs a live price
    now. A code it drops is only let go once two answers in a row agree: the
    pump window can end while OnProfitLossGWReport rows are still arriving,
    and a partial answer must not unsubscribe a position for one tick and
    subscribe it again on the next.
    """

    def __init__(self) -> None:
        self.codes: list[str] = []
        self._dropping: list[str] | None = None  # the last answer that dropped codes

    def update(self, seen: list[str]) -> bool:
        """Fold one answer's held codes in; True when `codes` changed."""
        if all(code in seen for code in self.codes):
            self._dropping = None
            if seen == self.codes:
                return False
            self.codes = list(seen)
            return True
        confirmed = self._dropping == seen
        self._dropping = None if confirmed else list(seen)
        new = list(seen) if confirmed else self.codes + [c for c in seen if c not in self.codes]
        if new == self.codes:
            return False
        self.codes = new
        return True


def held_outside(watch: list[str], holdings_payload: dict) -> list[str]:
    """The held codes the watchlist does not already cover, in holdings order."""
    out: list[str] = []
    for row in holdings_payload["holdings"]:
        if row["code"] not in watch and row["code"] not in out:
            out.append(row["code"])
    return out


def build_holdings_payload(rows: list[str], quotes: dict) -> dict | None:
    """
    OnProfitLossGWReport's 未實現彙總 rows -> the holdings file's shape (see
    references/quote-sources.md's 損益 section and
    stock-holdings.example.json). `price`/`prevClose` are a fallback only -
    the band prefers whatever the quotes file already says for that code,
    which is why the quotes fetch covers the watchlist UNION every held code.
    """
    holdings = []
    for row in rows:
        fields = row.split(",")
        if len(fields) < PL_MIN_FIELDS:
            continue
        code = fields[PL_CODE].strip()
        qty = to_float(fields[PL_QTY])
        if not code or qty == 0:
            continue
        if fields[PL_TRADE_TYPE].strip() in SHORT_TRADE_TYPES:
            qty = -qty  # a short - the qty sign carries it through the P&L math
        live = quotes.get(code)
        price = live["price"] if live else to_float(fields[PL_PRICE])
        if live:
            prev_close = live["prevClose"]
        else:
            # 市價 minus 今日市價漲跌 is 群益's own basis for the day's move,
            # which stays right through an ex-dividend date the way a plain
            # "yesterday's close" does not
            prev_close = to_float(fields[PL_PRICE]) - to_float(fields[PL_CHANGE])
        holdings.append(
            {
                "code": code,
                "name": fields[PL_NAME].strip() or code,
                "qty": qty,
                "cost": round(to_float(fields[PL_COST]), 4),
                "price": round(price, 4),
                "prevClose": round(prev_close or price, 4),
            }
        )
    if not holdings:
        return None
    return {"asOf": int(time.time() * 1000), "market": "tw", "source": HOLDINGS_LABEL, "holdings": holdings}


# --- process plumbing (shared shape with fetch-quotes-shioaji.py) -----------


def heartbeat_ts(text: str) -> float | None:
    """The heartbeat's timestamp (ms), from either shape the band writes: a
    bare number, or `{"ts": ms, "markets": [...]}` (what hooks/register.tsx
    writes since the 台指期 route - `markets` is the 永豐 fetcher's business,
    this route serves 台股 alone and only needs `ts`). None for anything else."""
    text = text.strip()
    try:
        return float(text)
    except ValueError:
        pass
    try:
        root = json.loads(text)
    except ValueError:
        return None
    if not isinstance(root, dict) or not isinstance(root.get("ts"), (int, float)):
        return None
    return float(root["ts"])


def heartbeat_stale(path: Path) -> bool:
    """Missing, unreadable, unparseable, or older than HEARTBEAT_MAX_AGE_MS - all read as stale."""
    if not path.exists():
        return True
    try:
        ts = heartbeat_ts(path.read_text(encoding="utf-8"))
    except OSError:
        return True
    if ts is None:
        return True
    return (time.time() * 1000 - ts) > HEARTBEAT_MAX_AGE_MS


def relaunch_detached(log_path: Path) -> None:
    """
    `--detach`: hand the real work to a DETACHED_PROCESS child and return, so
    the band's one-shot `$.process.run` resolves at once instead of waiting
    out a long-lived fetcher's pipes. This is the Windows counterpart of the
    `nohup ... &` wrapper hooks/register.tsx uses for the 永豐 route; there is
    no `nohup` here, and `start /b` would put the quoting of a python path
    with spaces in cmd.exe's hands, so the child is launched from Python
    where the argument list stays a list.
    """
    argv = [sys.executable, os.path.abspath(__file__)] + [a for a in sys.argv[1:] if a != "--detach"]
    log_path.parent.mkdir(parents=True, exist_ok=True)
    flags = 0
    flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
    flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with open(log_path, "a", encoding="utf-8", errors="replace") as log:
        subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            creationflags=flags,
            close_fds=True,
            cwd=str(log_path.parent),
        )


# --- --check ----------------------------------------------------------------


def check_platform() -> bool:
    if sys.platform != "win32":
        print(f"❌ 平台 {sys.platform}：SKCOM 只有 Windows 版，macOS／Linux 請改用永豐 Shioaji 路線")
        return False
    print(f"✅ 平台 {sys.platform}")
    return True


def check_bitness() -> None:
    import struct

    bits = struct.calcsize("P") * 8
    folder = "x64" if bits == 64 else "x86"
    print(f"ℹ️  Python {sys.version_info.major}.{sys.version_info.minor}，{bits} 位元（要註冊 SDK 的 元件\\{folder} 那份 SKCOM.dll）")


def check_comtypes() -> bool:
    try:
        import comtypes  # noqa: F401
    except ImportError as err:
        print(f"❌ import comtypes 失敗（{err}），跑 pip install comtypes")
        return False
    print("✅ import comtypes 成功")
    return True


def check_dll(dll_path: Path) -> bool:
    if not dll_path.exists():
        print(f"❌ 找不到 SKCOM.dll：{dll_path}（把 SDK 解壓到固定位置，再用 stock-band.json 的 capital.dll 指過去）")
        return False
    print(f"✅ SKCOM.dll 在：{dll_path}")
    return True


def check_env_file(env_path: Path) -> tuple[bool, dict]:
    """Returns (兩個欄位都有值, 讀到的值) - the values are only used to try a login and are never printed."""
    if not env_path.exists():
        print(f"❌ env 檔不存在：{env_path}")
        return False, {}
    print(f"✅ env 檔存在：{env_path}")
    values = read_env_file(env_path)
    ok = True
    for key in ("CAPITAL_USER_ID", "CAPITAL_PASSWORD"):
        has_value = bool(values.get(key))
        print(f"✅ {key} 有值" if has_value else f"❌ {key} 沒有值")
        ok = ok and has_value
    return ok, values


def run_check(args, dll_path: Path, log_dir: Path, codes: list[str], indices: list[tuple[str, str]]) -> bool:
    """--check: print each diagnostic line, write nothing but SKCOM's own log."""
    print("== 群益 Capital API 診斷 ==")
    ok_platform = check_platform()
    check_bitness()
    ok_comtypes = check_comtypes()
    ok_dll = check_dll(dll_path)
    ok_env, values = check_env_file(Path(args.env).expanduser())
    if not (ok_platform and ok_comtypes and ok_dll and ok_env):
        print("❌ 前面的項目沒過，登入與報價測試略過")
        return False

    api = Capital(dll_path, log_dir)
    try:
        api.load()
    except Exception as err:  # noqa: BLE001 - surfacing whatever COM raised is the point of --check
        print(f"❌ 建立 SKCOM 物件失敗：{type(err).__name__}: {err}")
        print("   多半是元件沒註冊：用系統管理員開命令提示字元，到 SDK 的 元件\\x64 資料夾跑 regsvr32 SKCOM.dll")
        return False
    print("✅ SKCOM 元件建立成功（已註冊）")

    try:
        api.login(values["CAPITAL_USER_ID"], values["CAPITAL_PASSWORD"])
    except Exception as err:  # noqa: BLE001
        print(f"❌ 登入失敗：{err}")
        return False
    print("✅ 登入成功")

    try:
        api.enter_monitor(timeout=args.connect_timeout, progress=lambda st, el: print(f"   …IsConnected={st}（{el:.0f} 秒）"))
    except Exception as err:  # noqa: BLE001
        print(f"❌ 連報價主機失敗：{err}")
        return False
    print("✅ 報價主機已連上（可以出價了）")

    try:
        api.subscribe(codes + [c for c, _ in indices])
    except Exception as err:  # noqa: BLE001
        print(f"❌ 訂閱失敗：{err}")
        return False
    api.pump(3)
    print(f"✅ 已訂閱 {len(codes)} 檔觀察清單 + {len(indices)} 個指數")

    missing = []
    for code in codes:
        stock = api.stock(code)
        if stock is None:
            missing.append(code)
            continue
        scale = divisor(stock)
        name = str(getattr(stock, "bstrStockName", "") or "")
        print(f"   {code} {name}  成交 {float(stock.nClose) / scale:g}  昨收 {float(stock.nRef) / scale:g}")
    if missing:
        print(f"⚠️  查不到報價的代號：{','.join(missing)}（收盤前沒成交也會這樣，盤中還是空的才是代號錯）")

    for code, name in indices:
        stock = api.stock(code)
        if stock is None:
            print(f"❌ 指數 {name}（{code}）查不到 — 在 stock-band.json 的 capital.indices 換成正確代號，或設成 [] 不顯示")
        else:
            print(f"✅ 指數 {name}（{code}）= {float(stock.nClose) / divisor(stock):g}")

    try:
        account = api.init_order(values["CAPITAL_USER_ID"])
    except Exception as err:  # noqa: BLE001
        print(f"⚠️  下單元件初始化失敗：{err}（只影響損益庫存，報價照常）")
        account = ""
    if account:
        print(f"✅ 證券帳號：{account[:4]}-{account[4:7]}***")
        try:
            api.request_holdings(values["CAPITAL_USER_ID"], account)
            api.pump(5)
            holdings = build_holdings_payload(api.pl_rows, {})
            count = len(holdings["holdings"]) if holdings else 0
            print(f"✅ 未實現損益查詢回來 {count} 檔庫存（查詢結果：{api.pl_status.split(',')[0] or '無'}）")
        except Exception as err:  # noqa: BLE001
            print(f"⚠️  庫存查詢失敗：{err}（報價照常，損益檢視會退回手動 holdings 設定）")
    else:
        print("⚠️  找不到證券帳號（市場別 TS）— 沒簽證券 API 下單聲明書的話，損益庫存查不到，報價照常")

    api.logout()
    return True


# --- main -------------------------------------------------------------------


def main() -> None:
    utf8_stdio()  # before argparse, so even --help survives a cp1252 pipe
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.getcwd(), help="the project whose .claude/stock-band.json holds the `tw` watchlist; also, when --out-dir is unset, what the runtime-dir slug is built from")
    parser.add_argument("--out-dir", default="", help="where stock-quotes.json / stock-holdings.json go; default is the same runtime dir hooks/register.tsx computes for --project")
    parser.add_argument("--env", default=None, help="file holding CAPITAL_USER_ID / CAPITAL_PASSWORD; defaults to whatever capital.env the stock-band.json files set (project wins), falling back to ~/.capital.env")
    parser.add_argument("--dll", default=None, help="path to the registered SKCOM.dll; defaults to capital.dll out of stock-band.json")
    parser.add_argument("--indices", default=None, help='footer indices as "CODE:NAME,CODE:NAME"; defaults to capital.indices, then TSEA:TAIEX,OTCA:TPEx')
    parser.add_argument("--interval", type=float, default=10, help="seconds between snapshots; 0 writes once and exits")
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=CONNECT_TIMEOUT_DEFAULT,
        help="seconds to wait for the quote host after EnterMonitorLONG; the SDK downloads the whole 商品檔 first, which is the slow part",
    )
    parser.add_argument("--codes", default="", help="comma-separated codes, overriding the band's own watchlist")
    parser.add_argument("--heartbeat", default="", help="path the band keeps rewriting while it wants this route; missing or >90s old exits this process (empty disables the check, for a by-hand run)")
    parser.add_argument("--pidfile", default="", help="path holding this fetcher's pid; a live pid already there exits this run at once instead of double-fetching the same project")
    parser.add_argument("--log", default="", help="with --detach, where the detached child's output goes")
    parser.add_argument("--detach", action="store_true", help="re-launch self detached and return at once (what the band spawns with; there is no nohup on Windows)")
    parser.add_argument("--check", action="store_true", help="diagnose the environment (platform, bitness, comtypes, SKCOM registration, env file, a real login, the quote host, every code, the 證券 account) and exit")
    args = parser.parse_args()
    # (stdout/stderr are UTF-8 already: utf8_stdio() at the top of main,
    # before argparse, so --help and --check's ✅/❌ survive a detached
    # child's plain file handle too)

    # Not `.resolve()`: that would follow symlinks and could reshape this
    # string differently than $.session.cwd() does on the TS side, landing a
    # manual run's files in a directory the band never looks at. abspath only
    # normalizes "." / ".." / a trailing slash, same as Node's path.resolve.
    project_str = os.path.abspath(os.path.expanduser(args.project))
    project = Path(project_str)
    home = user_home()

    # Config-backed defaults, read the same way and in the same order the
    # band itself would (user-level file, then project file - project wins),
    # so `--check` and a by-hand run agree with what a real spawn uses.
    config_paths = [project / ".claude" / "stock-band.json"]
    if home:
        config_paths.insert(0, Path(home) / ".claude" / "stock-band.json")
    block = read_config_capital(*config_paths)
    if args.env is None:
        args.env = str(block.get("env") or "~/.capital.env")
    if args.dll is None:
        args.dll = str(block.get("dll") or "")
    indices = parse_indices(args.indices if args.indices is not None else block.get("indices"))

    if not args.dll:
        sys.exit(
            "ERROR: 不知道 SKCOM.dll 在哪。把 SDK 解壓到固定位置（例如 "
            "%LOCALAPPDATA%\\CapitalAPI），再在 stock-band.json 設 "
            '"capital": { "dll": "...\\\\元件\\\\x64\\\\SKCOM.dll" }，或用 --dll 指定'
        )

    # Resolve every path arg against the caller's cwd now, before the chdir
    # below reshapes what "relative" means.
    args.env = os.path.abspath(os.path.expanduser(args.env))
    dll_path = Path(os.path.abspath(os.path.expanduser(args.dll)))
    if args.heartbeat:
        args.heartbeat = os.path.abspath(os.path.expanduser(args.heartbeat))
    if args.pidfile:
        args.pidfile = os.path.abspath(os.path.expanduser(args.pidfile))
    if args.log:
        args.log = os.path.abspath(os.path.expanduser(args.log))

    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else runtime_dir(home, project_str)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.detach:
        relaunch_detached(Path(args.log) if args.log else out_dir / "stock-capital.log")
        return

    # SKCenterLib_SetLogPath points SKCOM's own CapitalLog folder here rather
    # than at the caller's repo; chdir covers anything else in the SDK that
    # writes relative to the process.
    log_dir = out_dir / "CapitalLog"
    log_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(out_dir)

    if args.codes:
        watchlist = [{"code": c.strip(), "name": c.strip()} for c in args.codes.split(",") if c.strip()]
    else:
        watchlist = read_watchlist(project / ".claude" / "stock-band.json")
    watchlist_names = {row["code"]: row["name"] for row in watchlist}
    codes = [row["code"] for row in watchlist]

    if args.check:
        sys.exit(0 if run_check(args, dll_path, log_dir, codes, indices) else 1)

    out_path = out_dir / "stock-quotes.json"
    holdings_path = out_dir / "stock-holdings.json"

    pidfile = Path(args.pidfile).expanduser().resolve() if args.pidfile else None
    if pidfile and not claim_pidfile(pidfile):
        log(f"另一個 fetcher 已經在跑這個專案（{pidfile} 裡的 pid 還活著），這次略過")
        return
    heartbeat_path = Path(args.heartbeat).expanduser().resolve() if args.heartbeat else None

    # From here on every way out - a sys.exit below, a failed login, a
    # connect timeout - logs out and gives the pidfile back. The loop's own
    # `finally` covers the normal path; atexit covers everything before it,
    # which used to leave the pidfile behind.
    api = None

    def cleanup() -> None:
        nonlocal api
        if api is not None:
            try:
                api.logout()
            except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
                pass
            api = None
            log("群益 已離線")
        if pidfile:
            release_pidfile(pidfile)

    atexit.register(cleanup)

    load_env(Path(args.env), "CAPITAL_USER_ID / CAPITAL_PASSWORD")
    for key in ("CAPITAL_USER_ID", "CAPITAL_PASSWORD"):
        if not os.environ.get(key):
            sys.exit(f"ERROR: {key} 沒設")

    api = Capital(dll_path, log_dir)
    try:
        api.load()
    except Exception as err:  # noqa: BLE001 - the one failure worth spelling out, because the fix is a single command
        sys.exit(
            f"ERROR: 建立 SKCOM 物件失敗（{type(err).__name__}: {err}）。"
            "多半是元件沒註冊：用系統管理員身分在 SDK 的 元件\\x64 資料夾跑 regsvr32 SKCOM.dll"
        )

    log("群益 登入中…")
    api.login(os.environ["CAPITAL_USER_ID"], os.environ["CAPITAL_PASSWORD"])
    api.enter_monitor(timeout=args.connect_timeout, progress=connect_progress)

    # The holdings query is a bonus, not a precondition: an account with no
    # 證券 API 下單聲明書 signed still gets quotes, and the 損益 view falls
    # back to whatever `holdings` the config carries.
    account = ""
    try:
        account = api.init_order(os.environ["CAPITAL_USER_ID"])
        if not account:
            log("查不到證券帳號（市場別 TS），這次只出報價")
    except Exception as err:  # noqa: BLE001
        log(f"下單元件初始化失敗（只影響庫存）: {type(err).__name__}: {err}")

    if not codes and not account:
        sys.exit(
            f"ERROR: 找不到台股清單（{project}\\.claude\\stock-band.json 的 `tw`）也查不到庫存部位，"
            "或用 --codes 指定"
        )

    # The quotes fetch covers the watchlist UNION every held code, so a
    # holding that never made the watchlist still gets a live price here -
    # build_holdings_payload prefers exactly that over its own fallback. The
    # initial subscribe is the watchlist; each holdings file written re-sets
    # the held part to what that file holds, so a sold position stops being
    # subscribed and priced rather than riding along until the next restart.
    watch = list(codes)
    held = HeldCodes()
    subscribed: list[str] = []

    def resubscribe(wanted: list[str]) -> None:
        nonlocal subscribed
        if wanted == subscribed:
            return
        api.subscribe(wanted)
        subscribed = list(wanted)

    resubscribe(codes + [c for c, _ in indices])

    first_tick = True
    last_pl_problem: str | None = None  # logged once per change, not every tick
    empty_answers = 0  # consecutive successful P/L answers with no rows
    failed_ticks = 0  # consecutive ticks that wrote no quotes (link down, raised, or nothing priced)
    give_up_at = failed_ticks_limit(args.interval)
    try:
        while True:
            # Heartbeat check first, before doing any work this tick: a stale
            # heartbeat means nobody is watching Taiwan anymore (band closed,
            # or on the US board). The very first tick is exempt because the
            # band writes the heartbeat moments BEFORE spawning this process.
            if heartbeat_path and not first_tick and heartbeat_stale(heartbeat_path):
                log(f"心跳逾時（{heartbeat_path} 沒人更新），結束")
                break
            first_tick = False

            if account:
                try:
                    api.request_holdings(os.environ["CAPITAL_USER_ID"], account)
                except Exception as err:  # noqa: BLE001 - keep pumping; the quotes half of the tick still works
                    log(f"庫存查詢送出失敗（保留上一份）: {type(err).__name__}: {err}")

            # The pump IS the tick: SKCOM only moves prices into its cache
            # while messages are being dispatched, and the holdings rows
            # requested just above arrive during the same window.
            api.pump(max(args.interval, 1.0) if args.interval > 0 else 3.0)

            # SKCOM keeps answering from its cache after the quote host drops
            # (OnConnection 3002/3021), so a snapshot taken now would stamp a
            # frozen price with a fresh asOf and the band would keep calling
            # it 群益 即時. Write nothing while the link is down: the file goes
            # stale, the band says so, and past GIVE_UP_AFTER_S this exits so
            # the band's respawn logs in again. Down is EITHER signal saying
            # so: OnConnection's 3002/3021 clears `connected` even while
            # IsConnected() may still read 1, and a reconnect whose 3003 was
            # missed costs one clean respawn, never a frozen price.
            payload = None
            if not api.connected or api.quote_state() != QUOTE_STATE_READY:
                log(f"報價主機斷線（保留上一份檔案）{api.connection_error}")
            else:
                try:
                    payload = build_payload(api, codes, indices, watchlist_names)
                except Exception as err:  # noqa: BLE001 - any COM error is the same story here
                    log(f"快照失敗（保留上一份檔案）: {type(err).__name__}: {err}")
            # only a written file counts as alive: a link that reads READY but
            # prices nothing (subscriptions lost on a silent reconnect) is as
            # dead as one that is down
            failed_ticks = 0 if payload else failed_ticks + 1
            if failed_ticks >= give_up_at:
                log(f"連續 {failed_ticks} 輪沒有報價，結束讓 band 重新登入")
                sys.exit(1)
            if payload:
                write_atomic(out_path, payload)
                stamp = time.strftime("%H:%M:%S", time.localtime(payload["dataAt"] / 1000))
                log(f"{len(payload['quotes'])} 檔 -> {out_path}（資料 {stamp}）")
            # a failed snapshot leaves the file alone: the band drops a file
            # older than 120 s by itself and says so, which beats a stale
            # price that still looks live

            if account:
                problem = pl_report_problem(api.pl_status, api.pl_rows)
                if problem != last_pl_problem:
                    log(problem or "庫存查詢恢復正常")
                    last_pl_problem = problem
                try:
                    holdings_payload = build_holdings_payload(api.pl_rows, payload["quotes"] if payload else {})
                except Exception as err:  # noqa: BLE001 - same story as the quotes snapshot
                    log(f"庫存快照失敗（保留上一份檔案）: {type(err).__name__}: {err}")
                    holdings_payload = None
                answered_empty = pl_answered_empty(api.pl_status, api.pl_rows)
                empty_answers = empty_answers + 1 if answered_empty else 0
                if holdings_payload:
                    write_atomic(holdings_path, holdings_payload)
                    log(f"{len(holdings_payload['holdings'])} 檔庫存 -> {holdings_path}")
                elif empty_answers == 2:
                    # everything sold, and two answers in a row say so: an
                    # empty file replaces the last positions (the band then
                    # falls back to the config's holdings, as with no file)
                    write_atomic(holdings_path, {"asOf": int(time.time() * 1000), "market": "tw", "source": HOLDINGS_LABEL, "holdings": []})
                    log(f"0 檔庫存（全部出清）-> {holdings_path}")
                # a held code that never made the watchlist still needs a
                # live price, and a sold one no longer does: the subscription
                # follows the answers (HeldCodes), and the next tick prices
                # the new set. No usable answer this tick changes nothing.
                seen = held_outside(watch, holdings_payload) if holdings_payload else ([] if answered_empty else None)
                if seen is not None and held.update(seen):
                    codes = watch + held.codes
                    resubscribe(codes + [c for c, _ in indices])

            if args.interval <= 0:
                break
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()


if __name__ == "__main__":
    main()
