/* @jsx h */
import type { Register } from 'claude-code'
import { BARS_MAX_AGE_MS, BARS_STALE_MS, CHART_BARS, COINGECKO_MARKETS_URL, CONFIG_PATH, CRYPTO_COOLDOWN_MS, CRYPTO_LOW_TOKENS, CRYPTO_SUPPLY_COOLDOWN_MS, CRYPTO_SUPPLY_TTL_MS, FEED_BACKOFF_MAX_MS, HOLDINGS_PATH, IN_FLIGHT_STUCK_MS, PIONEX_TICKERS_URL, PNL_CHROME_ROWS, QUOTES_PATH, QUOTE_STALE_MS, REQUESTS_PER_HOUR, SNOOZE_MS, SPARK_BATCH, TABLE_CHROME_ROWS, TW_YAHOO_INDEX, USER_CONFIG_REL, US_INDEX_SYMBOL, US_INDICES, runtimeDir } from './constants.ts'
import { CRYPTO_COINGECKO_ID, MARKETS, currentSession, hasFutures, hhmm, lastCloseAt, localParts, phaseOf, pickMarket, sessionNote, taipeiNote } from './markets.ts'
import type { MarketId, MarketMode, MarketSwitcher, Phase, SortKey, Ticker, TwSourceName, View } from './markets.ts'
import { PNL_SORT_KEYS, PNL_SORT_LABELS, TIMEFRAMES, demoBars, demoPrice, quoteRow, roundPrice, sortHoldings } from './quotes.ts'
import type { Bar, ChartMode, FileQuote, IndexRow, PnlSortKey, PricedHolding, QuoteRow, Timeframe } from './quotes.ts'
import { asRecord, defaultConfig, effectiveColumns, feedInterval, feedMarkets, fitBand, num, parseConfigRoot, parseJsonRecord, requestsPerTick, str } from './config.ts'
import type { BoardLayout, Config, FeedExtras, Fit } from './config.ts'
import { holdingsFor, parseHoldingsFile, parseQuotes, pricedHoldings } from './files.ts'
import type { HoldingsFile, QuotesFile } from './files.ts'
import { FEED_HEADERS, chartUrl, misChannel, misUrl, parseChartBars, parseMis, parseSpark, pionexSymbol, sparkUrl, yahooSymbol } from './feeds.ts'
import { DIM, MARKET_SELECT_LABEL, MOON, MOON_BLUE, ORANGE, RIGHT_BUTTON_GROUP_COLS, SELECT_LABEL_CHROME_COLS, SUN, buildCycle, cycleButtonLabel, dispWidth, forkTabLabel, marketButtonLabel, marketSelectOptions, nextCycleStop, sameStop, stopOf, tabKey, tabLabel, tabRowWidth, tabsGroupWidth } from './switcher.ts'
import type { CycleStop, MarketSelectValue, MarketStop } from './switcher.ts'
import type { BoardProps as ClientBoardProps } from './board.tsx'

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
// the exchange's own real-time intraday endpoint (`mis`), 永豐's real-time
// feed (`shioaji`, macOS/Linux) or 群益's (`capital`, Windows) first, falling
// through to the next entry for a tick that source has nothing fresh for; the
// shipped default is `["yahoo"]` alone. A market the feed cannot reach at all
// falls back to a deterministic sine walk off each symbol's previous close,
// and the footer then says 示範資料 rather than pretending.
// Machine-written quotes and holdings live under the user's home directory
// now (see runtimeDir in constants.ts), never in the project's `.claude/`. Quotes read
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
// The rest of the band lives next to this file, imported below:
//   constants.ts - paths, timings, endpoints, index symbols
//   markets.ts   - markets, watchlists, trading sessions, pickMarket
//   quotes.ts    - quote/holding shapes, the demo walk, the 損益 sort
//   config.ts    - stock-band.json parsing, fitBand, the request budget
//   files.ts     - the quotes/holdings files
//   feeds.ts     - endpoint URLs and response parsers (no requests)
//   switcher.ts  - the market tab row
// This file keeps the module state, buildProps and the three hooks (the one
// other piece of state is files.ts's per-file parse cache).
// board.tsx is the Client surface and is never imported at runtime.
//
// Never name a local variable `h`: every JSX tag in this file compiles to h(...).

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

/** what the feed fetches for a market: the watchlist UNION the holdings not on it */
function feedList(market: MarketId): Ticker[] {
  return [...config.lists[market], ...holdingExtras(market, config.lists[market], config)]
}

/**
 * What the request budget has to pay for beyond the config: the symbols
 * holdings add on top of each watchlist, and (given `now`) the HTTP routes
 * backed off right now, which a tw tick falls through past.
 */
function feedExtras(now?: number): FeedExtras {
  const down = now === undefined ? [] : (['yahoo', 'mis'] as const).filter(host => now < feedBackoff[host].skipUntil)
  return {
    tw: holdingExtras('tw', config.lists.tw, config).length,
    us: holdingExtras('us', config.lists.us, config).length,
    down: [...down],
  }
}

/**
 * The home directory every `~` and every runtime path resolves against.
 * `$HOME` first, `%USERPROFILE%` second: Windows does not set `HOME` for a
 * normal process, and without the fallback runtimeDir() would put one
 * person's live prices and PID file inside the project's own `.claude/` -
 * exactly what the runtime dir exists to prevent. `scripts/fetch-quotes-
 * capital.py`'s user_home() reads the same two, in the same order.
 */
async function userHome($: { env: { get(name: string): Promise<string | undefined> } }): Promise<string> {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
}
// Stays in this file: the engine follows $ only into a function declared in
// the same file as the hook, never across an import (`claude plugin validate`).

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
  /** symbols a table row holds (1..4, see effectiveColumns()), or cells on the ticker line */
  columns: number
  /** how the board draws this view - board.tsx's BoardLayout; see fitBand */
  layout: BoardLayout
  /** data rows the board draws in this view: quote rows (table) or holding rows (損益) */
  quoteRows: number
  /** rows the Client is tall in this view - what `height=` gets */
  boardRows: number
  view: View
  focus: number
  barLabel: string
  sessionOpen: string
  sessionClose: string
  /** rows the chart view draws, already clamped to the band (see ui.render) */
  chartRows: number
  chartMode: ChartMode
  /** the timeframes the focused row's file offers; empty hides the buttons (stocks, 4-element bars) */
  timeframes: Timeframe[]
  timeframe: Timeframe
  /** the market's UTC offset in hours, so the board can print bar timestamps market-local */
  utcOffsetHours: number
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

// Compile time only: the props buildProps hands the Client have to fit what
// board.tsx declares it reads - a field renamed or retyped on either side
// fails `tsc` (scripts/dev/run-checks.sh, typecheck) instead of reaching the
// board as undefined. Erased from the module; board.tsx is never imported at
// runtime.
type Assert<T extends true> = T
export type BoardPropsFitClient = Assert<BoardProps extends ClientBoardProps ? true : false>

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

/**
 * `cfg.sort`'s effective value for the market actually on screen. An unset
 * `cfg.sort` (the common case - see Config.sort's comment) falls back to
 * that market's own default. An explicit `'volume'`/`'marketcap'` still
 * needs data only crypto carries (Pionex's `amount`, CoinGecko's supply
 * cache) - on tw/us it falls back to `'change'` instead of drawing the list
 * unsorted (there is no meaningful "unset" fallback that both markets share).
 */
function effectiveSort(cfgSort: SortKey | undefined, market: MarketId): SortKey {
  const wanted = cfgSort ?? MARKETS[market].defaultSort
  if ((wanted === 'volume' || wanted === 'marketcap') && market !== 'crypto') return 'change'
  return wanted
}

/**
 * price(live, this tick) x circulating supply(CoinGecko, cached - see
 * cryptoSupply/fetchCryptoSupply). A code with no cached supply (a coin
 * added to CRYPTO_LIST without a matching CRYPTO_COINGECKO_ID entry, or one
 * CoinGecko never priced) reads 0 - it sorts to the bottom rather than
 * crashing or dropping off the list.
 */
function marketCapOf(q: QuoteRow): number {
  return q.price * (cryptoSupply[q.code] ?? 0)
}

function buildProps(
  now: number,
  cfg: Config,
  quotesFile: QuotesFile | undefined,
  mode: MarketMode,
  view: View,
  /** which code the chart view is following; undefined or off-screen falls back to position 0 */
  focusCode: string | undefined,
  /** what the render hook settled the band's size on (see fitBand); a stub host's fixed sizes when absent */
  fit: Fit = fitBand(cfg, 0, 80),
  /** how this view is drawn: the ticker when the view cannot fit (see ui.render), else fit's own */
  layout: BoardLayout = view === 'table' ? fit.layout : 'full',
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
        ...quoteRow(
          { ...sym, name },
          fromFile.price,
          prevClose,
          fromFile.bars,
          quotesFile?.prev?.[sym.code]?.price,
          fromFile.amount,
        ),
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

  const sort = effectiveSort(cfg.sort, market)
  if (sort === 'change') {
    quotes.sort((a, b) => b.pct - a.pct)
  } else if (sort === 'volume') {
    // Pionex's `amount` is 24h turnover in USDT - `volume` (not used here)
    // is the coin's own unit count, and DOGE's ~800M coins next to BTC's
    // ~40K would rank purely on which coin happens to be cheap, not which
    // one actually trades the most money. `amount` is the apples-to-apples
    // number (see QuoteRow.amount).
    quotes.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
  } else if (sort === 'marketcap') {
    if (Object.keys(cryptoSupply).length > 0) {
      quotes.sort((a, b) => marketCapOf(b) - marketCapOf(a))
    } else {
      // CoinGecko has never answered this session (or its cache is still
      // empty) - market cap cannot be computed at all yet, so this falls
      // back to volume, the next-best liquidity ranking, rather than
      // leaving `quotes` in whatever order `list` happened to name them.
      // fetchCryptoSupply logs this once (cryptoSupplyWarned) - not here,
      // since buildProps runs every render and must stay side-effect free.
      quotes.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    }
  }
  // sort === 'list': no sort, the watchlist's own order stands.

  // One page is `quoteRows × columns` symbols - the rows the band has (see
  // fitBand) times the columns effectiveColumns() picks - or, on the ticker,
  // the cells one line holds. One page is on the board and the rest wait
  // their turn, the way a departures board shows the next five flights
  // rather than growing.
  const columns = layout === 'ticker' ? fit.tickerCells : effectiveColumns(cfg, list.length, fit)
  const quoteRows = layout === 'ticker' ? 1 : fit.quoteRows
  const perPage = quoteRows * columns
  const pages = Math.max(1, Math.ceil(quotes.length / perPage))
  lastPageCount = pages

  // The chart view follows a CODE, not a page: `page` only moves through
  // setPage (a table page turn) or autoPage, and autoPage freezes itself the
  // moment view !== 'table' (see autoPage). With `sort !== 'list'` (change,
  // volume, or marketcap) `quotes` re-sorts every render, so the focused
  // code's rank - and so its page - can drift out from under a `page` that
  // nothing is moving. This jumps `page` straight to wherever the code
  // actually sits, before `shown` is sliced, so the chart never reads a
  // foreign row off a stale page. It
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
    // `sort !== 'list'` the list re-sorts every render, so a rank
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
    // drawn for THIS market - onSelectMarket can switch markets without a page turn
    // or a pnl turn (see `lastShownMarket` above), and a stale other-market
    // `lastShown` would compare AAPL's row against 2330's row on nothing more
    // than shared position. Gated on `quotesFile` too: with no quotes file
    // the whole page is priced by demoPrice()'s continuous sine walk, whose
    // pct keeps drifting by a hair every render - with `sort === 'change'`
    // that alone reshuffles two close-ranked rows on almost every
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
  // freshly re-sorted every render when `sort !== 'list'`, so the code
  // a position held last render is not the code it holds this render. A
  // stale position would follow whatever rank crossed into that slot
  // instead of the symbol the chart is actually supposed to be following.
  // The page-follow jump above already moved `page` onto focusCode's own
  // page whenever the code is still in the list, so `findIndex` returning -1
  // here means focusCode is unset or the code was removed from the list
  // entirely - either way this falls back to position 0 via `Math.max`.
  const focusIdx = Math.max(0, shown.findIndex(q => q.code === focusCode))
  let barLabel = quotesFile?.barLabel ?? (usedFile ? 'K 棒' : 'K 棒（示範）')
  let timeframes: Timeframe[] = []
  if (view === 'chart' && shown.length > 0) {
    const q = shown[focusIdx]
    if (!usedFile && market !== 'tf' && (q.bars?.length ?? 0) < CHART_BARS) {
      const sym = list.find(t => t.code === q.code)
      if (sym) q.bars = demoBars(sym, now, CHART_BARS)
    }
    // The file's barsBy never crosses into the board - only the one set the
    // timeframe picks does, the way only the focused row carries bars at all.
    const byTf = quotesFile?.quotes[q.code]?.barsBy
    if (byTf) {
      timeframes = TIMEFRAMES.filter(tf => byTf[tf])
      const picked = byTf[timeframe]
      if (picked) {
        q.bars = picked
        barLabel = /^\d+ 分 K/.test(barLabel) ? barLabel.replace(/^\d+ 分 K/, `${timeframe} 分 K`) : `${timeframe} 分 K`
      }
    }
  }

  // tf has no index feed: the footer shows 台指近 (TXFR1, else the first
  // contract) from the fresh file, and 0 with no file - never a demo walk.
  const tfIdxCode =
    market === 'tf' && usedFile && quotesFile ? (quotesFile.quotes.TXFR1 ? 'TXFR1' : Object.keys(quotesFile.quotes)[0]) : undefined
  const tfIdx = tfIdxCode ? quotesFile?.quotes[tfIdxCode] : undefined
  const tfPrev = tfIdx?.prevClose ?? 0
  const idxName = tfIdxCode ? (list.find(t => t.code === tfIdxCode)?.name ?? tfIdxCode) : conf.indexName
  const idxPct = tfIdx
    ? tfPrev > 0 ? ((tfIdx.price - tfPrev) / tfPrev) * 100 : 0
    : market === 'tf'
      ? 0
      : quotesFile?.index
        ? quotesFile.index.pct
        : conf.indexDrift + conf.indexAmp * Math.sin((2 * Math.PI * (now / 1000)) / 89)
  const idxValue = tfIdx ? tfIdx.price : quotesFile?.index ? quotesFile.index.value : conf.indexClose * (1 + idxPct / 100)
  const idxChange = tfIdx ? tfIdx.price - tfPrev : quotesFile?.index ? quotesFile.index.change : idxValue - conf.indexClose

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
  const pnlRows = fit.pnlRows
  const maxScroll = Math.max(0, priced.length - pnlRows)
  const holdingsScroll = Math.max(0, Math.min(maxScroll, pnlScroll))

  // A mount, a page move or a sort change flaps every visible row, the same
  // way a watchlist page turn does (PAGE_TURN_WINDOW_MS/pageFrom below) -
  // `pnlPageFrom` is that turn's "from" snapshot, keyed by ON-SCREEN
  // POSITION (0..pnlRows-1), which is what makes a row that changed WHICH holding
  // occupies it (a page/sort move) turn its symbol and name too, not just
  // its numbers - see PricedHolding.was and board.tsx's per-row flap.
  let pricedForDisplay = priced
  if (pnlPageFrom && now - pnlPageAt < PAGE_TURN_WINDOW_MS) {
    pricedForDisplay = priced.map((h, idx) => {
      const pos = idx - holdingsScroll
      const before = pos >= 0 && pos < pnlRows ? pnlPageFrom![pos] : undefined
      if (!before) return h
      return { ...h, was: { price: before.price, code: before.code, name: before.name } }
    })
  }
  lastPnlShown = pricedForDisplay.slice(holdingsScroll, holdingsScroll + pnlRows)

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
    index: { name: idxName, value: idxValue, change: idxChange, pct: idxPct },
    // Taiwan has one index and no feed, so it falls through to the single row
    // and the board's flip finds nothing to flip
    indices:
      quotesFile?.indices && quotesFile.indices.length > 0
        ? quotesFile.indices
        : [{ name: idxName, value: idxValue, change: idxChange, pct: idxPct }],
    // tf without a fresh file draws dashes, not fake prices - so the footer
    // must not say 示範 (nor blink a live dot) over them
    source: usedFile ? (quotesFile?.origin ?? 'file') : market === 'tf' ? 'file' : 'demo',
    sourceLabel: usedFile ? (quotesFile?.sourceLabel ?? '') : market === 'tf' ? '無報價' : '',
    version,
    highlight: cfg.highlight,
    sorted: sort === 'change',
    columns,
    layout,
    quoteRows: view === 'pnl' ? pnlRows : quoteRows,
    // the Client's height: the board draws exactly this many rows
    boardRows:
      view === 'chart'
        ? fit.chartRows
        : view === 'pnl'
          ? pnlRows + PNL_CHROME_ROWS
          : layout === 'full'
            ? quoteRows + TABLE_CHROME_ROWS
            : layout === 'compact'
              ? quoteRows + 1
              : 1,
    view,
    focus: focusIdx,
    barLabel,
    sessionOpen: hhmm(session.open),
    sessionClose: hhmm(session.close),
    chartRows: fit.chartRows,
    chartMode: chartModeBy[market],
    timeframes,
    timeframe,
    utcOffsetHours: conf.offset(now),
    now,
    // The full priced list, not just the page on screen: board.tsx slices it
    // itself for the rows it draws (holdingsScroll says where), but it
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
// override) is fresh - feedTwFetcher's own health signal, set every poll
let runtimeQuotesFresh = false
// same for the runtime-dir futures file - the tf route's only health signal
let futuresQuotesFresh = false
/**
 * Per-route spawn bookkeeping for the broker fetchers (`shioaji`,
 * `capital`), keyed by route name because a config may list both and each
 * gets its own clocks. See feedTwFetcher for what each field gates:
 * - `lastSpawn`: when this session last launched that route's script, so it
 *   is never re-launched more than once a minute (spawnFetcher). The tf
 *   route shares the shioaji entry: one script serves both markets, and
 *   whichever asked first fixes its argv - see spawnFetcher.
 * - `warned`: true once the "this route isn't pricing anything" warning has
 *   been logged, which happens at most once per session per route.
 * - `pidSeenAt`: when this session FIRST saw a pidfile it did not itself
 *   spawn (a prior session's leftover, or a fetcher already running before
 *   this session polled) - that discovery gets its own 60s grace clock
 *   instead of being treated as having been alive since forever.
 */
type FetcherState = { lastSpawn: number; warned: boolean; pidSeenAt: number }
const fetcherState: Record<string, FetcherState> = {}
function fetcherStateFor(route: string): FetcherState {
  return (fetcherState[route] ??= { lastSpawn: 0, warned: false, pidSeenAt: 0 })
}
// the feed's last good snapshot per market, with the one before it for the
// turn. Keyed by market because a snapshot must never reach the other board:
// US prices under 加權指數 would be worse than no prices at all.
let liveBy: Partial<Record<MarketId, { file: QuotesFile; prev?: Record<string, FileQuote> }>> = {}
// The file slots' own "last snapshot", per market: a file-driven market
// (tf always; tw/us whenever a fetcher's file wins) has no liveBy entry, so
// without this the rows would jump to a new price instead of flapping to it.
// `prev` is the quotes the current file replaced - what the rows flap FROM.
let fileSeen: Partial<Record<MarketId, { asOf: number; quotes: Record<string, FileQuote>; prev?: Record<string, FileQuote> }>> = {}

/**
 * Notes a new file snapshot per market and starts one turn for it: the
 * previous file's quotes become that market's `prev`, and `turnSeq` bumps
 * exactly once for a changed asOf, never for a re-read of the same file.
 */
function noteFileSnapshots(): void {
  for (const market of Object.keys(quotesFiles) as MarketId[]) {
    const file = quotesFiles[market]
    if (!file) continue
    const seen = fileSeen[market]
    if (seen?.asOf === file.asOf) continue
    fileSeen[market] = { asOf: file.asOf, quotes: file.quotes, prev: seen?.quotes }
    if (seen) turnSeq += 1
  }
}
// keyed `<market>:<code>`, since a Taiwan code and a US ticker share a namespace
let liveBars: Record<string, { bars: Bar[]; at: number }> = {}
// One exponential back-off per HTTP host, set by a failed answer or a network
// error and doubling each time. Per host, not shared: a Yahoo 429 must not
// stop 證交所 (or the reverse), and neither may hold the broker fetchers'
// respawn, which makes no HTTP request at all.
type FeedHost = 'yahoo' | 'mis'
// `okAt` is the tick of the host's last good answer: a failure reported by an
// older tick (one abandoned past IN_FLIGHT_STUCK_MS that errors late) says
// nothing about the host now and must not back it off again.
const feedBackoff: Record<FeedHost, { skipUntil: number; failures: number; okAt: number }> = {
  yahoo: { skipUntil: 0, failures: 0, okAt: 0 },
  mis: { skipUntil: 0, failures: 0, okAt: 0 },
}
// Requests out on each host, by the tick that sent them: one that has not
// answered in IN_FLIGHT_STUCK_MS backs its host off like an error would -
// a request that hangs without erroring used to leave the host un-backed-off.
const hostsInFlight = new Set<{ host: FeedHost; since: number }>()
// Crypto's own cooldown, separate from feedBackoff above:
// Pionex's 429 is a flat 60s block (see CRYPTO_COOLDOWN_MS), not something
// that should share Yahoo's exponential-doubling curve, and a Pionex outage
// must not stop tw/us from fetching (or the reverse) since they are
// different hosts with different limits.
let cryptoSkipUntil = 0
// last `x-ratelimit-tokens` reading, or undefined once it has been acted on
// (see feedCrypto) or before the first response ever lands.
let cryptoTokensRemaining: number | undefined
let cryptoLowTokensWarned = false // this session's one-time low-tokens log
// circulating supply per code (CRYPTO_COINGECKO_ID's keys), fetchCryptoSupply's
// own cache - see CRYPTO_SUPPLY_TTL_MS. Empty until the first successful
// CoinGecko answer; the marketcap sort branch in buildProps reads this
// directly and falls back to volume while it is empty.
let cryptoSupply: Record<string, number> = {}
let cryptoSupplyFetchedAt = 0 // 0 means "never fetched" - always due
let cryptoSupplyCooldownUntil = 0 // set after a failed/empty CoinGecko answer
let cryptoSupplyWarned = false // this session's one-time "falling back to volume" log
let cryptoUnmappedWarned = false // this session's one-time "no CoinGecko id for ..." log
let feedSeq = 0 // one per snapshot the feed accepted; drives the board's live dot
let nextFeedAt = 0 // when the next request is due; the board counts down to it
// The feed timer's period, fixed when session.start installs it (the timer
// cannot be re-armed), and when it last fired. The request budget
// (feedInterval) can outgrow that period later - holdings added mid-session
// widen what a tick fetches - so the budgeted requests (Yahoo, 證交所) keep
// their own clock: they go out on every `steps`-th timer period, steps =
// ceil(interval / period), counted from the last tick that sent them
// (httpTickAt). While the budget fits the timer, steps is 1: every tick.
// Everything else a tick does - the broker heartbeat, tf's respawn, crypto -
// runs every tick regardless.
let feedEvery = 0
let lastTimerAt = 0
let httpTickAt = 0
// The timer also carries the broker heartbeat, once a tick, and a broker
// fetcher quits once that is 90 s old (HEARTBEAT_MAX_AGE_MS in
// scripts/_common.py) - so however expensive the budget, the timer stays
// under this and the budget's steps space the requests out instead.
const FEED_TIMER_MAX_MS = 60_000
// when the K-bar request in flight started, 0 when none is - a time rather
// than a flag so a request that never settles cannot latch it forever (see
// IN_FLIGHT_STUCK_MS)
let barsInFlightSince = 0
// the render hook asks for the chart view's K bars; the feed owns the request
let requestBars: ((market: MarketId, code: string) => void) | undefined
// ...and asks for a whole tick when a tab lands on a market the
// feed has no snapshot for, so a switch does not sit on 示範資料 until the
// next scheduled tick comes round
let requestFeed: (() => void) | undefined
let feedInFlightSince = 0 // same convention as barsInFlightSince
let config: Config = defaultConfig()
let modeOverride: MarketMode | undefined
let snoozedUntil = 0
// the chart view walks the list one symbol at a time and then returns to the
// table, so one button covers both "show me the chart" and "next symbol"
let view: View = 'table'
// which code the chart view is following, not which position: `shown` gets
// re-sorted every render whenever `sort !== 'list'`, so a position would
// silently start following whatever rank crossed into it. undefined (never
// focused yet) and a code that fell off the current page both resolve to
// position 0 in buildProps (see `focusIdx`), and ui.render syncs this back
// to whatever code buildProps actually landed on after every render.
let focusCode: string | undefined
// the chart's bar width, one for the session; a row without barsBy ignores it
let timeframe: Timeframe = '5'
// K線 / 曲線, remembered per market for the session
const chartModeBy: Record<MarketId, ChartMode> = { tw: 'candle', us: 'candle', tf: 'candle', crypto: 'candle' }
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
// which market `lastShown` was drawn for. onSelectMarket can land buildProps on a
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
// below) has one number to add the page's rows to and wrap.
//
// Not wired to ui.scroll: tried it (0.9.0) and reverted it (0.9.1). The
// engine only raises ui.scroll for a band whose drawn tree is taller than
// `maxRows` - "The band's window over a tree taller than maxRows" (d.ts) -
// and this Client sizes itself to fit inside `maxRows` in every view (#13;
// before that it was a fixed 8 rows), so it never qualifies; confirmed on
// the real build with --debug, zero ui.scroll events reached this module
// however the wheel was driven. If a taller-than-maxRows tree ever exists
// here, that is the condition to satisfy before re-adding a scroll hook -
// not a sign this one was wired wrong.
let pnlScroll = 0
// whether the last draw fell back to the ticker (a band too short for the
// view - see ui.render): the ticker rotates through the list on pageMs
// whatever view the tab row says, so autoPage reads this beside `view`
let tickerFit = false
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
  if (now < snoozedUntil || (view !== 'table' && !tickerFit) || pageCount() < 2) {
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
    const prev = fileSeen[market]?.asOf === file.asOf ? fileSeen[market]?.prev : undefined
    return {
      ...file,
      quotes,
      ...(prev ? { prev } : {}),
      ...(barsFromYahoo && !file.barLabel ? { barLabel: YAHOO_BAR_LABEL } : {}),
    }
  }
  const snap = liveBy[market]
  if (!snap || !snapshotHolds(snap.file.asOf, now, market)) return undefined
  const { quotes } = withLiveBars(market, snap.file.quotes, now)
  return { ...snap.file, quotes, ...(snap.prev ? { prev: snap.prev } : {}) }
}

/** whether a market has anything for a pnl stop to show - the config's `holdings` block, or that market's holdings file */
function hasHoldings(market: MarketId, cfg: Config): boolean {
  return holdingsFor(market, holdingsFiles[market], cfg).holdings.length > 0
}

/**
 * The stops upstream's three switcher styles share - tabs, select and cycle
 * all draw/walk THIS list, never three separately maintained ones
 * (2026-09-19, at the upstream user's request: three interchangeable styles
 * to try, not three features). Order: 台股, [台股庫存], [台指期], [期貨庫存],
 * 美股, [美股庫存], 加密貨幣 - the 台指期 pair sits right after 台股, the
 * same neighbour it has on the fork's own tab row (forkStops). `label` here
 * is the FULL name (`美股庫存`), what `select`'s dropdown rows and `cycle`'s
 * button both read off MARKETS[id] directly - `tabs` shortens the holdings
 * stops on its own (see tabLabel) since its Buttons sit close enough
 * together that "belongs to the market on its left" reads from position
 * alone.
 *
 * A stock market's table stop is always present. Its `:pnl` stop only
 * exists when that market actually has holdings to show - `holdingsFor`
 * already covers all three sources (the config's own `holdings` block, the
 * holdings file, and which one wins per `holdingsSource` - see its own doc
 * comment), so this defers to it rather than re-deriving "does this market
 * have holdings" a second way. 台指期's table stop needs a `futures` list
 * and its 期貨庫存 stop a position in the fetcher's futures-holdings.json,
 * gated independently (a holdings-only user gets the pnl view and no empty
 * table). crypto never gets a `:pnl` stop at all, holdings or not: it has no
 * broker-fetcher route (see feedCrypto/holdingsFor), so a `crypto:pnl` stop
 * would draw and do nothing.
 *
 * (This used to be a module-level constant, computed once at load. A stop
 * this list decides not to include for a data reason - not a fixed
 * config/market count - has to be recomputed on every call: `holdingsFiles`
 * is module state that changes after the module loads (the holdings file
 * arrives on its own poll), so a value cached at load time would keep
 * showing a market's `:pnl` stop as absent (or present) long after the data
 * that decision was based on changed. 2026-09-19: an earlier version of this
 * mod DID gate the US holdings stop on data - `buildCycle()` took a
 * `hasUsHoldings` argument - but only for US, and a later refactor read that
 * asymmetry as accidental and dropped the whole condition rather than
 * extending it to tw. This restores the gate and, per the user's request,
 * applies it identically to both markets.)
 */
function marketStops(cfg: Config): MarketStop[] {
  return (['tw', 'tf', 'us', 'crypto'] as const).flatMap(id => {
    if (id === 'crypto') return [stopOf(id, false)]
    if (id === 'tf') {
      const out: MarketStop[] = []
      if (hasFutures(cfg)) out.push(stopOf(id, false))
      if (hasHoldings(id, cfg)) out.push(stopOf(id, true))
      return out
    }
    return hasHoldings(id, cfg) ? [stopOf(id, false), stopOf(id, true)] : [stopOf(id, false)]
  })
}

/**
 * The fork's own tab row (`tabbar`, issue #9), in order: 美股 → (美股庫存,
 * only when US holdings are configured - file or config) → 台股 → 台股庫存 →
 * (台指期, only when the config lists `futures`) → (期貨庫存, only when the
 * fetcher's futures-holdings.json holds a position - the two tf stops are
 * gated independently, so a holdings-only user gets the pnl view and no
 * empty table) → (加密貨幣, only when the config opted into crypto - see
 * Config.cryptoConfigured; the built-in list alone does not add a tab, the
 * same rule the 台指期 tab follows). The single source of which tabs exist:
 * the row is drawn from this list, so the row and the stops can never
 * disagree.
 * 台股庫存 is always a stop even with no holdings at all (it draws the "沒有
 * 庫存資料" hint row instead of disappearing - a tab that vanishes depending
 * on data would shift the row under the pointer). Rebuilt on every render
 * since holdings can change mid-session (a fresh stock-holdings.json write,
 * or /reload-plugins).
 */
function forkStops(cfg: Config): MarketStop[] {
  const stops: MarketStop[] = [stopOf('us', false)]
  if (hasHoldings('us', cfg)) stops.push(stopOf('us', true))
  stops.push(stopOf('tw', false), stopOf('tw', true))
  if (hasFutures(cfg)) stops.push(stopOf('tf', false))
  if (hasHoldings('tf', cfg)) stops.push(stopOf('tf', true))
  if (cfg.cryptoConfigured) stops.push(stopOf('crypto', false))
  return stops
}

/** the footer's clock + source tag for the button row (compact/ticker boards): board.tsx's names, minus version and credit */
function foldedFooter(props: BoardProps): string {
  const stamp = props.phase === 'open' ? props.clock : `收盤 ${props.clock}`
  const source =
    props.source === 'demo' ? '示範資料' : props.sourceLabel || (props.source === 'live' ? '即時報價' : '報價檔')
  return `${stamp} · ${source}`
}

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
    const home = await userHome($)
    const userConfigPath = home ? `${home}/${USER_CONFIG_REL}` : ''
    // Resolved once per session, same as userConfigPath: every runtime file
    // this module or a broker fetcher writes lives under `runtime`.
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
      const runtimeQuotes = parseQuotes(runtimeQuotesText, now, 'runtime')
      runtimeQuotesFresh = runtimeQuotes !== undefined
      quotesFiles = {}
      // the stock file drives crypto too (a file naming no market drove every
      // market before the tf split), so a hand-written override reaches it
      fillQuoteSlots(runtimeQuotes ?? parseQuotes(projectQuotesText, now, 'project'), ['tw', 'us', 'crypto'])
      const futuresQuotes = parseQuotes(futuresQuotesText, now, 'futures')
      futuresQuotesFresh = futuresQuotes !== undefined
      fillQuoteSlots(futuresQuotes, ['tf'])
      noteFileSnapshots()
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
      fillHoldingsSlots(parseHoldingsFile(runtimeHoldingsText) ?? projectHoldings, ['tw', 'us', 'crypto'])
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
    const backOff = (host: FeedHost, now: number, why: string) => {
      const b = feedBackoff[host]
      if (now < b.okAt) return // a stale tick's failure: the host has answered since
      b.failures += 1
      const wait = Math.min(config.feedMs * 2 ** b.failures, FEED_BACKOFF_MAX_MS)
      // an abandoned tick (see IN_FLIGHT_STUCK_MS) can fail long after a
      // newer one started - its old `now` must not pull the back-off earlier
      b.skipUntil = Math.max(b.skipUntil, now + wait)
      $.ui.log(`tw-stock-mod: feed ${why}, next try in ${Math.round(wait / 1000)}s`)
    }
    const backedOff = (host: FeedHost, now: number) => now < feedBackoff[host].skipUntil
    const recovered = (host: FeedHost, now: number) => {
      feedBackoff[host].failures = 0
      feedBackoff[host].okAt = Math.max(feedBackoff[host].okAt, now)
    }
    /** backs off every host with a request out longer than IN_FLIGHT_STUCK_MS - once per request */
    const backOffHung = (now: number) => {
      for (const req of hostsInFlight) {
        if (now - req.since < IN_FLIGHT_STUCK_MS) continue
        hostsInFlight.delete(req)
        backOff(req.host, now, `no answer in ${Math.round(IN_FLIGHT_STUCK_MS / 1000)}s`)
      }
    }

    /**
     * $.http.fetch, except a thrown request (DNS, refused connection, reset)
     * comes back as an Error instead of unwinding the whole tick - a throw
     * used to skip every market after the failing one and the next
     * `twSources` entry, and to leave the host un-backed-off. The caller logs
     * it, once, alongside what it does about it.
     */
    const safeFetch = async (
      url: string,
      init?: { headers?: Record<string, string> },
      track?: { host: FeedHost; now: number },
    ): Promise<Awaited<ReturnType<typeof $.http.fetch>> | Error> => {
      const req = track ? { host: track.host, since: track.now } : undefined
      if (req) hostsInFlight.add(req)
      try {
        return await $.http.fetch(url, init)
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err))
      } finally {
        if (req) hostsInFlight.delete(req)
      }
    }
    /** the `why` a failed safeFetch answer gets in the back-off log line */
    const failure = (res: Awaited<ReturnType<typeof $.http.fetch>> | Error, what: string) =>
      res instanceof Error ? `network error${what}: ${res.message}` : `HTTP ${res.status}${what}`

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
      // An abandoned tick (see IN_FLIGHT_STUCK_MS) that finally answers must
      // not replace what a newer tick already published with older prices.
      const have = liveBy[opts.market]
      if (have && have.file.asOf > opts.now) return
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
          change: roundPrice(row.price - prev),
          pct: prev ? ((row.price - prev) / prev) * 100 : 0,
        })
      }

      const idx = opts.parsed[opts.indexKey]
      const idxPrev = idx?.prevClose ?? idx?.price ?? 0
      feedSeq += 1
      turnSeq += 1
      nextFeedAt = nextFeedTickAt(opts.now, opts.market)
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
                change: roundPrice(idx.price - idxPrev),
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
        const res = await safeFetch(sparkUrl(batch, now + i), { headers: FEED_HEADERS }, { host: 'yahoo', now })
        if (res instanceof Error || !res.ok) {
          backOff('yahoo', now, failure(res, what))
          return undefined
        }
        const part = parseSpark(res.text)
        Object.assign(quotes, part.quotes)
        tradedAt = Math.max(tradedAt, part.tradedAt)
      }
      return { quotes, tradedAt }
    }

    const feedUs = async (now: number, due: boolean) => {
      if (!due || backedOff('yahoo', now)) return
      const list = feedList('us')
      const symbols = [...list.map(t => t.code), ...US_INDICES.map(i => i.symbol)]
      httpTickAt = now // this tick sends: the budget's clock restarts here
      const answer = await fetchSpark(symbols, now, '')
      if (!answer) return
      recovered('yahoo', now)
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

    /**
     * Crypto via Pionex's public ticker endpoint. One request answers every
     * symbol the exchange lists (~330), not just the watchlist's ten - see
     * PIONEX_TICKERS_URL for why `symbol=A,B` cannot do this in one request
     * either. Success is `result === true`, never the HTTP status: Pionex
     * answers its own errors as HTTP 200 with `result: false` (e.g.
     * MARKET_INVALID_SYMBOL), and treating that as quotes would draw a made-
     * up price - see docs/stock-api-notes.md §11.
     */
    const feedCrypto = async (now: number) => {
      if (cryptoTokensRemaining !== undefined && cryptoTokensRemaining < CRYPTO_LOW_TOKENS) {
        // Only skip once: without a fresh response there is no way to learn
        // the shared bucket refilled, and the measured refill (~10/s, back
        // to steady-state within 2s of idling - docs/stock-api-notes.md
        // §11.2) is far faster than this module's own tick interval, so
        // holding the skip past one tick would just wait for a request that
        // is never going to fire.
        cryptoTokensRemaining = undefined
        if (!cryptoLowTokensWarned) {
          cryptoLowTokensWarned = true
          $.ui.log('tw-stock-mod: crypto feed skipped one tick, rate-limit tokens were low (shared across this IP - not necessarily this module’s own usage)')
        }
        return
      }
      const list = feedList('crypto')
      if (list.length === 0) return
      const res = await safeFetch(PIONEX_TICKERS_URL)
      // a network error keeps the last snapshot like any other failure; no
      // cooldown, the same as a non-429 HTTP error below
      if (res instanceof Error) {
        $.ui.log(`tw-stock-mod: crypto feed network error (${res.message}), keeping the last snapshot`)
        return
      }
      const tokensHeader = res.headers?.['x-ratelimit-tokens']
      if (tokensHeader !== undefined) {
        const tokens = parseFloat(tokensHeader)
        if (Number.isFinite(tokens)) cryptoTokensRemaining = tokens
      }
      if (res.status === 429) {
        // A flat cooldown, not backOff()'s exponential one - see
        // CRYPTO_COOLDOWN_MS and cryptoSkipUntil's own comments for why
        // this stays separate from the Yahoo feed's shared state.
        cryptoSkipUntil = now + CRYPTO_COOLDOWN_MS
        $.ui.log(`tw-stock-mod: crypto feed 429'd, next try in ${Math.round(CRYPTO_COOLDOWN_MS / 1000)}s`)
        return
      }
      if (!res.ok) {
        $.ui.log(`tw-stock-mod: crypto feed HTTP ${res.status}, keeping the last snapshot`)
        return
      }
      let body:
        | {
            result?: boolean
            code?: string
            data?: { tickers?: { symbol: string; time: number; open: string; close: string; amount: string }[] }
          }
        | undefined
      try {
        body = JSON.parse(res.text)
      } catch {
        $.ui.log('tw-stock-mod: crypto feed answered invalid JSON')
        return
      }
      if (!body || body.result !== true || !body.data?.tickers) {
        $.ui.log(`tw-stock-mod: crypto feed answered result:false (${body?.code ?? 'unknown'}), keeping last snapshot`)
        return
      }
      const wanted = new Set(list.map(t => pionexSymbol(t.code)))
      const quotes: Record<string, FileQuote> = {}
      let tradedAt = 0
      for (const row of body.data.tickers) {
        // BTC always gets parsed even when it is not on the watchlist - it
        // doubles as the headline index below at no extra request, the way
        // tw/us ride ^TWII/^IXIC on their own batched fetch.
        if (!wanted.has(row.symbol) && row.symbol !== 'BTC_USDT') continue
        const price = parseFloat(row.close)
        // Pionex has no changePercent field and no "previous close" the
        // way tw/us have one - `open` here is the price 24 HOURS ago, not
        // yesterday's close. Feeding it into FileQuote's `prevClose` slot
        // makes quoteRow() (shared with every other market) compute a
        // 24-HOUR change from it - that is a real semantic difference from
        // tw/us's "change since the last close", not a shortcut, and it is
        // why this comment exists rather than just doing it silently.
        const open = parseFloat(row.open)
        if (!Number.isFinite(price) || !Number.isFinite(open)) continue
        // `amount` (24h turnover in USDT) drives the 'volume' sort -
        // deliberately NOT Pionex's `volume` field, which is the coin's own
        // unit count (see QuoteRow.amount/effectiveSort). Missing/malformed
        // just omits the key rather than publishing a fake 0 that would sort
        // as "no turnover at all".
        const amount = parseFloat(row.amount)
        quotes[row.symbol] = { price, prevClose: open, ...(Number.isFinite(amount) ? { amount } : {}) }
        // epoch ms, UTC-based - no timezone arithmetic needed, unlike the
        // error object's `timestamp` (seconds, and only present on failure)
        tradedAt = Math.max(tradedAt, row.time)
      }
      if (Object.keys(quotes).length === 0) {
        $.ui.log('tw-stock-mod: crypto feed answered nothing usable; keeping the last snapshot')
        return
      }
      cryptoSkipUntil = 0
      publish({
        market: 'crypto',
        list,
        parsed: quotes,
        keyOf: t => pionexSymbol(t.code),
        // crypto has no exchange-wide index the way tw/us do - BTC stands
        // in, parsed above whether or not it is on the watchlist
        indices: [],
        indexKey: 'BTC_USDT',
        tradedAt,
        now,
        sourceLabel: 'Pionex 即時',
        barLabel: '5 分 K',
      })
    }

    /**
     * Circulating supply for the market-cap sort, from CoinGecko - Pionex's
     * ticker has no such field at all (see CRYPTO_COINGECKO_ID's comment).
     * Called alongside feedCrypto on every crypto tick, but its own
     * TTL/cooldown make it a no-op almost every time: it only actually hits
     * CoinGecko once an hour (CRYPTO_SUPPLY_TTL_MS) or, after a failure,
     * once per cooldown (CRYPTO_SUPPLY_COOLDOWN_MS). Market cap itself still
     * updates every tick regardless, since buildProps computes it as
     * supply(cached here) x price(live from feedCrypto) rather than fetching
     * a market-cap number outright.
     *
     * Deliberately isolated from feedCrypto's own success/failure: this
     * never touches `liveBy`/`publish`, so a CoinGecko outage or rate-limit
     * cannot affect the prices on screen, only which sort key buildProps can
     * actually satisfy (see effectiveSort/the marketcap branch there).
     */
    const fetchCryptoSupply = async (now: number) => {
      if (now < cryptoSupplyCooldownUntil) return
      if (cryptoSupplyFetchedAt !== 0 && now - cryptoSupplyFetchedAt < CRYPTO_SUPPLY_TTL_MS) return
      // Same list feedCrypto itself fetches (watchlist + holdings extras) -
      // NOT the hardcoded CRYPTO_COINGECKO_ID map, or a user-added coin not
      // in that map would never even try CoinGecko and would just sort last
      // with no explanation why.
      const list = feedList('crypto')
      const unmapped = [...new Set(list.filter(t => !CRYPTO_COINGECKO_ID[t.code]).map(t => t.code))]
      if (unmapped.length > 0 && !cryptoUnmappedWarned) {
        cryptoUnmappedWarned = true
        $.ui.log(`tw-stock-mod: no CoinGecko id for ${unmapped.join(', ')} - market-cap sort puts them last`)
      }
      const ids = [...new Set(list.map(t => CRYPTO_COINGECKO_ID[t.code]).filter(Boolean))]
      if (ids.length === 0) return
      const warnOnce = () => {
        // Only warn while the cache is still empty - once a real fetch has
        // ever succeeded, buildProps has real market caps to sort by and a
        // later failure just means "keep using the last cache", nothing
        // worth interrupting the user about.
        if (Object.keys(cryptoSupply).length > 0) return
        if (cryptoSupplyWarned) return
        cryptoSupplyWarned = true
        $.ui.log('tw-stock-mod: market-cap data (CoinGecko) unavailable this session, sorting crypto by volume instead')
      }
      try {
        // per_page=250: measured 2026-09-19 that this endpoint's default
        // page is 100 rows, so 101+ ids would be silently truncated; 250 is
        // CoinGecko's documented max page size (unmeasured against a list
        // that large).
        const url = `${COINGECKO_MARKETS_URL}?vs_currency=usd&ids=${ids.join(',')}&per_page=250`
        const res = await $.http.fetch(url)
        if (!res.ok) {
          cryptoSupplyCooldownUntil = now + CRYPTO_SUPPLY_COOLDOWN_MS
          warnOnce()
          return
        }
        const body: unknown = JSON.parse(res.text)
        if (!Array.isArray(body)) {
          cryptoSupplyCooldownUntil = now + CRYPTO_SUPPLY_COOLDOWN_MS
          warnOnce()
          return
        }
        // keyed by CoinGecko `id` first (ripple, binancecoin, ...), since
        // that is what the answer itself carries - the second loop below
        // flips it back to OUR ticker code via CRYPTO_COINGECKO_ID.
        const supplyById: Record<string, number> = {}
        for (const raw of body) {
          const row = asRecord(raw)
          if (!row) continue
          const id = str(row.id, '')
          const supply = num(row.circulating_supply, NaN)
          if (id && Number.isFinite(supply)) supplyById[id] = supply
        }
        // Never name a local `next` anywhere inside this module: `next` is the
        // hook continuation every hook receives, and the engine REFUSES to
        // load a module that shadows it - "hooks module did not load ...
        // `next` (the continuation) is declared again (shadowed)". esbuild
        // and tsc both accept the shadow, and the dev harnesses import the
        // bundle directly rather than through the engine, so nothing in this
        // repo catches it before the real host does.
        const byCode: Record<string, number> = {}
        for (const [code, id] of Object.entries(CRYPTO_COINGECKO_ID)) {
          if (supplyById[id] !== undefined) byCode[code] = supplyById[id]
        }
        if (Object.keys(byCode).length === 0) {
          cryptoSupplyCooldownUntil = now + CRYPTO_SUPPLY_COOLDOWN_MS
          warnOnce()
          return
        }
        cryptoSupply = byCode
        cryptoSupplyFetchedAt = now
        cryptoSupplyCooldownUntil = 0
      } catch {
        cryptoSupplyCooldownUntil = now + CRYPTO_SUPPLY_COOLDOWN_MS
        warnOnce()
      }
    }

    // Taiwan via Yahoo. Returns whether it produced a usable snapshot THIS
    // tick - the dispatcher below (feedTw) reads that to decide whether to
    // fall through to the next entry in `config.twSources`.
    const feedTwYahoo = async (now: number, due: boolean): Promise<boolean | 'held'> => {
      // the budget has not come round yet: hold this tick, never fall through
      // to the next route for it (a healthy Yahoo would otherwise hand the
      // tick to a broker login)
      if (!due) return 'held'
      // backed off: "no snapshot this tick", so feedTw falls through to the
      // next `twSources` entry
      if (backedOff('yahoo', now)) return false
      const list = feedList('tw')
      if (list.length === 0) return false
      const symbols = [...list.map(t => yahooSymbol('tw', t)), TW_YAHOO_INDEX]
      httpTickAt = now // this tick sends: the budget's clock restarts here
      const answer = await fetchSpark(symbols, now, ' (台股)')
      if (!answer) return false
      recovered('yahoo', now)
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
    const feedTwMis = async (now: number, due: boolean): Promise<boolean | 'held'> => {
      if (!due) return 'held' // see feedTwYahoo
      if (backedOff('mis', now)) return false
      const list = feedList('tw')
      if (list.length === 0) return false
      // the first entry is the one the market is read by, so an empty list
      // would leave the board with no headline index at all - parseTwIndices
      // never returns one
      const indices = config.twIndices
      const channels = [...list.map(misChannel), ...indices.map(misChannel)]
      httpTickAt = now // this tick sends: the budget's clock restarts here
      const res = await safeFetch(misUrl(channels, now), { headers: FEED_HEADERS }, { host: 'mis', now })
      if (res instanceof Error || !res.ok) {
        backOff('mis', now, failure(res, ' (證交所)'))
        return false
      }
      const { quotes: parsed, tradedAt } = parseMis(res.text)
      if (Object.keys(parsed).length === 0) {
        backOff('mis', now, '證交所 answered nothing usable')
        return false
      }
      recovered('mis', now)
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
     * What one broker-fetcher route (`shioaji`, `capital`) needs in order to
     * be spawned and watched. Everything that differs between them lives
     * here; feedTwFetcher below holds the one copy of the heartbeat, respawn
     * and visible-failure rules they share.
     */
    type FetcherSpec = {
      /** the `twSources` name, and the key its spawn bookkeeping lives under */
      route: TwSourceName
      /** what a warning calls this route, in the band's own language */
      label: string
      /** the interpreter, and the script under the plugin root it runs */
      python: string
      script: string
      /** flags beyond the ones every fetcher takes (see feedTwFetcher) */
      extraArgs: string[]
      /** seconds between snapshots, passed straight through as --interval */
      interval: number
      /** where this route's output and its pid live, both inside the runtime dir */
      logPath: string
      pidPath: string
      /**
       * Wraps the finished argument list in whatever makes the script
       * OUTLIVE this call. `$.process.run` is one-shot and waits for the
       * child's stdout/stderr pipes to close as well as its exit, and a
       * long-lived daemon's pipes never close on their own - so each route
       * needs its own way to hand the real work to a process this call is
       * not attached to. See each spec below for which trick it uses.
       */
      wrap: (args: string[]) => string[]
    }

    /**
     * A `twSources` entry backed by a spawned script rather than an HTTP
     * endpoint - see the ShioajiConfig/CapitalConfig doc comments for why
     * neither SDK can run inside the hooks module directly. Returns
     * whether the runtime-dir quotes file is fresh (true = this tick is
     * covered, same convention as feedTwYahoo/feedTwMis): the script writes
     * that file asynchronously, on its own schedule, so "did this route price
     * Taiwan just now" can only ever mean "is the file it wrote still
     * fresh", never "did a request this module made just now succeed". This
     * checks the runtime-dir file specifically, never the project's
     * `.claude/stock-quotes.json` override - that file can stay fresh for
     * reasons that have nothing to do with the fetcher, and must never mask a
     * dead one from either this respawn check or the visible-failure
     * warning below.
     *
     * Respawn rule (spawnFetcher): once at session start (the first feed
     * tick), then only when the quotes file has gone stale (>120s, i.e. no
     * script is feeding it) AND the last spawn attempt was more than 60s ago
     * - so a script that is merely slow to log in is never spawned a second
     * time on top of itself, and a script that died is retried at most once
     * a minute. The heartbeat itself is feedOnce's (writeHeartbeat), written
     * before any route runs, so the script's first-tick exemption still
     * sees a fresh one.
     *
     * Both broker routes share one heartbeat file and one quotes file,
     * which is why listing both in `twSources` is pointless rather than
     * harmful: whichever one this machine can actually run wins, and the
     * other never writes.
     */
    const heartbeatPath = `${runtime}stock-band.heartbeat`

    /**
     * The one spawn path for a broker fetcher, whichever market asks first
     * (feedTwFetcher for 台股, feedTf for 台指期 - both hand the shioaji
     * spec here, so they share its 60s clock). The pidfile means the first
     * spawn fixes the argv for the process lifetime, so a fetcher started
     * for 台股 at 10:00 must already know the futures codes it will be asked
     * for at 15:00 - the shioaji spec always carries `--futures` (possibly
     * empty) beside `--codes`. A changed list takes effect on the next
     * spawn; a live fetcher is never restarted for it.
     */
    const spawnFetcher = async (now: number, spec: FetcherSpec): Promise<void> => {
      const state = fetcherStateFor(spec.route)
      if (state.lastSpawn && now - state.lastSpawn < 60_000) return
      state.lastSpawn = now
      try {
        // Whichever wrapper spec.wrap adds, it resolves with exitCode 0
        // whether or not the DETACHED script itself goes on to fail
        // (missing python, missing env file, a bad login) - that failure
        // happens after the wrapper has already returned, so this
        // try/catch can only ever catch a failure to launch the wrapper,
        // never a failure inside the job it left running. The only signal
        // this module can observe for "the script isn't feeding the file"
        // is the file staying stale, which is exactly what the callers act
        // on: feedTwFetcher returns false and the dispatcher falls through
        // to the next source.
        //
        // --codes is the band's own effective Taiwan watchlist (built-in
        // list included, not just whatever `stock-band.json` overrides) -
        // without it the script fell back to reading `tw` out of
        // stock-band.json itself, which is empty whenever a project has no
        // config file at all, and it then snapshotted only the account's
        // positions: every OTHER watchlist row stayed on a demo price
        // while the footer still claimed a live broker feed. Passing the
        // codes here is what makes the script price the list the table draws.
        const codes = config.lists.tw.map(t => t.code).join(',')
        await $.process.run(
          spec.wrap([
            '--project',
            project,
            '--out-dir',
            runtime,
            '--interval',
            String(spec.interval),
            '--codes',
            codes,
            '--heartbeat',
            heartbeatPath,
            '--pidfile',
            spec.pidPath,
            ...spec.extraArgs,
          ]),
          { cwd: project, timeoutMs: 15000 },
        )
      } catch (err) {
        // The wrapper itself failed to launch (e.g. no /bin/sh, or a
        // python that is not on PATH) - logged, but not fatal: the callers
        // act on the file staying stale.
        $.ui.log(`tw-stock-mod: ${spec.route} spawn failed (${err})`)
      }
    }

    const feedTwFetcher = async (now: number, spec: FetcherSpec): Promise<boolean> => {
      const state = fetcherStateFor(spec.route)

      // Visible failure: a script that spawned (or is already running, per
      // its own pidfile) but still has not produced a fresh runtime-dir
      // quotes file 60s later is a failure the session should hear about
      // once, not a silent fallthrough to the next configured source.
      if (!state.warned && !runtimeQuotesFresh) {
        let alive = state.lastSpawn > 0
        if (!alive) {
          try {
            await $.fs.read(spec.pidPath)
            alive = true
            if (!state.pidSeenAt) state.pidSeenAt = now
          } catch {
            alive = false
            state.pidSeenAt = 0
          }
        }
        // Own spawn: age from when this session actually launched it. A
        // pidfile this session did not spawn (state.pidSeenAt): age from
        // first discovery, not from now-state.lastSpawn (0 => Infinity),
        // so a leftover pidfile gets the same 60s grace as a fresh spawn
        // instead of warning on the very first tick.
        const spawnAge = state.lastSpawn
          ? now - state.lastSpawn
          : state.pidSeenAt
            ? now - state.pidSeenAt
            : Infinity
        if (alive && spawnAge >= 60_000) {
          state.warned = true
          $.ui.log(
            `tw-stock-mod: ${spec.label}路線沒有出價，退回下一個來源。看 ${spec.logPath}，或跑 ${spec.python} ${spec.script} --check 找原因`,
          )
        }
      }

      const stale = !runtimeQuotesFresh
      if (!stale) return true

      await spawnFetcher(now, spec)

      // A missing python, a missing env file, or a dead login all show up
      // the same way from here: the runtime-dir quotes file stays stale.
      // Falling through to the next configured source (feedTw below) rather
      // than waiting out QUOTE_STALE_MS is what keeps the band off demo
      // prices in the meantime - a fresh runtime-dir file, once the script
      // does log in, wins over whatever that fallback publishes on the very
      // next poll (quotesFor prefers the file slot first).
      return false
    }

    /** `~` only ever means the home dir this session resolved once (see userHome) */
    const expandHome = (p: string) => (home && p.startsWith('~') ? home + p.slice(1) : p)

    /**
     * `"shioaji"` in `twSources` (and 台指期's only route): 永豐's Python SDK,
     * macOS/Linux only. `nohup ... >>log 2>&1 &` wrapped in `/bin/sh -c` is
     * what outlives the one-shot run() call - redirecting the script's
     * output to the log file gives the wrapper's OWN short-lived pipes
     * something to close immediately, and `&` backgrounds the real script
     * before that happens. One spec serves both markets (see spawnFetcher):
     * `--futures` is always passed, as `""` without a list, so a fetcher
     * started for 台股 already knows the contracts 夜盤 will ask for.
     */
    const shioajiSpec = (): FetcherSpec => {
      const python = expandHome(config.shioaji.python)
      const script = `${$.plugin.root}/scripts/fetch-quotes-shioaji.py`
      const logPath = `${runtime}stock-shioaji.log`
      const futures = config.lists.tf.map(t => t.code).join(',')
      return {
        route: 'shioaji',
        label: '永豐',
        python,
        script,
        interval: config.shioaji.interval,
        extraArgs: ['--env', expandHome(config.shioaji.env), '--futures', futures],
        logPath,
        pidPath: `${runtime}stock-shioaji.pid`,
        wrap: args => ['/bin/sh', '-c', `nohup "$0" "$@" >>"${logPath}" 2>&1 &`, python, script, ...args],
      }
    }
    const feedTwShioaji = (now: number): Promise<boolean> => feedTwFetcher(now, shioajiSpec())

    /**
     * `"capital"` in `twSources`: 群益's SKCOM, a Windows COM server. There
     * is no `nohup` here and no shell worth trusting with the quoting of a
     * python path that may sit under `Program Files`, so the script detaches
     * ITSELF: `--detach` makes it re-launch a DETACHED_PROCESS child with
     * `--log` for output and return at once, which is what lets run()
     * resolve. The wrapper is therefore just the plain argv.
     */
    const feedTwCapital = (now: number): Promise<boolean> => {
      const python = expandHome(config.capital.python)
      const script = `${$.plugin.root}/scripts/fetch-quotes-capital.py`
      const logPath = `${runtime}stock-capital.log`
      const indices = config.capital.indices.map(i => `${i.code}:${i.name}`).join(',')
      return feedTwFetcher(now, {
        route: 'capital',
        label: '群益',
        python,
        script,
        interval: config.capital.interval,
        // `--indices ""` is a real instruction (no index rows), which is why
        // it is passed even when empty rather than left off - the script
        // would otherwise fall back to its own defaults and put the index
        // board back on a board whose owner turned it off.
        extraArgs: [
          '--env',
          expandHome(config.capital.env),
          '--dll',
          expandHome(config.capital.dll),
          '--indices',
          indices,
          '--log',
          logPath,
          '--detach',
        ],
        logPath,
        pidPath: `${runtime}stock-capital.pid`,
        wrap: args => [python, script, ...args],
      })
    }

    /**
     * Tries `config.twSources` in order and stops at the first one that
     * prices Taiwan this tick. `twSources` is never empty (parseTwSources
     * falls back to defaultConfig's `["yahoo"]`), so this always attempts
     * at least Yahoo.
     */
    const feedTw = async (now: number, due: boolean) => {
      for (const source of config.twSources) {
        let ok: boolean | 'held' = false
        try {
          ok =
            source === 'shioaji'
              ? await feedTwShioaji(now)
              : source === 'capital'
                ? await feedTwCapital(now)
                : source === 'mis'
                  ? await feedTwMis(now, due)
                  : await feedTwYahoo(now, due)
        } catch (err) {
          // one broken route falls through to the next, like one that answered nothing
          $.ui.log(`tw-stock-mod: 台股 ${source} failed: ${err}`)
        }
        if (ok) return // priced, or held back by the budget
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
      await spawnFetcher(now, shioajiSpec())
    }

    /**
     * The signal a broker fetcher watches: it exits by itself once this is
     * older than 90s, and each tick works only the markets named here. `tw`
     * is named only when a broker (永豐 or 群益) is a configured 台股 route,
     * `tf` whenever its session is open and futures are listed - whatever
     * is on screen. Both routes read the same file: 永豐's fetcher reads the
     * `markets` list, 群益's only the `ts` (it serves 台股 alone).
     */
    const writeHeartbeat = async (now: number, markets: MarketId[]) => {
      try {
        await $.fs.write(heartbeatPath, JSON.stringify({ ts: now, markets }))
      } catch (err) {
        $.ui.log(`tw-stock-mod: could not write the fetcher heartbeat: ${err}`)
      }
    }

    /** timer periods between two sends of the budgeted requests */
    const budgetSteps = (interval: number): number => (feedEvery ? Math.max(1, Math.ceil(interval / feedEvery)) : 1)
    /**
     * When a timer tick may send the budgeted requests again: `steps` periods
     * after the last send, less half a period so a tick landing a little early
     * or late still counts - a period is the unit, so nothing shorter than
     * `steps` whole periods gets through, and a budget that fits (steps 1)
     * never holds a timer tick back.
     */
    const httpDueAt = (interval: number): number =>
      httpTickAt ? httpTickAt + (budgetSteps(interval) - 0.5) * feedEvery : 0

    /**
     * When the board's countdown should land: the next timer tick, and for a
     * market whose requests are budgeted (us, tw) the first such tick past
     * httpDueAt - the tick that will actually send.
     */
    const nextFeedTickAt = (now: number, market: MarketId): number => {
      const interval = feedInterval(config, feedExtras(now))
      if (!feedEvery || !lastTimerAt) return now + interval
      const earliest = market === 'us' || market === 'tw' ? httpDueAt(interval) : 0
      let at = lastTimerAt + feedEvery
      while (at <= now || at < earliest) at += feedEvery
      return at
    }

    let loggedSteps = 1
    /** logs once each time the budget outgrows the timer by a new number of periods */
    const noteOutgrown = (interval: number, now: number) => {
      const steps = budgetSteps(interval)
      if (steps === loggedSteps) return
      loggedSteps = steps
      if (steps === 1) return
      $.ui.log(
        `tw-stock-mod: the feed now costs ${requestsPerTick(config, feedExtras(now))} requests per tick, ` +
          `so Yahoo/證交所 are asked every ${Math.round((steps * feedEvery) / 1000)}s (budget ${REQUESTS_PER_HOUR}/hour)`,
      )
    }

    /** `force`: a tab switch asking for prices now (requestFeed) - it still counts against the budget */
    const feed = async (force = false) => {
      const now = await $.clock.now()
      // Snoozed means the table is not on screen at all, so the 30 minutes it
      // covers need no prices; feedInFlightSince keeps a slow answer from
      // stacking a second request on top of it, until IN_FLIGHT_STUCK_MS
      // says it is never coming. Back-off (feedBackoff) is per host, inside
      // each feed: it holds that host's requests only, never the heartbeat.
      if (config.feed === 'off' || now < snoozedUntil) return
      const onScreen = pickMarket(now, modeOverride ?? config.market, hasFutures(config)).market
      const markets = feedMarkets(config, onScreen).filter(market => marketNeedsFeed(now, market))
      // The heartbeat goes out ahead of the in-flight latch: a hung request
      // can hold the latch for IN_FLIGHT_STUCK_MS (120 s), longer than a
      // broker fetcher's 90 s patience, and must not make it quit.
      const brokerTw = config.twSources.includes('shioaji') || config.twSources.includes('capital')
      const wanted = markets.filter(m => m === 'tf' || (m === 'tw' && brokerTw))
      if (wanted.length > 0) await writeHeartbeat(now, wanted)
      backOffHung(now)
      if (feedInFlightSince && now - feedInFlightSince < IN_FLIGHT_STUCK_MS) return
      if (feedInFlightSince) $.ui.log('tw-stock-mod: the last feed tick never settled; starting a new one')
      const mine = now
      feedInFlightSince = mine
      try {
        await feedOnce(now, markets, force)
      } finally {
        // a stuck tick that finally settles must not clear its successor's latch
        if (feedInFlightSince === mine) feedInFlightSince = 0
      }
    }

    /**
     * One tick over `markets`. Whether it may send the budgeted requests is
     * decided once, here, and handed to each feed - a tick abandoned past
     * IN_FLIGHT_STUCK_MS that resumes later keeps its own answer. A tab switch
     * (`force`) always may: it wants prices for the board it just landed on,
     * and it restarts the budget's clock like any send.
     */
    const feedOnce = async (now: number, markets: MarketId[], force: boolean) => {
      const interval = feedInterval(config, feedExtras(now))
      noteOutgrown(interval, now)
      const due = force || now >= httpDueAt(interval)
      for (const market of markets) {
        // one market throwing must not skip the ones after it (a tw failure
        // used to leave tf's fetcher un-respawned for that tick)
        try {
          if (market === 'tf') await feedTf(now)
          else if (market === 'us') await feedUs(now, due)
          else if (market === 'crypto') {
            // Pionex's own flat cooldown, not feedBackoff's - a Pionex 429
            // must not also stop tw/us, nor a Yahoo one crypto.
            if (now < cryptoSkipUntil) continue
            await feedCrypto(now)
            // Independent of feedCrypto's own result (see fetchCryptoSupply's
            // own comment) - its own TTL/cooldown make this a no-op on almost
            // every tick, so riding the same cadence costs nothing extra.
            await fetchCryptoSupply(now)
          } else await feedTw(now, due)
        } catch (err) {
          $.ui.log(`tw-stock-mod: ${market} feed failed: ${err}`)
        }
      }
    }

    // K bars cost one request per symbol, so only the symbol the trend view is
    // showing asks for them, and only once a minute.
    // K bars come from Yahoo for both markets: MIS has no candles at all, and
    // a 5-minute bar twenty minutes old still draws the right shape.
    const feedBars = async (market: MarketId, code: string) => {
      if (market === 'tf') return // Yahoo has no futures mapping; tf bars only ever come from the file (T3)
      // Pionex's ticker endpoint carries no candles, and yahooSymbol() has
      // no route for a crypto code (it would produce a nonsense `.TW`
      // suffix) - so the chart view for crypto stays without live K bars
      // for now. demoBars() still draws the same fallback shape it draws
      // for any other market whose live feed has not produced bars yet.
      if (market === 'crypto') return
      const now = await $.clock.now()
      backOffHung(now)
      if (config.feed === 'off' || backedOff('yahoo', now)) return
      if (barsInFlightSince && now - barsInFlightSince < IN_FLIGHT_STUCK_MS) return
      const key = `${market}:${code}`
      const have = liveBars[key]
      if (have && now - have.at < BARS_MAX_AGE_MS) return
      const sym = config.lists[market].find(t => t.code === code)
      if (!sym) return
      const mine = now
      barsInFlightSince = mine
      try {
        const res = await safeFetch(chartUrl(yahooSymbol(market, sym), now), { headers: FEED_HEADERS }, { host: 'yahoo', now })
        if (res instanceof Error || !res.ok) return backOff('yahoo', now, failure(res, ` (${code} K 棒)`))
        const bars = parseChartBars(res.text)
        if (!bars) return
        // an abandoned request answering late must not replace newer bars
        if ((liveBars[key]?.at ?? 0) > now) return
        liveBars[key] = { bars, at: now }
        $.ui.invalidate('ui.render')
      } finally {
        if (barsInFlightSince === mine) barsInFlightSince = 0
      }
    }

    requestBars = (market, code) => {
      feedBars(market, code).catch(err => $.ui.log(`tw-stock-mod: K 棒 failed: ${err}`))
    }

    requestFeed = () => {
      feed(true).catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
    }

    if (config.feed !== 'off') {
      // sized off the holdings the boot poll above already read; see
      // httpTickAt for holdings that widen the feed later
      const interval = feedInterval(config, feedExtras())
      const every = Math.min(interval, FEED_TIMER_MAX_MS)
      feedEvery = every
      // a module that outlives a session must not carry the last one's clock
      lastTimerAt = 0
      httpTickAt = 0
      loggedSteps = budgetSteps(interval)
      if (interval > config.feedMs) {
        $.ui.log(
          `tw-stock-mod: ${requestsPerTick(config, feedExtras())} requests per tick, so Yahoo/證交所 are asked every ` +
            `${Math.round((loggedSteps * every) / 1000)}s instead of ${Math.round(config.feedMs / 1000)}s ` +
            `(budget ${REQUESTS_PER_HOUR}/hour)`,
        )
      }
      // the timer goes in before the boot tick: a boot request that never
      // settles would otherwise leave the session with no feed timer at all
      const tick = async () => {
        lastTimerAt = await $.clock.now()
        await feed()
      }
      $.clock.every(every, () => {
        tick().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
      })
      await tick().catch(err => $.ui.log(`tw-stock-mod: feed failed: ${err}`))
    }

    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const now = await $.clock.now()
    if (!ready) return next(e)

    const { Box, Button, Client, Text, Select } = await $.ui.resolve(e)
    // Capability check, not a surface-name check: terminal and desktop both
    // resolve a Select (d.ts Elements), mobile does not (no `ui_select`
    // message yet). The AbovePrompt guard above only ever lets `terminal`
    // reach here today, so this reads as always-true in production - but
    // writing it as "did the table hand out a Select" rather than
    // `e.surface === 'terminal'` means desktop starts drawing the same
    // dropdown the day that guard widens, with no second change needed here.
    const canSelect = Boolean(Select)

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

    // bodyColumns is the band's own width (narrower than the viewport with a
    // Pane docked beside the transcript); a stub host may give neither
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    // every view sizes itself to the band (fitBand); a stub host has no maxRows
    const maxRows = typeof e.props.maxRows === 'number' && e.props.maxRows > 0 ? e.props.maxRows : 0
    const fit = fitBand(config, maxRows, cols)
    const mode = modeOverride ?? config.market
    // Every stop the active switcher style can land on this render - see
    // marketStops()/forkStops()'s own doc comments for why this has to be
    // recomputed here rather than read off a module-level constant:
    // `holdingsFiles` is state that changes after the module loads, so a
    // stop list cached at load time would go stale the moment a holdings
    // file arrives or is removed. Computed once per render and threaded
    // through everywhere below (`select`'s options, `cycle`'s stops, the
    // tab Buttons and their width budget) rather than each call site
    // rebuilding its own copy. `tabbar` (the fork's default) has its own
    // list: 台股庫存 always present and crypto opt-in, see forkStops().
    const forkRow = config.marketSwitcher === 'tabbar'
    const stops = forkRow ? forkStops(config) : marketStops(config)
    // A person can be PARKED on a pnl stop that this render's `stops` no
    // longer includes - the holdings file was deleted, or `holdingsSource`
    // flipped, while they were looking at it (see marketStops()'s own doc
    // comment for what can make a stop disappear between renders). Nothing
    // else clears `view` on its own, so a stranded pnl view would otherwise
    // sit there forever showing the "沒有庫存資料" hint under a switcher
    // that no longer offers a way back to it. Converging to that SAME
    // market's table stop (not jumping markets, not resetting to `auto`)
    // is the smallest change from what was on screen - the market itself
    // did not go away, only its holdings did.
    if (view === 'pnl') {
      const curMarket = pickMarket(now, mode, hasFutures(config)).market
      const pnlStopStillExists = stops.some(s => s.market === curMarket && s.pnl)
      if (!pnlStopStillExists) {
        view = 'table'
        resetPnlScroll()
      }
    }
    // `cycle`'s own stop list, built off this same render's `stops` - shared
    // by onCycle below (walking it) and the cycle-position math further down
    // (`cyclePos`/`cycleStops.length` for the "n/total" label), so both read
    // off the identical list rather than two `buildCycle(stops)` calls that
    // could observe different `stops` if this ever moved between them.
    const cycleStops = buildCycle(stops)
    // A view the band cannot fit is drawn as the table's ticker; `view` keeps
    // the stop's choice so the chart/損益 is back once the band can hold it.
    const ticker =
      fit.adaptive &&
      (fit.layout === 'ticker' ||
        (view === 'chart' && fit.chartRows > fit.rows) ||
        (view === 'pnl' && fit.pnlRows + PNL_CHROME_ROWS > fit.rows))
    tickerFit = ticker
    const drawn: View = ticker ? 'table' : view
    const layout: BoardLayout = ticker ? 'ticker' : drawn === 'table' ? fit.layout : 'full'
    const onScreen = pickMarket(now, mode, hasFutures(config)).market
    const props = buildProps(now, config, quotesFor(onScreen, now), mode, drawn, focusCode, fit, layout)
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
    if (props.view === 'chart' && props.source !== 'demo' && props.quotes[props.focus]) {
      requestBars?.(props.market, props.quotes[props.focus].code)
    }

    // Button only draws from this module's own AbovePrompt tree - a Client
    // surface has no Button (docs/api-notes.md) - so the controls sit on their
    // own row directly above the table.
    //
    // `tabbar` (the fork's default) and upstream's `tabs`/`select` land on a
    // stop directly through onSelectMarket; `cycle` walks the whole ring
    // (buildCycle/nextCycleStop) in `stops` order instead - it runs whenever
    // the effective switcher style resolves to `cycle` (mobile's fallback,
    // canSelect === false; an explicit `marketSwitcher: "cycle"`; or `tabs`
    // too narrow to fit - see `switcher` below), since a dropdown or a
    // direct-target Button has no use for a "next stop" to walk.
    // `market`/`view` do not change here for any stop-internal reason (the
    // watchlist itself is unaffected by which stop is showing), so the feed
    // gating in feedOnce (which reads modeOverride's MARKET half only) never
    // needs to know about the pnl stops at all - see marketNeedsFeed.
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
    // the switcher marks the stop the person chose, even while a too-short
    // band draws it as the ticker (props.view is then 'table')
    const currentStop: CycleStop = { market: props.market, pnl: view === 'pnl' }
    // Lands on one stop: market AND view in one pick - the fork's tab row,
    // upstream's `tabs` Buttons and the Select all call this with a stop's
    // packed `value` (see marketSelectOptions()), so this splits it back
    // apart rather than computing a "next stop" the way onCycle's
    // buildCycle/nextCycleStop do. There is no separate holdings toggle left
    // to press afterward. onCycle below reuses the same page-reset/pnl-reset/
    // refetch steps, so a cycle press behaves identically to a pick landing
    // on the same stop.
    const landOn = (stop: CycleStop) => {
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
      // `pageFromMarket` exists to keep off the board. Picking a different
      // STOP on the same market (table <-> pnl) leaves the table's own page
      // alone, since the pnl view has no page of its own to collide with it
      // (see holdingsScroll instead).
      if (stop.market !== props.market) page = 0
      modeOverride = stop.market
      view = stop.pnl ? 'pnl' : 'table'
      resetPnlScroll() // "changing the stop" always resets the pnl scroll position
      if (stop.pnl) turnPnl() // landing on a pnl stop flaps it in, like a mount
      // the market just landed on may never have been fetched: ask for it
      // now rather than showing demo prices until the next tick
      if (!quotesFor(pickMarket(now, modeOverride, hasFutures(config)).market, now)) requestFeed?.()
      $.ui.invalidate('ui.render')
    }
    const onSelectMarket = (value: string) => {
      // Every value marketSelectOptions() hands out is a MarketSelectValue -
      // see its own comment - so splitting on the literal ':pnl' suffix is
      // exhaustive, not a guess.
      const pnl = value.endsWith(':pnl')
      const stop: CycleStop = { market: (pnl ? value.slice(0, -':pnl'.length) : value) as MarketId, pnl }
      // the selected stop picked again is a no-op - unless the chart is up,
      // where the same market's own stop is the way back to its table
      if (sameStop(stop, currentStop) && view !== 'chart') return
      landOn(stop)
    }
    const onCycle = () => landOn(nextCycleStop(currentStop, cycleStops))
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
    const onTimeframe = (tf: Timeframe) => () => {
      timeframe = tf
      $.ui.invalidate('ui.render')
    }
    const onChartMode = (m: ChartMode) => () => {
      chartModeBy[props.market] = m
      $.ui.invalidate('ui.render')
    }
    // The chart's own controls only draw once there is a chart: a row with no
    // bars shows the notice, and a timeframe or a line through nothing is noise.
    const chartControls = props.view === 'chart' && (props.quotes[props.focus]?.bars?.length ?? 0) > 0
    // Moves the scroll offset a whole page of holding rows at a time,
    // wrapping back to 0 past the last page - "paging sets the offset to
    // page*rows".
    const pnlRows = Math.max(1, fit.pnlRows)
    const holdingsPageCount = Math.max(1, Math.ceil(props.holdings.length / pnlRows))
    const holdingsPageNum = Math.floor(props.holdingsScroll / pnlRows) + 1
    const onHoldingsPage = () => {
      const curPage = Math.floor(props.holdingsScroll / pnlRows)
      pnlScroll = ((curPage + 1) % holdingsPageCount) * pnlRows
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

    // The switcher marks the stop ON THE BAND: `open` tracks the clock until
    // the first press on whichever market-switcher style is on screen, then
    // toggles with it.
    const open = props.phase === 'open'
    // Three views, three names, so every line in the button row below can
    // read forwards: `table ? 元素 : null`, `chart ? 元素 : null`, `pnl ?
    // 元素 : null`, never a negation that says what does NOT draw and has to
    // be reversed in the head before it says anything.
    const chart = props.view === 'chart'
    const pnl = props.view === 'pnl'
    const table = props.view === 'table'
    // Which of the four switcher styles this render actually draws.
    // `tabbar` (the fork's default) always draws - its row never collapses,
    // the notes after it give way instead (see `fits` below). `select` needs
    // a real Select (canSelect) or it drops to `cycle`, the rule this
    // already had; `tabs` needs its own Buttons to fit next to the session
    // state/hours and the right-side button group or it drops to `cycle`
    // too - same direction as `select`'s fallback, so a style this
    // environment/terminal cannot draw never fails silently into something
    // broken, always into the one style every surface can draw. `cols` is
    // measured up front (see its own definition above), so this check runs
    // before anything else in the row has committed to a layout.
    const requestedSwitcher = config.marketSwitcher
    const tabsFit = tabsGroupWidth(stops) + RIGHT_BUTTON_GROUP_COLS <= cols
    const switcher: MarketSwitcher =
      requestedSwitcher === 'select' && !canSelect
        ? 'cycle'
        : requestedSwitcher === 'tabs' && !tabsFit
          ? 'cycle'
          : requestedSwitcher
    // the stop the switcher marks - `currentStop`'s pnl half, which follows
    // the chosen `view` even while a too-short band draws the ticker
    const pnlStop = currentStop.pnl
    // `cycleStops`'s own position, for `cycle`'s "n/total" label - `cycleStops`
    // (built off this render's `stops`, see its own definition above) is
    // recomputed every render (cheap, at most seven entries) rather than
    // cached, so a fresh stock-holdings.json or /reload-plugins changes the
    // stops without a stale cycle surviving in closure state.
    const cycleIdx = cycleStops.findIndex(s => sameStop(s, currentStop))
    const cyclePos = (cycleIdx < 0 ? 0 : cycleIdx) + 1
    // marketLabel is `cycle`'s own on-screen Button label when the switcher
    // resolves there (mobile's fallback, an explicit `marketSwitcher:
    // "cycle"`, or `tabs` collapsing for width); otherwise it is only
    // `select`'s on-screen width proxy in the budget math right below,
    // since there is no way to measure what the framework actually renders
    // from inside the hook - a dropdown showing the same market name costs
    // about the same columns as the button that used to carry it.
    const marketLabel =
      switcher === 'cycle'
        ? cycleButtonLabel(props.marketLabel, pnlStop, cyclePos, cycleStops.length)
        : marketButtonLabel(props.marketLabel, pnlStop)
    // `tabs`/`tabbar` swap in their own multi-Button width instead of
    // marketLabel's - see tabsGroupWidth/tabRowWidth for what each counts.
    const marketControlWidth =
      switcher === 'tabbar'
        ? tabRowWidth(stops)
        : switcher === 'tabs'
          ? tabsGroupWidth(stops)
          : switcher === 'select'
            ? dispWidth(MARKET_SELECT_LABEL) + SELECT_LABEL_CHROME_COLS + dispWidth(marketLabel)
            : dispWidth(marketLabel)
    // The Select's own `value`: crypto never reaches `pnl` (see
    // marketStops()/onSelectMarket - there is no `crypto:pnl` stop to land
    // on), so `props.market` alone already covers that case; tw/us/tf fold
    // the pnl stop into the packed `${market}:pnl` value the same way a
    // stop's own `value` does, so the dropdown shows "美股庫存" rather than
    // reverting to "美股" the moment 損益 is on screen. The tab styles' own
    // active-tab check (below) compares market/pnl directly instead of
    // building this packed form, since they never round-trip through a string.
    const marketSelectValue: MarketSelectValue =
      pnlStop && props.market !== 'crypto' ? `${props.market}:pnl` : props.market
    // The switcher never gives way; what follows it does, in order:
    // sessionNote first (09:30-16:00 ET answers the wrong question in Taipei
    // anyway), then taipeiNote, then the session badge. There is no way to
    // measure what the framework actually renders from inside the hook, so
    // this reserves a fixed budget for the button group on the right (see
    // RIGHT_BUTTON_GROUP_COLS) and drops each piece when it no longer fits.
    const badge = `${open ? SUN : MOON} ${open ? '盤中' : '休市'}`
    const fits = (...parts: string[]) =>
      marketControlWidth + parts.reduce((w, p) => w + 1 + dispWidth(p), 0) + RIGHT_BUTTON_GROUP_COLS <= cols
    const taipei = props.taipeiNote === '' ? [] : [props.taipeiNote]
    // compact/ticker boards have no footer row: its clock and source tag fold
    // in here and give way last - which prices these are outranks the hours
    const tail = table && props.layout !== 'full' ? [foldedFooter(props)] : []
    const showSession = table && fits(badge, props.sessionNote, ...taipei, ...tail)
    const showTaipei = table && taipei.length > 0 && fits(badge, ...taipei, ...tail)
    const showBadge = table && fits(badge, ...tail)
    const showTail = tail.length > 0 && fits(...tail)

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
            {switcher === 'tabbar' ? (
              // The fork's tab row: one plain Button per forkStops() entry,
              // the current stop bracketed and at full strength, every other
              // tab dimColor - see forkTabLabel.
              stops.flatMap((stop, i) => [
                i > 0 ? <Text key={`${tabKey(stop)}:gap`}> </Text> : null,
                <Button
                  key={tabKey(stop)}
                  label={forkTabLabel(stop, currentStop)}
                  plain
                  dimColor={!sameStop(stop, currentStop)}
                  onPress={() => onSelectMarket(stop.value)}
                />,
              ])
            ) : switcher === 'select' ? (
              <Select
                key="stock-band:market"
                label={MARKET_SELECT_LABEL}
                options={marketSelectOptions(stops)}
                value={marketSelectValue}
                onSelect={onSelectMarket}
              />
            ) : switcher === 'tabs' ? (
              // One Button per stop, marketStops()/`stops` order, each jumping
              // straight to its own stop through onSelectMarket - the same state-switch
              // function `select` uses, not a second copy of it. The stop
              // actually on screen draws at full strength; every other stop
              // stays dimColor (ButtonProps.dimColor: "dim at rest ... full
              // strength under the pointer or the focus" - the same visual
              // vocabulary a secondary control already uses elsewhere in
              // this engine, borrowed here for "not the current tab" rather
              // than "secondary action"). A one-column gap Text sits between
              // each pair, the same explicit-gap convention this row already
              // uses for session-state/hours/taipei (see `fits`) -
              // tabsGroupWidth's own width budget counts these same gaps.
              stops.flatMap((stop, i) => {
                const active = sameStop(stop, currentStop)
                const btn = (
                  <Button
                    key={`stock-band:market:${stop.value}`}
                    label={tabLabel(stop)}
                    dimColor={!active}
                    onPress={() => onSelectMarket(stop.value)}
                  />
                )
                return i === 0 ? [btn] : [<Text key={`stock-band:market:gap:${stop.value}`}> </Text>, btn]
              })
            ) : (
              <Button key="stock-band:market" label={marketLabel} onPress={onCycle} />
            )}
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
            {/* the timeframe and K線/曲線 pairs read like the tab row: plain,
                the active one bracketed, the rest dim */}
            {chartControls && props.timeframes.length > 0 ? <Text> </Text> : null}
            {chartControls
              ? props.timeframes.flatMap((tf, i) => [
                  i > 0 ? <Text key={`stock-band:tf:${tf}:gap`}> </Text> : null,
                  <Button
                    key={`stock-band:tf:${tf}`}
                    label={tf === props.timeframe ? `[${tf}分]` : `${tf}分`}
                    plain
                    dimColor={tf !== props.timeframe}
                    onPress={onTimeframe(tf)}
                  />,
                ])
              : null}
            {chartControls ? <Text> </Text> : null}
            {chartControls
              ? (['candle', 'line'] as ChartMode[]).flatMap((m, i) => [
                  i > 0 ? <Text key={`stock-band:mode:${m}:gap`}> </Text> : null,
                  <Button
                    key={`stock-band:mode:${m}`}
                    label={m === props.chartMode ? `[${m === 'candle' ? 'K線' : '曲線'}]` : m === 'candle' ? 'K線' : '曲線'}
                    plain
                    dimColor={m !== props.chartMode}
                    onPress={onChartMode(m)}
                  />,
                ])
              : null}
            {showBadge ? <Text> </Text> : null}
            {showBadge ? <Text color={open ? ORANGE : MOON_BLUE}>{badge}</Text> : null}
            {showSession ? <Text> </Text> : null}
            {showSession ? <Text color={DIM}>{props.sessionNote}</Text> : null}
            {showTaipei ? <Text> </Text> : null}
            {showTaipei ? <Text color={DIM}>{props.taipeiNote}</Text> : null}
            {showTail ? <Text> </Text> : null}
            {showTail ? <Text color={DIM}>{tail[0]}</Text> : null}
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
            {/* no chart can fit in a band that draws the ticker */}
            {table && props.layout !== 'ticker' ? <Button key="stock-band:trend" label="趨勢圖" onPress={onTrend} /> : null}
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
          height={props.boardRows}
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
