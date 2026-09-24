// Endpoint helpers for the built-in feed: URLs and parsers for Yahoo, 證交所 MIS and symbol spellings. No requests are made here - register.tsx owns those.

import { CHART_BARS, FEED_UA, MIS_URL } from './constants.ts'
import type { TwExchange } from './constants.ts'
import type { MarketId } from './markets.ts'
import type { Bar, FileQuote } from './quotes.ts'
import { asRecord, num, str } from './config.ts'

// --- live feed: Yahoo ------------------------------------------------------
// The spark endpoint answers a whole symbol list in one request, with the last
// price, the previous close and the day's 5-minute closes - everything the
// table needs. The chart endpoint answers open/high/low/close for one symbol,
// which only the trend view needs. Both are public and keyless; both refuse a
// request that does not look like a browser, so FEED_UA is not optional.

// Both the CDN in front of Yahoo and the host's own fetch answer a repeated
// URL from cache - measured: six ticks over 80 seconds returned a byte-identical
// body and a frozen price. `_` makes every tick a new URL, and the no-cache
// headers cover the near side.
export const FEED_HEADERS = { 'User-Agent': FEED_UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' }

export function sparkUrl(symbols: string[], now: number): string {
  const list = symbols.map(encodeURIComponent).join(',')
  return `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${list}&range=1d&interval=5m&_=${now}`
}

export function chartUrl(symbol: string, now: number): string {
  const s = encodeURIComponent(symbol)
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1d&interval=5m&includePrePost=false&_=${now}`
}

/**
 * the Yahoo symbol for a watchlist entry. US codes already are symbols;
 * Taiwan needs the exchange suffix, and a code that carries its own dot
 * (someone wrote `2330.TW` in the config) is left alone.
 */
// only ever called for tw/us - crypto has its own symbol shape (see
// pionexSymbol below) and no Yahoo route for K bars (see feedBars' crypto
// guard), so `market === 'crypto'` never reaches here.
export function yahooSymbol(market: MarketId, t: { code: string; ex?: TwExchange }): string {
  if (market === 'us') return t.code
  return t.code.includes('.') ? t.code : `${t.code}.${t.ex === 'otc' ? 'TWO' : 'TW'}`
}

/** the Pionex symbol for a watchlist entry: `BTC` -> `BTC_USDT`. Every
 * crypto quote here is USDT-denominated - Pionex has no other quote asset
 * this band needs, and the verified symbol shape is BASE_QUOTE (see
 * PIONEX_TICKERS_URL). */
export function pionexSymbol(code: string): string {
  return `${code}_USDT`
}

/** MIS names a symbol by exchange: `tse_2330.tw`, `otc_6488.tw`, `tse_t00.tw` */
export function misChannel(t: { code: string; ex?: TwExchange }): string {
  return `${t.ex === 'otc' ? 'otc' : 'tse'}_${t.code}.tw`
}

export function misUrl(channels: string[], now: number): string {
  return `${MIS_URL}?ex_ch=${encodeURIComponent(channels.join('|'))}&json=1&delay=0&_=${now}`
}

/** MIS hands every number back as a string, and an untraded symbol as '-' */
function misNum(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : NaN
}

/**
 * one MIS answer, keyed by plain code (`2330`, `t00`). `z` is the last trade
 * and it reads `-` between trades - the last actual deal is then in `trade.z`,
 * and a symbol that has not traded at all today has neither, so it falls back
 * to the open and finally to yesterday's close rather than dropping the row.
 * `tradedAt` is the exchange's own clock, which is what the band shows as 更新.
 */
export function parseMis(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
  const out: Record<string, FileQuote> = {}
  let tradedAt = 0
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return { quotes: out, tradedAt }
  }
  // an error payload is a 200 with rtcode set and no msgArray
  if (str(root?.rtcode, '0000') !== '0000') return { quotes: out, tradedAt }
  const rows = Array.isArray(root?.msgArray) ? (root.msgArray as unknown[]) : []
  for (const raw of rows) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.c, '')
    const trade = asRecord(entry.trade)
    const price = [misNum(entry.z), misNum(trade?.z), misNum(entry.o), misNum(entry.y)].find(v =>
      Number.isFinite(v),
    )
    const prevClose = misNum(entry.y)
    if (!code || price === undefined || !Number.isFinite(prevClose)) continue
    const name = str(entry.n, '')
    out[code] = { price, prevClose, ...(name ? { name } : {}) }
    // tlong is already in milliseconds
    const at = misNum(entry.tlong)
    if (Number.isFinite(at)) tradedAt = Math.max(tradedAt, at)
  }
  return { quotes: out, tradedAt }
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? asRecord(value[0]) : undefined
}

/**
 * the spark payload, keyed by Yahoo symbol; a symbol that came back broken is
 * dropped. `tradedAt` is the newest `regularMarketTime` in the answer - the
 * exchange's own clock, which is what the band shows as 更新.
 */
export function parseSpark(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
  const out: Record<string, FileQuote> = {}
  let tradedAt = 0
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return { quotes: out, tradedAt }
  }
  const spark = asRecord(root?.spark)
  const results = Array.isArray(spark?.result) ? (spark.result as unknown[]) : []
  for (const raw of results) {
    const entry = asRecord(raw)
    if (!entry) continue
    const symbol = str(entry.symbol, '')
    const response = firstRecord(entry.response)
    const meta = asRecord(response?.meta)
    if (!symbol || !meta) continue
    const price = num(meta.regularMarketPrice, NaN)
    const prevClose = num(meta.previousClose, num(meta.chartPreviousClose, NaN))
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue
    out[symbol] = { price, prevClose }
    // Yahoo answers seconds; the band works in milliseconds
    tradedAt = Math.max(tradedAt, num(meta.regularMarketTime, 0) * 1000)
  }
  return { quotes: out, tradedAt }
}

/** one symbol's 5-minute K bars with volume and bucket start; a bar with a null leg is dropped, not patched */
export function parseChartBars(text: string): Bar[] | undefined {
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  const chart = asRecord(root?.chart)
  const result = firstRecord(chart?.result)
  const quote = asRecord(firstRecord(asRecord(result?.indicators)?.quote))
  if (!quote) return undefined
  const o = quote.open
  const hi = quote.high
  const lo = quote.low
  const c = quote.close
  if (!Array.isArray(o) || !Array.isArray(hi) || !Array.isArray(lo) || !Array.isArray(c)) return undefined
  const vol = Array.isArray(quote.volume) ? (quote.volume as unknown[]) : []
  const stamps = Array.isArray(result?.timestamp) ? (result.timestamp as unknown[]) : []
  const bars: Bar[] = []
  for (let i = 0; i < c.length; i++) {
    const leg = [o[i], hi[i], lo[i], c[i]]
    if (leg.every(v => typeof v === 'number' && Number.isFinite(v))) {
      const bar: Bar = [leg[0] as number, leg[1] as number, leg[2] as number, leg[3] as number]
      // Yahoo answers seconds; a bar with no stamp is still a bar (the board falls back to the session axis)
      const at = num(stamps[i], 0) * 1000
      if (at > 0) bar.push(Math.max(0, num(vol[i], 0)), at)
      bars.push(bar)
    }
  }
  return bars.length > 0 ? bars.slice(-CHART_BARS) : undefined
}
