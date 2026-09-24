// The quotes and holdings files: parsing, staleness, and pricing holdings off them.

import { QUOTE_STALE_MS } from './constants.ts'
import type { MarketId } from './markets.ts'
import { TIMEFRAMES } from './quotes.ts'
import type { Bar, FileQuote, Holding, IndexRow, PricedHolding, Timeframe } from './quotes.ts'
import { asRecord, num, parseHoldingsList, str } from './config.ts'
import type { Config } from './config.ts'

export type QuotesFile = {
  asOf: number
  market?: MarketId
  /** where the snapshot came from, so the band can say so in its footer */
  origin?: 'file' | 'live'
  /** what the footer calls that source, e.g. `證交所 即時`; '' falls back to the origin */
  sourceLabel?: string
  /**
   * when the prices traded, not when this module read them. The band prints
   * this as 更新, so the clock on screen cannot claim a freshness the data
   * does not have.
   */
  dataAt?: number
  /** bumped once per snapshot; the board's live dot advances on it */
  seq?: number
  quotes: Record<string, FileQuote>
  index?: { value: number; change: number; pct: number }
  /** every index the feed carries, in display order; the board flips through them */
  indices?: IndexRow[]
  /**
   * the snapshot before this one, keyed the same way. The board turns a row
   * from its old number to its new one, and only the board knows how - it
   * needs somewhere to turn from.
   */
  prev?: Record<string, FileQuote>
  /** what the bars are, e.g. "5 分 K"; only the feed knows */
  barLabel?: string
}

// [o, h, l, c, v?, ts?] or { o, h, l, c, v?, ts? }: which one a feed hands over
// is not worth a conversion step; a 4- or 5-element bar is still a bar.
function parseBars(value: unknown): Bar[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Bar[] = []
  const push = (legs: unknown[], v: unknown, ts: unknown) => {
    if (legs.length !== 4 || !legs.every(x => typeof x === 'number' && Number.isFinite(x))) return
    const bar = legs as [number, number, number, number]
    const vol = num(v, NaN)
    const at = num(ts, NaN)
    // a Client's props must not hold undefined, so the tuple is cut short instead
    if (at > 0) out.push([...bar, vol >= 0 ? vol : 0, at])
    else if (vol >= 0) out.push([...bar, vol])
    else out.push(bar)
  }
  for (const raw of value) {
    if (Array.isArray(raw)) {
      push(raw.slice(0, 4), raw[4], raw[5])
      continue
    }
    const obj = asRecord(raw)
    if (!obj) continue
    push([obj.o ?? obj.open, obj.h ?? obj.high, obj.l ?? obj.low, obj.c ?? obj.close], obj.v ?? obj.volume, obj.ts ?? obj.t)
  }
  return out.length > 0 ? out : undefined
}

/** a futures file's `barsBy` block: one bar set per timeframe it names, unknown keys ignored */
function parseBarsBy(value: unknown): Partial<Record<Timeframe, Bar[]>> | undefined {
  const obj = asRecord(value)
  if (!obj) return undefined
  const out: Partial<Record<Timeframe, Bar[]>> = {}
  for (const tf of TIMEFRAMES) {
    const bars = parseBars(obj[tf])
    if (bars) out[tf] = bars
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// Parses a `stock-quotes.json` file's text, whichever of the two locations
// it came from (runtime-dir or the project's `.claude/`, see runtimeDir and
// the header comment), or the fetcher's `futures-quotes.json` (same shape,
// `market: "tf"`, plus multiplier/decimals/resolved per quote); see
// stock-band.example.json for the shape. Anything stale or malformed is
// ignored and the band falls back to demo prices (no-data rows for tf).
// The poll re-reads every quotes file each refreshMs, and a file that has
// not been rewritten since returns the same text - re-parsing it (a futures
// file carries every K bar) is work for nothing. One entry per file slot, the
// last text it read and what that parsed to: a rewritten file parses fresh,
// an unchanged one is a string compare. The result is never mutated
// downstream (buildProps copies rows out of it), so sharing it is safe.
type QuotesSlot = 'runtime' | 'project' | 'futures'
const quotesParseCache: Partial<Record<QuotesSlot, { text: string; file: QuotesFile | undefined }>> = {}

export function parseQuotes(text: string | undefined, now: number, slot?: QuotesSlot): QuotesFile | undefined {
  if (!text) return undefined
  let file: QuotesFile | undefined
  const hit = slot ? quotesParseCache[slot] : undefined
  if (hit && hit.text === text) {
    file = hit.file
  } else {
    file = parseQuotesUncached(text)
    if (slot) quotesParseCache[slot] = { text, file }
  }
  // staleness is the one part that depends on `now`, so it stays outside the cache
  if (!file || now - file.asOf > QUOTE_STALE_MS) return undefined
  return file
}

function parseQuotesUncached(text: string): QuotesFile | undefined {
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const asOf = num(root.asOf, 0)
  if (!asOf) return undefined
  const quotesRaw = asRecord(root.quotes)
  if (!quotesRaw) return undefined
  const quotes: Record<string, FileQuote> = {}
  for (const [code, raw] of Object.entries(quotesRaw)) {
    const entry = asRecord(raw)
    if (!entry) continue
    const price = num(entry.price, NaN)
    if (!Number.isFinite(price)) continue
    // decimals feed toFixed(), which throws outside 0..100 - a bad value in a
    // fetcher-written file must not take the render down with it
    const decimals = num(entry.decimals, NaN)
    quotes[code] = {
      price,
      prevClose: typeof entry.prevClose === 'number' ? entry.prevClose : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      bars: parseBars(entry.bars),
      barsBy: parseBarsBy(entry.barsBy),
      multiplier: typeof entry.multiplier === 'number' && entry.multiplier > 0 ? entry.multiplier : undefined,
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : undefined,
      resolved: typeof entry.resolved === 'string' && entry.resolved ? entry.resolved : undefined,
    }
  }
  const market =
    root.market === 'tw' || root.market === 'us' || root.market === 'tf' || root.market === 'crypto' ? root.market : undefined
  const idx = asRecord(root.index)
  // a fetcher that carries more than one index (Taiwan has 加權 and 櫃買) can
  // hand the whole board over and the footer flips through it
  const indices: IndexRow[] = []
  for (const raw of Array.isArray(root.indices) ? (root.indices as unknown[]) : []) {
    const row = asRecord(raw)
    const name = str(row?.name, '')
    if (!row || !name) continue
    indices.push({ name, value: num(row.value, 0), change: num(row.change, 0), pct: num(row.pct, 0) })
  }
  return {
    asOf,
    market,
    origin: 'file',
    // a file that knows when its prices traded says so in dataAt; one that does
    // not falls back to when it was written
    dataAt: num(root.dataAt, asOf),
    seq: Math.floor(asOf / 1000),
    quotes,
    index: idx
      ? { value: num(idx.value, 0), change: num(idx.change, 0), pct: num(idx.pct, 0) }
      : undefined,
    ...(indices.length > 0 ? { indices } : {}),
    // `source` lets a fetcher name itself in the footer instead of 報價檔
    sourceLabel: typeof root.source === 'string' ? root.source : undefined,
    barLabel: typeof root.barLabel === 'string' ? root.barLabel : undefined,
  }
}

// --- holdings file (stock-holdings.json, runtime-dir or project .claude/) --
export type HoldingsFile = {
  asOf: number
  market?: MarketId
  source?: string
  holdings: Holding[]
}

/**
 * `stock-holdings.json` - positions the 損益 view prices, written by the
 * Shioaji fetcher every tick (after `list_positions`) into the runtime dir,
 * or by hand into the project's `.claude/` (see runtimeDir and the header
 * comment for the read order between the two). Unlike the quotes file this
 * is never treated as stale: a position does not go wrong just because
 * nobody wrote a fresh copy in the last two minutes, so QUOTE_STALE_MS does
 * not apply here. `asOf` still travels through, so the board can print when
 * the snapshot was taken.
 *
 * That "never stale" rule is exactly why a legacy project-path file is
 * dangerous: before runtimeDir existed, `fetch-quotes-shioaji.py` wrote
 * straight into `<project>/.claude/stock-holdings.json`, always stamped
 * `"source": "永豐 庫存"` (see the script's `list_positions` output). A copy
 * left behind after upgrading to the runtime-dir version would otherwise
 * read as a permanent manual override and never go away on its own. The
 * project-path caller (see the `poll` loop in `session.start`) treats that
 * exact source string at that exact path as the legacy fetcher's leftovers
 * and discards it instead of trusting it - the runtime-dir file is never
 * filtered this way, and nothing else is expected to write that label at
 * the project path (see stock-holdings.example.json and the README).
 */
export function parseHoldingsFile(text: string | undefined): HoldingsFile | undefined {
  if (!text) return undefined
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const holdingsRaw = root.holdings
  const holdings = parseHoldingsList(holdingsRaw)
  if (holdings.length === 0) return undefined
  const market =
    root.market === 'tw' || root.market === 'us' || root.market === 'tf' || root.market === 'crypto' ? root.market : undefined
  return {
    asOf: num(root.asOf, 0),
    market,
    source: typeof root.source === 'string' ? root.source : undefined,
    holdings,
  }
}

/**
 * The holdings file wins over `stock-band.json`'s `holdings` block for
 * whichever market it names (or for both, if it leaves `market` out); a
 * market the file does not cover falls back to the config block. Returns the
 * raw (unpriced) holdings plus what the footer should call the source and
 * when the snapshot was taken - `pricedHoldings` below fills in the price.
 */
export function holdingsFor(
  market: MarketId,
  file: HoldingsFile | undefined,
  cfg: Config,
): { holdings: Holding[]; source: string; asOf: number } {
  const manual = cfg.holdings[market]
  if (cfg.holdingsSource === 'config' && manual.length > 0) {
    return { holdings: manual, source: '設定檔', asOf: 0 }
  }
  if (file && (!file.market || file.market === market)) {
    return { holdings: file.holdings, source: file.source ?? '庫存檔', asOf: file.asOf }
  }
  return { holdings: manual, source: manual.length > 0 ? '設定檔' : '', asOf: 0 }
}
/**
 * Every holding's price, live quote first: a symbol the feed or the quotes
 * file is already carrying (because it is on the watchlist, or because the
 * feed also fetched it for this reason - see feedUs/feedTw) prices the
 * holding at the same number the table would show. A holding the feed never
 * touched falls back to whatever the holdings file itself carried
 * (`price`/`prevClose`), and a holding with neither reads as its own cost so
 * the P&L math never divides by zero or shows NaN.
 */
export function pricedHoldings(
  holdings: Holding[],
  quotesFile: QuotesFile | undefined,
  cfg: Config,
  market: MarketId,
): PricedHolding[] {
  return holdings.map(h => {
    const live = quotesFile?.quotes[h.code]
    const price = live?.price ?? h.price ?? h.cost
    const prevClose = live?.prevClose ?? h.prevClose ?? price
    // `h.name` defaults to `h.code` when the holdings file or the config's
    // `holdings` block left it out (parseHoldingsList), so `h.name ===
    // h.code` is how "this holding has no real name" shows up here. In that
    // case: the config/built-in watchlist's own name for the same code
    // (even one bought outside the watchlist can still be a known symbol),
    // then whatever the quotes file says, then the code itself as the last
    // resort - never a bare code standing in for a name when something
    // better is one lookup away.
    const configName = cfg.lists[market].find(t => t.code === h.code)?.name
    // tf reads config-first like the 台指期 table (futuresName): the same
    // contract should carry the same name in both views
    const name =
      market === 'tf'
        ? (configName ?? (h.name !== h.code ? h.name : (live?.name ?? h.code)))
        : h.name !== h.code
          ? h.name
          : (configName ?? live?.name ?? h.code)
    // The exact same snapshot-before-last a watchlist row's own `was` reads
    // (quoteRow's `wasPrice` param) - a holding priced off the live feed
    // blinks on a real tick-to-tick price move for free, with no separate
    // cache of "the price last render saw" to keep in sync. A holding
    // priced from its own file/config `price` (no live quote at all) has no
    // `prev` to compare against, so it never blinks - correct, since
    // nothing about it actually ticked.
    const wasPrice = quotesFile?.prev?.[h.code]?.price
    return {
      code: h.code,
      name,
      qty: h.qty,
      cost: h.cost,
      price,
      prevClose,
      multiplier: h.multiplier ?? 1,
      // omitted, not undefined: see quoteRow on what a Client's props may hold
      ...(live?.decimals !== undefined ? { decimals: live.decimals } : {}),
      ...(wasPrice !== undefined && wasPrice !== price ? { was: { price: wasPrice } } : {}),
    }
  })
}
