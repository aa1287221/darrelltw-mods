// Markets, their watchlists and trading sessions: which market is open, when
// the next one opens, and which one the band shows.

import type { TwExchange } from './constants.ts'
import type { Config } from './config.ts'

/** a footer index row on the MIS route; `code`/`ex` are what misChannel() reads */
export type TwIndex = { code: string; name: string; ex: TwExchange }

export type MarketId = 'tw' | 'us' | 'tf' | 'crypto'
export type Phase = 'open' | 'closed'
export type MarketMode = 'auto' | MarketId
/** a route the Taiwan feed can try, in the order `Config.twSources` lists them */
export type TwSourceName = 'shioaji' | 'capital' | 'yahoo' | 'mis'
export type View = 'table' | 'chart' | 'pnl'
/** how many symbols the table draws per row; "auto" picks off the list and the band's width, see effectiveColumns() */
export type ColumnMode = 'auto' | 1 | 2 | 3 | 4
/**
 * `'change'`/`'list'` are the original two - rank by 24h(tw/us)/24h(crypto)
 * %, or leave the watchlist's own order alone. `'marketcap'`/`'volume'` are
 * crypto-only (see effectiveSort): tw/us/tf have neither Pionex's `amount`
 * nor a CoinGecko supply cache, so either one falls back to `'change'` there.
 */
export type SortKey = 'change' | 'list' | 'marketcap' | 'volume'
/**
 * How the band lets a person jump between the market/holdings stops (see
 * marketStops()): `tabs` draws every stop as its own Button, `select`
 * draws the existing dropdown, `cycle` draws one Button that walks the
 * stops in order. `tabs` was tried 2026-09-19 at the upstream user's request
 * (the Select's own reflow/highlight chrome is the engine's, not something
 * this mod can restyle) and dropped there after width measurements on a
 * real terminal showed it does not reliably fit - see defaultConfig's own
 * comment on marketSwitcher for the numbers. `tabs` and `cycle` stay as
 * config-switchable alternatives, `select` is upstream's default.
 *
 * `tabbar` is this fork's own default (issue #9): one plain Button per stop
 * of forkStops(), the selected one bracketed `[台指期]`, 台股庫存 always a
 * stop, and the row never collapses - the session notes give way instead
 * (see the `fits` cascade in ui.render). See parseConfigRoot for how a
 * config file picks one; an invalid value falls back to `tabbar` rather
 * than throwing.
 */
export type MarketSwitcher = 'tabbar' | 'tabs' | 'select' | 'cycle'

export type Ticker = {
  code: string
  name: string
  /** 上市 tse (default) or 上櫃 otc; Taiwan only, and both price routes need it */
  ex?: TwExchange
  prevClose: number
  // demo-only price walk parameters (ignored once a quotes file drives the band)
  amp: number
  phase: number
  period: number
  drift: number
}

// prevClose is the change basis and, in demo mode, the level the fake walk
// oscillates around; amp/phase/period/drift only shape that fake walk and are
// ignored once a quotes file drives the band. All 20 prevClose values were
// read directly off Yahoo's spark endpoint on 2026-09-16 ~12:39 Taipei time
// and cross-checked against 證交所 MIS's own `y` field (exact match on every
// symbol) - refresh both if they drift. All twenty are 上市 (no otc symbol
// needed a `.TWO`/`otc_` route).
export const TW_LIST: Ticker[] = [
  { code: '2330', name: '台積電', prevClose: 2385, amp: 0.9, phase: 0, period: 47, drift: 1.1 },
  { code: '2317', name: '鴻海', prevClose: 246.5, amp: 0.7, phase: 1.7, period: 61, drift: 0.35 },
  { code: '2454', name: '聯發科', prevClose: 4430, amp: 1.1, phase: 3.1, period: 53, drift: -0.6 },
  { code: '0050', name: '元大台灣50', prevClose: 106.25, amp: 0.4, phase: 0.8, period: 71, drift: 0.55 },
  { code: '006208', name: '富邦台50', prevClose: 243.5, amp: 0.35, phase: 2.4, period: 67, drift: -0.15 },
  { code: '2412', name: '中華電', prevClose: 143.5, amp: 0.25, phase: 0.5, period: 83, drift: 0.1 },
  { code: '2881', name: '富邦金', prevClose: 151.0, amp: 0.5, phase: 1.2, period: 57, drift: 0.2 },
  { code: '2882', name: '國泰金', prevClose: 110.0, amp: 0.5, phase: 2.0, period: 63, drift: -0.15 },
  { code: '2891', name: '中信金', prevClose: 69.7, amp: 0.45, phase: 2.8, period: 69, drift: 0.1 },
  { code: '3008', name: '大立光', prevClose: 6055, amp: 1.4, phase: 3.5, period: 41, drift: -0.8 },
  { code: '2603', name: '長榮', prevClose: 233.5, amp: 1.6, phase: 4.2, period: 39, drift: 1.0 },
  { code: '1301', name: '台塑', prevClose: 62.0, amp: 0.35, phase: 4.9, period: 77, drift: -0.2 },
  { code: '2002', name: '中鋼', prevClose: 18.65, amp: 0.3, phase: 5.5, period: 87, drift: 0.05 },
  { code: '2308', name: '台達電', prevClose: 1670, amp: 0.9, phase: 0.2, period: 49, drift: 0.5 },
  { code: '3711', name: '日月光投控', prevClose: 592.0, amp: 0.8, phase: 0.9, period: 52, drift: 0.3 },
  { code: '2379', name: '瑞昱', prevClose: 703.0, amp: 1.0, phase: 1.6, period: 45, drift: -0.4 },
  { code: '3034', name: '聯詠', prevClose: 541.0, amp: 0.95, phase: 2.3, period: 48, drift: 0.35 },
  { code: '2357', name: '華碩', prevClose: 928.0, amp: 0.7, phase: 3.0, period: 59, drift: -0.25 },
  { code: '2382', name: '廣達', prevClose: 333.0, amp: 1.3, phase: 3.7, period: 43, drift: 0.9 },
  { code: '2303', name: '聯電', prevClose: 138.5, amp: 0.6, phase: 4.4, period: 64, drift: -0.3 },
]

// Same field contract as TW_LIST above. All 20 prevClose values came off
// Yahoo's spark endpoint in one request on 2026-09-16 ~13:05 Taipei time
// (US market closed, so these are the 09-15 closes) - refresh them if the
// demo walk starts oscillating around the wrong level. NFLX is post-split.
export const US_LIST: Ticker[] = [
  { code: 'NVDA', name: 'NVIDIA', prevClose: 210.96, amp: 1.3, phase: 0.4, period: 43, drift: 0.9 },
  { code: 'TSLA', name: 'Tesla', prevClose: 358.97, amp: 1.8, phase: 2.2, period: 37, drift: -1.2 },
  { code: 'NET', name: 'Cloudflare', prevClose: 330.36, amp: 1.5, phase: 4, period: 59, drift: 0.4 },
  { code: 'QQQ', name: 'Invesco QQQ', prevClose: 709.18, amp: 0.5, phase: 1.1, period: 73, drift: 0.25 },
  { code: 'VOO', name: 'Vanguard 500', prevClose: 699.3, amp: 0.4, phase: 3.6, period: 79, drift: -0.1 },
  { code: 'AAPL', name: 'Apple', prevClose: 333.08, amp: 0.7, phase: 0.9, period: 61, drift: 0.3 },
  { code: 'MSFT', name: 'Microsoft', prevClose: 505.41, amp: 0.6, phase: 1.6, period: 67, drift: -0.25 },
  { code: 'GOOGL', name: 'Alphabet', prevClose: 349.39, amp: 0.8, phase: 2.3, period: 55, drift: 0.45 },
  { code: 'AMZN', name: 'Amazon', prevClose: 253.54, amp: 0.85, phase: 3.0, period: 51, drift: -0.35 },
  { code: 'META', name: 'Meta', prevClose: 665.6, amp: 0.95, phase: 3.7, period: 47, drift: 0.5 },
  { code: 'AVGO', name: 'Broadcom', prevClose: 344.72, amp: 1.2, phase: 4.4, period: 45, drift: 0.7 },
  { code: 'AMD', name: 'AMD', prevClose: 493.41, amp: 1.4, phase: 5.1, period: 41, drift: 1.0 },
  { code: 'TSM', name: 'TSMC ADR', prevClose: 418.01, amp: 1.0, phase: 5.8, period: 49, drift: 0.6 },
  { code: 'NFLX', name: 'Netflix', prevClose: 80.32, amp: 0.9, phase: 0.2, period: 57, drift: -0.4 },
  { code: 'PLTR', name: 'Palantir', prevClose: 173.31, amp: 1.7, phase: 1.0, period: 39, drift: 0.85 },
  { code: 'COIN', name: 'Coinbase', prevClose: 191.45, amp: 2.0, phase: 1.9, period: 35, drift: -1.1 },
  { code: 'CRWD', name: 'CrowdStrike', prevClose: 235.38, amp: 1.3, phase: 2.7, period: 44, drift: 0.4 },
  { code: 'MU', name: 'Micron', prevClose: 924.03, amp: 1.6, phase: 3.4, period: 40, drift: 0.95 },
  { code: 'ORCL', name: 'Oracle', prevClose: 144.79, amp: 1.1, phase: 4.1, period: 53, drift: -0.5 },
  { code: 'ARM', name: 'Arm', prevClose: 239.01, amp: 1.25, phase: 4.8, period: 46, drift: 0.55 },
]

/** one trading session, minutes from local midnight; close <= open means it runs past midnight */
type Session = { open: number; close: number }

// Same field contract as TW_LIST/US_LIST, but `code` is the plain ticker
// (`BTC`), never the Pionex symbol (`BTC_USDT`) - pionexSymbol() below does
// that translation the same way yahooSymbol() does for Taiwan, and `name`
// is the ticker again rather than a company name (there is no issuer to
// name). `prevClose` here is NOT "yesterday's close" the way it is for
// tw/us: Pionex has no such concept (see feedCrypto's comment on 24-hour
// change), so it is only the demo-walk anchor and the config fallback -
// close prices read directly off the tickers endpoint on 2026-09-18
// ~23:15 UTC (see docs/stock-api-notes.md §11). amp/phase/period/drift are
// demo-only, same as the other two lists. Every code here must have a real
// Pionex market: TON does not (checked against the full ~330-symbol response,
// 2026-09-18) and was replaced by BCH, the next major by turnover that Pionex
// actually lists. A code with no market is not a crash - the existing "market
// has a snapshot but never priced this code" path draws it as a dim
// placeholder rather than a fake price (see buildProps) - but a default list
// must not ship a row that can never fill in.
export const CRYPTO_LIST: Ticker[] = [
  { code: 'BTC', name: 'BTC', prevClose: 80744.04, amp: 1.2, phase: 0, period: 53, drift: 0.3 },
  { code: 'ETH', name: 'ETH', prevClose: 2579.91, amp: 1.6, phase: 1.1, period: 47, drift: 0.4 },
  { code: 'SOL', name: 'SOL', prevClose: 110.92, amp: 2.1, phase: 2.2, period: 41, drift: 0.6 },
  { code: 'BNB', name: 'BNB', prevClose: 756.24, amp: 1.3, phase: 3.3, period: 59, drift: 0.2 },
  { code: 'XRP', name: 'XRP', prevClose: 1.3785, amp: 2.4, phase: 4.4, period: 37, drift: 0.5 },
  { code: 'DOGE', name: 'DOGE', prevClose: 0.08735, amp: 3.0, phase: 0.6, period: 33, drift: 0.7 },
  { code: 'ADA', name: 'ADA', prevClose: 0.2191, amp: 2.6, phase: 1.7, period: 43, drift: 0.35 },
  { code: 'AVAX', name: 'AVAX', prevClose: 8.1, amp: 2.8, phase: 2.8, period: 39, drift: 0.55 },
  { code: 'LINK', name: 'LINK', prevClose: 12.16, amp: 2.2, phase: 3.9, period: 45, drift: 0.45 },
  { code: 'BCH', name: 'BCH', prevClose: 252.6, amp: 1.9, phase: 5.0, period: 51, drift: 0.25 },
]

// Pionex has no market-cap or circulating-supply field at all (verified
// 2026-09-18 against the full ticker response: symbol/time/open/close/high/
// low/volume/amount/count, nothing else) - fetchCryptoSupply asks CoinGecko
// instead, and CoinGecko's `id` is NOT the ticker code (BNB is
// `binancecoin`, XRP is `ripple`, AVAX is `avalanche-2`, BCH is
// `bitcoin-cash` - the rest happen to match their lowercase full name). A
// user's config.lists.crypto is not required to stay inside this table: a
// code with no entry here is logged once per session (cryptoUnmappedWarned)
// and its market cap reads 0, so it sorts last rather than crashing or
// dropping off the list (see marketCapOf).
export const CRYPTO_COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  BCH: 'bitcoin-cash',
}

type MarketConf = {
  label: string
  /** the pnl stop's tab label: 台股庫存 / 美股庫存 / 期貨庫存 */
  holdingsLabel: string
  list: Ticker[]
  hours: string
  indexName: string
  indexClose: number
  indexAmp: number
  indexDrift: number
  /** weekday sessions in the day's order; 台指期 has two, the stock markets one */
  sessions: Session[]
  offset: (now: number) => number
  /**
   * true for a market that never closes (crypto). phaseOf() reads this
   * before it ever looks at `open`/`close`/weekday, because a 24/7 market
   * has no boundary those fields could express - there is no real "closed"
   * moment to compare `now` against, so minutesToOpen/minutesSinceClose
   * (which walk forward/back to the next/last such moment) do not apply
   * either and are never called once this is true. `sessions` still carries
   * one 0-1440 entry for this market (see MARKETS.crypto) so the places that
   * print it (chart-view axis labels) get a literally true "00:00-24:00"
   * span instead of an undefined read - openSession/nextSession/lastSession
   * all hand that entry back without consulting sessionSpans.
   */
  alwaysOpen?: boolean
  /**
   * what `sort: undefined` resolves to for THIS market (see effectiveSort) -
   * the per-market default the old single global `defaultConfig().sort`
   * used to hardcode. tw/us keep the original 'change'; crypto opens on
   * 'marketcap', at the user's request (2026-09-19).
   */
  defaultSort: SortKey
}

// Taipei is UTC+8 all year; US eastern is UTC-5, UTC-4 between the 2nd Sunday
// of March and the 1st Sunday of November. Doing the arithmetic here beats
// trusting a tz database to exist inside the hooks sandbox.
function usEasternOffset(now: number): number {
  const d = new Date(now)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  if (month < 3 || month > 11) return -5
  if (month > 3 && month < 11) return -4
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() // 0 = Sunday
  const firstSunday = 1 + ((7 - firstDow) % 7)
  if (month === 3) return day >= firstSunday + 7 ? -4 : -5
  return day >= firstSunday ? -5 : -4
}

export const MARKETS: Record<MarketId, MarketConf> = {
  tw: {
    label: '台股',
    holdingsLabel: '台股庫存',
    list: TW_LIST,
    hours: '09:00-13:30',
    indexName: '加權指數',
    indexClose: 45862.52,
    indexAmp: 0.6,
    indexDrift: 0.75,
    sessions: [{ open: 9 * 60, close: 13 * 60 + 30 }],
    offset: () => 8,
    defaultSort: 'change',
  },
  us: {
    label: '美股',
    holdingsLabel: '美股庫存',
    list: US_LIST,
    hours: '09:30-16:00 ET',
    indexName: 'NASDAQ',
    indexClose: 26333.04,
    indexAmp: 0.5,
    indexDrift: -0.35,
    sessions: [{ open: 9 * 60 + 30, close: 16 * 60 }],
    offset: usEasternOffset,
    defaultSort: 'change',
  },
  crypto: {
    label: '加密貨幣',
    // never a stop (crypto has no broker-fetcher route, see marketStops), so
    // only here to keep MarketConf total
    holdingsLabel: '加密貨幣庫存',
    list: CRYPTO_LIST,
    hours: '24 小時',
    // BTC stands in for a headline index (see feedCrypto) - this is only the
    // pre-fetch demo-walk anchor, same read as CRYPTO_LIST's prevClose
    // values, 2026-09-18 ~23:15 UTC.
    indexName: 'BTC',
    indexClose: 80744.04,
    indexAmp: 1.2,
    indexDrift: 0.3,
    // The whole day, 00:00-24:00 - see alwaysOpen's comment on MarketConf.
    // Never fed to sessionSpans (a 1440-minute session would read as a
    // zero-length one there): alwaysOpen short-circuits every session lookup
    // to this entry, so only its open/close are ever printed.
    sessions: [{ open: 0, close: 24 * 60 }],
    // Crypto has no exchange-local session to translate, so this reads as
    // Taipei time - taipeiNote() then sees offset === TAIPEI_OFFSET and
    // skips the "台灣 HH:MM" restatement it would otherwise add for a
    // market whose hours are in another timezone.
    offset: () => TAIPEI_OFFSET,
    alwaysOpen: true,
    defaultSort: 'marketcap',
  },
  // 台灣期貨: no built-in list (the config's `futures` is the only source) and
  // no demo walk - every zero here keeps the index card from inventing a level.
  tf: {
    label: '台指期',
    holdingsLabel: '期貨庫存',
    list: [],
    hours: '08:45-13:45 · 15:00-05:00',
    indexName: '台指期',
    indexClose: 0,
    indexAmp: 0,
    indexDrift: 0,
    sessions: [
      { open: 8 * 60 + 45, close: 13 * 60 + 45 },
      { open: 15 * 60, close: 5 * 60 },
    ],
    offset: () => 8,
    defaultSort: 'change',
  },
}

type LocalParts = { dow: number; minutes: number; clock: string }

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export function localParts(now: number, offsetHours: number): LocalParts {
  const d = new Date(now + offsetHours * 3_600_000)
  return {
    dow: d.getUTCDay(), // 0 = Sunday
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    clock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
  }
}

const TAIPEI_OFFSET = 8 // UTC+8 all year, no daylight saving

/** one session on one weekday, as minutes since Sunday 00:00 market-local (`start` < `end`) */
type SessionSpan = { session: Session; start: number; end: number }

// PROTOTYPE LIMIT: weekday-only. Taiwan and US market holidays (and the
// Taiwan make-up trading Saturdays) are not in here - a real feed's own
// "no trades today" answer is what should decide this later.
//
// A session starts on a weekday and runs for its length, so a 夜盤 that
// starts Friday 15:00 ends Saturday 05:00 and nothing starts on a weekend.
// The week before and after are included so a lookup near Sunday midnight
// still finds Friday's close and Monday's open.
function sessionSpans(market: MarketId): SessionSpan[] {
  const out: SessionSpan[] = []
  for (const session of MARKETS[market].sessions) {
    const length = (((session.close - session.open) % 1440) + 1440) % 1440
    for (const week of [-1, 0, 1]) {
      for (let dow = 1; dow <= 5; dow++) {
        const start = (week * 7 + dow) * 1440 + session.open
        out.push({ session, start, end: start + length })
      }
    }
  }
  return out
}

function weekMinute(now: number, market: MarketId): number {
  const { dow, minutes } = localParts(now, MARKETS[market].offset(now))
  return dow * 1440 + minutes
}

/** the session trading right now, if any */
function openSession(now: number, market: MarketId): Session | undefined {
  if (MARKETS[market].alwaysOpen) return MARKETS[market].sessions[0]
  const t = weekMinute(now, market)
  return sessionSpans(market).find(s => s.start <= t && t < s.end)?.session
}

export function phaseOf(now: number, market: MarketId): Phase {
  return openSession(now, market) ? 'open' : 'closed'
}

/** the next session to open and how far away it is */
function nextSession(now: number, market: MarketId): { session: Session; minutes: number } {
  // a 24/7 market is never "about to open" - the one session it has is the
  // answer, at no distance, so a caller printing it still gets 00:00
  if (MARKETS[market].alwaysOpen) return { session: MARKETS[market].sessions[0], minutes: 0 }
  const t = weekMinute(now, market)
  let best: SessionSpan | undefined
  for (const s of sessionSpans(market)) if (s.start > t && (!best || s.start < best.start)) best = s
  return { session: best!.session, minutes: best!.start - t }
}

/** the session that closed most recently and how long ago */
function lastSession(now: number, market: MarketId): { session: Session; minutes: number } {
  // same for "last closed": a 24/7 market never did, see nextSession
  if (MARKETS[market].alwaysOpen) return { session: MARKETS[market].sessions[0], minutes: 0 }
  const t = weekMinute(now, market)
  let best: SessionSpan | undefined
  for (const s of sessionSpans(market)) if (s.end <= t && (!best || s.end > best.end)) best = s
  return { session: best!.session, minutes: t - best!.end }
}

/** the session the board describes: the one trading, else the one that closed last */
export function currentSession(now: number, market: MarketId): Session {
  return openSession(now, market) ?? lastSession(now, market).session
}

function minutesToOpen(now: number, market: MarketId): number {
  return nextSession(now, market).minutes
}

function minutesSinceClose(now: number, market: MarketId): number {
  return lastSession(now, market).minutes
}

/** when this market last closed, as a timestamp - minutesSinceClose walks back
 * over the weekend for us, so this is a real moment on any day of the week */
export function lastCloseAt(now: number, market: MarketId): number {
  return now - minutesSinceClose(now, market) * 60_000
}

export function hhmm(minutesFromMidnight: number): string {
  return `${pad2(Math.floor(minutesFromMidnight / 60))}:${pad2(minutesFromMidnight % 60)}`
}

export function sessionNote(now: number, market: MarketId, phase: Phase): string {
  const conf = MARKETS[market]
  const zone = MARKETS[market].offset(now) === TAIPEI_OFFSET ? '' : ' ET'
  if (phase === 'open') return conf.hours
  const { session, minutes } = nextSession(now, market)
  return minutes <= 1440 ? `下次開盤 ${hhmm(session.open)}${zone}` : `下個交易日 ${hhmm(session.open)}${zone}`
}

// The person reading this band lives in Taipei, so US hours in ET answer the
// wrong question: 09:30 ET is 21:30 tonight, and the close lands after midnight.
// Returns '' for a market already on Taipei time, and the board drops the
// restatement rather than the clock when the row runs out of room.
export function taipeiNote(now: number, market: MarketId, phase: Phase): string {
  const conf = MARKETS[market]
  if (conf.offset(now) === TAIPEI_OFFSET) return ''
  const shift = (TAIPEI_OFFSET - conf.offset(now)) * 60
  const at = (minutes: number) => hhmm((((minutes + shift) % 1440) + 1440) % 1440)
  const session = phase === 'open' ? currentSession(now, market) : nextSession(now, market).session
  return phase === 'open' ? `台灣 ${at(session.open)}-${at(session.close)}` : `台灣 ${at(session.open)}`
}

const PREVIEW_MINS = 60 // how early a market takes the band over before it opens

// auto mode: whichever market is trading. Outside both sessions the band keeps
// showing the market that closed MOST RECENTLY - its closing prices are the
// news right after 13:30, not the other side of the world's pre-market - until
// the other market is within PREVIEW_MINS of its open.
// 台指期 only takes the band over while it is the one market trading (夜盤
// after 台股 and before 美股); the closed-market race stays between tw and us.
//
// Crypto never enters this race on purpose: it is alwaysOpen (see
// MarketConf), so if it competed here on the same "which one is open"
// footing it would win every single tick and tw/us would never surface in
// auto mode again. Auto stays a tw/us(/tf) pick; crypto only shows up when
// `market` names it directly or a manual switch lands on it (see mode !==
// 'auto' below, which is untouched by this - it already returns whatever
// `mode` says outright).
export function pickMarket(now: number, mode: MarketMode, hasFutures: boolean): { market: MarketId; phase: Phase } {
  if (mode !== 'auto') return { market: mode, phase: phaseOf(now, mode) }
  if (phaseOf(now, 'tw') === 'open') return { market: 'tw', phase: 'open' }
  if (phaseOf(now, 'us') === 'open') return { market: 'us', phase: 'open' }
  if (hasFutures && phaseOf(now, 'tf') === 'open') return { market: 'tf', phase: 'open' }
  const twToOpen = minutesToOpen(now, 'tw')
  const usToOpen = minutesToOpen(now, 'us')
  const soonest = Math.min(twToOpen, usToOpen)
  if (soonest <= PREVIEW_MINS) return { market: twToOpen <= usToOpen ? 'tw' : 'us', phase: 'closed' }
  const market: MarketId = minutesSinceClose(now, 'tw') <= minutesSinceClose(now, 'us') ? 'tw' : 'us'
  return { market, phase: 'closed' }
}

/** whether the config names any futures contract - the switch for the tf market */
export function hasFutures(cfg: Config): boolean {
  return cfg.lists.tf.length > 0
}
