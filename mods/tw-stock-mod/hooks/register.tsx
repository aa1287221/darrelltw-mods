/* @jsx h */
import type { Register } from 'claude-code'

// tw-stock-mod: a watchlist band above the Claude Code prompt. Taiwan trading
// hours show the Taiwan list, US trading hours show the US list, and the
// red/green convention flips with the market (台股紅漲綠跌 / 美股綠漲紅跌).
//
// This module never calls $.model.* and never touches the prompt: it computes
// the market session off $.clock.now(), builds a quote snapshot, and draws a
// Client board (hooks/board.tsx). Both markets are priced live by the feed
// below, each from its own source and each saying which in the footer: US
// quotes come from Yahoo's public endpoints, and so does Taiwan by default -
// Yahoo's Taiwan quotes run about twenty minutes behind, the tradeoff for a
// feed that answers with one request whatever the list length.
// `twSources` (an order of preference, e.g. `["shioaji", "yahoo"]`) tries
// the exchange's own real-time intraday endpoint (`mis`) or 永豐's real-time
// feed (`shioaji`) first, falling through to the next entry for a tick that
// source has nothing fresh for; the shipped default is `["yahoo"]` alone. A
// market the feed cannot reach at all falls back to a
// deterministic sine walk off each symbol's previous close, and the footer
// then says 示範資料 rather than pretending.
// Machine-written quotes and holdings live under the user's home directory
// now (see runtimeDir below), never in the project's `.claude/`. Quotes read
// order: the runtime-dir file while it is fresh (<120s), then the project's
// `.claude/stock-quotes.json` - which stays as the override seam (see
// stock-band.example.json and docs/stock-api-notes.md) for a hand-edited
// snapshot or another fetcher to take the band over - then the built-in
// feed. 台指期 reads only the fetcher's runtime-dir `futures-quotes.json`
// (no override, no feed: 永豐 is its only route). Holdings follow the same
// order, except the runtime-dir file never expires (see parseHoldingsFile):
// a position does not go stale just because nobody wrote a fresh copy
// recently.
//
// Never name a local variable `h`: every JSX tag in this file compiles to h(...).

const CONFIG_PATH = '.claude/stock-band.json'
const QUOTES_PATH = '.claude/stock-quotes.json'
const HOLDINGS_PATH = '.claude/stock-holdings.json'
// A user-level config, never inside a project (so it never lands in version
// control): each person's own source order and broker paths live here, and
// a shared project's stock-band.json stays neutral. `~` is resolved with
// $.env.get("HOME") at poll time, since a path constant cannot expand it.
const USER_CONFIG_REL = '.claude/stock-band.json'

// Everything the module or the Shioaji fetcher writes at runtime - quotes,
// holdings, the heartbeat, the fetcher's log and its PID file - lives under
// this directory instead of the project's `.claude/`, so a shared project
// never picks up one person's live prices or PID file. One directory per
// project avoids collisions: RUNTIME_DIR_ROOT plus the project path with
// its leading "/" dropped and every remaining "/" turned into "-" (e.g.
// `/Users/x/app` -> `Users-x-app`). `home` falls back to the project's own
// `.claude/` only when $HOME is unset, matching how this module wrote its
// runtime files before runtimeDir existed.
const RUNTIME_DIR_ROOT = '.claude/stock-band'
function runtimeDir(home: string, project: string): string {
  if (!home) return `${project}/.claude/`
  const slug = project.replace(/^\/+/, '').replace(/\//g, '-')
  return `${home}/${RUNTIME_DIR_ROOT}/${slug}/`
}

const DEFAULT_REFRESH_MS = 3000
const QUOTE_STALE_MS = 120_000
const SNOOZE_MS = 30 * 60 * 1000
// One symbol page in single-column mode, two in two-column mode (see
// `columns` below) - the table Client is 8 terminal rows either way, the
// chart one 9, whatever the list holds.
const PAGE_SIZE_1COL = 5
const PAGE_SIZE_2COL = 10
// Yahoo's spark endpoint answers `Number of symbols needs to be less than or
// equal to 20` above 20 symbols (measured 2026-09-16: 20 -> 200, 21 -> 400).
// That is a request-batching limit, not a watchlist-length one - `fetchSpark`
// already splits a longer symbol list into 20-symbol requests - but a list
// longer than Yahoo answers in two requests is not worth carrying, so this
// caps it there too.
const MAX_SYMBOLS = 20
const SPARK_BATCH = 20 // Yahoo's own per-request symbol cap
const PAGE_MS_DEFAULT = 10_000 // one page holds this long before the board turns
const PAGE_MS_MIN = 4000
// A budget, not an interval: `feedMs` alone cannot keep the host inside the
// limit once one tick costs more than one request. See feedInterval().
const REQUESTS_PER_HOUR = 300
const CHART_BARS = 40 // K bars the chart view asks for (it draws what fits)
const DEMO_BAR_MS = 3000 // demo time per fake bar; a real feed sets its own

// --- live feed --------------------------------------------------------------
// Yahoo's public endpoints, no key, no account. One batched spark request per
// tick covers the whole list plus the index, which is what keeps the feed
// inside the rate limit: a request with no browser User-Agent gets 429 on the
// first try, and a burst of per-symbol requests gets 429 as well. K bars cost
// one request per symbol, so nothing fetches them until the chart view asks
// for the one symbol it is drawing.
const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const FEED_MS_DEFAULT = 30_000
const FEED_MS_MIN = 15_000 // a floor, so a bad config cannot get the host banned
const FEED_BACKOFF_MAX_MS = 300_000
const BARS_MAX_AGE_MS = 120_000 // a 5-minute bar refetched sooner than this says nothing new
const BARS_STALE_MS = 900_000 // past this a bar set is dropped rather than drawn
const US_INDEX_SYMBOL = '^IXIC' // NASDAQ Composite, what MARKETS.us calls its index
// the three the US market is read by. They ride the same batched request as
// the quotes, so showing all three costs no extra call.
const US_INDICES: { symbol: string; name: string }[] = [
  // Latin names: the board flaps them character by character, and a Chinese
  // character has no drum to riffle through
  { symbol: '^DJI', name: 'DOW' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: US_INDEX_SYMBOL, name: 'NASDAQ' },
]

// `"mis"` in `twSources` sends Taiwan to the exchange instead of Yahoo. Both
// are keyless, but Yahoo's Taiwan quotes run about twenty minutes behind the
// floor (measured 2026-09-16: Yahoo answered 10:21:51 while MIS was on
// 10:41:59), and a band that says 即時 has to mean it - which is what `mis`
// is for. MIS takes the whole watchlist and both indices in one request
// whatever the list length, and has no 20-symbol cap of its own.
const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
// 上市 / 上櫃. It decides the MIS channel prefix and the Yahoo suffix, and
// nothing else about a symbol tells them apart - 6488 is 上櫃, 2330 is 上市.
type TwExchange = 'tse' | 'otc'
const TW_INDEX_SYMBOL = 't00' // 發行量加權股價指數, what MARKETS.tw calls its index
// Latin names for the same reason the US ones are Latin: the board flaps one
// character at a time and a Chinese character has no drum to riffle through.
// they are named `code` rather than `symbol` so misChannel() takes them as-is
// MIS answers every index on the same request as the quotes, so the length of
// this list costs nothing. What it does cost is time on the footer: each row
// holds 5 s before the board flaps to the next, so four indices is a 20 s lap.
// `twIndices` in the config replaces the whole list - the exchange publishes
// 146 of them (getCategory.jsp?ex=tse&i=TIDX lists every channel).
const TW_INDICES: TwIndex[] = [
  { code: TW_INDEX_SYMBOL, name: 'TAIEX', ex: 'tse' }, // 發行量加權股價指數
  { code: 't24', name: 'SEMI', ex: 'tse' }, // 半導體類指數
  { code: 't17', name: 'FINANCE', ex: 'tse' }, // 金融保險類指數
  { code: 't15', name: 'SHIPPING', ex: 'tse' }, // 航運類指數
  // 櫃買 is { code: 'o00', name: 'TPEx', ex: 'otc' } - it needs the otc channel
]
const TW_YAHOO_INDEX = '^TWII' // the Yahoo route's only index; ^TWOII answers a year-old close

/** a footer index row on the MIS route; `code`/`ex` are what misChannel() reads */
type TwIndex = { code: string; name: string; ex: TwExchange }

type MarketId = 'tw' | 'us' | 'tf'
type Phase = 'open' | 'closed'
type MarketMode = 'auto' | MarketId
/** a route the Taiwan feed can try, in the order `Config.twSources` lists them */
type TwSourceName = 'shioaji' | 'yahoo' | 'mis'
type View = 'table' | 'chart' | 'pnl'
/** how many symbols the table draws per row; "auto" picks off the page size, see effectiveColumns() */
type ColumnMode = 'auto' | 1 | 2

type Ticker = {
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
const TW_LIST: Ticker[] = [
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
const US_LIST: Ticker[] = [
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

const MARKETS: Record<MarketId, MarketConf> = {
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
  },
}

type LocalParts = { dow: number; minutes: number; clock: string }

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function localParts(now: number, offsetHours: number): LocalParts {
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
  const t = weekMinute(now, market)
  return sessionSpans(market).find(s => s.start <= t && t < s.end)?.session
}

function phaseOf(now: number, market: MarketId): Phase {
  return openSession(now, market) ? 'open' : 'closed'
}

/** the next session to open and how far away it is */
function nextSession(now: number, market: MarketId): { session: Session; minutes: number } {
  const t = weekMinute(now, market)
  let best: SessionSpan | undefined
  for (const s of sessionSpans(market)) if (s.start > t && (!best || s.start < best.start)) best = s
  return { session: best!.session, minutes: best!.start - t }
}

/** the session that closed most recently and how long ago */
function lastSession(now: number, market: MarketId): { session: Session; minutes: number } {
  const t = weekMinute(now, market)
  let best: SessionSpan | undefined
  for (const s of sessionSpans(market)) if (s.end <= t && (!best || s.end > best.end)) best = s
  return { session: best!.session, minutes: t - best!.end }
}

/** the session the board describes: the one trading, else the one that closed last */
function currentSession(now: number, market: MarketId): Session {
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
function lastCloseAt(now: number, market: MarketId): number {
  return now - minutesSinceClose(now, market) * 60_000
}

function hhmm(minutesFromMidnight: number): string {
  return `${pad2(Math.floor(minutesFromMidnight / 60))}:${pad2(minutesFromMidnight % 60)}`
}

function sessionNote(now: number, market: MarketId, phase: Phase): string {
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
function taipeiNote(now: number, market: MarketId, phase: Phase): string {
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
function pickMarket(now: number, mode: MarketMode, hasFutures: boolean): { market: MarketId; phase: Phase } {
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

// --- quotes ----------------------------------------------------------------
type Bar = [number, number, number, number] // open, high, low, close
type IndexRow = { name: string; value: number; change: number; pct: number }

type QuoteRow = {
  code: string
  name: string
  price: number
  change: number
  pct: number
  prevClose: number
  bars?: Bar[]
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
function demoPrice(sym: Ticker, now: number): number {
  const t = now / 1000
  const pct =
    sym.drift +
    sym.amp * Math.sin((2 * Math.PI * t) / sym.period + sym.phase) +
    0.35 * sym.amp * Math.sin((2 * Math.PI * t) / (sym.period / 4.7) + sym.phase * 2.3)
  return Math.round(sym.prevClose * (1 + pct / 100) * 100) / 100
}

// a bar's high/low needs intra-bar movement the sine walk does not have, so a
// deterministic wiggle stands in for it
function demoBars(sym: Ticker, now: number, count: number): Bar[] {
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

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function quoteRow(sym: Ticker, price: number, prevClose: number, bars?: Bar[], wasPrice?: number): QuoteRow {
  const change = round2(price - prevClose)
  // the old number measured against the same close, so only the price moved
  const wasChange = wasPrice === undefined ? 0 : round2(wasPrice - prevClose)
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
    // a row that did not move has nothing to turn, and turning it anyway is
    // noise: a real board only flaps what changed
    ...(wasPrice !== undefined && wasPrice !== price
      ? { was: { price: wasPrice, change: wasChange, pct: prevClose ? (wasChange / prevClose) * 100 : 0 } }
      : {}),
  }
}

// --- optional config / quotes files ----------------------------------------
type FileQuote = {
  price: number
  prevClose?: number
  name?: string
  bars?: Bar[]
  /** futures only (futures-quotes.json): points-to-money factor, display digits, and the month an alias resolved to */
  multiplier?: number
  decimals?: number
  resolved?: string
}

// A holding as the holdings file or `stock-band.json`'s `holdings` block
// states it - `price`/`prevClose` are optional because the live feed usually
// covers them; `pricedHolding` below fills in whatever this leaves out.
type Holding = {
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
type PricedHolding = {
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
type PnlSortKey = 'code' | 'today' | 'todayPnl' | 'totalPnl' | 'totalPnlPct'
const PNL_SORT_KEYS: PnlSortKey[] = ['code', 'today', 'todayPnl', 'totalPnl', 'totalPnlPct']
const PNL_SORT_LABELS: Record<PnlSortKey, string> = {
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
function sortHoldings(list: PricedHolding[], key: PnlSortKey, dir: 'asc' | 'desc'): PricedHolding[] {
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

type Config = {
  market: MarketMode
  refreshMs: number
  sort: 'change' | 'list'
  highlight: boolean
  /**
   * how many symbols the table draws per row. `auto` picks off the page size:
   * 5 or fewer draws the single-column table (代號/名稱/價格/變更$/變更%), 6 or
   * more draws two symbols a row (代號/名稱/價格/變更% only). The board itself
   * still falls back to 1 at render time if the terminal is too narrow for a
   * readable half.
   */
  columns: ColumnMode
  /**
   * which markets the live feed prices. `auto` follows the band, so only the
   * market on screen costs a request; `both` keeps the other side warm so a
   * market switch shows real prices at once. `off` leaves the band on demo
   * prices.
   */
  feed: 'auto' | 'us' | 'tw' | 'both' | 'off'
  /**
   * where Taiwan prices come from, in preference order - the band tries the
   * first entry, and falls through to the next for THIS tick when the first
   * has nothing fresh (shioaji: the quotes file is stale/absent while the
   * script logs in, or never spawned at all; yahoo/mis: the request failed).
   * `yahoo` is one batched request, ~20 minutes behind. `mis` is 證交所's own
   * real-time snapshot, a backup route for whoever wants exchange-true
   * intraday without a broker account. `shioaji` hands Taiwan to 永豐's
   * real-time feed instead: the band spawns `scripts/fetch-quotes-shioaji.py`
   * itself (see spawnShioaji below) and reads back the quotes file it
   * writes, rather than calling an HTTP endpoint the way the other two do.
   * The shipped default is `["yahoo"]` alone - `shioaji`/`mis` are opt-in,
   * and the recommended place to opt in is the user-level
   * `~/.claude/stock-band.json` (see CONFIG_PATH/USER_CONFIG below), not a
   * shared project file, since a source order is a personal preference.
   * A legacy `"twSource": "x"` (singular, a string) is still accepted as an
   * alias for `["x"]` and nothing else, so an old config keeps working.
   */
  twSources: TwSourceName[]
  /** seconds between feed requests, in ms; clamped to FEED_MS_MIN and up */
  feedMs: number
  /** how long one page of the watchlist holds before the board turns; 0 = manual only */
  pageMs: number
  /** the indices the footer flaps through on the Taiwan board (MIS route only) */
  twIndices: TwIndex[]
  /**
   * `full` flaps and blinks on a 50 ms frame clock; `off` leaves the board
   * still and repaints once a second for the countdown (and not at all if the
   * countdown is off too). See docs: the measured cost of each is in the README.
   */
  animation: 'full' | 'off'
  /** show how many seconds until the next feed request */
  countdown: boolean
  /** `tf` is the config's `futures` list: no built-in default and no MAX_SYMBOLS cap (parseFutures) */
  lists: Record<MarketId, Ticker[]>
  /** `futures` entries parseFutures dropped, so the poll can log them once */
  droppedFutures: string[]
  /** `twSources` includes `"shioaji"` only - how the band runs the fetcher script itself */
  shioaji: ShioajiConfig
  /**
   * manual holdings, keyed by market - the alternative to
   * `.claude/stock-holdings.json` (which wins for whichever market it names).
   * See parseHoldings and the README's 損益 section.
   */
  holdings: Record<MarketId, Holding[]>
  /**
   * `"config"` makes the `holdings` block above win over the holdings file
   * the broker script keeps writing - the way to show a demo portfolio on a
   * band whose Taiwan route is a live brokerage. Default `"file"`.
   */
  holdingsSource: 'file' | 'config'
}

type ShioajiConfig = {
  /** interpreter to run the script with, e.g. the project's own venv python */
  python: string
  /** env file holding SINOBON_API_KEY / SINOBON_SECRET_KEY; `~` expands to $HOME */
  env: string
  /** seconds between snapshots the script writes */
  interval: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

// a config entry only has to carry `code`; everything else falls back to the
// built-in symbol of the same code, then to a plain default
function parseList(value: unknown, builtin: Ticker[]): Ticker[] {
  if (!Array.isArray(value)) return builtin
  const out: Ticker[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    const base = builtin.find(s => s.code === code)
    const ex = entry.ex === 'otc' || entry.ex === 'tse' ? entry.ex : base?.ex
    out.push({
      code,
      ...(ex ? { ex } : {}),
      name: str(entry.name, base?.name ?? code),
      prevClose: num(entry.prevClose, base?.prevClose ?? 100),
      amp: num(entry.amp, base?.amp ?? 0.8),
      phase: num(entry.phase, base?.phase ?? 0),
      period: num(entry.period, base?.period ?? 57),
      drift: num(entry.drift, base?.drift ?? 0),
    })
    // a longer list cannot be priced in one batched request, so it is cut here
    // rather than silently half-fed further down
    if (out.length >= MAX_SYMBOLS) break
  }
  return out.length > 0 ? out : builtin
}

/**
 * The `futures` watchlist. Unlike parseList there is no built-in list to
 * fall back to and no MAX_SYMBOLS cap (a futures market costs no Yahoo
 * request); an entry without a string `code` is dropped and reported.
 */
function parseFutures(value: unknown): { list: Ticker[]; dropped: string[] } {
  const list: Ticker[] = []
  const dropped: string[] = []
  if (!Array.isArray(value)) return { list, dropped }
  for (const raw of value) {
    const entry = asRecord(raw)
    const code = entry ? str(entry.code, '') : ''
    if (!entry || !code) {
      dropped.push(JSON.stringify(raw))
      continue
    }
    // the demo-walk fields are never used for tf (see buildProps), so they are zero
    list.push({ code, name: str(entry.name, code), prevClose: 0, amp: 0, phase: 0, period: 1, drift: 0 })
  }
  return { list, dropped }
}

/** whether the config names any futures contract - the switch for the tf market */
function hasFutures(cfg: Config): boolean {
  return cfg.lists.tf.length > 0
}

function defaultConfig(): Config {
  return {
    market: 'auto',
    refreshMs: DEFAULT_REFRESH_MS,
    sort: 'change',
    highlight: true,
    columns: 'auto',
    feed: 'auto',
    twSources: ['yahoo'],
    feedMs: FEED_MS_DEFAULT,
    pageMs: PAGE_MS_DEFAULT,
    twIndices: TW_INDICES,
    animation: 'full',
    countdown: true,
    lists: { tw: TW_LIST, us: US_LIST, tf: [] },
    droppedFutures: [],
    shioaji: { python: 'python3', env: '~/.sinobon.env', interval: 10 },
    holdings: { tw: [], us: [], tf: [] },
    holdingsSource: 'file',
  }
}

/** resolves `"auto"` off the watchlist length; an explicit 1/2 always wins */
function effectiveColumns(cfg: Config, listLength: number): 1 | 2 {
  if (cfg.columns === 1 || cfg.columns === 2) return cfg.columns
  return listLength > PAGE_SIZE_1COL ? 2 : 1
}

function pageSize(columns: 1 | 2): number {
  return columns === 2 ? PAGE_SIZE_2COL : PAGE_SIZE_1COL
}

/**
 * The markets one feed tick prices, given where the band is pointed right
 * now. `tf` rides along whenever the config lists futures, whatever is on
 * screen: it costs no HTTP request, and the 永豐 fetcher must not die every
 * night just because 美股 (21:30-04:00) is the market on the band. Whether
 * its session is open is marketNeedsFeed's call.
 */
function feedMarkets(cfg: Config, market: MarketId): MarketId[] {
  if (cfg.feed === 'off') return []
  const markets: MarketId[] = cfg.feed === 'both' ? ['tw', 'us'] : cfg.feed === 'auto' ? [market] : [cfg.feed]
  if (hasFutures(cfg) && !markets.includes('tf')) markets.push('tf')
  return markets
}

/** what one market costs per tick, before the chart view's own bar fetch is added */
function marketRequests(cfg: Config, market: MarketId): number {
  if (market === 'tf') return 0 // 永豐 only, never an HTTP request from this module
  if (market === 'us') return Math.ceil((cfg.lists.us.length + US_INDICES.length) / SPARK_BATCH)
  // The preferred route's own cost - shioaji costs this module no HTTP
  // requests at all, so it is estimated as Yahoo's (the likely fallback,
  // and a safe overestimate for the budget floor below).
  // MIS answers the whole list plus both indices in one call, whatever the
  // list length - there is no sparkline column left to pay Yahoo for on top.
  if (cfg.twSources[0] === 'mis') return 1
  return Math.ceil((cfg.lists.tw.length + 1) / SPARK_BATCH)
}

/**
 * How many requests one feed tick costs, at its worst. `auto` prices one
 * market at a time, so it costs the dearer of the two rather than the sum;
 * `both` really does pay for both.
 */
function requestsPerTick(cfg: Config): number {
  if (cfg.feed === 'off') return 0
  const tw = marketRequests(cfg, 'tw')
  const us = marketRequests(cfg, 'us')
  return cfg.feed === 'both' ? tw + us : cfg.feed === 'tw' ? tw : cfg.feed === 'us' ? us : Math.max(tw, us)
}

/**
 * `feedMs` is an interval, and an interval alone does not bound the request
 * rate: 15 s with a 20-symbol Yahoo-fed list is 240 requests an hour against a
 * ceiling around 360, and `both` doubles that. The floor here turns the
 * budget into an interval, so no config can get the host banned.
 */
function feedInterval(cfg: Config): number {
  const budgetFloor = Math.ceil((requestsPerTick(cfg) * 3_600_000) / REQUESTS_PER_HOUR)
  return Math.max(cfg.feedMs, FEED_MS_MIN, budgetFloor)
}

/** reads text as a JSON object, or undefined for anything that is not one - malformed, missing, or a non-object */
function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

const TW_SOURCE_NAMES: TwSourceName[] = ['shioaji', 'yahoo', 'mis']

/**
 * `twSources` in preference order, or the legacy singular `twSource` as an
 * alias for a one-entry list, or `fallback` (defaultConfig's `["yahoo"]`,
 * carried in by an earlier, lower-precedence root) when the current root
 * states neither. An array present but empty, or holding nothing valid,
 * still counts as "stated" and clears the fallback rather than ignoring it -
 * same as every other field here, the most specific root wins outright.
 */
function parseTwSources(root: Record<string, unknown>, fallback: TwSourceName[]): TwSourceName[] {
  const isSourceName = (v: unknown): v is TwSourceName => TW_SOURCE_NAMES.includes(v as TwSourceName)
  if (Array.isArray(root.twSources)) return root.twSources.filter(isSourceName)
  if (isSourceName(root.twSource)) return [root.twSource]
  return fallback
}

/**
 * Turns one parsed config root (a user-level file, a project file, or the
 * merged root `poll()` builds from both - see USER_CONFIG_REL and
 * CONFIG_PATH) into a `Config`, filling in `defaultConfig()` for every key
 * the root does not set.
 */
function parseConfigRoot(root: Record<string, unknown> | undefined): Config {
  const cfg = defaultConfig()
  if (!root) return cfg
  const market = str(root.market, 'auto')
  if (market === 'tw' || market === 'us' || market === 'tf' || market === 'auto') cfg.market = market
  cfg.refreshMs = Math.max(1000, num(root.refreshMs, cfg.refreshMs))
  if (root.sort === 'list') cfg.sort = 'list'
  if (root.highlight === false) cfg.highlight = false
  if (root.columns === 1 || root.columns === 2 || root.columns === 'auto') cfg.columns = root.columns
  const feed = root.feed
  if (feed === 'off' || feed === false) cfg.feed = 'off'
  else if (feed === 'auto' || feed === 'us' || feed === 'tw' || feed === 'both') cfg.feed = feed
  cfg.twSources = parseTwSources(root, cfg.twSources)
  const shioaji = asRecord(root.shioaji)
  if (shioaji) {
    cfg.shioaji = {
      python: str(shioaji.python, cfg.shioaji.python),
      env: str(shioaji.env, cfg.shioaji.env),
      interval: Math.max(0, num(shioaji.interval, cfg.shioaji.interval)),
    }
  }
  cfg.feedMs = Math.max(FEED_MS_MIN, num(root.feedMs, cfg.feedMs))
  // 0 turns auto-paging off and leaves the `p` button as the only way to page
  const pageMs = num(root.pageMs, cfg.pageMs)
  cfg.pageMs = pageMs <= 0 ? 0 : Math.max(PAGE_MS_MIN, pageMs)
  if (root.animation === 'off' || root.animation === false) cfg.animation = 'off'
  if (root.countdown === false) cfg.countdown = false
  const futures = parseFutures(root.futures)
  cfg.lists = { tw: parseList(root.tw, TW_LIST), us: parseList(root.us, US_LIST), tf: futures.list }
  cfg.droppedFutures = futures.dropped
  cfg.twIndices = parseTwIndices(root.twIndices)
  const holdings = asRecord(root.holdings)
  cfg.holdings = {
    tw: parseHoldingsList(holdings?.tw),
    us: parseHoldingsList(holdings?.us),
    tf: [], // 期貨庫存 comes from the fetcher's own file (T6), not a config block
  }
  if (root.holdingsSource === 'config') cfg.holdingsSource = 'config'
  return cfg
}

/**
 * The manual alternative to `.claude/stock-holdings.json`: a `holdings` block
 * in `stock-band.json`, `{ tw: [...], us: [...] }`. `code` and `qty` are the
 * only fields that matter for the P&L math; `name` falls back to the code and
 * a bad or missing `qty`/`cost` reads as 0 rather than dropping the row, so a
 * typo shows up as an obviously wrong number instead of a silently missing
 * holding.
 */
function parseHoldingsList(value: unknown): Holding[] {
  if (!Array.isArray(value)) return []
  const out: Holding[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    out.push({
      code,
      name: str(entry.name, code),
      qty: num(entry.qty, 0),
      cost: num(entry.cost, 0),
      price: typeof entry.price === 'number' ? entry.price : undefined,
      prevClose: typeof entry.prevClose === 'number' ? entry.prevClose : undefined,
      // `direction` is not kept: the fetcher already signs qty with it
      multiplier: typeof entry.multiplier === 'number' && entry.multiplier > 0 ? entry.multiplier : undefined,
    })
  }
  return out
}

/**
 * The footer's Taiwan index rows. A channel the exchange does not know simply
 * answers nothing and `publish` leaves that row out, so a typo costs one
 * missing row rather than the whole footer. `name` has to be Latin: the board
 * flaps a row one character at a time and a Chinese character has no drum to
 * riffle through, so a Chinese name would sit there unable to turn.
 */
function parseTwIndices(value: unknown): TwIndex[] {
  if (!Array.isArray(value)) return TW_INDICES
  const out: TwIndex[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    if (!entry) continue
    const code = str(entry.code, '')
    if (!code) continue
    const known = TW_INDICES.find(i => i.code === code)
    out.push({
      code,
      name: str(entry.name, known?.name ?? code.toUpperCase()),
      ex: entry.ex === 'otc' ? 'otc' : 'tse',
    })
  }
  return out.length > 0 ? out : TW_INDICES
}

type QuotesFile = {
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

// a bar is [open, high, low, close] or { o, h, l, c } - accept both, since
// which one a feed hands over is not worth a conversion step in the fetcher
function parseBars(value: unknown): Bar[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Bar[] = []
  for (const raw of value) {
    if (Array.isArray(raw)) {
      const four = raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (four.length >= 4) out.push([four[0], four[1], four[2], four[3]])
      continue
    }
    const obj = asRecord(raw)
    if (!obj) continue
    const o = num(obj.o ?? obj.open, NaN)
    const h = num(obj.h ?? obj.high, NaN)
    const l = num(obj.l ?? obj.low, NaN)
    const c = num(obj.c ?? obj.close, NaN)
    if ([o, h, l, c].every(Number.isFinite)) out.push([o, h, l, c])
  }
  return out.length > 0 ? out : undefined
}

// Parses a `stock-quotes.json` file's text, whichever of the two locations
// it came from (runtime-dir or the project's `.claude/`, see runtimeDir and
// the header comment), or the fetcher's `futures-quotes.json` (same shape,
// `market: "tf"`, plus multiplier/decimals/resolved per quote); see
// stock-band.example.json for the shape. Anything stale or malformed is
// ignored and the band falls back to demo prices (no-data rows for tf).
function parseQuotes(text: string | undefined, now: number): QuotesFile | undefined {
  if (!text) return undefined
  let root: Record<string, unknown> | undefined
  try {
    root = asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
  if (!root) return undefined
  const asOf = num(root.asOf, 0)
  if (!asOf || now - asOf > QUOTE_STALE_MS) return undefined
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
      multiplier: typeof entry.multiplier === 'number' && entry.multiplier > 0 ? entry.multiplier : undefined,
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : undefined,
      resolved: typeof entry.resolved === 'string' && entry.resolved ? entry.resolved : undefined,
    }
  }
  const market = root.market === 'tw' || root.market === 'us' || root.market === 'tf' ? root.market : undefined
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
type HoldingsFile = {
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
function parseHoldingsFile(text: string | undefined): HoldingsFile | undefined {
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
  const market = root.market === 'tw' || root.market === 'us' || root.market === 'tf' ? root.market : undefined
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
function holdingsFor(
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
/**
 * Holdings the feed also has to fetch a price for, because they are not on
 * the watchlist. The feed's symbol set for a market is the watchlist UNION
 * these - see feedUs/feedTw - so every holding has a live price in the
 * quotes file, and buildProps still draws only the watchlist in the table
 * (item 6/7 of the spec): a holding-only code is priced but never shown
 * there. `ex` is left out (Taiwan holdings default to 上市 the same way
 * parseList's own default does); a 上櫃-only holding needs its own
 * watchlist entry with `"ex": "otc"` to price through MIS correctly.
 */
function holdingExtras(market: MarketId, list: Ticker[], cfg: Config): Ticker[] {
  const { holdings } = holdingsFor(market, holdingsFiles[market], cfg)
  const have = new Set(list.map(t => t.code))
  return holdings
    .filter(h => !have.has(h.code))
    .map(h => ({ code: h.code, name: h.name, prevClose: h.prevClose ?? h.cost ?? 100, amp: 0.8, phase: 0, period: 57, drift: 0 }))
}

function pricedHoldings(
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
const FEED_HEADERS = { 'User-Agent': FEED_UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' }

function sparkUrl(symbols: string[], now: number): string {
  const list = symbols.map(encodeURIComponent).join(',')
  return `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${list}&range=1d&interval=5m&_=${now}`
}

function chartUrl(symbol: string, now: number): string {
  const s = encodeURIComponent(symbol)
  return `https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1d&interval=5m&includePrePost=false&_=${now}`
}

/**
 * the Yahoo symbol for a watchlist entry. US codes already are symbols;
 * Taiwan needs the exchange suffix, and a code that carries its own dot
 * (someone wrote `2330.TW` in the config) is left alone.
 */
function yahooSymbol(market: MarketId, t: { code: string; ex?: TwExchange }): string {
  if (market === 'us') return t.code
  return t.code.includes('.') ? t.code : `${t.code}.${t.ex === 'otc' ? 'TWO' : 'TW'}`
}

/** MIS names a symbol by exchange: `tse_2330.tw`, `otc_6488.tw`, `tse_t00.tw` */
function misChannel(t: { code: string; ex?: TwExchange }): string {
  return `${t.ex === 'otc' ? 'otc' : 'tse'}_${t.code}.tw`
}

function misUrl(channels: string[], now: number): string {
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
function parseMis(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
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
function parseSpark(text: string): { quotes: Record<string, FileQuote>; tradedAt: number } {
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

/** one symbol's 5-minute K bars; a bar with a null leg is dropped, not patched */
function parseChartBars(text: string): Bar[] | undefined {
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
  const bars: Bar[] = []
  for (let i = 0; i < c.length; i++) {
    const leg = [o[i], hi[i], lo[i], c[i]]
    if (leg.every(v => typeof v === 'number' && Number.isFinite(v))) {
      bars.push([leg[0] as number, leg[1] as number, leg[2] as number, leg[3] as number])
    }
  }
  return bars.length > 0 ? bars.slice(-CHART_BARS) : undefined
}

// --- board props -----------------------------------------------------------
type BoardProps = {
  market: MarketId
  marketLabel: string
  phase: Phase
  sessionNote: string
  /** the same hours in Taipei time, '' when the market already trades on it */
  taipeiNote: string
  clock: string
  quotes: QuoteRow[]
  index: { name: string; value: number; change: number; pct: number }
  /** what the footer flips through; one entry means it just sits there */
  indices: IndexRow[]
  source: 'demo' | 'file' | 'live'
  /** what the footer calls the source; '' lets the board name it from `source` */
  sourceLabel: string
  /** the plugin's own version, read from its manifest; '' when it could not be */
  version: string
  highlight: boolean
  sorted: boolean
  /** 1 = single-column table, 2 = two symbols a row; see effectiveColumns() */
  columns: 1 | 2
  view: View
  focus: number
  barLabel: string
  sessionOpen: string
  sessionClose: string
  /** snapshot counter; the board's live dot flips on it (0 while faking prices) */
  seq: number
  /**
   * bumped whenever the rows should turn - a new snapshot OR a page change.
   * Kept apart from `seq` because the live dot must mean "the feed answered",
   * and a page turn is not the feed answering.
   */
  turn: number
  /** which page of the watchlist is on the board, and how many there are */
  page: number
  pageCount: number
  /** when the next feed request is due, in epoch ms; 0 while nothing is fetching */
  nextFeedAt: number
  /** 'full' = flaps and blinks, 'off' = a still board */
  animation: 'full' | 'off'
  countdown: boolean
  now: number
  /** `view: "pnl"` only; already priced AND sorted (pricedHoldings/sortHoldings) - board.tsx only formats */
  holdings: PricedHolding[]
  holdingsSource: string
  holdingsAt: number
  pnlSortKey: PnlSortKey
  pnlSortDir: 'asc' | 'desc'
  /** the first data row on screen, 0-based - a wheel tick moves it by `e.by`, 翻頁 by whole pages */
  holdingsScroll: number
}

/**
 * A futures row's name: the config's own `name` when it gave one (parseFutures
 * leaves `name === code` when it did not, the idiom pricedHoldings reads too),
 * else the contract name from the file, else the code - then ` (TXFJ6)` for
 * an alias, so the table says which month `TXFR1` means today. The stock
 * markets keep their file-name-first rule; this one is tf only.
 */
function futuresName(sym: Ticker, quote: FileQuote): string {
  const base = sym.name !== sym.code ? sym.name : (quote.name ?? sym.code)
  return quote.resolved && quote.resolved !== sym.code ? `${base} (${quote.resolved})` : base
}

/** how long after a page change the outgoing rows are still worth turning from */
const PAGE_TURN_WINDOW_MS = 2500
/** holdings per page in the pnl view - rows 2..6 of its 8-row board */
const PNL_PAGE_SIZE = 5

function buildProps(
  now: number,
  cfg: Config,
  quotesFile: QuotesFile | undefined,
  mode: MarketMode,
  view: View,
  /** which code the chart view is following; undefined or off-screen falls back to position 0 */
  focusCode: string | undefined,
): BoardProps {
  const { market, phase } = pickMarket(now, mode, hasFutures(cfg))
  const conf = MARKETS[market]
  const session = currentSession(now, market)
  const list = cfg.lists[market]
  let usedFile = false

  const quotes = list.map(sym => {
    const fromFile = quotesFile?.quotes[sym.code]
    if (fromFile) {
      usedFile = true
      const prevClose = fromFile.prevClose ?? sym.prevClose
      const name = market === 'tf' ? futuresName(sym, fromFile) : (fromFile.name ?? sym.name)
      return {
        ...quoteRow({ ...sym, name }, fromFile.price, prevClose, fromFile.bars, quotesFile?.prev?.[sym.code]?.price),
        // omitted, not undefined: see quoteRow on what a Client's props may hold
        ...(fromFile.decimals !== undefined ? { decimals: fromFile.decimals } : {}),
      }
    }
    if (quotesFile) {
      // The market HAS a live/override snapshot - it just never priced this
      // particular code (a fetcher whose own list is narrower than the
      // band's, or a gap the Yahoo bridge merge in quotesFor did not cover
      // either). A demo-walk number here would look like a real price under
      // a 永豐 即時/證交所 即時 footer, so this draws as a dim placeholder
      // instead (board.tsx reads QuoteRow.noData).
      return { ...quoteRow(sym, sym.prevClose, sym.prevClose), noData: true }
    }
    // a leveraged contract is never shown with an invented price: no quotes
    // source for tf means the no-data marker, not the demo walk
    if (market === 'tf') return { ...quoteRow(sym, 0, 0), noData: true }
    return quoteRow(sym, demoPrice(sym, now), sym.prevClose)
  })

  if (cfg.sort === 'change') quotes.sort((a, b) => b.pct - a.pct)

  // The single-column table shows 5 symbols a page, the two-column one 10 -
  // effectiveColumns() picks which off the watchlist length (or the config's
  // explicit override). Either way the table Client is always the same 8
  // terminal rows: one page is on the board and the rest wait their turn, the
  // way a departures board shows the next five flights rather than growing.
  const columns = effectiveColumns(cfg, list.length)
  const perPage = pageSize(columns)
  const pages = Math.max(1, Math.ceil(quotes.length / perPage))
  lastPageCount = pages

  // The chart view follows a CODE, not a page: `page` only moves through
  // setPage (a table page turn) or autoPage, and autoPage freezes itself the
  // moment view !== 'table' (see autoPage). With `cfg.sort === 'change'`
  // `quotes` re-sorts every render, so the focused code's rank - and so its
  // page - can drift out from under a `page` that nothing is moving. This
  // jumps `page` straight to wherever the code actually sits, before `shown`
  // is sliced, so the chart never reads a foreign row off a stale page. It
  // writes `page` directly rather than going through setPage: setPage's
  // pageFrom/pageFromAt bookkeeping only feeds the table's page-turn flap,
  // which the chart view does not draw, and this jump carries no such
  // animation of its own.
  if (view === 'chart' && focusCode !== undefined) {
    const fullIdx = quotes.findIndex(q => q.code === focusCode)
    if (fullIdx >= 0) {
      const focusPage = Math.floor(fullIdx / perPage)
      if (focusPage !== ((page % pages) + pages) % pages) page = focusPage
    }
  }

  const pageIdx = ((page % pages) + pages) % pages
  const shown = quotes.slice(pageIdx * perPage, pageIdx * perPage + perPage)

  // A page turn changes every row at once, so every row turns - including the
  // ones whose price did not move, and including the symbol and the name.
  // Price updates keep their own `was` (set in quoteRow), which carries no
  // code/name and so leaves the left-hand columns still.
  if (pageFrom && pageFromMarket === market && now - pageFromAt < PAGE_TURN_WINDOW_MS) {
    for (let i = 0; i < shown.length; i++) {
      const before = pageFrom[i]
      if (!before) continue
      shown[i] = {
        ...shown[i],
        was: {
          price: before.price,
          change: before.change,
          pct: before.pct,
          code: before.code,
          name: before.name,
        },
      }
    }
  } else {
    // No page turn is running, but a row's OCCUPANT can still change: with
    // `cfg.sort === 'change'` the list re-sorts every render, so a rank
    // cross moves a code to a different on-screen position without page or
    // sort key ever changing. Comparing this render's row at position i
    // against what `lastShown` actually drew there last render catches
    // that - the whole-page flap above cannot, because it only runs inside
    // a page turn's own window. Merging into whatever price-only `was`
    // quoteRow() already attached (rather than requiring the row have none)
    // makes a rank cross that also lands on a row whose own price moved
    // turn both halves, not just the price side.
    let ranksCrossed = false
    // `lastShown` only means something as a rank-cross baseline when it was
    // drawn for THIS market - onSelectStop can switch markets without a page turn
    // or a pnl turn (see `lastShownMarket` above), and a stale other-market
    // `lastShown` would compare AAPL's row against 2330's row on nothing more
    // than shared position. Gated on `quotesFile` too: with no quotes file
    // the whole page is priced by demoPrice()'s continuous sine walk, whose
    // pct keeps drifting by a hair every render - with `cfg.sort ===
    // 'change'` that alone reshuffles two close-ranked rows on almost every
    // poll, so the demo/off/backoff board would flap nearly every tick for
    // noise instead of a real rank change. A quotes-file-backed row only
    // moves rank when its actual price moved, so real data keeps this check.
    if (quotesFile && lastShownMarket === market) {
      for (let i = 0; i < shown.length; i++) {
        const before = lastShown[i]
        if (!before || before.code === shown[i].code) continue
        shown[i] = {
          ...shown[i],
          was: {
            price: before.price,
            change: before.change,
            pct: before.pct,
            code: before.code,
            name: before.name,
          },
        }
        ranksCrossed = true
      }
    }
    // Bumps once per render that actually crossed a rank, not once per row,
    // matching setPage's own single bump per page turn.
    if (ranksCrossed) turnSeq += 1
  }
  // what setPage turns away from next time; read only at the moment of a page
  // change, so rewriting it on every render costs nothing
  lastShown = shown
  lastShownMarket = market

  // Only the one symbol the chart view is showing gets bars at all: a whole
  // page of chart-length bars would be hundreds of numbers crossing into the
  // board every refresh for nothing. demoBars fills that in only for the demo
  // walk (no quotes file, no live snapshot). A stock quotes file (永豐,
  // 證交所) never carries its own candles, but quotesFor layers in whatever
  // Yahoo has fetched for the focused symbol (see withLiveBars) the same way
  // the built-in feed already does - until that fetch lands, the chart shows
  // no bars yet rather than a demo-walk stand-in for a real price. The
  // futures file is the exception: its rows arrive with 永豐's own 5 分 K.
  //
  // `focusIdx` is looked up by CODE, not carried as a position: `shown` is
  // freshly re-sorted every render when `cfg.sort === 'change'`, so the code
  // a position held last render is not the code it holds this render. A
  // stale position would follow whatever rank crossed into that slot
  // instead of the symbol the chart is actually supposed to be following.
  // The page-follow jump above already moved `page` onto focusCode's own
  // page whenever the code is still in the list, so `findIndex` returning -1
  // here means focusCode is unset or the code was removed from the list
  // entirely - either way this falls back to position 0 via `Math.max`.
  const focusIdx = Math.max(0, shown.findIndex(q => q.code === focusCode))
  if (view === 'chart' && shown.length > 0) {
    const q = shown[focusIdx]
    if (!usedFile && market !== 'tf' && (q.bars?.length ?? 0) < CHART_BARS) {
      const sym = list.find(t => t.code === q.code)
      if (sym) q.bars = demoBars(sym, now, CHART_BARS)
    }
  }

  const idxPct = quotesFile?.index
    ? quotesFile.index.pct
    : conf.indexDrift + conf.indexAmp * Math.sin((2 * Math.PI * (now / 1000)) / 89)
  const idxValue = quotesFile?.index ? quotesFile.index.value : conf.indexClose * (1 + idxPct / 100)
  const idxChange = quotesFile?.index ? quotesFile.index.change : idxValue - conf.indexClose

  // The pnl view's own list and scroll position - see the `pnlScroll` module
  // state comment for why it is not the watchlist's `page`.
  const { holdings: rawHoldings, source: holdingsSource, asOf: rawHoldingsAt } = holdingsFor(
    market,
    holdingsFiles[market],
    cfg,
  )
  const priced = sortHoldings(pricedHoldings(rawHoldings, quotesFile, cfg, market), pnlSortKey, pnlSortDir)
  // Manual/config holdings (and a holdings file that never states its own
  // `asOf`) read 0 here - rather than print `更新 --:--`, the title falls
  // back to the SAME time the watchlist footer already shows for this
  // market (quotesFile's dataAt), and only to `now` when neither exists.
  const holdingsAt = rawHoldingsAt || quotesFile?.dataAt || now
  const maxScroll = Math.max(0, priced.length - PNL_PAGE_SIZE)
  const holdingsScroll = Math.max(0, Math.min(maxScroll, pnlScroll))

  // A mount, a page move or a sort change flaps every visible row, the same
  // way a watchlist page turn does (PAGE_TURN_WINDOW_MS/pageFrom below) -
  // `pnlPageFrom` is that turn's "from" snapshot, keyed by ON-SCREEN
  // POSITION (0..4), which is what makes a row that changed WHICH holding
  // occupies it (a page/sort move) turn its symbol and name too, not just
  // its numbers - see PricedHolding.was and board.tsx's per-row flap.
  let pricedForDisplay = priced
  if (pnlPageFrom && now - pnlPageAt < PAGE_TURN_WINDOW_MS) {
    pricedForDisplay = priced.map((h, idx) => {
      const pos = idx - holdingsScroll
      const before = pos >= 0 && pos < PNL_PAGE_SIZE ? pnlPageFrom![pos] : undefined
      if (!before) return h
      return { ...h, was: { price: before.price, code: before.code, name: before.name } }
    })
  }
  lastPnlShown = pricedForDisplay.slice(holdingsScroll, holdingsScroll + PNL_PAGE_SIZE)

  return {
    market,
    marketLabel: conf.label,
    phase,
    sessionNote: sessionNote(now, market, phase),
    taipeiNote: taipeiNote(now, market, phase),
    // open: the market-local time the prices on screen traded at - NOT the
    // redraw clock. The band redraws every few seconds but only fetches every
    // 30, so printing `now` here claimed a freshness the prices did not have.
    // closed: the session's close time, so "收盤 13:30" cannot read as "last
    // updated".
    clock:
      phase === 'open' ? localParts(quotesFile?.dataAt ?? now, conf.offset(now)).clock : hhmm(session.close),
    // the live dot advances once per snapshot, so a frozen feed shows a frozen
    // dot instead of an animation that says "live" whatever happens
    seq: quotesFile?.seq ?? 0,
    turn: turnSeq,
    page: pageIdx,
    pageCount: pages,
    // the board counts this down on its own clock; 0 means nothing is fetching
    // and the board then shows no countdown rather than a stuck number
    nextFeedAt:
      cfg.feed === 'off' || !quotesFile || quotesFile.origin !== 'live' || !marketNeedsFeed(now, market)
        ? 0
        : nextFeedAt,
    animation: cfg.animation,
    countdown: cfg.countdown,
    quotes: shown,
    index: { name: conf.indexName, value: idxValue, change: idxChange, pct: idxPct },
    // Taiwan has one index and no feed, so it falls through to the single row
    // and the board's flip finds nothing to flip
    indices:
      quotesFile?.indices && quotesFile.indices.length > 0
        ? quotesFile.indices
        : [{ name: conf.indexName, value: idxValue, change: idxChange, pct: idxPct }],
    // tf without a fresh file draws dashes, not fake prices - so the footer
    // must not say 示範 (nor blink a live dot) over them
    source: usedFile ? (quotesFile?.origin ?? 'file') : market === 'tf' ? 'file' : 'demo',
    sourceLabel: usedFile ? (quotesFile?.sourceLabel ?? '') : market === 'tf' ? '無報價' : '',
    version,
    highlight: cfg.highlight,
    sorted: cfg.sort === 'change',
    columns,
    view,
    focus: focusIdx,
    barLabel: quotesFile?.barLabel ?? (usedFile ? 'K 棒' : 'K 棒（示範）'),
    sessionOpen: hhmm(session.open),
    sessionClose: hhmm(session.close),
    now,
    // The full priced list, not just the page on screen: board.tsx slices it
    // itself for the 5 rows it draws (holdingsScroll says where), but it
    // also sums the footer's totals over the whole portfolio, which a
    // pre-sliced list could not answer.
    holdings: pricedForDisplay,
    holdingsSource,
    holdingsAt,
    pnlSortKey,
    pnlSortDir,
    holdingsScroll,
  }
}

// --- module state (memory only: a fresh session starts unsnoozed) ----------
// The poll owns the slow, IO-backed half of the state (config + the quotes
// file); ui.render builds the props from it on every draw, so a button press
// changes the view on the same frame instead of waiting out a refresh tick.
let ready = false
// The quotes file each market is drawn from: tw/us share the stock file
// (runtime-dir while fresh, else the project override - a file naming no
// market fills both), tf only ever the fetcher's futures-quotes.json. Keyed
// by market for the same reason liveBy is: 永豐 futures under 加權指數, or a
// stock override pricing a contract, would be worse than no price at all.
let quotesFiles: Partial<Record<MarketId, QuotesFile>> = {}
// Holdings files per market, the same split as quotesFiles: tw/us share the
// stock file (runtime-dir, else the project override), tf only ever the
// fetcher's futures-holdings.json. Neither expires - see parseHoldingsFile.
let holdingsFiles: Partial<Record<MarketId, HoldingsFile>> = {}
// true once the 0.9-legacy-holdings-file warning has been logged this
// session, so a file left behind at the project path is reported once
// instead of on every poll tick (see the poll loop's use of it below)
let loggedLegacyProjectHoldings = false
// same idea for invalid `futures` entries: the poll re-parses the config
// every tick, and one typo is worth one line, not one per tick
let loggedDroppedFutures = false
// whether the runtime-dir quotes file specifically (not the project
// override) is fresh - feedTwShioaji's own health signal, set every poll
let runtimeQuotesFresh = false
// same for the runtime-dir futures file - the tf route's only health signal
let futuresQuotesFresh = false
// when spawnShioaji last ran, so it is never re-run more than once a minute
// (see spawnShioaji's own comment for the full respawn rule)
let lastShioajiSpawn = 0
// true once this session has logged the "shioaji isn't pricing anything"
// warning - logged at most once per session, see feedTwShioaji
let shioajiWarned = false
// when this session FIRST saw a pidfile it did not itself spawn (a prior
// session's leftover, or a fetcher already running before this session
// polled) - gives that discovery its own 60s grace clock instead of
// treating it as having been alive since forever, see feedTwShioaji
let shioajiPidSeenAt = 0
// the feed's last good snapshot per market, with the one before it for the
// turn. Keyed by market because a snapshot must never reach the other board:
// US prices under 加權指數 would be worse than no prices at all.
let liveBy: Partial<Record<MarketId, { file: QuotesFile; prev?: Record<string, FileQuote> }>> = {}
// keyed `<market>:<code>`, since a Taiwan code and a US ticker share a namespace
let liveBars: Record<string, { bars: Bar[]; at: number }> = {}
let feedSkipUntil = 0 // set by a 429 or a network error, doubling each time
let feedFailures = 0
let feedSeq = 0 // one per snapshot the feed accepted; drives the board's live dot
let nextFeedAt = 0 // when the next request is due; the board counts down to it
let barsInFlight = false
// the render hook asks for the chart view's K bars; the feed owns the request
let requestBars: ((market: MarketId, code: string) => void) | undefined
// ...and asks for a whole tick when a tab lands on a market the
// feed has no snapshot for, so a switch does not sit on 示範資料 until the
// next scheduled tick comes round
let requestFeed: (() => void) | undefined
let feedInFlight = false
let config: Config = defaultConfig()
let modeOverride: MarketMode | undefined
let snoozedUntil = 0
// the chart view walks the list one symbol at a time and then returns to the
// table, so one button covers both "show me the chart" and "next symbol"
let view: View = 'table'
// which code the chart view is following, not which position: `shown` gets
// re-sorted every render under `cfg.sort === 'change'`, so a position would
// silently start following whatever rank crossed into it. undefined (never
// focused yet) and a code that fell off the current page both resolve to
// position 0 in buildProps (see `focusIdx`), and ui.render syncs this back
// to whatever code buildProps actually landed on after every render.
let focusCode: string | undefined
// how many quotes the last drawn board held, so a posted row index can be
// checked against something real: a Client's post is code's word, not the
// engine's, and a pick is resolved against `lastShown`, not trusted as-is.
let shownCount = 0
// The band draws from a COPY of this plugin under
// ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, frozen at install
// time - editing the working tree changes nothing until `claude plugin update`
// and a restart. So "which build am I looking at" is a real question, and the
// footer answers it: this is read from the manifest that shipped beside the
// code actually running, not from a constant that can drift from it.
let version = ''

// --- paging ----------------------------------------------------------------
// A watchlist longer than five symbols is shown one page at a time. The page
// index lives here rather than in the board because the button above the band
// has to show which page you are on, and only this module draws buttons.
let page = 0
let pageAt = 0 // when the current page arrived, so the turn has a start time
let lastShown: QuoteRow[] = [] // the page on the board right now
// which market `lastShown` was drawn for. onSelectStop can land buildProps on a
// different market without ever calling setPage or turnPnl (a table-to-table
// or pnl-to-table tab press) - the rank-cross check below must not
// compare this render's row against a DIFFERENT market's row just because
// they share a position, or "台積電 replaced AAPL" reads as a same-market
// rank cross and flaps a price/pct/code/name that never actually turned.
let lastShownMarket: MarketId | undefined
let pageFrom: QuoteRow[] | undefined // the page it turned away from
// which market `pageFrom` was captured from - a market switch that lands
// back on a table can still fall inside `PAGE_TURN_WINDOW_MS` with a
// `pageFrom` snapshot from a market visited turns ago. Same guard as
// `lastShownMarket`, for the same reason.
let pageFromMarket: MarketId | undefined
// when `pageFrom` was captured - kept apart from `pageAt` because autoPage
// keeps `pageAt` perpetually recent (refreshed every poll, see autoPage)
// whenever the view sits outside the table, so a chart-view stay of more
// than one poll would otherwise leave `pageAt` reading "just now" while
// `pageFrom` still holds whatever page a real turn last captured - possibly
// several page turns and a rank-cross drift ago. `pageFromAt` only moves
// inside `setPage`, alongside `pageFrom` itself, so the flap window below
// always measures time since the snapshot it is actually flapping away
// from, never since autoPage's unrelated "restart the deadline" touches.
let pageFromAt = 0
// bumped by a new snapshot AND by a page change: it is what tells the board to
// start a turn, which `seq` cannot do without making the live dot lie
let turnSeq = 0
// how many pages the board last drew. The page clock and the page button both
// need it and neither can work out the market's list on its own, so buildProps
// - which runs on every render - leaves it here.
let lastPageCount = 1

// The pnl view's own scroll position, kept apart from the watchlist's `page`
// above: the two views can never be on screen together, but a shared
// counter would leave the pnl view scrolled to wherever the watchlist
// happened to be paged. It is a ROW OFFSET (0-based, first row on screen),
// not a page index, purely so 翻頁 (the only thing that ever moves it - see
// below) has one number to add PNL_PAGE_SIZE to and wrap.
//
// Not wired to ui.scroll: tried it (0.9.0) and reverted it (0.9.1). The
// engine only raises ui.scroll for a band whose drawn tree is taller than
// `maxRows` - "The band's window over a tree taller than maxRows" (d.ts) -
// and this Client is a fixed 8 rows every view, table or pnl, so it never
// qualifies; confirmed on the real build with --debug, zero ui.scroll
// events reached this module however the wheel was driven. If a taller-
// than-maxRows tree ever exists here, that is the condition to satisfy
// before re-adding a scroll hook - not a sign this one was wired wrong.
let pnlScroll = 0
// what a page/sort turn last turned FROM (keyed by on-screen position, see
// buildProps), and when - the pnl view's own pageFrom/pageAt, same idea as
// the watchlist's below, sharing its PAGE_TURN_WINDOW_MS
let pnlPageFrom: PricedHolding[] | undefined
let pnlPageAt = 0
let lastPnlShown: PricedHolding[] = []
// the pnl view's sort - lives here like `view`/`focusCode`, default 總損益
// descending. Persists across a page/scroll move and a tab press
// (unlike pnlScroll, changing the SORT is not "changing the stop").
let pnlSortKey: PnlSortKey = 'totalPnl'
let pnlSortDir: 'asc' | 'desc' = 'desc'

function resetPnlScroll() {
  pnlScroll = 0
}

function pageCount(): number {
  return lastPageCount
}

/**
 * Turn the page when the one on the board has had its `pageMs`, and not a tick
 * sooner. It rides the config poll rather than owning a timer of its own,
 * because a timer of its own cannot be reset: pressing 翻頁 at 9.9 s of a 10 s
 * interval used to leave the page you asked for on screen for 100 ms before
 * the interval fired and took it away. `pageAt` already records when the page
 * arrived and `setPage` already updates it, so a manual press pushes the
 * deadline out for free. The cost is granularity - the turn lands on the next
 * poll after the deadline, so up to `refreshMs` late, which at a 10 s page and
 * a 3 s poll is invisible next to the 100 ms flash it replaces.
 */
function autoPage(now: number) {
  if (config.pageMs <= 0) return
  // Nothing to page through, and the chart view owns the list already. Restart
  // the deadline rather than just returning, so the page gets its full hold
  // from the moment it is back on screen instead of turning the instant you
  // come back from the chart or from 收起.
  if (now < snoozedUntil || view !== 'table' || pageCount() < 2) {
    pageAt = now
    return
  }
  // first poll of the session: start the clock, do not turn off a zero
  if (pageAt === 0) {
    pageAt = now
    return
  }
  if (now - pageAt < config.pageMs) return
  setPage((page + 1) % pageCount(), now)
}

function setPage(next: number, now: number) {
  if (next === page) return
  pageFrom = lastShown
  pageFromMarket = lastShownMarket
  pageFromAt = now
  pageAt = now
  page = next
  turnSeq += 1
}

/**
 * Whether a snapshot still describes the market. While it trades, two minutes
 * without a new price means the feed died and the band has to say so rather
 * than keep drawing a price nobody is quoting. Once the market closes the
 * price cannot change, so a snapshot taken after the close stays true until
 * the next session - expiring it on the same two-minute rule would throw away
 * a real closing price and draw the demo walk over it.
 */
function snapshotHolds(asOf: number, now: number, market: MarketId): boolean {
  if (phaseOf(now, market) === 'open') return now - asOf <= QUOTE_STALE_MS
  return asOf >= lastCloseAt(now, market)
}

/**
 * Whether this market is worth a request right now. A closed market answers
 * the same closing price every time, so the run costs nothing but the ban
 * risk: one fetch after the close captures it and the rest are waste. At 30 s
 * a tick and two requests a tick, a watchlist left open overnight used to
 * spend about 1,900 requests re-reading a number that had stopped moving.
 */
function marketNeedsFeed(now: number, market: MarketId): boolean {
  if (phaseOf(now, market) === 'open') return true
  // tf only ever arrives through the file (never publish, so liveBy.tf is
  // never set): the closing-snapshot rule below would read as "always",
  // and the heartbeat would keep the fetcher alive all weekend
  if (market === 'tf') return false
  const snap = liveBy[market]
  // never fetched, or the snapshot predates the close and so is not the
  // closing price yet
  return !snap || snap.file.asOf < lastCloseAt(now, market)
}

/** the badge a Yahoo-sourced bar set gets when the quotes file itself names none */
const YAHOO_BAR_LABEL = '5 分 K（Yahoo）'

// Neither a 永豐 stock report nor a 證交所/MIS snapshot carries candles, so a
// stock quotes file's entries never have `bars` - feedBars (fetched per
// focused symbol, always from Yahoo) is the only source for a stock market's
// K-bar view. This layers that cache under a market's quotes: an entry that
// already has bars (the built-in feed's own snapshot, or every entry of the
// futures file, whose 5 分 K come from 永豐) keeps them, and only a gap gets
// the Yahoo set, and only while it is still within BARS_STALE_MS.
function withLiveBars(
  market: MarketId,
  quotes: Record<string, FileQuote>,
  now: number,
): { quotes: Record<string, FileQuote>; barsFromYahoo: boolean } {
  let barsFromYahoo = false
  const out: Record<string, FileQuote> = {}
  for (const [code, quote] of Object.entries(quotes)) {
    if (quote.bars) {
      out[code] = quote
      continue
    }
    const bars = liveBars[`${market}:${code}`]
    if (bars && now - bars.at <= BARS_STALE_MS) {
      out[code] = { ...quote, bars: bars.bars }
      barsFromYahoo = true
    } else {
      out[code] = quote
    }
  }
  return { quotes: out, barsFromYahoo }
}

/**
 * Which of `allowed` a parsed file drives: the market it names (a stock file
 * saying `tf`, or a futures file saying `tw`, drives nothing), or every one
 * of them when it names none - the pre-tf override semantics for tw/us.
 */
function fillQuoteSlots(file: QuotesFile | undefined, allowed: MarketId[]): void {
  if (!file) return
  for (const market of allowed) if (!file.market || file.market === market) quotesFiles[market] = file
}

/** the holdings twin of fillQuoteSlots: a file naming no market fills every allowed slot */
function fillHoldingsSlots(file: HoldingsFile | undefined, allowed: MarketId[]): void {
  if (!file) return
  for (const market of allowed) if (!file.market || file.market === market) holdingsFiles[market] = file
}

// The quotes file wins over the feed: it is the explicit override. A market
// with no snapshot falls back to the demo walk, which is what the footer's
// 示範資料 tag is for.
function quotesFor(market: MarketId, now: number): QuotesFile | undefined {
  const file = quotesFiles[market]
  if (file) {
    // The override file wins, but it does not have to be COMPLETE to win: a
    // fetcher whose own watchlist is narrower than the band's (or briefly
    // out of date) can leave a code the table draws with no quote at all.
    // `liveBy[market]` is the built-in feed's own last snapshot for this
    // market - when `twSources` leads with `"shioaji"`, that is exactly
    // whatever the next configured source published while the override was
    // stale (feedTw's fallthrough), and its
    // codes are the band's full watchlist. Fill gaps from it before falling
    // through to buildProps' own noData marker; the override's own entries
    // always win over the bridge's.
    const bridge = liveBy[market]
    const bridgeHolds = bridge && snapshotHolds(bridge.file.asOf, now, market)
    const merged = bridgeHolds ? { ...bridge.file.quotes, ...file.quotes } : file.quotes
    const { quotes, barsFromYahoo } = withLiveBars(market, merged, now)
    return {
      ...file,
      quotes,
      ...(barsFromYahoo && !file.barLabel ? { barLabel: YAHOO_BAR_LABEL } : {}),
    }
  }
  const snap = liveBy[market]
  if (!snap || !snapshotHolds(snap.file.asOf, now, market)) return undefined
  const { quotes } = withLiveBars(market, snap.file.quotes, now)
  return { ...snap.file, quotes, ...(snap.prev ? { prev: snap.prev } : {}) }
}

/** one stop on the tab row - a market's table, or its pnl view */
type CycleStop = { market: MarketId; pnl: boolean }

// A tab's label is just the stop ON THE BAND, nothing else: 美股 / 台股 for a
// table stop, 美股庫存 / 台股庫存 for a pnl stop. It used to append 固定 to
// distinguish a pinned market from the same market in auto mode, which is a
// distinction the label has no business carrying: the two draw identical
// boards and only differ hours later, at the handover.
function stopLabel(stop: CycleStop): string {
  const conf = MARKETS[stop.market]
  return stop.pnl ? conf.holdingsLabel : conf.label
}

// The tab row: one plain Button per stop; the stop on screen reads `[台指期]`
// at full strength, every other tab is dimColor. Plain (no `[ label ]`
// chrome) so six tabs cost ~45 columns, not ~67.
function tabLabel(stop: CycleStop, current: CycleStop): string {
  const label = stopLabel(stop)
  return sameStop(stop, current) ? `[${label}]` : label
}
function sameStop(a: CycleStop, b: CycleStop): boolean {
  return a.market === b.market && a.pnl === b.pnl
}
function tabKey(stop: CycleStop): string {
  return `stock-band:tab:${stop.market}${stop.pnl ? ':pnl' : ''}`
}
/** display width of the whole tab row: labels, single-space gaps, the mark's brackets */
function tabRowWidth(stops: CycleStop[]): number {
  return stops.reduce((w, s) => w + dispWidth(stopLabel(s)), 0) + Math.max(0, stops.length - 1) + 2
}

/**
 * The tab row's stops, in order: 美股 → (美股庫存, only when US holdings are
 * configured - file or config) → 台股 → 台股庫存 → (台指期, only when the
 * config lists `futures`) → (期貨庫存, only when the fetcher's
 * futures-holdings.json holds a position - the two tf stops are gated
 * independently, so a holdings-only user gets the pnl view and no empty
 * table). The single source of which stops exist: the tabs are drawn from
 * this list, so the row and the stops can never disagree.
 * 台股庫存 is always a stop even with no holdings at all (it draws the "沒有
 * 庫存資料" hint row instead of disappearing - a tab that vanishes depending
 * on data would shift the row under the pointer). Rebuilt on every render
 * since holdings can change mid-session (a fresh stock-holdings.json write,
 * or /reload-plugins).
 */
function buildCycle(hasUsHoldings: boolean, hasTfTable: boolean, hasTfHoldings: boolean): CycleStop[] {
  const stops: CycleStop[] = [{ market: 'us', pnl: false }]
  if (hasUsHoldings) stops.push({ market: 'us', pnl: true })
  stops.push({ market: 'tw', pnl: false }, { market: 'tw', pnl: true })
  if (hasTfTable) stops.push({ market: 'tf', pnl: false })
  if (hasTfHoldings) stops.push({ market: 'tf', pnl: true })
  return stops
}

// --- the title/button row ----------------------------------------------
// This module draws the row directly with Box/Text/Button (docs/api-notes.md:
// a Client surface has no Button), so it needs its own copies of the colors
// and the display-width math board.tsx uses for the same session badge - the
// two files never import each other (a Client module loads by literal path
// only; see docs/api-notes.md).
const ORANGE = '#d97757'
const MOON_BLUE = '#8ab4f8' // the closed-session moon, so 休市 still reads at a glance
const DIM = '#6e7681'
const SUN = '☀'
const MOON = '☽'

// the table Client lost its title row (the button row above it draws that
// now); the chart Client kept its own, since that title names the symbol
// being charted rather than the market
const TABLE_BOARD_ROWS = 8
const CHART_BOARD_ROWS = 8
const PNL_BOARD_ROWS = 8

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  return wide ? 2 : 1
}
function dispWidth(s: string): number {
  let w = 0
  for (const ch of Array.from(s)) w += charWidth(ch)
  return w
}

// rough width of the right-hand button group (翻頁 X/Y, 趨勢圖, 收起 30分, plus
// the gaps a Button draws around its own label) - there is no way to measure
// what the framework actually renders from inside the hook, so the left group
// treats this as a fixed reservation when it decides which of the session
// notes / badge after the tabs still fit.
const RIGHT_BUTTON_GROUP_COLS = 40

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)

    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
      if (typeof manifest?.version === 'string') version = `v${manifest.version}`
    } catch {
      // a band that cannot name its version still draws prices
    }

    // resolved once per session: `~` in a config path only ever means this
    const home = (await $.env.get('HOME')) ?? ''
    const userConfigPath = home ? `${home}/${USER_CONFIG_REL}` : ''
    // Resolved once per session, same as userConfigPath: every runtime file
    // this module or the Shioaji fetcher writes lives under `runtime`.
    const project = await $.session.cwd()
    const runtime = runtimeDir(home, project)

    // Both files are optional and most sessions have neither, but the host logs
    // every failed $.fs.read at ERROR level - so polling them every few seconds
    // fills a new user's debug log with two errors per tick about files they
    // were never required to create. A missing file is retried every MISS_EVERY
    // ticks instead; the counter resets the moment it turns up, so a session
    // that does have a config reads it on every poll as before.
    const MISS_EVERY = 10
    const misses: Record<string, number> = {}
    const readOptional = async (path: string): Promise<string | undefined> => {
      const missed = misses[path] ?? 0
      if (missed > 0 && missed % MISS_EVERY !== 0) {
        misses[path] = missed + 1
        return undefined
      }
      try {
        const text = await $.fs.read(path)
        misses[path] = 0
        return text
      } catch {
        misses[path] = missed + 1
        return undefined
      }
    }

    const poll = async () => {
      const now = await $.clock.now()
      // Merge order: built-in defaults < user-level file < project file -
      // each later root overrides a key the earlier ones set, so a shared
      // project's stock-band.json can stay neutral (no twSources, no
      // broker paths) while ~/.claude/stock-band.json carries one person's
      // own preference order. A key only one side states still applies.
      const userConfigText = userConfigPath ? await readOptional(userConfigPath) : undefined
      const projectConfigText = await readOptional(CONFIG_PATH)
      const userRoot = parseJsonRecord(userConfigText)
      const projectRoot = parseJsonRecord(projectConfigText)
      const mergedRoot = userRoot || projectRoot ? { ...userRoot, ...projectRoot } : undefined
      // Quotes: the runtime-dir file (the Shioaji fetcher's own output)
      // wins while fresh, then the project's file as the manual override
      // seam, then nothing (the built-in feed takes over). Holdings follow
      // the same order, but the runtime-dir file wins outright whenever it
      // parses - see parseHoldingsFile for why it never goes stale.
      const runtimeQuotesText = await readOptional(`${runtime}stock-quotes.json`)
      const projectQuotesText = await readOptional(QUOTES_PATH)
      // futures have no project-level override: 永豐 is their only route
      const futuresQuotesText = await readOptional(`${runtime}futures-quotes.json`)
      const runtimeHoldingsText = await readOptional(`${runtime}stock-holdings.json`)
      const projectHoldingsText = await readOptional(HOLDINGS_PATH)
      const futuresHoldingsText = await readOptional(`${runtime}futures-holdings.json`)

      config = parseConfigRoot(mergedRoot)
      if (config.droppedFutures.length > 0 && !loggedDroppedFutures) {
        loggedDroppedFutures = true
        $.ui.log(`tw-stock-mod: futures 有 ${config.droppedFutures.length} 筆沒有 code，已略過：${config.droppedFutures.join(', ')}`)
      }
      const runtimeQuotes = parseQuotes(runtimeQuotesText, now)
      runtimeQuotesFresh = runtimeQuotes !== undefined
      quotesFiles = {}
      fillQuoteSlots(runtimeQuotes ?? parseQuotes(projectQuotesText, now), ['tw', 'us'])
      const futuresQuotes = parseQuotes(futuresQuotesText, now)
      futuresQuotesFresh = futuresQuotes !== undefined
      fillQuoteSlots(futuresQuotes, ['tf'])
      // The project-path holdings file only: a 0.9-era Shioaji fetcher wrote
      // its output straight here (before runtimeDir existed) and always
      // stamped it "永豐 庫存" - see parseHoldingsFile's docblock. That file
      // never expires, so a leftover copy would otherwise read as a
      // permanent manual override forever after the upgrade. Filter it out
      // and warn once; the runtime-dir file is never filtered this way.
      let projectHoldings = parseHoldingsFile(projectHoldingsText)
      if (projectHoldings?.source === '永豐 庫存') {
        projectHoldings = undefined
        if (!loggedLegacyProjectHoldings) {
          loggedLegacyProjectHoldings = true
          $.ui.log(
            `tw-stock-mod: ${project}/${HOLDINGS_PATH} 是 0.9 版留下的永豐輸出，已忽略，可以刪掉；新版寫在 ${runtime}stock-holdings.json`,
          )
        }
      }
      holdingsFiles = {}
      fillHoldingsSlots(parseHoldingsFile(runtimeHoldingsText) ?? projectHoldings, ['tw', 'us'])
      fillHoldingsSlots(parseHoldingsFile(futuresHoldingsText), ['tf'])
      ready = true
      autoPage(now)
      // redraw while snoozed too, so the collapsed row's countdown ticks down
      $.ui.invalidate('ui.render')
    }

    // once immediately so the band is there on the first prompt, then on the
    // refresh interval the config asked for. The interval is fixed for the
    // session: changing refreshMs later needs /reload-plugins.
    await poll().catch(err => $.ui.log(`tw-stock-mod: poll failed: ${err}`))
    $.clock.every(config.refreshMs, () => {
      poll().catch(err => $.ui.log(`tw-stock-mod: poll failed: ${err}`))
    })

    // A failed request must never become a made-up price: the feed keeps the
    // last good snapshot, the snapshot goes stale after QUOTE_STALE_MS, and the
    // band then falls back to the demo walk with the footer saying so.
    const backOff = (now: number, why: string) => {
      feedFailures += 1
      const wait = Math.min(config.feedMs * 2 ** feedFailures, FEED_BACKOFF_MAX_MS)
      feedSkipUntil = now + wait
      $.ui.log(`tw-stock-mod: feed ${why}, next try in ${Math.round(wait / 1000)}s`)
    }

    /**
     * Hand one market's parsed snapshot to the board. Everything above this
     * differs per market - the endpoint, the symbol spelling, the index list -
     * and everything below it is the same, so it lives here once.
     */
    const publish = (opts: {
      market: MarketId
      list: Ticker[]
      /** parsed rows, keyed the way the endpoint spells a symbol */
      parsed: Record<string, FileQuote>
      /** how to spell a watchlist entry in that same keying */
      keyOf: (t: Ticker) => string
      indices: { key: string; name: string }[]
      /** which of those indices the market is read by */
      indexKey: string
      tradedAt: number
      now: number
      sourceLabel: string
      barLabel: string
    }): void => {
      const quotes: Record<string, FileQuote> = {}
      for (const sym of opts.list) {
        const q = opts.parsed[opts.keyOf(sym)]
        if (q) quotes[sym.code] = q
      }
      if (Object.keys(quotes).length === 0) {
        $.ui.log(`tw-stock-mod: ${opts.market} feed answered nothing usable; keeping the last snapshot`)
        return
      }
      // an index the answer skipped is left out rather than drawn at zero
      const indices: IndexRow[] = []
      for (const spec of opts.indices) {
        const row = opts.parsed[spec.key]
        if (!row) continue
        const prev = row.prevClose ?? row.price
        indices.push({
          name: spec.name,
          value: row.price,
          change: round2(row.price - prev),
          pct: prev ? ((row.price - prev) / prev) * 100 : 0,
        })
      }

      const idx = opts.parsed[opts.indexKey]
      const idxPrev = idx?.prevClose ?? idx?.price ?? 0
      feedSeq += 1
      turnSeq += 1
      nextFeedAt = opts.now + feedInterval(config)
      liveBy[opts.market] = {
        prev: liveBy[opts.market]?.file.quotes,
        file: {
          asOf: opts.now,
          market: opts.market,
          origin: 'live',
          sourceLabel: opts.sourceLabel,
          // the exchange's clock when it answered; only this module's own read
          // time is left if the answer carried none
          dataAt: opts.tradedAt || opts.now,
          seq: feedSeq,
          quotes,
          barLabel: opts.barLabel,
          ...(indices.length > 0 ? { indices } : {}),
          index: idx
            ? {
                value: idx.price,
                change: round2(idx.price - idxPrev),
                pct: idxPrev ? ((idx.price - idxPrev) / idxPrev) * 100 : 0,
              }
            : undefined,
        },
      }
      $.ui.invalidate('ui.render')
    }

    /**
     * One batched spark request where the symbols fit in one, two where they
     * do not: Yahoo answers `Number of symbols needs to be less than or equal
     * to 20`, so a full 20-symbol watchlist plus the three indices is 23 and
     * has to be split. feedInterval() has already widened the tick to pay for
     * the extra call. Returns undefined when a request failed, which is not
     * the same as an answer with nothing in it.
     */
    const fetchSpark = async (
      symbols: string[],
      now: number,
      what: string,
    ): Promise<{ quotes: Record<string, FileQuote>; tradedAt: number } | undefined> => {
      const quotes: Record<string, FileQuote> = {}
      let tradedAt = 0
      for (let i = 0; i < symbols.length; i += SPARK_BATCH) {
        const batch = symbols.slice(i, i + SPARK_BATCH)
        const res = await $.http.fetch(sparkUrl(batch, now + i), { headers: FEED_HEADERS })
        if (!res.ok) {
          backOff(now, `HTTP ${res.status}${what}`)
          return undefined
        }
        const part = parseSpark(res.text)
        Object.assign(quotes, part.quotes)
        tradedAt = Math.max(tradedAt, part.tradedAt)
      }
      return { quotes, tradedAt }
    }

    const feedUs = async (now: number) => {
      const list = [...config.lists.us, ...holdingExtras('us', config.lists.us, config)]
      const symbols = [...list.map(t => t.code), ...US_INDICES.map(i => i.symbol)]
      const answer = await fetchSpark(symbols, now, '')
      if (!answer) return
      feedFailures = 0
      publish({
        market: 'us',
        list,
        parsed: answer.quotes,
        keyOf: t => t.code,
        indices: US_INDICES.map(i => ({ key: i.symbol, name: i.name })),
        indexKey: US_INDEX_SYMBOL,
        tradedAt: answer.tradedAt,
        now,
        sourceLabel: 'Yahoo 即時',
        barLabel: '5 分 K',
      })
    }

    // Taiwan via Yahoo. Returns whether it produced a usable snapshot THIS
    // tick - the dispatcher below (feedTw) reads that to decide whether to
    // fall through to the next entry in `config.twSources`.
    const feedTwYahoo = async (now: number): Promise<boolean> => {
      const list = [...config.lists.tw, ...holdingExtras('tw', config.lists.tw, config)]
      if (list.length === 0) return false
      const symbols = [...list.map(t => yahooSymbol('tw', t)), TW_YAHOO_INDEX]
      const answer = await fetchSpark(symbols, now, ' (台股)')
      if (!answer) return false
      feedFailures = 0
      publish({
        market: 'tw',
        list,
        parsed: answer.quotes,
        keyOf: t => yahooSymbol('tw', t),
        indices: [{ key: TW_YAHOO_INDEX, name: 'TAIEX' }],
        indexKey: TW_YAHOO_INDEX,
        tradedAt: answer.tradedAt,
        now,
        // Yahoo's Taiwan quotes are about twenty minutes behind, and the
        // footer has to say so rather than claim 即時
        sourceLabel: 'Yahoo 延遲',
        barLabel: '5 分 K',
      })
      return true
    }

    /**
     * Taiwan through the exchange's own intraday endpoint, which answers the
     * whole watchlist and both indices in one request. MIS carries no K
     * bars, so the chart view still goes to Yahoo per symbol the way the US
     * one does, whichever `twSources` entry prices the table. Same return
     * convention as feedTwYahoo.
     */
    const feedTwMis = async (now: number): Promise<boolean> => {
      const list = [...config.lists.tw, ...holdingExtras('tw', config.lists.tw, config)]
      if (list.length === 0) return false
      // the first entry is the one the market is read by, so an empty list
      // would leave the board with no headline index at all - parseTwIndices
      // never returns one
      const indices = config.twIndices
      const channels = [...list.map(misChannel), ...indices.map(misChannel)]
      const res = await $.http.fetch(misUrl(channels, now), { headers: FEED_HEADERS })
      if (!res.ok) {
        backOff(now, `HTTP ${res.status} (證交所)`)
        return false
      }
      const { quotes: parsed, tradedAt } = parseMis(res.text)
      if (Object.keys(parsed).length === 0) {
        backOff(now, '證交所 answered nothing usable')
        return false
      }
      feedFailures = 0
      publish({
        market: 'tw',
        list,
        parsed,
        keyOf: t => t.code,
        indices: indices.map(i => ({ key: i.code, name: i.name })),
        indexKey: indices[0].code,
        tradedAt,
        now,
        sourceLabel: '證交所 即時',
        barLabel: '5 分 K',
      })
      return true
    }

    /**
     * `"shioaji"` in `twSources`: spawn (or re-check) the fetcher script
     * rather than call an HTTP endpoint - see the ShioajiConfig doc comment
     * for why this cannot run inside the hooks module directly. Returns
     * whether the runtime-dir quotes file is fresh (true = this tick is
     * covered, same convention as feedTwYahoo/feedTwMis): the script writes
     * that file asynchronously, on its own schedule, so "did shioaji price
     * Taiwan just now" can only ever mean "is the file it wrote still
     * fresh", never "did a request this module made just now succeed". This
     * checks the runtime-dir file specifically, never the project's
     * `.claude/stock-quotes.json` override - that file can stay fresh for
     * reasons that have nothing to do with shioaji, and must never mask a
     * dead fetcher from either this respawn check or the visible-failure
     * warning below.
     *
     * Respawn rule (spawnShioaji): once at session start (the first feed
     * tick), then only when the quotes file has gone stale (>120s, i.e. no
     * script is feeding it) AND the last spawn attempt was more than 60s ago
     * - so a script that is merely slow to log in is never spawned a second
     * time on top of itself, and a script that died is retried at most once
     * a minute. The heartbeat itself is feedOnce's, written before any route
     * runs, so the script's first-tick exemption still sees a fresh one.
     */
    const heartbeatPath = `${runtime}stock-band.heartbeat`
    const expand = (p: string) => (home && p.startsWith('~') ? home + p.slice(1) : p)
    const shioajiLogPath = `${runtime}stock-shioaji.log`
    const shioajiPidPath = `${runtime}stock-shioaji.pid`

    /**
     * The one spawn path for the fetcher, whichever market asks first. It
     * always carries both `--codes` and `--futures` (possibly empty): the
     * pidfile means the first spawn fixes the argv for the process lifetime,
     * so a fetcher started for 台股 at 10:00 must already know the futures
     * codes it will be asked for at 15:00. A changed list takes effect on
     * the next spawn; a live fetcher is never restarted for it.
     */
    const spawnShioaji = async (now: number): Promise<void> => {
      if (lastShioajiSpawn && now - lastShioajiSpawn < 60_000) return
      lastShioajiSpawn = now
      const python = expand(config.shioaji.python)
      const env = expand(config.shioaji.env)
      const script = `${$.plugin.root}/scripts/fetch-quotes-shioaji.py`
      try {
        // `nohup ... >>log 2>&1 &`, wrapped in `/bin/sh -c`, is what lets
        // $.process.run resolve at all: run() is one-shot and waits for
        // the child's stdout/stderr pipes to close as well as its exit,
        // and a long-lived daemon's pipes never close on their own.
        // Redirecting them to the log file gives the wrapper's OWN
        // short-lived pipes something to close immediately - `&`
        // backgrounds the real script before that happens, so run() sees
        // the wrapper exit at once while the script keeps going past it,
        // logging to logPath instead of to a pipe nothing is reading.
        //
        // This also means the wrapper resolves with exitCode 0 whether or
        // not the BACKGROUNDED script itself goes on to fail (missing
        // python, missing env file, a bad login) - that failure happens
        // after `sh -c` has already returned, so this try/catch can only
        // ever catch a failure to launch the shell itself, never a
        // failure inside the detached job. The only signal this module
        // can observe for "the script isn't feeding the file" is the file
        // staying stale, which is exactly what the callers act on.
        // --codes is the band's own effective Taiwan watchlist (built-in
        // list included, not just whatever `stock-band.json` overrides) -
        // without it the script fell back to reading `tw` out of
        // stock-band.json itself, which is empty whenever a project has no
        // config file at all, and it then snapshotted only the account's
        // positions: every OTHER watchlist row stayed on a demo price
        // while the footer still said 永豐 即時. Passing the codes here is
        // what makes the script price the same list the table draws.
        const codes = config.lists.tw.map(t => t.code).join(',')
        const futures = config.lists.tf.map(t => t.code).join(',')
        await $.process.run(
          [
            '/bin/sh',
            '-c',
            `nohup "$0" "$@" >>"${shioajiLogPath}" 2>&1 &`,
            python,
            script,
            '--project',
            project,
            '--out-dir',
            runtime,
            '--env',
            env,
            '--interval',
            String(config.shioaji.interval),
            '--codes',
            codes,
            '--futures',
            futures,
            '--heartbeat',
            heartbeatPath,
            '--pidfile',
            shioajiPidPath,
          ],
          { cwd: project, timeoutMs: 15000 },
        )
      } catch (err) {
        // The shell itself failed to launch (e.g. no /bin/sh) - logged,
        // but not fatal: the callers act on the file staying stale.
        $.ui.log(`tw-stock-mod: shioaji spawn failed (${err})`)
      }
    }

    const feedTwShioaji = async (now: number): Promise<boolean> => {
      const python = expand(config.shioaji.python)
      const script = `${$.plugin.root}/scripts/fetch-quotes-shioaji.py`
      const logPath = shioajiLogPath
      const pidPath = shioajiPidPath

      // Visible failure: a script that spawned (or is already running, per
      // its own pidfile) but still has not produced a fresh runtime-dir
      // quotes file 60s later is a failure the session should hear about
      // once, not a silent fallthrough to the next configured source.
      if (!shioajiWarned && !runtimeQuotesFresh) {
        let alive = lastShioajiSpawn > 0
        if (!alive) {
          try {
            await $.fs.read(pidPath)
            alive = true
            if (!shioajiPidSeenAt) shioajiPidSeenAt = now
          } catch {
            alive = false
            shioajiPidSeenAt = 0
          }
        }
        // Own spawn: age from when this session actually launched it. A
        // pidfile this session did not spawn (shioajiPidSeenAt): age from
        // first discovery, not from now-lastShioajiSpawn (0 => Infinity),
        // so a leftover pidfile gets the same 60s grace as a fresh spawn
        // instead of warning on the very first tick.
        const spawnAge = lastShioajiSpawn
          ? now - lastShioajiSpawn
          : shioajiPidSeenAt
            ? now - shioajiPidSeenAt
            : Infinity
        if (alive && spawnAge >= 60_000) {
          shioajiWarned = true
          $.ui.log(
            `tw-stock-mod: 永豐路線沒有出價，退回下一個來源。看 ${logPath}，或跑 ${python} ${script} --check 找原因`,
          )
        }
      }

      const stale = !runtimeQuotesFresh
      if (!stale) return true

      await spawnShioaji(now)

      // A missing python, a missing env file, or a dead login all show up
      // the same way from here: the runtime-dir quotes file stays stale.
      // Falling through to the next configured source (feedTw below) rather
      // than waiting out QUOTE_STALE_MS is what keeps the band off demo
      // prices in the meantime - a fresh runtime-dir file, once the script
      // does log in, wins over whatever that fallback publishes on the very
      // next poll (quotesFor prefers the file slot first).
      return false
    }

    /**
     * Tries `config.twSources` in order and stops at the first one that
     * prices Taiwan this tick. `twSources` is never empty (parseTwSources
     * falls back to defaultConfig's `["yahoo"]`), so this always attempts
     * at least Yahoo.
     */
    const feedTw = async (now: number) => {
      for (const source of config.twSources) {
        const ok =
          source === 'shioaji' ? await feedTwShioaji(now) : source === 'mis' ? await feedTwMis(now) : await feedTwYahoo(now)
        if (ok) return
      }
    }

    /**
     * 台指期: 永豐 is the only route, so there is nothing to fall through to
     * and no warning to raise - a stale futures file is drawn as no-data by
     * the poll. All this does is keep the fetcher alive (the heartbeat, in
     * feedOnce) and (re)spawn it on the shared rule when its file is stale.
     */
    const feedTf = async (now: number) => {
      if (futuresQuotesFresh) return
      await spawnShioaji(now)
    }

    /**
     * The signal the fetcher watches: it exits by itself once this is older
     * than 90s, and each tick works only the markets named here. `tw` is
     * named only when 永豐 is a configured 台股 route, `tf` whenever its
     * session is open and futures are listed - whatever is on screen.
     */
    const writeHeartbeat = async (now: number, markets: MarketId[]) => {
      try {
        await $.fs.write(heartbeatPath, JSON.stringify({ ts: now, markets }))
      } catch (err) {
        $.ui.log(`tw-stock-mod: could not write the shioaji heartbeat: ${err}`)
      }
    }

    const feed = async () => {
      const now = await $.clock.now()
      // Snoozed means the table is not on screen at all, so the 30 minutes it
      // covers need no prices; feedInFlight keeps a slow answer from stacking
      // a second request on top of it. A 429 back-off (feedSkipUntil) is
      // feedOnce's: it holds the HTTP markets only, never the heartbeat.
      if (config.feed === 'off' || now < snoozedUntil || feedInFlight) return
      feedInFlight = true
      try {
        await feedOnce(now)
      } finally {
        feedInFlight = false
      }
    }

    const feedOnce = async (now: number) => {
      const onScreen = pickMarket(now, modeOverride ?? config.market, hasFutures(config)).market
      const markets = feedMarkets(config, onScreen).filter(market => marketNeedsFeed(now, market))
      const wanted = markets.filter(m => m === 'tf' || (m === 'tw' && config.twSources.includes('shioaji')))
      if (wanted.length > 0) await writeHeartbeat(now, wanted)
      for (const market of markets) {
        if (market === 'tf') await feedTf(now)
        else if (now < feedSkipUntil) continue
        else if (market === 'us') await feedUs(now)
        else await feedTw(now)
      }
    }

    // K bars cost one request per symbol, so only the symbol the trend view is
    // showing asks for them, and only once a minute.
    // K bars come from Yahoo for both markets: MIS has no candles at all, and
    // a 5-minute bar twenty minutes old still draws the right shape.
    const feedBars = async (market: MarketId, code: string) => {
      if (market === 'tf') return // Yahoo has no futures mapping; tf bars only ever come from the file (T3)
      const now = await $.clock.now()
      if (config.feed === 'off' || now < feedSkipUntil || barsInFlight) return
      const key = `${market}:${code}`
      const have = liveBars[key]
      if (have && now - have.at < BARS_MAX_AGE_MS) return
      const sym = config.lists[market].find(t => t.code === code)
      if (!sym) return
      barsInFlight = true
      try {
        const res = await $.http.fetch(chartUrl(yahooSymbol(market, sym), now), { headers: FEED_HEADERS })
        if (!res.ok) return backOff(now, `HTTP ${res.status} (${code} K 棒)`)
        const bars = parseChartBars(res.text)
        if (!bars) return
        liveBars[key] = { bars, at: now }
        $.ui.invalidate('ui.render')
      } finally {
        barsInFlight = false
      }
    }

    requestBars = (market, code) => {
      feedBars(market, code).catch(err => $.ui.log(`tw-stock-mod: K 棒 failed: ${err}`))
    }

    requestFeed = () => {
      feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
    }

    if (config.feed !== 'off') {
      const every = feedInterval(config)
      if (every > config.feedMs) {
        $.ui.log(
          `tw-stock-mod: ${requestsPerTick(config)} requests per tick, so the feed ticks every ` +
            `${Math.round(every / 1000)}s instead of ${Math.round(config.feedMs / 1000)}s ` +
            `(budget ${REQUESTS_PER_HOUR}/hour)`,
        )
      }
      await feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
      $.clock.every(every, () => {
        feed().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
      })
    }

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const now = await $.clock.now()
    if (!ready) return next(e)

    const { Box, Button, Client, Text } = await $.ui.resolve(e)

    // Snoozing used to drop the band with no way back: the only exits were
    // waiting out the 30 minutes or restarting the session. Leave one row
    // behind that says how long is left and brings the table back.
    if (now < snoozedUntil) {
      const mins = Math.max(1, Math.ceil((snoozedUntil - now) / 60_000))
      const onWake = () => {
        snoozedUntil = 0
        $.ui.invalidate('ui.render')
      }
      // No hotkey (see the comment above the button row below for why) - this
      // one presses by click or by focus+Enter.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="stock-band:wake" label={`股票列 ${mins}分 展開`} onPress={onWake} />
          </Box>
          {await next(e)}
        </Box>
      )
    }

    const cols = e.viewport?.columns ?? e.props.bodyColumns ?? 80
    const mode = modeOverride ?? config.market
    const onScreen = pickMarket(now, mode, hasFutures(config)).market
    const props = buildProps(now, config, quotesFor(onScreen, now), mode, view, focusCode)
    // buildProps chases focusCode to whatever position it actually landed on
    // (falling back to 0 when the code is unset, paged off, or gone from the
    // list) - syncing it back here keeps that landing code, not a stale one,
    // so the next onPrev/onNext step counts from the row actually on screen.
    focusCode = props.quotes[props.focus]?.code

    // the trend view is the only thing that needs K bars, so it is the only
    // thing that asks for them; feedBars drops a request it already answered.
    // A stock quotes file (永豐, 證交所) never carries bars of its own, so it
    // asks Yahoo the same way the built-in feed does - only the demo walk
    // skips this and draws demoBars instead (see the demoBars call below),
    // and feedBars itself drops a tf request: those bars are in the file.
    if (view === 'chart' && props.source !== 'demo' && props.quotes[props.focus]) {
      requestBars?.(props.market, props.quotes[props.focus].code)
    }

    // Button only draws from this module's own AbovePrompt tree - a Client
    // surface has no Button (docs/api-notes.md) - so the controls sit on their
    // own row directly above the table.
    //
    // The tab row is one Button per stop of buildCycle - 美股 → (美股庫存) →
    // 台股 → 台股庫存 → (台指期) → (期貨庫存) - and a press lands on that stop
    // directly. `market`/`view` do not change here for any stop-internal
    // reason (the watchlist itself is unaffected by which stop is showing),
    // so the feed gating in feedOnce (which reads modeOverride's MARKET half
    // only) never needs to know about the pnl stops at all - see
    // marketNeedsFeed.
    // Bumps `turnSeq` and snapshots what was on screen (pnlPageFrom) - the
    // pnl view's own version of the watchlist's page-turn flap
    // (PAGE_TURN_WINDOW_MS/pageFrom), reusing the exact same turn/rowFlap
    // machinery board.tsx already runs for the table: this only decides
    // WHEN a turn starts, the animation itself lives entirely in board.tsx.
    const turnPnl = () => {
      pnlPageFrom = lastPnlShown
      pnlPageAt = now
      turnSeq += 1
    }
    const currentStop: CycleStop = { market: props.market, pnl: props.view === 'pnl' }
    const stops = buildCycle(
      holdingsFor('us', holdingsFiles.us, config).holdings.length > 0,
      hasFutures(config),
      holdingsFor('tf', holdingsFiles.tf, config).holdings.length > 0,
    )
    const onSelectStop = (stop: CycleStop) => {
      // the selected tab pressed again is a no-op - unless the chart is up,
      // where the same market's tab is the way back to its table
      if (sameStop(stop, currentStop) && view !== 'chart') return
      // A market switch starts the table back at page 0: the two markets'
      // page counts have no relation to each other, so carrying the old
      // index over lands on whichever page the new market's remainder
      // happens to wrap to, not "from the top" the way switching markets
      // reads. Written directly like the chart view's focus-chase jump
      // (see buildProps) rather than through setPage: `lastShownMarket`
      // will already read the OLD market on this same render (buildProps
      // has not run yet), so a setPage here would open a pageFrom/
      // pageFromAt flap that pairs the new market's row 0 with whatever
      // the old market last drew in that slot - the exact cross-market mix
      // `pageFromMarket` exists to keep off the board.
      if (stop.market !== props.market) page = 0
      modeOverride = stop.market
      view = stop.pnl ? 'pnl' : 'table'
      resetPnlScroll() // "changing the stop" always resets the pnl scroll position
      if (stop.pnl) turnPnl() // landing on a pnl stop flaps it in, like a mount
      // the market the tab just landed on may never have been fetched: ask
      // for it now rather than showing demo prices until the next tick
      if (!quotesFor(pickMarket(now, modeOverride, hasFutures(config)).market, now)) requestFeed?.()
      $.ui.invalidate('ui.render')
    }
    const onSnooze = () => {
      snoozedUntil = now + SNOOZE_MS
      $.ui.invalidate('ui.render')
    }
    const rowCount = props.quotes.length
    shownCount = rowCount
    const onPage = () => {
      setPage((props.page + 1) % props.pageCount, now)
      $.ui.invalidate('ui.render')
    }
    // One button used to do all three jobs - enter the chart, step to the next
    // symbol, and fall back to the table on the last one - which left no way
    // back to the symbol you just passed and no way out except walking to the
    // end. The chart view now gets its own three buttons, and 趨勢圖 only ever
    // opens the view.
    const onTrend = () => {
      view = 'chart'
      focusCode = props.quotes[0]?.code
      $.ui.invalidate('ui.render')
    }
    const step = (by: number) => () => {
      const n = Math.max(1, rowCount)
      const nextPos = (props.focus + by + n) % n
      focusCode = props.quotes[nextPos]?.code
      $.ui.invalidate('ui.render')
    }
    const onPrev = step(-1)
    const onNext = step(1)
    const onList = () => {
      view = 'table'
      focusCode = props.quotes[0]?.code
      $.ui.invalidate('ui.render')
    }
    // Moves the scroll offset a whole PNL_PAGE_SIZE at a time, wrapping back
    // to 0 past the last page - "paging sets the offset to page*5".
    const holdingsPageCount = Math.max(1, Math.ceil(props.holdings.length / PNL_PAGE_SIZE))
    const holdingsPageNum = Math.floor(props.holdingsScroll / PNL_PAGE_SIZE) + 1
    const onHoldingsPage = () => {
      const curPage = Math.floor(props.holdingsScroll / PNL_PAGE_SIZE)
      pnlScroll = ((curPage + 1) % holdingsPageCount) * PNL_PAGE_SIZE
      turnPnl() // a page move flaps the new page in, same as the watchlist's 翻頁
      $.ui.invalidate('ui.render')
    }
    // Cycles the five sort keys in a fixed order (PNL_SORT_KEYS), keeping
    // whatever direction was already set - only a header-cell click (see
    // ui.message) flips direction, on the key it lands on.
    const onPnlSort = () => {
      const idx = PNL_SORT_KEYS.indexOf(pnlSortKey)
      pnlSortKey = PNL_SORT_KEYS[(idx + 1) % PNL_SORT_KEYS.length]
      resetPnlScroll() // "changing the sort key/direction" resets the pnl scroll position
      turnPnl()
      $.ui.invalidate('ui.render')
    }

    // The tab row marks the stop ON THE BAND: it tracks the clock until the
    // first press, then whatever tab was pressed.
    const open = props.phase === 'open'
    // Three views, three names, so every line in the button row below can
    // read forwards: `table ? 元素 : null`, `chart ? 元素 : null`, `pnl ?
    // 元素 : null`, never a negation that says what does NOT draw and has to
    // be reversed in the head before it says anything.
    const chart = props.view === 'chart'
    const pnl = props.view === 'pnl'
    const table = props.view === 'table'
    // The tabs never give way; what follows them does, in order: sessionNote
    // first (09:30-16:00 ET answers the wrong question in Taipei anyway),
    // then taipeiNote, then the session badge. There is no way to measure
    // what the framework actually renders from inside the hook, so this
    // reserves a fixed budget for the button group on the right (see
    // RIGHT_BUTTON_GROUP_COLS) and drops each piece when it no longer fits.
    const badge = `${open ? SUN : MOON} ${open ? '盤中' : '休市'}`
    const fits = (...parts: string[]) =>
      tabRowWidth(stops) + parts.reduce((w, p) => w + 1 + dispWidth(p), 0) + RIGHT_BUTTON_GROUP_COLS <= cols
    const taipei = props.taipeiNote === '' ? [] : [props.taipeiNote]
    const showSession = table && fits(badge, props.sessionNote, ...taipei)
    const showTaipei = table && taipei.length > 0 && fits(badge, ...taipei)
    const showBadge = table && fits(badge)

    // No hotkeys on any of these (2026-09-16, at the user's request: 先不加
    // 上快捷鍵). A letter hotkey only fires once one of the band's Buttons
    // already holds the focus ring (d.ts:653-658) - it buys nothing over
    // pressing Enter once the ring is there - and a digit hotkey fires from
    // an empty composer, which would eat a prompt that happens to start with
    // that digit. Every button below stays pressable by click or by
    // focus+Enter.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            {stops.flatMap((stop, i) => [
              i > 0 ? <Text key={`${tabKey(stop)}:gap`}> </Text> : null,
              <Button
                key={tabKey(stop)}
                label={tabLabel(stop, currentStop)}
                plain
                dimColor={!sameStop(stop, currentStop)}
                onPress={() => onSelectStop(stop)}
              />,
            ])}
            {/* The chart view's controls sit here, next to the symbol they move
                through, rather than stranded on the far right where the eye is
                not. The session state and hours give up the space because the
                chart draws its own title row with both already on it. */}
            {chart ? <Text> </Text> : null}
            {chart ? <Button key="stock-band:prev" label="◀ 上一檔" onPress={onPrev} /> : null}
            {chart ? (
              <Button key="stock-band:next" label={`下一檔 ▶ ${props.focus + 1}/${rowCount}`} onPress={onNext} />
            ) : null}
            {chart ? <Button key="stock-band:list" label="回清單" onPress={onList} /> : null}
            {showBadge ? <Text> </Text> : null}
            {showBadge ? <Text color={open ? ORANGE : MOON_BLUE}>{badge}</Text> : null}
            {showSession ? <Text> </Text> : null}
            {showSession ? <Text color={DIM}>{props.sessionNote}</Text> : null}
            {showTaipei ? <Text> </Text> : null}
            {showTaipei ? <Text color={DIM}>{props.taipeiNote}</Text> : null}
          </Box>
          <Box flexDirection="row">
            {table && props.pageCount > 1 ? (
              <Button
                key="stock-band:page"
                label={`翻頁 ${props.page + 1}/${props.pageCount}`}
                onPress={onPage}
              />
            ) : null}
            {pnl && holdingsPageCount > 1 ? (
              <Button
                key="stock-band:pnl-page"
                label={`翻頁 ${holdingsPageNum}/${holdingsPageCount}`}
                onPress={onHoldingsPage}
              />
            ) : null}
            {table ? <Button key="stock-band:trend" label="趨勢圖" onPress={onTrend} /> : null}
            {pnl ? (
              <Button
                key="stock-band:pnl-sort"
                label={`排序 ${PNL_SORT_LABELS[props.pnlSortKey]} ${props.pnlSortDir === 'desc' ? '↓' : '↑'}`}
                onPress={onPnlSort}
              />
            ) : null}
            <Button key="stock-band:snooze" label="收起 30分" onPress={onSnooze} />
          </Box>
        </Box>
        <Client
          key="stock-band:table"
          module="./board.tsx"
          width={cols}
          height={props.view === 'chart' ? CHART_BOARD_ROWS : props.view === 'pnl' ? PNL_BOARD_ROWS : TABLE_BOARD_ROWS}
          props={{ ...props }}
        />
        {await next(e)}
      </Box>
    )
  })

  // Clicking a quote in the table opens its trend chart. The board hit-tests
  // the pointer (a Client has no Button) and posts the row it landed on; this
  // is the other end of that. It is a shortcut, not a replacement: the table
  // is not on screen in chart view, so 上一檔 / 下一檔 / 回清單 stay the only
  // way to move once the chart is up.
  //
  // `data` came from code, so it is input to validate, not a fact - hence the
  // bounds check against the board that was actually drawn.
  on('ui.message', async ($, e, next) => {
    // `e.module` is the path under the plugin folder (`hooks/board.tsx`), NOT
    // the `./board.tsx` literal the Client prop carries. Comparing it against
    // the prop threw every message away in silence: the pointer fired, the hit
    // test matched, the post went out, and this hook dropped it.
    if (e.element !== 'stock-band:table' || !e.module.endsWith('board.tsx')) return next(e)
    const data = e.data as { pick?: unknown; sortPnl?: unknown } | null

    // A pnl header-cell click: `data` came from code, so it is input to
    // validate, not a fact - hence the check against the five real keys
    // rather than trusting whatever string arrived. Clicking the ALREADY
    // active key flips direction; landing on a new one resets to desc, the
    // same starting point the 排序 button's own key changes use.
    if (typeof data?.sortPnl === 'string' && PNL_SORT_KEYS.includes(data.sortPnl as PnlSortKey)) {
      const key = data.sortPnl as PnlSortKey
      pnlSortDir = key === pnlSortKey ? (pnlSortDir === 'desc' ? 'asc' : 'desc') : 'desc'
      pnlSortKey = key
      resetPnlScroll() // a header click always changes the key or the direction
      // same turn/flap this view's own buttons trigger (onPnlSort) - see
      // that function's comment; this hook has no `now` of its own handy.
      pnlPageFrom = lastPnlShown
      pnlPageAt = await $.clock.now()
      turnSeq += 1
      $.ui.invalidate('ui.render')
      return {}
    }

    const pick = data?.pick
    if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 0 || pick >= shownCount) {
      return next(e)
    }
    view = 'chart'
    // `pick` is the position the board actually drew the click on - resolve
    // it against `lastShown` (this module's record of that same drawn page)
    // to the code sitting there, not the position itself, so a rank cross
    // on the very next render cannot walk the chart onto some other symbol.
    focusCode = lastShown[pick]?.code
    $.ui.invalidate('ui.render')
    return {}
  })
}
