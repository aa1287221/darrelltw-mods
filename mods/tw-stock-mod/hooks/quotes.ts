// Quote and holding shapes, the demo walk, and the 損益 sort.

import { DEMO_BAR_MS } from './constants.ts'
import type { Ticker } from './markets.ts'

// --- quotes ----------------------------------------------------------------
/** open, high, low, close, then optional volume and bucket-start ms (#12: the fetcher writes six) */
export type Bar = [number, number, number, number, number?, number?]
/** the bar widths a futures file's `barsBy` block may carry, in minutes */
export type Timeframe = '1' | '5' | '15' | '60'
export const TIMEFRAMES: Timeframe[] = ['1', '5', '15', '60']
export type ChartMode = 'candle' | 'line'
export type IndexRow = { name: string; value: number; change: number; pct: number }

export type QuoteRow = {
  code: string
  name: string
  price: number
  change: number
  pct: number
  prevClose: number
  bars?: Bar[]
  /**
   * 24h turnover in USDT (Pionex's `amount` field, NOT `volume` - `volume`
   * is the coin's own unit count, which is meaningless to rank one coin
   * against another; see effectiveSort/the `'volume'` sort branch below).
   * Crypto only - tw/us never set this.
   */
  amount?: number
  /**
   * what this row said before the last update; absent when nothing moved.
   * `code`/`name` are only set when the whole row changed symbol - a page turn -
   * and they are what makes the board flap the left-hand columns as well.
   */
  was?: { price: number; change: number; pct: number; code?: string; name?: string }
  /**
   * the market has a live/override snapshot, but it never priced this code -
   * not the same as "no change" (pct 0). board.tsx draws a dim placeholder
   * instead of the price/change/pct fields; see buildProps' quotes.map.
   */
  noData?: boolean
  /** price/change digits when the contract says (a futures file's `decimals`); the board defaults to 2 */
  decimals?: number
}

// PROTOTYPE: a deterministic sine walk off the previous close, so the band
// moves on its own with no API and no randomness to debug.
export function demoPrice(sym: Ticker, now: number): number {
  const t = now / 1000
  const pct =
    sym.drift +
    sym.amp * Math.sin((2 * Math.PI * t) / sym.period + sym.phase) +
    0.35 * sym.amp * Math.sin((2 * Math.PI * t) / (sym.period / 4.7) + sym.phase * 2.3)
  return Math.round(sym.prevClose * (1 + pct / 100) * 100) / 100
}

// a bar's high/low needs intra-bar movement the sine walk does not have, so a
// deterministic wiggle stands in for it
export function demoBars(sym: Ticker, now: number, count: number): Bar[] {
  const bars: Bar[] = []
  for (let i = 0; i < count; i++) {
    const t1 = now - (count - 1 - i) * DEMO_BAR_MS
    const o = demoPrice(sym, t1 - DEMO_BAR_MS)
    const c = demoPrice(sym, t1)
    const mid = (o + c) / 2
    const span = Math.abs(c - o) / 2 + mid * 0.0008 * (1 + Math.sin((t1 / 1000) * 1.7 + sym.phase) ** 2)
    bars.push([o, Math.max(o, c) + span, Math.min(o, c) - span, c])
  }
  return bars
}

/**
 * Rounds a price or a price difference to as many decimals as its own
 * magnitude needs to stay meaningful, rather than a flat 2 - the same
 * thresholds board.tsx's quotePriceDecimals() uses for display. A flat 2
 * decimals is harmless for tw/us (nothing on either watchlist trades under
 * $1) but silently wrecks a sub-$1 crypto move: DOGE's real 24h change of
 * $0.00558 rounds to $0.01 at a flat 2 decimals - not a display quirk, an
 * 80%+ relative error baked into `pct` itself, since pct is computed FROM
 * this rounded value (see quoteRow below). Scaling by the VALUE being
 * rounded rather than by market means tw/us (always >= 1) see no behavior
 * change at all.
 */
export function roundPrice(v: number): number {
  const decimals = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

export function quoteRow(
  sym: Ticker,
  price: number,
  prevClose: number,
  bars?: Bar[],
  wasPrice?: number,
  amount?: number,
): QuoteRow {
  const change = roundPrice(price - prevClose)
  // the old number measured against the same close, so only the price moved
  const wasChange = wasPrice === undefined ? 0 : roundPrice(wasPrice - prevClose)
  return {
    code: sym.code,
    name: sym.name,
    price,
    change,
    pct: prevClose ? (change / prevClose) * 100 : 0,
    prevClose,
    // a Client's props must not hold undefined: the engine rejects the whole
    // tree and draws nothing. Rows without K bars omit the key instead.
    ...(bars ? { bars } : {}),
    ...(amount !== undefined ? { amount } : {}),
    // a row that did not move has nothing to turn, and turning it anyway is
    // noise: a real board only flaps what changed
    ...(wasPrice !== undefined && wasPrice !== price
      ? { was: { price: wasPrice, change: wasChange, pct: prevClose ? (wasChange / prevClose) * 100 : 0 } }
      : {}),
  }
}

// --- optional config / quotes files ----------------------------------------
export type FileQuote = {
  price: number
  prevClose?: number
  name?: string
  bars?: Bar[]
  /** crypto only: 24h turnover in USDT (Pionex's `amount`), what the `'volume'` sort ranks by - see QuoteRow.amount */
  amount?: number
  /** futures only: the same bars resampled per timeframe; `bars` stays the 5 分 set for older readers */
  barsBy?: Partial<Record<Timeframe, Bar[]>>
  /** futures only (futures-quotes.json): points-to-money factor, display digits, and the month an alias resolved to */
  multiplier?: number
  decimals?: number
  resolved?: string
}

// A holding as the holdings file or `stock-band.json`'s `holdings` block
// states it - `price`/`prevClose` are optional because the live feed usually
// covers them; `pricedHolding` below fills in whatever this leaves out.
export type Holding = {
  code: string
  name: string
  /** shares for a stock; 口 for a futures contract, signed (the fetcher writes Sell as negative) */
  qty: number
  cost: number
  price?: number
  prevClose?: number
  /** points-to-money factor from the contract (futures-holdings.json); absent for stocks, read as 1 */
  multiplier?: number
}
// A holding once register.tsx has resolved a price for it - board.tsx (the
// 損益 view) only formats these, it never falls back to anything itself.
export type PricedHolding = {
  code: string
  name: string
  qty: number
  cost: number
  price: number
  prevClose: number
  /** 1 for stocks, so the existing P&L math is unchanged; the contract's own factor for futures */
  multiplier: number
  /** price/cost digits from the matching tf quote; omitted (board default 2) when there is none */
  decimals?: number
  /**
   * what this holding said before the last update - same idea as
   * QuoteRow.was, deliberately just as thin: only `price` carries real old
   * data, board.tsx recomputes was-side 今日%/今日損益/總損益/損益% from it
   * using the CURRENT cost/qty/prevClose (assumed stable within a tick),
   * exactly how quoteRow() derives `was.change`/`was.pct` from `was.price`
   * alone. `code`/`name` are only set on a page/sort turn (pricedForDisplay
   * in buildProps), when the row's OCCUPANT changed, not its price.
   */
  was?: { price: number; code?: string; name?: string }
}

/** which pnl column the 損益 view is sorted by - board.tsx only marks the active header */
export type PnlSortKey = 'code' | 'today' | 'todayPnl' | 'totalPnl' | 'totalPnlPct'
export const PNL_SORT_KEYS: PnlSortKey[] = ['code', 'today', 'todayPnl', 'totalPnl', 'totalPnlPct']
export const PNL_SORT_LABELS: Record<PnlSortKey, string> = {
  code: '代號',
  today: '今日%',
  todayPnl: '今日損益',
  totalPnl: '總損益',
  totalPnlPct: '損益%',
}

/**
 * Sorts the whole priced list by one column - register.tsx does this, not
 * board.tsx, because the sort has to hold across the page boundary (a
 * holding on page 2 by rank has to STAY on page 2 after paging back to it,
 * which only works if the array board.tsx slices is already in final order).
 */
export function sortHoldings(list: PricedHolding[], key: PnlSortKey, dir: 'asc' | 'desc'): PricedHolding[] {
  const rank = (h: PricedHolding): number =>
    key === 'today'
      ? h.prevClose
        ? (h.price / h.prevClose - 1) * 100
        : 0
      : key === 'todayPnl'
        ? (h.price - h.prevClose) * h.qty * h.multiplier
        : key === 'totalPnl'
          ? (h.price - h.cost) * h.qty * h.multiplier
          : h.cost
            ? // the position's own return: a short gains when the price falls (board.tsx's 損益% column)
              (h.price / h.cost - 1) * 100 * (h.qty < 0 ? -1 : 1)
            : 0
  const sign = dir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => (key === 'code' ? sign * a.code.localeCompare(b.code) : sign * (rank(a) - rank(b))))
}
