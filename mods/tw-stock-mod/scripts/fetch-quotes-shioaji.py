#!/usr/bin/env python3
"""
永豐 Shioaji -> the runtime dir's stock-quotes.json and stock-holdings.json
(the band's override seams).

Where it writes: --out-dir, which defaults to the same runtime dir
hooks/register.tsx computes for --project (`$HOME/.claude/stock-band/<project
-slug>/`, see runtimeDir() there and runtime_dir() below - the two must keep
computing the same string). Every machine-written file - stock-quotes.json,
stock-holdings.json, the heartbeat, the log, the pid file - lives there, never
in the project's `.claude/`. --project only supplies the `tw` watchlist from
`<project>/.claude/stock-band.json` and, when --out-dir is not given, the
string the slug is built from.

Shioaji itself also writes a shioaji.log, into whatever directory the
process happens to be running from - the SDK gives no way to point that log
elsewhere. main() therefore chdir()s into out_dir (creating it first) before
shioaji is imported anywhere, --check included, so that log lands next to
our own output instead of in the caller's repo.

Why a script and not another branch of the feed: Shioaji is a Python SDK with
a login that takes seconds and holds a session, so it cannot be called from
the hooks module the way the exchange's and Yahoo's plain HTTP endpoints are.
This logs in once, writes both files on a loop, and the band picks them up -
a fresh quotes file wins over the built-in feed (footer says 永豐 即時), and the
holdings file feeds the 損益 view (source label 永豐 庫存).

Three ways to run it:
  * by hand, same as before - stop it with Ctrl-C, the band falls back to its
    own feed 120s later:

      python3 mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
        --project . --interval 10

  * a one-off diagnostic - checks the Python version, the shioaji install,
    the env file, a real login, and the platform, then exits. Writes nothing,
    needs no --codes:

      python3 mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py --check

  * spawned BY the band itself, when `stock-band.json` sets
    `"twSource": "shioaji"` (hooks/register.tsx's spawnShioaji). That path
    always passes `--out-dir`, `--heartbeat` and `--pidfile`:
      - `--heartbeat FILE`: the band rewrites this file on every tick it
        wants the Shioaji route, as `{"ts": <ms>, "markets": ["tw", "tf"]}`
        naming which markets to work this tick (stock rows only while "tw"
        is listed, futures rows only while "tf" is). A bare ms number - what
        a pre-T4 band wrote - still reads as both markets, for one release.
        Once FILE is missing or its `ts` is more than 90s old, this process
        exits by itself - the band closed, or stopped wanting either market,
        and nothing is watching anymore. It also exits (1) after
        MAX_FAILED_TICKS ticks in a row where every snapshot raised - a dead
        session - so the band's respawn logs in again.
      - `--pidfile FILE`: if FILE already holds another live process's pid,
        this run exits at once (0) rather than double-fetching for the same
        project; otherwise it writes its own pid there and removes it on
        every way out (a failed login included), unless a successor has
        already claimed it. Two Claude Code sessions on the same project then share one
        fetcher instead of racing two logins.

What you need:
  * a 永豐金 account with the API enabled and 簽署中心 passed
  * SINOBON_API_KEY / SINOBON_SECRET_KEY in an env file (never in the repo;
    --env, when not given, reads shioaji.env out of ~/.claude/stock-band.json
    or --project's stock-band.json (project wins), falling back to
    ~/.sinobon.env when neither sets it - see read_config_shioaji_env())
  * shioaji installed on Python 3.10-3.13 (3.12/3.13 is what SinoPac tests
    against) - `--check` verifies all of this, including a real login
"""
from __future__ import annotations  # defers `X | None` annotations so --check's own probe of "is this Python new enough" can run first, even on Python 3.9

import argparse
import atexit
import json
import math
import os
import queue
import signal
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import NamedTuple

HEARTBEAT_MAX_AGE_MS = 90_000
HEARTBEAT_MARKETS = frozenset({"tw", "tf"})  # the markets a heartbeat can ask this fetcher to work
# Consecutive ticks in which every snapshot the tick attempted raised before
# the fetcher gives up and exits for a fresh login - 6 x the default 10 s
# interval, about a minute, well inside the band's own 120 s staleness window.
MAX_FAILED_TICKS = 6

# 發行量加權股價指數 / 櫃買指數. Latin names because the board flaps one
# character at a time and a Chinese character has no drum to riffle through.
INDICES = [
    ("TSE", "IX0001", "TAIEX"),
    ("OTC", "IX0043", "TPEx"),
]
# Shioaji stamps a snapshot with Taipei wall-clock time counted as if it were
# UTC, so a snapshot taken at 10:55 comes back as an epoch that reads 18:55.
# Measured 2026-09-16: ts was exactly 8 h ahead of the real clock. Taipei is
# UTC+8 all year, so one subtraction fixes it - and it has to be fixed here,
# because the band prints this as 更新.
TAIPEI_OFFSET_MS = 8 * 3600 * 1000


RUNTIME_DIR_ROOT = ".claude/stock-band"


def runtime_dir(home: str, project: str) -> Path:
    """
    Same rule as hooks/register.tsx's runtimeDir(): RUNTIME_DIR_ROOT plus the
    project path with its leading "/" dropped and every remaining "/" turned
    into "-" (e.g. `/Users/x/app` -> `Users-x-app`). `project` must already
    be the same normalized absolute string register.tsx would compute (see
    main()'s use of this) - a symlink-resolved or otherwise reshaped string
    here would land manual runs and the band in two different directories.
    `home` falls back to the project's own `.claude/` only when $HOME is
    unset, matching the TS side.
    """
    if not home:
        return Path(project) / ".claude"
    slug = project.lstrip("/").replace("/", "-")
    return Path(home) / RUNTIME_DIR_ROOT / slug


def load_env(path: Path) -> None:
    if not path.exists():
        sys.exit(f"ERROR: {path} 不存在（要有 SINOBON_API_KEY / SINOBON_SECRET_KEY）")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def read_watchlist(config_path: Path) -> list[dict]:
    """The band's own config is the list, so there is only ever one watchlist."""
    if not config_path.exists():
        return []
    try:
        root = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        sys.exit(f"ERROR: {config_path} 不是合法 JSON: {err}")
    rows = root.get("tw") if isinstance(root, dict) else None
    out = []
    for row in rows or []:
        code = str(row.get("code", "")).strip()
        if code:
            out.append({"code": code, "name": row.get("name") or code})
    return out


def read_config_shioaji_env(*config_paths: Path) -> str | None:
    """`shioaji.env` out of one or more stock-band.json files, same merge
    order as register.tsx's poll() (user-level file first, project file
    second - a later path's value wins). Returns None when neither config
    sets it, so the caller falls back to the shared ~/.sinobon.env default -
    this is what keeps `--check` (and a by-hand run with no --env) agreeing
    with whatever path the band itself would actually spawn this script
    with, instead of a fixed default no real project uses."""
    env_value: str | None = None
    for config_path in config_paths:
        if not config_path.exists():
            continue
        try:
            root = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        shioaji = root.get("shioaji") if isinstance(root, dict) else None
        if isinstance(shioaji, dict) and shioaji.get("env"):
            env_value = str(shioaji["env"])
    return env_value


def field(obj, name, default=None):
    value = getattr(obj, name, default)
    return default if value is None else value


def resolve_name(code: str, contracts: dict, watchlist_names: dict) -> str:
    """
    Every quote and every holding names itself this way: the Shioaji contract
    first (`contract.name`, e.g. 台積電 - the one source that is always right
    when it has an answer), the watchlist's own name second (whatever
    `stock-band.json`'s `tw` entry or --codes said, which itself defaults to
    the code when nobody wrote a real name), and the code last. A code added
    to the fetch only because it showed up in `list_positions` - not on the
    watchlist at all - has no watchlist name to fall back to, so it depended
    entirely on the contract lookup; skipping this and naming a union row by
    its bare code (`00631L`, `2308`, even `2330`, which IS on the built-in
    list but was never in the SCRIPT's own copy of it before --codes existed)
    was the bug.
    """
    contract = contracts.get(code)
    cname = getattr(contract, "name", None) if contract else None
    return cname or watchlist_names.get(code) or code


def snapshot_rows(api, contracts: dict, watchlist_names: dict | None = None) -> dict:
    """code -> {price, prevClose, name}. A symbol the snapshot skipped is left out."""
    if not contracts:
        return {}
    watchlist_names = watchlist_names or {}
    snaps = api.snapshots(list(contracts.values()))
    out = {}
    for snap in snaps:
        code = str(field(snap, "code", ""))
        contract = contracts.get(code)
        close = float(field(snap, "close", 0) or 0)
        if not code or not contract or close <= 0:
            continue
        # `reference` is 昨收 (the 漲跌 basis the exchange publishes), and
        # change_price is what Shioaji itself computed against it - deriving
        # the basis back out keeps the two consistent when a symbol went ex-
        # dividend and the reference is not literally yesterday's close.
        change = float(field(snap, "change_price", 0) or 0)
        prev_close = float(field(contract, "reference", 0) or 0) or (close - change)
        out[code] = {
            "price": close,
            "prevClose": prev_close,
            "name": resolve_name(code, contracts, watchlist_names),
            "ts": int(field(snap, "ts", 0) or 0),
        }
    return out


def build_payload(api, contracts: dict, index_contracts: list, watchlist_names: dict) -> dict | None:
    quotes = snapshot_rows(api, contracts, watchlist_names)
    if not quotes:
        return None

    # the exchange's own clock, in ms: the band prints it as 更新, so it must
    # be when the prices traded and not when this script woke up
    traded_ns = max(row["ts"] for row in quotes.values())
    now_ms = int(time.time() * 1000)
    data_at = fix_taipei_ts(traded_ns) if traded_ns else now_ms
    # per-row stamp too: the tick overlay's stale guard compares against it
    for row in quotes.values():
        row_ns = row.pop("ts", 0)
        row["dataAt"] = fix_taipei_ts(row_ns) if row_ns else data_at

    index_rows = snapshot_rows(api, {c.code: c for _, c in index_contracts})
    indices = []
    for name, contract in index_contracts:
        row = index_rows.get(contract.code)
        if not row:
            continue
        prev = row["prevClose"] or row["price"]
        indices.append(
            {
                "name": name,
                "value": round(row["price"], 2),
                "change": round(row["price"] - prev, 2),
                "pct": round((row["price"] - prev) / prev * 100, 2) if prev else 0,
            }
        )

    payload = {
        "asOf": now_ms,
        "dataAt": data_at,
        "market": "tw",
        "source": "永豐 即時",
        # every code the snapshot actually answered, not just the ones that
        # started out on the watchlist - `contracts` already IS the union
        # (watchlist UNION positions, kept current every tick in main()), so
        # this covers a position-only code the same as a watchlist one.
        "quotes": {
            code: {"price": round(row["price"], 4), "prevClose": round(row["prevClose"], 4), "name": row["name"], "dataAt": row["dataAt"]}
            for code, row in quotes.items()
        },
    }
    if indices:
        payload["indices"] = indices
        payload["index"] = {k: v for k, v in indices[0].items() if k != "name"}
    return payload


FUTURES_TIMEFRAMES = (1, 5, 15, 60)  # minutes; barsBy's keys - all resampled from the same cached 1-minute kbars, zero extra api.kbars() calls (issue #12)
FUTURES_BAR_LIMIT = 120  # bars kept per timeframe - register.tsx's candleCells merges extra bars into the plot width rather than capping (read-only checked), so this is not bounded by the terminal
FUTURES_KBARS_REFRESH_S = 5 * 60  # api.kbars() is the SDK usage-budget cost (~2100 rows/contract/call at a 10s tick) - reuse bars across ticks inside this window instead of refetching every tick


def fix_taipei_ts(raw_ns: int) -> int:
    """Same 8h correction as build_payload's dataAt, factored out so the
    kbar and snapshot paths both call it independently."""
    return raw_ns // 1_000_000 - TAIPEI_OFFSET_MS


def kbars_to_rows(kbars) -> list[dict]:
    """api.kbars()'s columnar lists -> one dict per 1-minute row, ts
    corrected here (the kbar side's one call site for fix_taipei_ts)."""
    ts_list = field(kbars, "ts", []) or []
    opens = field(kbars, "Open", []) or []
    highs = field(kbars, "High", []) or []
    lows = field(kbars, "Low", []) or []
    closes = field(kbars, "Close", []) or []
    volumes = field(kbars, "Volume", []) or []
    return [
        {
            "ts": fix_taipei_ts(int(ts_list[i])),
            "Open": float(opens[i]),
            "High": float(highs[i]),
            "Low": float(lows[i]),
            "Close": float(closes[i]),
            "Volume": float(volumes[i]),
        }
        for i in range(len(ts_list))
    ]


def bucket_start(ts_ms: int, minutes: int) -> int:
    """Floor `ts_ms` to the start of its `minutes`-wide bucket. Epoch ms is
    already hour-aligned across a whole-hour offset like Taipei's UTC+8, so
    this floors to the Taipei hour too, not just the UTC one - the single
    site both resample_minutes and update_trailing_bar floor through, so the
    two paths cannot drift apart."""
    bucket_ms = minutes * 60_000
    return (ts_ms // bucket_ms) * bucket_ms


def resample_minutes(rows: list[dict], minutes: int) -> list[dict]:
    """1-minute rows -> ascending `minutes`-wide OHLCV buckets; the trailing
    bucket is kept even with one row - that's the live, still-forming bar."""
    buckets: dict[int, dict] = {}
    for row in sorted(rows, key=lambda r: r["ts"]):
        bucket_ts = bucket_start(row["ts"], minutes)
        bucket = buckets.get(bucket_ts)
        if bucket is None:
            buckets[bucket_ts] = {
                "ts": bucket_ts,
                "Open": row["Open"],
                "High": row["High"],
                "Low": row["Low"],
                "Close": row["Close"],
                "Volume": row["Volume"],
            }
        else:
            bucket["High"] = max(bucket["High"], row["High"])
            bucket["Low"] = min(bucket["Low"], row["Low"])
            bucket["Close"] = row["Close"]
            bucket["Volume"] += row["Volume"]
    return [buckets[key] for key in sorted(buckets)]


def resample_5min(rows: list[dict]) -> list[dict]:
    return resample_minutes(rows, 5)


def bucket_to_bar(bucket: dict) -> list[float]:
    """One resample_minutes bucket -> the file's bar shape, [o, h, l, c, v,
    ts] - the ts is the bucket's own start, so the band can draw a real
    x-axis from it (issue #12)."""
    return [bucket["Open"], bucket["High"], bucket["Low"], bucket["Close"], bucket["Volume"], bucket["ts"]]


def buckets_to_bars(buckets: list[dict], limit: int = FUTURES_BAR_LIMIT) -> tuple[list[list[float]], int]:
    """Ascending buckets -> (the most recent `limit` bars oldest first, the
    bucket ts the trailing bar covers - 0 when empty). The bucket is what
    lets a later tick tell "still this bar" from "open a new one"."""
    trimmed = buckets[-limit:] if limit else buckets
    bars = [bucket_to_bar(b) for b in trimmed]
    return bars, (trimmed[-1]["ts"] if trimmed else 0)


def minute_buckets(rows_1min: list[dict], minutes: int) -> list[dict]:
    """Corrected 1-minute kbar rows -> ascending buckets for one timeframe.
    minutes=1 is the raw rows themselves, sorted but unresampled - each row
    already IS its own 1-minute bucket, and the spec (issue #12) calls this
    out explicitly rather than leaving it to resample_minutes(rows, 1) to
    reconstruct the same thing at the cost of a redundant pass."""
    if minutes == 1:
        return sorted(rows_1min, key=lambda r: r["ts"])
    return resample_minutes(rows_1min, minutes)


def futures_quote_row(contract, snapshot, bars_by: dict, requested_code: str) -> dict | None:
    """One futures-quotes.json entry; multiplier/decimals/prevClose always
    come from `contract`, never a lookup table. `bars_by` is {"1"/"5"/"15"/
    "60": bars}, already ≤ FUTURES_BAR_LIMIT each (see refresh_futures_kbars)
    - `bars` stays the 5-minute set for backward compatibility, and is the
    SAME list object as barsBy["5"] so a tick that mutates one is visible
    through the other. `ts` is popped by build_futures_payload once folded
    into dataAt."""
    close = float(field(snapshot, "close", 0) or 0)
    if close <= 0:
        return None
    row = {
        "price": round(close, 4),
        "prevClose": round(float(field(contract, "reference", 0) or 0), 4),
        "name": field(contract, "name", None) or requested_code,
        "multiplier": field(contract, "multiplier", 1),
        "decimals": int(field(contract, "decimal_locator", 0) or 0),
        "bars": bars_by.get("5", []),
        "barsBy": bars_by,
        "ts": fix_taipei_ts(int(field(snapshot, "ts", 0) or 0)),
    }
    target_code = field(contract, "target_code", None)
    if target_code:
        row["resolved"] = target_code
    return row


def build_futures_payload(rows: dict) -> dict | None:
    """futures-quotes.json's shape; each row keeps its own corrected snapshot
    ts as `dataAt`, and the file's dataAt is the newest of them."""
    if not rows:
        return None
    now_ms = int(time.time() * 1000)
    for row in rows.values():
        row["dataAt"] = row.pop("ts", 0)
    data_at = max(row["dataAt"] for row in rows.values()) or now_ms
    return {
        "asOf": now_ms,
        "dataAt": data_at,
        "market": "tf",
        "source": "永豐",
        "barLabel": "5 分 K（永豐）",
        "quotes": rows,
    }


# ---------------------------------------------------------------------------
# tick overlay (issue #10): ticks fold into an in-memory copy of each quotes
# file between snapshots; the file is rewritten at most once a second
# ---------------------------------------------------------------------------

TICK_WRITE_MIN_INTERVAL_MS = 1000
TAIPEI_TZ = timezone(timedelta(hours=8))


class TickEvent(NamedTuple):
    """What a tick callback hands the main loop - the SDK object itself
    stays on the callback thread."""

    market: str  # "tw" (stock callback) or "tf" (futures callback)
    code: str  # the resolved month code (TXFJ6 even when TXFR1 was subscribed)
    at: datetime  # Taipei wall-clock, naive - no 8 h quirk here, unlike snapshot/kbars
    close: object  # Decimal or str, float()-able either way
    price_chg: object
    pct_chg: object
    total_volume: int
    simtrade: bool


def tick_ts_ms(at: datetime) -> int:
    """Naive tick datetime -> epoch ms, pinned to Taipei whatever the machine's zone is."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=TAIPEI_TZ)
    return int(at.timestamp() * 1000)


def update_trailing_bar(entry: dict, ts_ms: int, price: float, minutes: int = 5, limit: int = FUTURES_BAR_LIMIT) -> bool:
    """Fold one trade into one timeframe's kbars-cache entry ({"bars":
    [[o,h,l,c,v,ts]...], "bucket": ts}) in place: same bucket moves h/l/c, a
    newer bucket opens a bar (oldest dropped past `limit`), an older one is
    ignored. `v` is left alone either way - a TickEvent only carries
    session-cumulative total_volume, not a per-trade delta, so there is no
    correct number to add; a freshly opened bar starts at v=0.0 until the
    next kbars refresh fills the real volume. Returns whether anything
    changed."""
    bars = entry["bars"]
    bucket = bucket_start(ts_ms, minutes)
    current = entry.get("bucket", 0)
    if bars and bucket < current:
        return False
    if not bars or bucket > current:
        bars.append([price, price, price, price, 0.0, bucket])
        del bars[:-limit]
        entry["bucket"] = bucket
        return True
    bar = bars[-1]
    bar[1] = max(bar[1], price)
    bar[2] = min(bar[2], price)
    bar[3] = price
    return True


def advance_trailing_bars(entry: dict, ts_ms: int, price: float, limit: int = FUTURES_BAR_LIMIT) -> None:
    """Fold one tick into EVERY timeframe's trailing bar inside one code's
    kbars-cache entry ({"at", "by": {minutes: {"bars", "bucket"}}}) - a tick
    in a new bucket opens a bar in that timeframe only, independent of the
    others (issue #12: a 22:31 tick opens a new 1-min bar while still
    extending the 22:30 5-min/15-min bars and the 22:00 60-min bar)."""
    by = entry.get("by", {})
    for minutes in FUTURES_TIMEFRAMES:
        tf_entry = by.get(minutes)
        if tf_entry is not None:
            update_trailing_bar(tf_entry, ts_ms, price, minutes=minutes, limit=limit)


def apply_tick(rows: dict, tick: TickEvent, code_map: dict) -> list[str]:
    """Fold one tick into the overlay rows (requested code -> row with a
    `dataAt`); `code_map` is resolved code -> requested codes. Returns the
    rows it changed - empty for 試撮, a stale tick, or an unknown code."""
    if tick.simtrade:
        return []
    ts_ms = tick_ts_ms(tick.at)
    price = float(tick.close)
    changed = []
    for requested in code_map.get(tick.code, ()):
        row = rows.get(requested)
        if row is None or ts_ms < row.get("dataAt", 0):
            continue
        row["price"] = price
        row["dataAt"] = ts_ms
        changed.append(requested)
    return changed


def should_write(last_write_ms: int, now_ms: int, dirty: bool) -> bool:
    """A dirty overlay is flushed at most once per second; a clean one never."""
    return dirty and (now_ms - last_write_ms) >= TICK_WRITE_MIN_INTERVAL_MS


class QuotesOverlay:
    """One quotes file's in-memory copy between snapshots: `rows` are the
    payload's quotes (each with its own dataAt), `template` the rest."""

    def __init__(self, path: Path):
        self.path = path
        self.template: dict | None = None
        self.rows: dict = {}
        self.dirty = False
        self.last_write_ms = 0

    def absorb(self, payload: dict, now_ms: int) -> dict:
        """A fresh snapshot replaces the overlay; a row whose tick is newer
        than the snapshot's stamp keeps the tick. Returns the payload to
        write (the overlay is clean afterwards)."""
        rows = {}
        for code, row in payload["quotes"].items():
            old = self.rows.get(code)
            if old and old.get("dataAt", 0) > row.get("dataAt", 0):
                row = dict(row, price=old["price"], dataAt=old["dataAt"])
            rows[code] = row
        self.rows = rows
        self.template = {k: v for k, v in payload.items() if k != "quotes"}
        self.dirty = False
        self.last_write_ms = now_ms
        return self.payload(now_ms)

    def clear(self) -> None:
        self.template = None
        self.rows = {}
        self.dirty = False

    def payload(self, now_ms: int) -> dict:
        out = dict(self.template or {})
        out["asOf"] = now_ms
        out["dataAt"] = max((row.get("dataAt", 0) for row in self.rows.values()), default=0) or out.get("dataAt", now_ms)
        out["quotes"] = self.rows
        return out


def new_tick_stats() -> dict:
    return {"applied": {}, "simtrade": 0, "ignored": 0, "other_market": 0, "writes": {}}


def drain_ticks(tick_queue: queue.Queue, overlays: dict, code_maps: dict, kbars_cache: dict, stats: dict) -> None:
    """Apply every queued tick to the worked markets' overlays (`overlays`
    holds only those, so a tick for any other market is dropped) and fold
    futures ticks into the trailing bar. SDK events ride the same queue so
    they print from the main thread, in order."""
    while True:
        try:
            item = tick_queue.get_nowait()
        except queue.Empty:
            return
        if not isinstance(item, TickEvent):
            print(f"永豐 事件 resp={item[1]} code={item[2]} {item[3]} {item[4]}", file=sys.stderr)
            continue
        overlay = overlays.get(item.market)
        if overlay is None:
            stats["other_market"] += 1
            continue
        changed = apply_tick(overlay.rows, item, code_maps.get(item.market, {}))
        if not changed:
            stats["simtrade" if item.simtrade else "ignored"] += 1
            continue
        stats["applied"][item.code] = stats["applied"].get(item.code, 0) + 1
        overlay.dirty = True
        if item.market == "tf":
            for code in changed:
                entry = kbars_cache.get(code)
                if entry is not None:
                    advance_trailing_bars(entry, tick_ts_ms(item.at), float(item.close))


def flush_overlays(overlays: dict, now_ms: int, stats: dict) -> None:
    for market, overlay in overlays.items():
        if should_write(overlay.last_write_ms, now_ms, overlay.dirty):
            write_atomic(overlay.path, overlay.payload(now_ms))
            overlay.last_write_ms = now_ms
            overlay.dirty = False
            stats["writes"][market] = stats["writes"].get(market, 0) + 1


def format_tick_stats(stats: dict) -> str:
    applied = " ".join(f"{code}={n}" for code, n in sorted(stats["applied"].items())) or "（沒有）"
    writes = " ".join(f"{m}={n}" for m, n in sorted(stats["writes"].items())) or "（沒有）"
    return (
        f"tick 套用 {applied} · 略過 試撮={stats['simtrade']} 過期/未知={stats['ignored']} "
        f"非目前市場={stats['other_market']} · tick 寫檔 {writes}"
    )


def sync_subscriptions(api, sj, desired: dict, subscribed: dict) -> None:
    """Bring the SDK's tick subscriptions to `desired` ((market, code) ->
    contract): subscribe what is new, unsubscribe what is gone. A failure
    is logged with its reason and retried next time round."""
    for key, contract in desired.items():
        if key in subscribed:
            continue
        market, code = key
        resolved = field(contract, "target_code", None) or code
        try:
            api.subscribe(contract, quote_type=sj.QuoteType.Tick, version=sj.QuoteVersion.v1)
        except Exception as err:  # noqa: BLE001 - one bad subscription must not stop the others or the snapshots
            print(f"訂閱 tick 失敗 {market} {code}: {type(err).__name__}: {err}", file=sys.stderr)
            continue
        subscribed[key] = contract
        print(f"訂閱 tick {market} {code}" + (f" -> {resolved}" if resolved != code else ""), file=sys.stderr)
    for key in [k for k in subscribed if k not in desired]:
        market, code = key
        try:
            api.unsubscribe(subscribed[key], quote_type=sj.QuoteType.Tick, version=sj.QuoteVersion.v1)
        except Exception as err:  # noqa: BLE001 - keep it listed and retry next time round
            print(f"退訂 tick 失敗 {market} {code}: {type(err).__name__}: {err}", file=sys.stderr)
            continue
        del subscribed[key]
        print(f"退訂 tick {market} {code}", file=sys.stderr)


def split_futures_codes(raw: str) -> list[str]:
    """--futures CLI value -> codes, blanks dropped. Empty input alone does
    no futures work - a signed account's own positions can still drive it."""
    return [c.strip() for c in raw.split(",") if c.strip()]


def _bars_by(cache_entry: dict) -> dict[str, list]:
    """One code's kbars_cache entry ({"at", "by": {minutes: {"bars",
    "bucket"}}}) -> {"1"/"5"/"15"/"60": bars}, the SAME list objects the
    cache holds (not copies) - the one place int-minute keys become the
    payload's string keys, so the two keyspaces cannot drift apart."""
    return {str(minutes): cache_entry["by"][minutes]["bars"] for minutes in FUTURES_TIMEFRAMES}


def refresh_futures_kbars(api, contract, code: str, start: str, today: str, kbars_cache: dict, tick_now: float) -> tuple[dict, str]:
    """(bars_by, cadence note for the tick log) - bars_by is {"1"/"5"/"15"/
    "60": bars}. Reuses `kbars_cache[code]` when it is younger than
    FUTURES_KBARS_REFRESH_S, else calls api.kbars() ONCE and resamples every
    timeframe from that same 1-minute fetch (issue #12: zero extra API
    calls per extra timeframe). A failed fetch falls back to the cached
    bars_by (or an all-empty one if there is none yet) WITHOUT restamping -
    a transient error should not lock the chart to a stale/empty array for
    the rest of the window."""
    cached = kbars_cache.get(code)
    if cached is not None:
        age_s = tick_now - cached["at"]
        if age_s < FUTURES_KBARS_REFRESH_S:
            return _bars_by(cached), f"（沿用 {age_s / 60:.1f} 分前）"
    try:
        rows_1min = kbars_to_rows(api.kbars(contract, start=start, end=today))
    except Exception as err:  # noqa: BLE001 - a bad K-bar fetch keeps the quote, just with no bars
        print(f"{code} K 棒取得失敗（沿用{'上次結果' if cached else '空陣列'}）: {type(err).__name__}: {err}", file=sys.stderr)
        if cached:
            return _bars_by(cached), "（取得失敗，未更新快取）"
        return {str(minutes): [] for minutes in FUTURES_TIMEFRAMES}, "（取得失敗，未更新快取）"
    # each timeframe's entry is shared with the tick overlay: update_trailing_bar
    # mutates the SAME "bars" list in place, so ticks survive the next
    # snapshot's cache reuse (see advance_trailing_bars / drain_ticks)
    by = {}
    for minutes in FUTURES_TIMEFRAMES:
        bars, bucket = buckets_to_bars(minute_buckets(rows_1min, minutes))
        by[minutes] = {"bars": bars, "bucket": bucket}
    kbars_cache[code] = {"at": tick_now, "by": by}
    return _bars_by(kbars_cache[code]), "（重抓）"


def fetch_futures_rows(
    api,
    contracts: dict,
    codes: list,
    today: str,
    kbars_cache: dict | None = None,
    now=time.monotonic,
) -> dict:
    """Per-tick snapshot + K-bar fetch for every already-resolved futures
    code. A failed K-bar fetch keeps the quote with empty bars rather than
    dropping it - the price is still good.

    api.kbars() is the SDK usage-budget cost (measured 2026-09-18: ~25 MB/h
    from calling it every 10s tick), so it is only reissued once every
    FUTURES_KBARS_REFRESH_S per contract - see refresh_futures_kbars().
    `kbars_cache` (code -> {"at", "by": {minutes: {"bars", "bucket"}}})
    carries that cadence across ticks and must be the SAME dict every call - a fresh {} each time (the
    default) degrades to "always fetch", which is what a caller not passing
    the cache still gets, matching the old behaviour. `now` is a
    monotonic-clock callable so tests can move time without sleeping.
    """
    live = {code: contracts[code] for code in codes if code in contracts}
    if not live:
        return {}
    if kbars_cache is None:
        kbars_cache = {}
    # api.kbars filters by Taipei calendar day, not trading session - a 夜盤
    # tick just after midnight would otherwise only see tonight-so-far and
    # fall well short of 120 five-minute bars, so the request always spans
    # yesterday through today and buckets_to_bars's own [-limit:] does the trimming.
    start = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    snaps = {str(field(s, "code", "")): s for s in api.snapshots(list(live.values()))}
    rows = {}
    tick_now = now()
    for code, contract in live.items():
        snap = snaps.get(code)
        if snap is None:
            print(f"跳過期貨 {code}：這次快照沒有回應", file=sys.stderr)
            continue
        bars_by, cadence_note = refresh_futures_kbars(api, contract, code, start, today, kbars_cache, tick_now)
        row = futures_quote_row(contract, snap, bars_by, code)
        if row is None:
            print(f"跳過期貨 {code}：快照價格無效", file=sys.stderr)
            continue
        rows[code] = row
        resolved = row.get("resolved", code)
        counts = " ".join(f"{m}分={len(bars_by.get(str(m), []))}" for m in FUTURES_TIMEFRAMES)
        print(
            f"期貨 {code} -> {resolved}  乘數={row['multiplier']}  小數位={row['decimals']}  K棒 {counts} 根{cadence_note}",
            file=sys.stderr,
        )
    return rows


def fetch_futures_positions(api) -> list:
    """A missing `futopt_account` and an unsigned one (`signed=False`, which
    raises HTTP 406 on `list_positions`) are both normal, checked here so
    neither hits the caller as an exception every tick."""
    account = getattr(api, "futopt_account", None)
    if account is None:
        print("期貨帳戶未設定（futopt_account 是 None），期貨庫存視為空", file=sys.stderr)
        return []
    if not getattr(account, "signed", True):
        print(f"期貨帳戶未簽署（{field(account, 'account_id', '?')} signed=False），期貨庫存視為空", file=sys.stderr)
        return []
    return api.list_positions(account) or []


def futures_holding_row(position, contract) -> dict | None:
    """One futures-holdings.json entry; multiplier/prevClose come from
    `contract`. qty carries the direction sign (Sell negative), so the
    band's P&L math needs no separate sign lookup."""
    code = str(field(position, "code", "")).strip()
    qty = float(field(position, "quantity", 0) or 0)
    if not code or qty == 0:
        return None
    direction = "Sell" if "Sell" in str(field(position, "direction", "Buy")) else "Buy"
    if direction == "Sell":
        qty = -qty
    return {
        "code": code,
        "name": field(contract, "name", None) or code,
        "qty": qty,
        "cost": round(float(field(position, "price", 0) or 0), 4),
        "price": round(float(field(position, "last_price", 0) or 0), 4),
        "prevClose": round(float(field(contract, "reference", 0) or 0), 4),
        "multiplier": field(contract, "multiplier", 1),
        "direction": direction,
    }


def check_futures_pnl(position, contract) -> str | None:
    """The SDK's own `pnl` vs (last_price - price) * quantity * multiplier,
    cross-checked rather than trusted. The SDK rounds its pnl to the dollar
    (seen live: 195950.0 vs 195951.00000000017), so the tolerance is a
    couple of dollars plus a hair of relative slack, not a real mismatch."""
    quantity = float(field(position, "quantity", 0) or 0)
    price = float(field(position, "price", 0) or 0)
    last_price = float(field(position, "last_price", 0) or 0)
    multiplier = float(field(contract, "multiplier", 1) or 1)
    expected = (last_price - price) * quantity * multiplier
    sdk_pnl = float(field(position, "pnl", 0) or 0)
    if math.isclose(expected, sdk_pnl, rel_tol=1e-6, abs_tol=2.0):
        return None
    code = field(position, "code", "?")
    return f"{code} pnl 不符：SDK={sdk_pnl}，算出={expected}"


def build_futures_holdings_payload(rows: list) -> dict:
    """futures-holdings.json's shape - always a payload (`holdings: []` when
    unsigned/missing), so `asOf` alone tells "no positions" from "fetcher
    dead"."""
    return {"asOf": int(time.time() * 1000), "market": "tf", "source": "永豐 期貨", "holdings": rows}


def build_holdings_payload(positions: list, contracts: dict, quotes: dict, watchlist_names: dict) -> dict | None:
    """
    `api.list_positions` -> the holdings file's shape (see
    references/quote-sources.md's 損益 section and stock-holdings.example.json).
    `price`/`prevClose` are filled here as a fallback only - the band prefers
    whatever the quotes file already says for that code (item 4/6 of the
    spec: the quotes fetch covers watchlist UNION positions precisely so
    every holding has a live price there too).
    """
    holdings = []
    for pos in positions:
        code = str(field(pos, "code", "")).strip()
        qty = float(field(pos, "quantity", 0) or 0)
        if not code or qty == 0:
            continue
        direction = str(field(pos, "direction", "Buy"))
        if "Sell" in direction:  # a short position - the qty sign carries it through the P&L math
            qty = -qty
        cost = float(field(pos, "price", 0) or 0)
        contract = contracts.get(code)
        name = resolve_name(code, contracts, watchlist_names)
        live = quotes.get(code)
        last_price = float(field(pos, "last_price", 0) or 0)
        price = live["price"] if live else (last_price or cost)
        prev_close = live["prevClose"] if live else (float(getattr(contract, "reference", 0) or 0) or price)
        holdings.append(
            {"code": code, "name": name, "qty": qty, "cost": round(cost, 4), "price": round(price, 4), "prevClose": round(prev_close, 4)}
        )
    if not holdings:
        return None
    return {"asOf": int(time.time() * 1000), "market": "tw", "source": "永豐 庫存", "holdings": holdings}


def pid_alive(pid: int) -> bool:
    """A stopped (T/t) or zombie owner is not feeding: kill -0 still says
    alive, so the band would skip respawning for as long as it stays that
    way (a Ctrl-Z'd claude session drags the fetcher down with it). Kill a
    stopped one so it cannot wake later and double-write the runtime dir."""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return True
    if state in ("T", "t", "Z"):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        return False
    return True


def claim_pidfile(pidfile: Path) -> bool:
    """
    True: this process owns the pidfile and should run. False: another live
    process already owns it for this project, so the caller exits quietly
    (0) rather than double-fetching - see the module docstring's `--pidfile`
    section.
    """
    if pidfile.exists():
        try:
            existing = int(pidfile.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            existing = None
        if existing and existing != os.getpid() and pid_alive(existing):
            return False
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    pidfile.write_text(str(os.getpid()), encoding="utf-8")
    return True


def release_pidfile(pidfile: Path) -> None:
    """Unlink the pidfile only while it still names this process: a successor
    that already claimed it (after this one was judged dead) keeps its claim."""
    try:
        if pidfile.read_text(encoding="utf-8").strip() == str(os.getpid()):
            pidfile.unlink()
    except (OSError, ValueError):
        pass


def parse_heartbeat(text: str, now_ms: float) -> tuple[bool, frozenset[str]]:
    """(stale, markets the band wants worked). A bare ms number (pre-T4
    band) reads as every market for one release; anything else unparseable
    is stale - exiting beats guessing what the band wants."""
    text = text.strip()
    try:
        ts = float(text)
        markets = HEARTBEAT_MARKETS
    except ValueError:
        try:
            root = json.loads(text)
        except ValueError:
            return True, frozenset()
        if not isinstance(root, dict) or not isinstance(root.get("ts"), (int, float)):
            return True, frozenset()
        ts = float(root["ts"])
        raw = root.get("markets")
        markets = frozenset(m for m in raw if m in HEARTBEAT_MARKETS) if isinstance(raw, list) else frozenset()
    if (now_ms - ts) > HEARTBEAT_MAX_AGE_MS:
        return True, markets
    return False, markets


def read_heartbeat(path: Path) -> tuple[bool, frozenset[str]]:
    """Missing or unreadable reads as stale, same as a bad body - see parse_heartbeat."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return True, frozenset()
    return parse_heartbeat(text, time.time() * 1000)


def write_atomic(path: Path, payload: dict) -> None:
    """
    Write through a temp file and rename: the band polls this file every few
    seconds and a half-written JSON would read as malformed and drop it back
    to demo prices.
    """
    tmp = path.with_suffix(".json.tmp")
    # compact: futures-quotes.json carries every K bar and is rewritten up to
    # once a second, and indent=1 put each bar number on its own line (~40%
    # of the bytes). `python -m json.tool FILE` reads it back for a human.
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def fetch_positions(api) -> list:
    """`list_positions` in shares, not 張 - the band's Holding.qty contract wants shares."""
    import shioaji as sj

    return api.list_positions(api.stock_account, unit=sj.constant.Unit.Share) or []


def check_python_version() -> bool:
    major, minor = sys.version_info[:2]
    version = f"{major}.{minor}"
    if (major, minor) > (3, 13):
        print(f"❌ Python 版本 {version}：shioaji 不支援這個版本，請用 3.12 或 3.13 的 venv")
        return False
    if (major, minor) < (3, 10):
        print(f"❌ Python 版本 {version}：shioaji 需要 3.10-3.13")
        return False
    print(f"✅ Python 版本 {version}（shioaji 支援 3.10-3.13）")
    return True


def check_import_shioaji() -> bool:
    try:
        import shioaji  # noqa: F401
    except ImportError as err:
        print(f"❌ import shioaji 失敗（{err}），跑 pip install shioaji")
        return False
    print("✅ import shioaji 成功")
    return True


def check_env_file(env_path: Path) -> tuple[bool, dict]:
    """Returns (兩把 key 都有值, 讀到的值) - the values are used only to try a
    login below and are never printed."""
    if not env_path.exists():
        print(f"❌ env 檔不存在：{env_path}")
        return False, {}
    print(f"✅ env 檔存在：{env_path}")
    values: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    ok = True
    for key in ("SINOBON_API_KEY", "SINOBON_SECRET_KEY"):
        has_value = bool(values.get(key))
        print(f"{'✅' if has_value else '❌'} {key} 有值" if has_value else f"❌ {key} 沒有值")
        ok = ok and has_value
    return ok, values


def check_login(values: dict, shioaji_ok: bool) -> bool:
    if not shioaji_ok:
        print("❌ 登入略過（shioaji 沒裝好，見上）")
        return False
    if not values.get("SINOBON_API_KEY") or not values.get("SINOBON_SECRET_KEY"):
        print("❌ 登入略過（env 檔缺 key，見上）")
        return False
    import shioaji as sj

    try:
        api = sj.Shioaji()
        api.login(
            api_key=values["SINOBON_API_KEY"],
            secret_key=values["SINOBON_SECRET_KEY"],
            subscribe_trade=False,
        )
    except Exception as err:  # noqa: BLE001 - surfacing whatever shioaji raised is the point of --check
        message = str(err)
        if "406" in message:
            print("❌ 登入失敗（HTTP 406）：簽署中心的 Python API 測試沒通過，去永豐簽署中心完成測試")
        else:
            print(f"❌ 登入失敗：{type(err).__name__}: {message}")
        return False
    print("✅ 登入成功")
    try:
        api.logout()
    except Exception:  # noqa: BLE001 - logout failing after a successful check changes nothing
        pass
    return True


def check_platform() -> bool:
    if sys.platform == "win32":
        print("❌ 永豐路線只支援 macOS／Linux（band 用 nohup 啟動）")
        return False
    print(f"✅ 平台 {sys.platform}")
    return True


def run_check(args) -> bool:
    """--check: print each diagnostic line, write nothing, never touch --codes."""
    print("== 永豐 Shioaji 診斷 ==")
    ok_version = check_python_version()
    ok_import = check_import_shioaji()
    ok_env, values = check_env_file(Path(args.env).expanduser())
    ok_login = check_login(values, ok_import)
    ok_platform = check_platform()
    return ok_version and ok_import and ok_env and ok_login and ok_platform


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.getcwd(), help="the project whose .claude/stock-band.json holds the `tw` watchlist; also, when --out-dir is unset, what the runtime-dir slug is built from")
    parser.add_argument("--out-dir", default="", help="where stock-quotes.json / stock-holdings.json go; default is the same runtime dir hooks/register.tsx computes for --project. The heartbeat/pid still go wherever --heartbeat/--pidfile say (empty = off), same as always")
    parser.add_argument(
        "--env",
        default=None,
        help="file holding SINOBON_API_KEY / SINOBON_SECRET_KEY; defaults to whatever "
        "shioaji.env ~/.claude/stock-band.json or --project's stock-band.json sets "
        "(project wins), falling back to ~/.sinobon.env when neither sets it",
    )
    parser.add_argument("--interval", type=float, default=10, help="seconds between snapshots; 0 writes once and exits")
    parser.add_argument("--codes", default="", help="comma-separated codes, overriding the band's own watchlist")
    parser.add_argument("--futures", default="", help="comma-separated 期貨合約代號（月合約或 R1/R2 別名，如 TXFR1,SRFJ6）；空值本身不會啟動期貨工作，但簽署期貨帳戶若有庫存部位，仍會驅動期貨快照與庫存檔")
    parser.add_argument("--heartbeat", default="", help="path the band keeps rewriting while it wants this route, as {\"ts\": ms, \"markets\": [\"tw\"|\"tf\"]} (a bare ms number, the pre-T4 form, still means both markets); missing or >90s old exits this process, and each tick works only the markets named (empty disables the check and works every market, for a by-hand run)")
    parser.add_argument("--pidfile", default="", help="path holding this fetcher's pid; a live pid already there exits this run at once instead of double-fetching the same project")
    parser.add_argument("--check", action="store_true", help="diagnose the environment (Python version, shioaji install, env file, a real login, platform) and exit; writes nothing, needs no --codes")
    args = parser.parse_args()

    # Not `.resolve()`: that would follow symlinks and could reshape this
    # string differently than $.session.cwd() does on the TS side, landing a
    # manual run's files in a directory the band never looks at. abspath only
    # normalizes "." / ".." / a trailing slash, same as Node's path.resolve.
    project_str = os.path.abspath(os.path.expanduser(args.project))
    project = Path(project_str)
    home = os.environ.get("HOME", "")

    # --env not given: read the same shioaji.env the band itself would spawn
    # this script with (user-level file, then project file - project wins),
    # before falling back to the shared ~/.sinobon.env default. Keeps a
    # by-hand run and `--check` honest about the env file a real spawn uses,
    # instead of a fixed default that no project with a custom path matches.
    if args.env is None:
        config_paths = [project / ".claude" / "stock-band.json"]
        if home:
            config_paths.insert(0, Path(home) / ".claude" / "stock-band.json")
        args.env = read_config_shioaji_env(*config_paths) or "~/.sinobon.env"

    # Resolve every path arg against the caller's cwd now, before the chdir
    # below reshapes what "relative" means - otherwise a relative --env /
    # --heartbeat / --pidfile would start resolving against out_dir instead
    # of wherever the caller actually meant.
    args.env = os.path.abspath(os.path.expanduser(args.env))
    if args.heartbeat:
        args.heartbeat = os.path.abspath(os.path.expanduser(args.heartbeat))
    if args.pidfile:
        args.pidfile = os.path.abspath(os.path.expanduser(args.pidfile))

    out_dir = Path(args.out_dir).expanduser().resolve() if args.out_dir else runtime_dir(home, project_str)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Shioaji writes its own shioaji.log into whatever directory the process
    # runs from - there is no config knob to point it elsewhere - so this
    # must chdir into out_dir before shioaji is imported anywhere below,
    # --check included, or that log lands in the caller's repo instead of
    # next to our own output files.
    os.chdir(out_dir)

    if args.check:
        sys.exit(0 if run_check(args) else 1)

    out_path = out_dir / "stock-quotes.json"
    holdings_path = out_dir / "stock-holdings.json"
    futures_out_path = out_dir / "futures-quotes.json"
    futures_holdings_path = out_dir / "futures-holdings.json"
    futures_codes = split_futures_codes(args.futures)

    pidfile = Path(args.pidfile).expanduser().resolve() if args.pidfile else None
    if pidfile and not claim_pidfile(pidfile):
        print(f"另一個 fetcher 已經在跑這個專案（{pidfile} 裡的 pid 還活著），這次略過", file=sys.stderr)
        return
    heartbeat_path = Path(args.heartbeat).expanduser().resolve() if args.heartbeat else None

    # From here on every way out - a sys.exit below, a failed login, an
    # unresolvable contract - logs out and gives the pidfile back. The loop's
    # own `finally` covers the normal path; atexit covers everything before
    # it, which used to leave the pidfile behind and the session logged in.
    api = None

    def cleanup() -> None:
        nonlocal api
        if api is not None:
            try:
                api.logout()
            except Exception:  # noqa: BLE001 - logout failing on the way out changes nothing
                pass
            api = None
            print("永豐 已登出", file=sys.stderr)
        if pidfile:
            release_pidfile(pidfile)

    atexit.register(cleanup)

    # Installed before login, not after: a SIGTERM during the (slow) login
    # would otherwise kill the process before any cleanup could run. Before
    # the loop, `running = False` just means the loop never starts.
    def stop(*_):
        nonlocal running
        running = False

    running = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    if args.codes:
        watchlist = [{"code": c.strip(), "name": c.strip()} for c in args.codes.split(",") if c.strip()]
    else:
        watchlist = read_watchlist(project / ".claude" / "stock-band.json")

    load_env(Path(args.env).expanduser())
    for key in ("SINOBON_API_KEY", "SINOBON_SECRET_KEY"):
        if not os.environ.get(key):
            sys.exit(f"ERROR: {key} 沒設")

    import shioaji as sj  # imported here so --help works without the SDK

    api = sj.Shioaji()
    print("永豐 登入中…", file=sys.stderr)
    api.login(
        api_key=os.environ["SINOBON_API_KEY"],
        secret_key=os.environ["SINOBON_SECRET_KEY"],
        subscribe_trade=False,  # quotes only: this script never places an order
    )

    # Ticks arrive on an SDK thread: the callbacks only queue a plain tuple,
    # the main loop applies them every 0.2 s of its sleep (drain_ticks).
    tick_queue: queue.Queue = queue.Queue()

    def queue_tick(market: str, tick) -> None:
        tick_queue.put(
            TickEvent(
                market=market,
                code=str(field(tick, "code", "")),
                at=field(tick, "datetime", datetime.now(TAIPEI_TZ).replace(tzinfo=None)),
                close=field(tick, "close", 0),
                price_chg=field(tick, "price_chg", 0),
                pct_chg=field(tick, "pct_chg", 0),
                total_volume=int(field(tick, "total_volume", 0) or 0),
                simtrade=bool(field(tick, "simtrade", False)),
            )
        )

    # *args: the pyi types the callback as (tick) but classic shioaji passed
    # (exchange, tick) - the tick is the last argument either way
    api.set_on_tick_stk_v1_callback(lambda *args: queue_tick("tw", args[-1]))
    api.set_on_tick_fop_v1_callback(lambda *args: queue_tick("tf", args[-1]))
    api.set_event_callback(lambda resp_code, event_code, info, event: tick_queue.put(("event", resp_code, event_code, info, event)))
    tw_overlay = QuotesOverlay(out_path)
    tf_overlay = QuotesOverlay(futures_out_path)
    subscribed: dict = {}
    tick_stats = new_tick_stats()
    try:
        positions = fetch_positions(api)
    except Exception as err:  # noqa: BLE001 - a failed first fetch just means no holdings this run
        print(f"庫存查詢失敗: {type(err).__name__}: {err}", file=sys.stderr)
        positions = []
    position_codes = {str(field(p, "code", "")).strip() for p in positions}
    position_codes.discard("")

    if not watchlist and not position_codes and not futures_codes:
        sys.exit(
            f"ERROR: 找不到台股清單（{project}/.claude/stock-band.json 的 `tw`）也沒有庫存部位，"
            "也沒有 --futures 代號，或用 --codes 指定"
        )

    # Whatever name the watchlist itself carries for a code - resolve_name's
    # second choice, behind the Shioaji contract. --codes and a `tw` entry
    # with no explicit "name" both default to the code here, which is fine:
    # resolve_name still tries the contract first, so this only matters when
    # the contract lookup itself comes up empty.
    watchlist_names = {row["code"]: row["name"] for row in watchlist}

    # The quotes fetch covers the watchlist UNION every held code (item 4/6 of
    # the spec), so a holding that never made the watchlist still gets a live
    # price in stock-quotes.json - build_holdings_payload prefers exactly that
    # over the fallback price it computes itself.
    watchlist_codes = {row["code"] for row in watchlist}
    symbols = list(watchlist) + [{"code": c, "name": c} for c in position_codes if c not in watchlist_codes]

    # Shioaji resolves 上市/上櫃 itself, so unlike the exchange endpoint the
    # watchlist needs no `ex` field here.
    contracts: dict = {}

    def ensure_contract(code: str):
        if code in contracts:
            return contracts[code]
        contract = api.Contracts.Stocks[code]
        if contract is None:
            print(f"跳過 {code}：永豐查不到這個代號", file=sys.stderr)
            return None
        contracts[code] = contract
        return contract

    for row in symbols:
        ensure_contract(row["code"])

    index_contracts = []
    for exchange, code, name in INDICES:
        contract = getattr(api.Contracts.Indexs, exchange)[code]
        if contract is not None:
            index_contracts.append((name, contract))

    # --futures codes resolve once here; a position's code (T5) resolves
    # lazily inside the tick loop instead, the same way a stock position
    # adds itself to `symbols` there - contracts persist across ticks either way.
    futures_contracts: dict = {}
    # same dict every tick, so fetch_futures_rows's kbars cadence actually
    # persists across the loop instead of resetting to "always fetch"
    futures_kbars_cache: dict = {}

    def ensure_futures_contract(code: str):
        if code in futures_contracts:
            return futures_contracts[code]
        contract = api.Contracts.Futures[code]
        if contract is None:
            print(f"跳過期貨 {code}：永豐查不到這個合約代號", file=sys.stderr)
            return None
        futures_contracts[code] = contract
        return contract

    for code in futures_codes:
        ensure_futures_contract(code)

    first_tick = True
    failed_ticks = 0  # consecutive ticks where every snapshot attempted raised
    last_futures_positions: list = []  # kept across ticks the same way `positions` is - see below
    try:
        while running:
            # Heartbeat check first, before doing any work this tick: a stale
            # heartbeat means nobody wants either market anymore (band closed),
            # and the very first tick is exempt because the caller
            # (spawnShioaji) writes the heartbeat moments BEFORE spawning this
            # process, not after. A by-hand run (no --heartbeat) works both.
            if heartbeat_path:
                stale, wanted = read_heartbeat(heartbeat_path)
                if stale and not first_tick:
                    print(f"心跳逾時（{heartbeat_path} 沒人更新），結束", file=sys.stderr)
                    break
                why = f"心跳要 {sorted(wanted) or '（沒有市場）'}"
            else:
                wanted = HEARTBEAT_MARKETS
                why = "沒有 --heartbeat，全做"
            first_tick = False
            work_tw = "tw" in wanted
            tf_wanted = "tf" in wanted
            futures_positions = last_futures_positions
            if tf_wanted:
                try:
                    futures_positions = fetch_futures_positions(api)
                except Exception as err:  # noqa: BLE001 - None/unsigned accounts return [] inside; only a network/SDK error reaches here, so keep last tick's positions
                    print(f"期貨庫存查詢失敗（保留上一份）: {type(err).__name__}: {err}", file=sys.stderr)
                    futures_positions = last_futures_positions
                last_futures_positions = futures_positions

            # union: a held code not on --futures still gets a live quote (spec story 22)
            tick_futures_codes = list(futures_codes)
            for pos in futures_positions:
                pos_code = str(field(pos, "code", "")).strip()
                if pos_code:
                    ensure_futures_contract(pos_code)
                    if pos_code not in tick_futures_codes:
                        tick_futures_codes.append(pos_code)

            # positions alone drive futures work (holdings-only user), but only while the band wants tf
            work_tf = tf_wanted and bool(tick_futures_codes or futures_positions)
            tf_note = "做" if work_tf else ("不做：心跳沒要 tf" if not tf_wanted else "不做：沒有 --futures 代號也沒有期貨部位")
            print(
                f"{time.strftime('%H:%M:%S')}  tick  台股={'做' if work_tw else '不做：心跳沒要 tw'}  "
                f"期貨={tf_note}  （{why}）",
                file=sys.stderr,
            )
            if subscribed:
                print(format_tick_stats(tick_stats), file=sys.stderr)
            tick_stats = new_tick_stats()
            attempted = failed = 0

            if work_tw:
                try:
                    positions = fetch_positions(api)
                except Exception as err:  # noqa: BLE001 - keep the last good positions rather than crash
                    print(f"庫存查詢失敗（保留上一份）: {type(err).__name__}: {err}", file=sys.stderr)
                for pos in positions:
                    code = str(field(pos, "code", "")).strip()
                    if code:
                        ensure_contract(code)
                        if code not in watchlist_codes and not any(s["code"] == code for s in symbols):
                            symbols.append({"code": code, "name": code})

                attempted += 1
                try:
                    payload = build_payload(api, contracts, index_contracts, watchlist_names)
                except Exception as err:  # noqa: BLE001 - any SDK error is the same story here
                    print(f"快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                    payload = None
                    failed += 1
                if payload:
                    write_atomic(out_path, tw_overlay.absorb(payload, int(time.time() * 1000)))
                    rows = len(payload["quotes"])
                    stamp = time.strftime("%H:%M:%S", time.localtime(payload["dataAt"] / 1000))
                    print(f"{stamp}  {rows} 檔 -> {out_path}", file=sys.stderr)
                # a failed snapshot leaves the file alone: the band drops a file
                # older than 120 s by itself and says so, which beats a stale price
                # that still looks live

                try:
                    holdings_payload = build_holdings_payload(
                        positions, contracts, payload["quotes"] if payload else {}, watchlist_names
                    )
                except Exception as err:  # noqa: BLE001 - same story as the quotes snapshot
                    print(f"庫存快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                    holdings_payload = None
                if holdings_payload:
                    write_atomic(holdings_path, holdings_payload)
                    print(f"{len(holdings_payload['holdings'])} 檔庫存 -> {holdings_path}", file=sys.stderr)

            if work_tf:
                attempted += 1
                try:
                    futures_rows = fetch_futures_rows(
                        api, futures_contracts, tick_futures_codes, date.today().isoformat(), kbars_cache=futures_kbars_cache
                    )
                except Exception as err:  # noqa: BLE001 - any SDK error is the same story here
                    print(f"期貨快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                    futures_rows = {}
                    failed += 1
                futures_payload = build_futures_payload(futures_rows)
                if futures_payload:
                    write_atomic(futures_out_path, tf_overlay.absorb(futures_payload, int(time.time() * 1000)))
                    print(f"{len(futures_payload['quotes'])} 檔期貨 -> {futures_out_path}", file=sys.stderr)

                try:
                    holding_rows = []
                    for pos in futures_positions:
                        pos_code = str(field(pos, "code", "")).strip()
                        contract = futures_contracts.get(pos_code)
                        if not contract:
                            print(f"期貨庫存 {pos_code} 略過：合約未解析", file=sys.stderr)
                            continue
                        row = futures_holding_row(pos, contract)
                        if row is None:
                            continue
                        mismatch = check_futures_pnl(pos, contract)
                        holding_rows.append(row)
                        status = mismatch if mismatch else "OK"
                        print(
                            f"期貨庫存 {row['code']} 方向={row['direction']} qty={row['qty']} 乘數={row['multiplier']} pnl={status}",
                            file=sys.stderr,
                        )
                    futures_holdings_payload = build_futures_holdings_payload(holding_rows)
                except Exception as err:  # noqa: BLE001 - same story as the quotes side
                    print(f"期貨庫存快照失敗（保留上一份檔案）: {type(err).__name__}: {err}", file=sys.stderr)
                    futures_holdings_payload = None
                if futures_holdings_payload:
                    write_atomic(futures_holdings_path, futures_holdings_payload)
                    print(f"{len(futures_holdings_payload['holdings'])} 檔期貨庫存 -> {futures_holdings_path}", file=sys.stderr)

            # A session that died (token expired, connection dropped for good)
            # fails every snapshot while the heartbeat keeps this process -
            # and its pidfile - alive, so the band never respawns it and the
            # files just go stale. Give up instead: exiting frees the pidfile,
            # and the band's next tick respawns a fresh login.
            failed_ticks = failed_ticks + 1 if attempted and failed == attempted else 0
            if failed_ticks >= MAX_FAILED_TICKS:
                print(f"連續 {failed_ticks} 輪快照全部失敗，結束讓 band 重新登入", file=sys.stderr)
                sys.exit(1)

            # Ticks follow the worked set: subscribe what this tick served,
            # unsubscribe what it no longer does, and only keep an overlay
            # (a tick target) for a market whose snapshot succeeded.
            desired: dict = {}
            overlays: dict = {}
            code_maps: dict = {}
            if work_tw:
                desired.update({("tw", code): contract for code, contract in contracts.items()})
                code_maps["tw"] = {code: [code] for code in contracts}
                if tw_overlay.template is not None:
                    overlays["tw"] = tw_overlay
            else:
                tw_overlay.clear()
            if work_tf:
                code_maps["tf"] = {}
                for code in tick_futures_codes:
                    contract = futures_contracts.get(code)
                    if contract is None:
                        continue
                    desired[("tf", code)] = contract
                    code_maps["tf"].setdefault(field(contract, "target_code", None) or code, []).append(code)
                if tf_overlay.template is not None:
                    overlays["tf"] = tf_overlay
            else:
                tf_overlay.clear()
            if args.interval <= 0:
                break
            sync_subscriptions(api, sj, desired, subscribed)
            slept = 0.0
            while running and slept < args.interval:
                time.sleep(0.2)
                slept += 0.2
                drain_ticks(tick_queue, overlays, code_maps, futures_kbars_cache, tick_stats)
                flush_overlays(overlays, int(time.time() * 1000), tick_stats)
    finally:
        cleanup()


if __name__ == "__main__":
    main()
