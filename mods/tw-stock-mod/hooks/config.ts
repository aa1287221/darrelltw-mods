// stock-band.json: the Config shape, its parsers and defaults, and the
// layout/request-budget math that follows from it.

import { CHART_ROWS_MIN, COLUMN_MIN_COLS, DEFAULT_CHART_ROWS, DEFAULT_REFRESH_MS, FEED_MS_DEFAULT, FEED_MS_MIN, MAX_COLUMNS, MAX_SYMBOLS, PAGE_MS_DEFAULT, PAGE_MS_MIN, PNL_CHROME_ROWS, REQUESTS_PER_HOUR, SPARK_BATCH, TABLE_CHROME_ROWS, TABLE_QUOTE_ROWS, TICKER_CELL_COLS, TW_INDICES, US_INDICES } from './constants.ts'
import { CRYPTO_LIST, TW_LIST, US_LIST, hasFutures } from './markets.ts'
import type { ColumnMode, MarketId, MarketMode, MarketSwitcher, SortKey, Ticker, TwIndex, TwSourceName } from './markets.ts'
import type { Holding } from './quotes.ts'

export type Config = {
  market: MarketMode
  refreshMs: number
  /** the chart view's height in rows (min 8); the render hook clamps it to the band's `maxRows - 2` */
  chartRows: number
  /**
   * undefined means "no explicit choice" - effectiveSort() then resolves it
   * off MARKETS[market].defaultSort, so each market keeps its own default
   * (crypto: marketcap, tw/us/tf: change) instead of one hardcoded global
   * value. See parseConfigRoot for how an explicit `"sort"` in the config
   * file overrides this.
   */
  sort?: SortKey
  highlight: boolean
  /**
   * how many symbols the table draws per row. `auto` picks the fewest
   * columns (1..4) that hold the list in the quote rows the band has, as
   * many as the band's width allows: 5 or fewer symbols draw the
   * single-column table (代號/名稱/價格/變更$/變更%), more draw two, three or
   * four symbols a row (代號/名稱/價格/變更% only). The board itself still
   * falls back to fewer at render time if the terminal is too narrow.
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
   * intraday without a broker account. `shioaji` and `capital` hand Taiwan to
   * a broker's own real-time feed instead: the band spawns
   * `scripts/fetch-quotes-shioaji.py` / `scripts/fetch-quotes-capital.py`
   * itself (see feedTwFetcher below) and reads back the quotes file it
   * writes, rather than calling an HTTP endpoint the way the other two do.
   * Those two are also platform-split, because their SDKs are: 永豐's shioaji
   * is a POSIX-only Python package and the band spawns it with `nohup`;
   * 群益's SKCOM is a Windows COM server. Listing the one this machine cannot
   * run is harmless - it just never produces a fresh file, and the tick falls
   * through to the next entry.
   * The shipped default is `["yahoo"]` alone - the rest are opt-in,
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
  /**
   * whether the config opted into crypto at all - a `crypto` list of its own
   * or `market: "crypto"`. The built-in CRYPTO_LIST always fills
   * `lists.crypto` (so `select`/`tabs`/`cycle` can offer 加密貨幣 the way
   * upstream does), but the fork's own `tabbar` only draws the 加密貨幣 tab
   * when this is true, the same opt-in rule its 台指期 tab follows.
   */
  cryptoConfigured: boolean
  /** `twSources` includes `"shioaji"` only - how the band runs the fetcher script itself */
  shioaji: ShioajiConfig
  /** `twSources` includes `"capital"` only - how the band runs the 群益 fetcher script itself */
  capital: CapitalConfig
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
  /** which of the three market-switch control styles the band draws; default `'select'` - see MarketSwitcher's own comment */
  marketSwitcher: MarketSwitcher
}

type ShioajiConfig = {
  /** interpreter to run the script with, e.g. the project's own venv python */
  python: string
  /** env file holding SINOBON_API_KEY / SINOBON_SECRET_KEY; `~` expands to $HOME */
  env: string
  /** seconds between snapshots the script writes */
  interval: number
}

type CapitalConfig = {
  /** interpreter to run the script with - must be the same bitness as the registered SKCOM 元件 */
  python: string
  /** env file holding CAPITAL_USER_ID / CAPITAL_PASSWORD; `~` expands to the home dir */
  env: string
  /**
   * the registered `SKCOM.dll`, e.g.
   * `~/CapitalAPI/元件/x64/SKCOM.dll`. There is no sane default: 群益 ships
   * the SDK as a zip with no install location, and the script refuses to
   * guess rather than fail three steps later with a COM error.
   */
  dll: string
  /** seconds between snapshots the script writes */
  interval: number
  /**
   * the footer's index rows on this route, as SKCOM 商品代號. 群益's manual
   * documents no index codes, so the defaults were found by dumping
   * `SKQuoteLib_RequestStockList` and checked against the exchange's own MIS
   * feed (2026-09-18: TSEA 47004.27 vs t00 47001.67, OTCA 409.11 vs o00
   * 409.12). `TSE01` is NOT 加權指數 - it is 水泥類股. The script still
   * probes each code at startup and drops what does not resolve instead of
   * writing a zero, and `--check` prints which ones answered. `[]` turns the
   * index board off for this route.
   */
  indices: { code: string; name: string }[]
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function str(value: unknown, fallback: string): string {
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

export function defaultConfig(): Config {
  return {
    market: 'auto',
    refreshMs: DEFAULT_REFRESH_MS,
    chartRows: DEFAULT_CHART_ROWS,
    // no `sort` key here on purpose - see Config.sort's own comment. Each
    // market names its own default (MARKETS[id].defaultSort) instead of one
    // hardcoded value that would be wrong for either crypto or tw/us.
    highlight: true,
    columns: 'auto',
    feed: 'auto',
    twSources: ['yahoo'],
    feedMs: FEED_MS_DEFAULT,
    pageMs: PAGE_MS_DEFAULT,
    twIndices: TW_INDICES,
    animation: 'full',
    countdown: true,
    lists: { tw: TW_LIST, us: US_LIST, tf: [], crypto: CRYPTO_LIST },
    droppedFutures: [],
    cryptoConfigured: false,
    shioaji: { python: 'python3', env: '~/.sinobon.env', interval: 10 },
    capital: {
      python: 'python',
      env: '~/.capital.env',
      dll: '',
      interval: 10,
      indices: [
        { code: 'TSEA', name: 'TAIEX' },
        { code: 'OTCA', name: 'TPEx' },
      ],
    },
    // crypto holdings have no broker-fetcher route (see feedCrypto) - the
    // key only exists so Config.holdings stays a total Record<MarketId, ...>
    // and a hand-written config can still opt in through the manual
    // `holdings` block the same way tw/us do. tf's come from the fetcher's
    // own futures-holdings.json, never a config block.
    holdings: { tw: [], us: [], tf: [], crypto: [] },
    holdingsSource: 'file',
    // `tabbar`, this fork's own tab row (issue #9) - see MarketSwitcher and
    // forkStops(). Upstream's default is `select`, the dropdown: it collapses
    // to about 12 columns, the same order as `cycle`, and it shows every
    // stop at once when opened rather than making a person walk the ring to
    // find out what exists.
    //
    // Upstream measured its `tabs` style on a real 100-column terminal
    // (2026-09-19): the tabs row needs 30 columns, and the header line it
    // shares already spends about 36 on the session state, the market hours
    // and the Taipei restatement, on top of RIGHT_BUTTON_GROUP_COLS. That
    // totals ~106, so `tabs` fits only a terminal wider than most, and at
    // 100 it silently drops the Taipei hours instead. `tabbar` answers the
    // same squeeze the other way round: its Buttons are `plain` (no chrome)
    // and the notes give way first, never a tab. `tabs` stays available for
    // a wide terminal, `cycle` for a narrow one - and `cycle` is what
    // `select` falls back to wherever the surface has no Select element
    // (mobile). See MarketSwitcher.
    marketSwitcher: 'tabbar',
  }
}

/** how the table view is drawn - board.tsx's BoardLayout, settled here (see fitBand) */
export type BoardLayout = 'full' | 'compact' | 'ticker'

/** what one draw settled on from the host's `maxRows`/`bodyColumns` (#13); the board draws exactly this */
export type Fit = {
  /** false on a stub host with no `maxRows`: the fixed pre-#13 sizes, so the dev harnesses stay byte-identical */
  adaptive: boolean
  /** rows the band may take below the button row; only read when adaptive */
  rows: number
  layout: BoardLayout
  /** quote rows the table draws (1..5); the ticker draws one */
  quoteRows: number
  /** holding rows the 損益 view draws (1..5) */
  pnlRows: number
  /** the chart's height, cfg.chartRows clamped to the band, never under CHART_ROWS_MIN */
  chartRows: number
  /** symbol columns the width holds (1..MAX_COLUMNS) */
  widthColumns: number
  /** `代號 價格 ▲pct` cells one ticker line holds */
  tickerCells: number
}

/**
 * `rows = maxRows - 1` (the button row). Table: header + rule + q + footer,
 * q = rows - 3 capped at 5; at rows <= 4 that leaves one quote row or none,
 * so the titles move onto the rule and the footer into the button row
 * (q = rows - 1); rows <= 2 is the one-line ticker. 損益 needs 4 rows and the
 * chart 8 (#12's clamp) - under that ui.render falls back to the ticker.
 */
export function fitBand(cfg: Config, maxRows: number, cols: number): Fit {
  // n columns need n * 35 + (n - 1) * 6 of `cols - 1` (board.tsx's half
  // width and gutter), i.e. n * 41 <= cols + 5: 77 columns fit two, 118 three
  const widthColumns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor((cols + 5) / COLUMN_MIN_COLS)))
  const tickerCells = Math.max(1, Math.floor((cols - 1) / TICKER_CELL_COLS))
  if (maxRows <= 0) {
    return {
      adaptive: false,
      rows: 0,
      layout: 'full',
      quoteRows: TABLE_QUOTE_ROWS,
      pnlRows: TABLE_QUOTE_ROWS,
      chartRows: cfg.chartRows,
      widthColumns,
      tickerCells,
    }
  }
  const rows = maxRows - 1
  const layout: BoardLayout = rows <= 2 ? 'ticker' : rows <= 4 ? 'compact' : 'full'
  const quoteRows = layout === 'full' ? Math.min(TABLE_QUOTE_ROWS, rows - TABLE_CHROME_ROWS) : layout === 'compact' ? rows - 1 : 1
  return {
    adaptive: true,
    rows,
    layout,
    quoteRows,
    pnlRows: Math.max(1, Math.min(TABLE_QUOTE_ROWS, rows - PNL_CHROME_ROWS)),
    chartRows: Math.max(CHART_ROWS_MIN, Math.min(cfg.chartRows, maxRows - 2)),
    widthColumns,
    tickerCells,
  }
}

/**
 * `"auto"` = the fewest columns that hold the list in the band's quote rows;
 * explicit or auto, capped by the width so the page matches what the board
 * can draw. A stub host keeps the pre-#13 rule (two columns past five symbols).
 */
export function effectiveColumns(cfg: Config, listLength: number, fit: Fit): number {
  if (!fit.adaptive) return cfg.columns === 'auto' ? (listLength > TABLE_QUOTE_ROWS ? 2 : 1) : cfg.columns
  const want = cfg.columns === 'auto' ? Math.ceil(listLength / fit.quoteRows) : cfg.columns
  return Math.max(1, Math.min(want, fit.widthColumns))
}

/**
 * The markets one feed tick prices, given where the band is pointed right
 * now. `tf` rides along whenever the config lists futures, whatever is on
 * screen: it costs no HTTP request, and the 永豐 fetcher must not die every
 * night just because 美股 (21:30-04:00) is the market on the band. Whether
 * its session is open is marketNeedsFeed's call.
 */
export function feedMarkets(cfg: Config, market: MarketId): MarketId[] {
  if (cfg.feed === 'off') return []
  // `both` stays tw+us only - it predates crypto and means "keep both
  // traditional markets warm for an instant switch", not "everything this
  // config could ever show". Crypto still gets fetched whenever it is
  // actually on screen, through the `auto` branch right below - `market`
  // carries whatever pickMarket resolved, which is 'crypto' outright once
  // `config.market` names it (see pickMarket's mode !== 'auto' branch).
  const markets: MarketId[] = cfg.feed === 'both' ? ['tw', 'us'] : cfg.feed === 'auto' ? [market] : [cfg.feed]
  if (hasFutures(cfg) && !markets.includes('tf')) markets.push('tf')
  return markets
}

/**
 * Symbols the feed fetches per market on top of the watchlist: the holdings
 * that are not on it (register.tsx's feedList / holdingExtras). They ride the
 * same batched requests, so they can tip a list into a second batch.
 */
export type FeedExtras = Partial<Record<MarketId, number>>

/** what one market costs per tick, before the chart view's own bar fetch is added */
function marketRequests(cfg: Config, market: MarketId, extras: FeedExtras = {}): number {
  if (market === 'tf') return 0 // 永豐 only, never an HTTP request from this module
  if (market === 'us') return Math.ceil((cfg.lists.us.length + (extras.us ?? 0) + US_INDICES.length) / SPARK_BATCH)
  // Pionex's ticker endpoint answers the whole exchange in one request
  // whatever the watchlist length - `symbol=A,B` does not batch (verified
  // 2026-09-18, see PIONEX_TICKERS_URL) so feedCrypto pulls everything and
  // filters locally instead of paying per symbol.
  if (market === 'crypto') return 1
  // A tick tries `twSources` in order and can fall through to any of them,
  // so it costs the dearest route listed: Yahoo pays per batch of the
  // watchlist plus holdings plus the index; MIS answers the whole list and
  // both indices in one call whatever its length; a broker route (shioaji,
  // capital) costs this module no HTTP request at all.
  const cost = (source: TwSourceName): number =>
    source === 'yahoo'
      ? Math.ceil((cfg.lists.tw.length + (extras.tw ?? 0) + 1) / SPARK_BATCH)
      : source === 'mis'
        ? 1
        : 0
  return Math.max(0, ...cfg.twSources.map(cost))
}

/**
 * How many requests one feed tick costs, at its worst. `auto` prices one
 * market at a time, so it costs the dearer of the two rather than the sum;
 * `both` really does pay for both. Crypto is folded into the `auto`/pinned
 * max here for completeness (feedMarkets already routes to it whenever
 * `market` names it - see feedMarkets), even though its cost is a fixed 1
 * and so never actually changes which side of the max wins.
 */
export function requestsPerTick(cfg: Config, extras: FeedExtras = {}): number {
  if (cfg.feed === 'off') return 0
  const tw = marketRequests(cfg, 'tw', extras)
  const us = marketRequests(cfg, 'us', extras)
  const crypto = marketRequests(cfg, 'crypto', extras)
  return cfg.feed === 'both' ? tw + us : cfg.feed === 'tw' ? tw : cfg.feed === 'us' ? us : Math.max(tw, us, crypto)
}

/**
 * `feedMs` is an interval, and an interval alone does not bound the request
 * rate: 15 s with a 20-symbol Yahoo-fed list is 240 requests an hour against a
 * ceiling around 360, and `both` doubles that. The floor here turns the
 * budget into an interval, so no config can get the host banned.
 */
export function feedInterval(cfg: Config, extras: FeedExtras = {}): number {
  const budgetFloor = Math.ceil((requestsPerTick(cfg, extras) * 3_600_000) / REQUESTS_PER_HOUR)
  return Math.max(cfg.feedMs, FEED_MS_MIN, budgetFloor)
}

/** reads text as a JSON object, or undefined for anything that is not one - malformed, missing, or a non-object */
export function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/**
 * `capital.indices` -> the `{code, name}` rows the 群益 fetcher gets on its
 * `--indices` flag. A row with no `code` is dropped rather than passed on as
 * an empty symbol the SDK would silently ignore; `name` falls back to the
 * code so the footer never flaps a blank drum.
 */
function parseCapitalIndices(value: unknown[]): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = []
  for (const raw of value) {
    const entry = asRecord(raw)
    const code = str(entry?.code, '')
    if (!code) continue
    out.push({ code, name: str(entry?.name, code) })
  }
  return out
}

const TW_SOURCE_NAMES: TwSourceName[] = ['shioaji', 'capital', 'yahoo', 'mis']

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
export function parseConfigRoot(root: Record<string, unknown> | undefined): Config {
  const cfg = defaultConfig()
  if (!root) return cfg
  const market = str(root.market, 'auto')
  if (market === 'tw' || market === 'us' || market === 'tf' || market === 'crypto' || market === 'auto') cfg.market = market
  cfg.refreshMs = Math.max(1000, num(root.refreshMs, cfg.refreshMs))
  cfg.chartRows = Math.max(CHART_ROWS_MIN, Math.floor(num(root.chartRows, cfg.chartRows)))
  // any of the four is an explicit choice and overrides the per-market
  // default outright, same as every other field here - an absent/invalid
  // `sort` leaves cfg.sort unset, so effectiveSort() falls through to
  // MARKETS[market].defaultSort instead.
  if (root.sort === 'change' || root.sort === 'list' || root.sort === 'marketcap' || root.sort === 'volume') {
    cfg.sort = root.sort
  }
  if (root.highlight === false) cfg.highlight = false
  if (root.columns === 1 || root.columns === 2 || root.columns === 3 || root.columns === 4 || root.columns === 'auto') {
    cfg.columns = root.columns
  }
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
  const capital = asRecord(root.capital)
  if (capital) {
    cfg.capital = {
      python: str(capital.python, cfg.capital.python),
      env: str(capital.env, cfg.capital.env),
      dll: str(capital.dll, cfg.capital.dll),
      interval: Math.max(0, num(capital.interval, cfg.capital.interval)),
      // an array present but empty means "no index rows", the same way an
      // empty twSources means "nothing stated but yahoo" - so this only
      // falls back to the defaults when the key is absent entirely
      indices: Array.isArray(capital.indices) ? parseCapitalIndices(capital.indices) : cfg.capital.indices,
    }
  }
  cfg.feedMs = Math.max(FEED_MS_MIN, num(root.feedMs, cfg.feedMs))
  // 0 turns auto-paging off and leaves the `p` button as the only way to page
  const pageMs = num(root.pageMs, cfg.pageMs)
  cfg.pageMs = pageMs <= 0 ? 0 : Math.max(PAGE_MS_MIN, pageMs)
  if (root.animation === 'off' || root.animation === false) cfg.animation = 'off'
  if (root.countdown === false) cfg.countdown = false
  const futures = parseFutures(root.futures)
  cfg.lists = {
    tw: parseList(root.tw, TW_LIST),
    us: parseList(root.us, US_LIST),
    tf: futures.list,
    crypto: parseList(root.crypto, CRYPTO_LIST),
  }
  cfg.droppedFutures = futures.dropped
  // a `crypto` key of any shape is an opt-in (parseList falls back to the
  // built-in list for a bad one, so the tab still has something to draw),
  // and so is pinning the band to it - see Config.cryptoConfigured
  cfg.cryptoConfigured = root.crypto !== undefined || cfg.market === 'crypto'
  cfg.twIndices = parseTwIndices(root.twIndices)
  const holdings = asRecord(root.holdings)
  cfg.holdings = {
    tw: parseHoldingsList(holdings?.tw),
    us: parseHoldingsList(holdings?.us),
    tf: [], // 期貨庫存 comes from the fetcher's own file (T6), not a config block
    crypto: parseHoldingsList(holdings?.crypto),
  }
  if (root.holdingsSource === 'config') cfg.holdingsSource = 'config'
  const marketSwitcher = root.marketSwitcher
  if (marketSwitcher === 'tabbar' || marketSwitcher === 'tabs' || marketSwitcher === 'select' || marketSwitcher === 'cycle') {
    cfg.marketSwitcher = marketSwitcher
  } // anything else (including the default '貓'-style typo) keeps defaultConfig()'s 'tabbar'
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
export function parseHoldingsList(value: unknown): Holding[] {
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
