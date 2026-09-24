// Paths, timings, endpoints and index symbols the rest of the band shares.

import type { TwIndex } from './markets.ts'

export const CONFIG_PATH = '.claude/stock-band.json'
export const QUOTES_PATH = '.claude/stock-quotes.json'
export const HOLDINGS_PATH = '.claude/stock-holdings.json'
// A user-level config, never inside a project (so it never lands in version
// control): each person's own source order and broker paths live here, and
// a shared project's stock-band.json stays neutral. `~` is resolved with
// userHome() at poll time, since a path constant cannot expand it.
export const USER_CONFIG_REL = '.claude/stock-band.json'

// Everything the module or a broker fetcher writes at runtime - quotes,
// holdings, the heartbeat, the fetcher's log and its PID file - lives under
// this directory instead of the project's `.claude/`, so a shared project
// never picks up one person's live prices or PID file. One directory per
// project avoids collisions: RUNTIME_DIR_ROOT plus the project path with
// its leading separators dropped and every remaining separator turned into
// "-" (e.g. `/Users/x/app` -> `Users-x-app`, `D:\app` -> `D--app`). `\` and
// `:` count as separators alongside `/` so a Windows path becomes a legal
// directory name; a POSIX path contains neither, so this is byte-identical
// to the old `/`-only rule there and no existing runtime dir moves.
// `home` falls back to the project's own `.claude/` only when neither $HOME
// nor %USERPROFILE% is set, matching how this module wrote its runtime files
// before runtimeDir existed.
const RUNTIME_DIR_ROOT = '.claude/stock-band'
export function runtimeDir(home: string, project: string): string {
  if (!home) return `${project}/.claude/`
  const slug = project.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')
  return `${home}/${RUNTIME_DIR_ROOT}/${slug}/`
}

export const DEFAULT_REFRESH_MS = 3000
export const QUOTE_STALE_MS = 120_000
export const SNOOZE_MS = 30 * 60 * 1000
// The table is header + rule + quote rows + footer and the 損益 view title +
// header + holding rows + totals, each sized off the band's `maxRows` (#13,
// see fitBand) with the quote/holding rows capped here - the pre-#13 fixed
// board, which a stub host with no `maxRows` still gets.
export const TABLE_QUOTE_ROWS = 5
export const TABLE_CHROME_ROWS = 3 // header, rule, footer
export const PNL_CHROME_ROWS = 3 // title, header, totals
export const MAX_COLUMNS = 4
// what one more symbol column costs in terminal columns - board.tsx's
// MIN_HALF_WIDTH + TWO_COL_GUTTER (35 + 6), so 77 columns fit two, 118 three
export const COLUMN_MIN_COLS = 41
// board.tsx TICKER_CELL_W: one `代號 價格 ▲pct` cell on the ticker line
export const TICKER_CELL_COLS = 28
// Yahoo's spark endpoint answers `Number of symbols needs to be less than or
// equal to 20` above 20 symbols (measured 2026-09-16: 20 -> 200, 21 -> 400).
// That is a request-batching limit, not a watchlist-length one - `fetchSpark`
// already splits a longer symbol list into 20-symbol requests, and
// feedInterval() slows the tick down as the batch count grows - so the
// watchlist cap is a page-count choice, not a Yahoo one. 40 keeps a market
// at three requests a tick at most (list + indices) and eight pages of five.
export const MAX_SYMBOLS = 40
export const SPARK_BATCH = 20 // Yahoo's own per-request symbol cap
export const PAGE_MS_DEFAULT = 10_000 // one page holds this long before the board turns
export const PAGE_MS_MIN = 4000
// A budget, not an interval: `feedMs` alone cannot keep the host inside the
// limit once one tick costs more than one request. See feedInterval().
export const REQUESTS_PER_HOUR = 300
export const CHART_BARS = 120 // K bars the chart view asks for (it draws the newest that fit)
export const DEFAULT_CHART_ROWS = 16
export const CHART_ROWS_MIN = 8 // title, 5 plot rows, axis, footer - the pre-#12 layout
export const DEMO_BAR_MS = 3000 // demo time per fake bar; a real feed sets its own

// --- live feed --------------------------------------------------------------
// Yahoo's public endpoints, no key, no account. One batched spark request per
// tick covers the whole list plus the index, which is what keeps the feed
// inside the rate limit: a request with no browser User-Agent gets 429 on the
// first try, and a burst of per-symbol requests gets 429 as well. K bars cost
// one request per symbol, so nothing fetches them until the chart view asks
// for the one symbol it is drawing.
export const FEED_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
export const FEED_MS_DEFAULT = 30_000
export const FEED_MS_MIN = 15_000 // a floor, so a bad config cannot get the host banned
export const FEED_BACKOFF_MAX_MS = 300_000
// $.http.fetch takes no timeout and the hooks module has no timer to race it
// against, so a request that never settles would hold feed()/feedBars()'s
// in-flight latch for the rest of the session. Past this age the latch is
// treated as abandoned and the next tick goes ahead anyway.
export const IN_FLIGHT_STUCK_MS = 120_000
export const BARS_MAX_AGE_MS = 120_000 // a 5-minute bar refetched sooner than this says nothing new
export const BARS_STALE_MS = 900_000 // past this a bar set is dropped rather than drawn
export const US_INDEX_SYMBOL = '^IXIC' // NASDAQ Composite, what MARKETS.us calls its index
// the three the US market is read by. They ride the same batched request as
// the quotes, so showing all three costs no extra call.
export const US_INDICES: { symbol: string; name: string }[] = [
  // Latin names: the board flaps them character by character, and a Chinese
  // character has no drum to riffle through
  { symbol: '^DJI', name: 'DOW' },
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: US_INDEX_SYMBOL, name: 'NASDAQ' },
]

// Pionex's public ticker endpoint, no key, no header required at all
// (verified 2026-09-18: unlike Yahoo, a bare GET with no User-Agent still
// answers 200). `symbol=A,B` does NOT batch multiple codes in one request
// (verified 2026-09-18: it answers `{"result":false,"code":
// "MARKET_INVALID_SYMBOL", ...}`, HTTP 200 regardless) - the endpoint with
// no `symbol` param at all answers the whole exchange instead (~330
// tickers, ~55 KB), which is what feedCrypto fetches and filters locally so
// a ten-coin watchlist still costs one request a tick, not ten.
export const PIONEX_TICKERS_URL = 'https://api.pionex.com/api/v1/market/tickers'
// Pionex documents the limit as "10 per second" but as a WEIGHT budget, not
// a request count, and never publishes a per-endpoint weight table
// (https://pionex-doc.gitbook.io/apidocs/restful/general/rate-limit) - so
// this cannot be read as "10 requests/second" for every endpoint. Measured
// against THIS endpoint specifically (2026-09-18, see docs/stock-api-
// notes.md §11.2 for the full readout): every response carries an
// `x-ratelimit-tokens` header, steady-state ~29-30, and both a bulk fetch
// (no `symbol`, ~330 tickers) and a single-symbol fetch cost the same ~1
// token each - so for `market/tickers`, weight is 1 per request regardless
// of payload size. That is evidence for this one endpoint only; `depth`,
// `klines` and anything private have not been measured and are not assumed
// to match.
// A 429 blocks the IP for 60s and adds +10s for every request that still
// lands during the block, so retrying while blocked only makes it worse.
// CRYPTO_COOLDOWN_MS sits comfortably above that 60s floor rather than
// matching it exactly, and it is a flat wait, not an exponential backoff -
// Pionex's own block is a fixed length, not a curve this module needs to
// invent on top of it (contrast FEED_BACKOFF_MAX_MS, which doubles because
// Yahoo's own throttling behavior was never this well specified).
export const CRYPTO_COOLDOWN_MS = 90_000
// `x-ratelimit-tokens` reflects the WHOLE IP's shared bucket, not this
// module's own usage - anything else on the same machine hitting Pionex
// lowers the number this module reads too. Below this many tokens,
// feedCrypto skips firing this one tick rather than spend what is left of
// someone else's headroom; it does not retry sooner or shorten the
// interval to compensate; that would be "failing to back off" the way the
// rate-limit doc warns against, this time self-inflicted.
export const CRYPTO_LOW_TOKENS = 5

// CoinGecko's free `coins/markets` endpoint - no API key needed (verified
// 2026-09-19, HTTP 200 with no auth header). This is ONLY the market-cap
// sort's circulating-supply source, never a price: prices still come from
// Pionex on every tick (see feedCrypto) so a CoinGecko outage never touches
// what is on screen, only how the crypto list is ordered.
export const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets'
// Circulating supply barely moves hour to hour, so this bounds how often
// fetchCryptoSupply is allowed to hit CoinGecko - market cap itself still
// updates every tick because it is computed as supply(cached) x price(live),
// never fetched as a whole number.
export const CRYPTO_SUPPLY_TTL_MS = 3_600_000 // 1 hour
// CoinGecko publishes no per-endpoint free-tier rate limit (unmeasured as of
// 2026-09-19 - unlike CRYPTO_COOLDOWN_MS above, which IS a measured Pionex
// number). This cooldown after a failed/empty answer is a conservative
// guess, not a documented limit - kept long on purpose until someone
// measures the real one.
export const CRYPTO_SUPPLY_COOLDOWN_MS = 600_000 // 10 minutes

// `"mis"` in `twSources` sends Taiwan to the exchange instead of Yahoo. Both
// are keyless, but Yahoo's Taiwan quotes run about twenty minutes behind the
// floor (measured 2026-09-16: Yahoo answered 10:21:51 while MIS was on
// 10:41:59), and a band that says 即時 has to mean it - which is what `mis`
// is for. MIS takes the whole watchlist and both indices in one request
// whatever the list length, and has no 20-symbol cap of its own.
export const MIS_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'
// 上市 / 上櫃. It decides the MIS channel prefix and the Yahoo suffix, and
// nothing else about a symbol tells them apart - 6488 is 上櫃, 2330 is 上市.
export type TwExchange = 'tse' | 'otc'
const TW_INDEX_SYMBOL = 't00' // 發行量加權股價指數, what MARKETS.tw calls its index
// Latin names for the same reason the US ones are Latin: the board flaps one
// character at a time and a Chinese character has no drum to riffle through.
// they are named `code` rather than `symbol` so misChannel() takes them as-is
// MIS answers every index on the same request as the quotes, so the length of
// this list costs nothing. What it does cost is time on the footer: each row
// holds 5 s before the board flaps to the next, so four indices is a 20 s lap.
// `twIndices` in the config replaces the whole list - the exchange publishes
// 146 of them (getCategory.jsp?ex=tse&i=TIDX lists every channel).
export const TW_INDICES: TwIndex[] = [
  { code: TW_INDEX_SYMBOL, name: 'TAIEX', ex: 'tse' }, // 發行量加權股價指數
  { code: 't24', name: 'SEMI', ex: 'tse' }, // 半導體類指數
  { code: 't17', name: 'FINANCE', ex: 'tse' }, // 金融保險類指數
  { code: 't15', name: 'SHIPPING', ex: 'tse' }, // 航運類指數
  // 櫃買 is { code: 'o00', name: 'TPEx', ex: 'otc' } - it needs the otc channel
]
export const TW_YAHOO_INDEX = '^TWII'
