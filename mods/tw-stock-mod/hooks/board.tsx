/* @jsx h */
import type { ClientElements, ClientSurface, RenderNode } from 'claude-code'

type TextTag = ClientElements['Text']

// The stock band's Client board: pure drawing, on its own frame clock
// (surface.every), independent of the hooks module. Quotes, market session and
// the market-local clock all arrive as props from hooks/register.tsx - this
// file never decides what a price is, it only lays the table out.
//
// Column layout, colors, badge scheme and the red/green conventions are ported
// from prototype/stock-band-demo.py (repo root) - read that first if a number
// here looks arbitrary. Never name a local variable `h`: every JSX tag in this
// file compiles to h(...).

export type MarketId = 'tw' | 'us' | 'tf'
export type Phase = 'open' | 'closed'
export type View = 'table' | 'chart' | 'pnl'

/** [open, high, low, close, volume?, bucket start ms?] - the fetcher writes six, older files four */
export type Bar = [number, number, number, number, number?, number?]

export type QuoteRow = {
  code: string
  name: string
  price: number
  change: number
  pct: number
  prevClose: number
  /** K bars, oldest first; only the focused symbol (the chart view) carries these */
  bars?: Bar[]
  /**
   * what this row said before the last update; absent when nothing moved.
   * `code`/`name` only appear on a page turn, when the slot changed symbol.
   */
  was?: { price: number; change: number; pct: number; code?: string; name?: string }
  /**
   * the market has a live/override snapshot, but it never priced this code -
   * not the same as "no change" (pct 0). Drawn as a dim placeholder instead
   * of the price/change/pct fields (see drawTwoColQuote and the table loop).
   */
  noData?: boolean
  /** price/change digits when the contract says so (futures `decimals`); absent = 2, as stocks always were */
  decimals?: number
}

/** a holding, already priced by register.tsx - the 損益 view only formats these */
export type Holding = {
  code: string
  name: string
  /** shares (tw/us) or 口 (tf); a short futures position is negative */
  qty: number
  cost: number
  price: number
  prevClose: number
  /** points-to-money factor: 1 for stocks, the contract's own for futures */
  multiplier: number
  /** 成本/現價 digits when the contract says so; absent = 2, as stocks always were */
  decimals?: number
  /**
   * what this holding said before the last update - same idea as
   * QuoteRow.was and deliberately as thin: only `price` is real old data;
   * was-side 今日%/今日損益/總損益/損益% are derived from it using the
   * CURRENT cost/qty/prevClose, the same way the table derives
   * `was.change`/`was.pct` from `was.price` alone. `code`/`name` only
   * appear on a page/sort turn, when the row's occupant changed.
   */
  was?: { price: number; code?: string; name?: string }
}

/** which pnl column `holdings` is sorted by - register.tsx does the actual sort, board only marks the header */
export type PnlSortKey = 'code' | 'today' | 'todayPnl' | 'totalPnl' | 'totalPnlPct'

export type BoardProps = {
  market: MarketId
  marketLabel: string
  phase: Phase
  /** trading hours when open, "下次開盤 ..." when closed */
  sessionNote: string
  /** the same hours in Taipei time, '' when the market already trades on it */
  taipeiNote: string
  /** market-local HH:MM:SS, formatted in the hooks module (the board has no $) */
  clock: string
  quotes: QuoteRow[]
  index: { name: string; value: number; change: number; pct: number }
  /** what the footer flips through; one entry means it just sits there */
  indices: { name: string; value: number; change: number; pct: number }[]
  /** 'demo' = faked prices (no API), 'file' = a quotes file, 'live' = the feed */
  source: 'demo' | 'file' | 'live'
  /** what the footer calls the source; '' falls back to naming it from `source` */
  sourceLabel: string
  /** the plugin's version, e.g. `v0.4.1`; '' hides it */
  version: string
  /** snapshot counter; the live dot flips on it (0 while faking prices) */
  seq: number
  highlight: boolean
  sorted: boolean
  /**
   * 1 = the single-column table (代號/名稱/價格/變更$/變更%, up to 5 rows); 2 =
   * two symbols per row (代號/名稱/價格/變更% only - 變更$ has no room), filled
   * column-major off the current sort so the left column is the top half of
   * the page and the right column the bottom half. register.tsx resolves
   * `"auto"` to one of these before the board ever sees it; the board itself
   * still falls back to 1 at render time if the terminal is too narrow for a
   * readable half (see `fitsTwoColumns`).
   */
  columns: 1 | 2
  /** 'table' = the watchlist, 'chart' = one symbol's K bars */
  view: View
  /** which row the chart view is showing */
  focus: number
  /** what the bars are, e.g. "5 分 K" - the feed decides, so it is a string */
  barLabel: string
  /** market-local session bounds, "HH:MM", the chart's time axis when the bars carry no stamps */
  sessionOpen: string
  sessionClose: string
  /** rows the chart view draws (min 8), already clamped to the band by register.tsx */
  chartRows: number
  /** K線 (half-block candles) or 曲線 (a braille close line over a shaded area) */
  chartMode: 'candle' | 'line'
  /** the timeframes the focused row offers and the one on screen - drawn as buttons by register.tsx, not here */
  timeframes: string[]
  timeframe: string
  /** the market's UTC offset in hours, to print bar stamps in the market's own clock */
  utcOffsetHours: number
  /** bumped on a new snapshot or a page change; what starts a row turn */
  turn: number
  /** which page of the watchlist this is, and how many there are */
  page: number
  pageCount: number
  /** epoch ms of the next feed request; 0 when nothing is fetching */
  nextFeedAt: number
  /** 'off' leaves the board still - see the README's cost table */
  animation: 'full' | 'off'
  countdown: boolean
  now: number
  /**
   * `view: "pnl"` only - already priced and merged by register.tsx (live
   * quote first, the holdings file's own price/prevClose otherwise; see
   * pricedHoldings). board.tsx never looks anything up itself, it only
   * formats what arrives here and pages through it 5 at a time.
   */
  holdings: Holding[]
  /** what the pnl view's title calls the source, e.g. "永豐 庫存" */
  holdingsSource: string
  /** epoch ms the holdings snapshot was taken, or the matching watchlist quote's time when it has none */
  holdingsAt: number
  /** already applied to `holdings` by register.tsx - board only marks the active header cell */
  pnlSortKey: PnlSortKey
  pnlSortDir: 'asc' | 'desc'
  /** the first data row on screen, 0-based - a wheel tick moves it, 翻頁 by whole pages; see register.tsx's pnlScroll */
  holdingsScroll: number
}

// `turn` is the change the rows last turned for, and `since` is when that turn
// started. The hook's props say what the numbers are; only the board knows when
// it noticed them change, which is what the row animation is timed off.
// `flipMs` and `nextFeedAt` ride along because the frame timer runs outside the
// render and has nothing else to read them from.
type State = {
  frame: string
  turn: number
  since: number
  flipMs: number
  nextFeedAt: number
  /**
   * whether the live dot is on the 500 ms pulse. On real quotes it advances
   * once per snapshot instead, and counting the pulse into the frame id then
   * costs two repaints a second to draw a character that did not change.
   */
  blinks: boolean
}

// --- colors (prototype/stock-band-demo.py) ---------------------------------
const UP_GREEN = '#3fb950'
const DOWN_RED = '#e5534b'
const FLAT = '#9aa0a6'
const DIM = '#6e7681'
const HEAD = '#a6aebb'
const SYMBOL = '#79a8ff' // the blue ticker links in the reference screenshot
const RULE = '#2d333b'
const ORANGE = '#d97757'
const WHITE = '#f0f3f6'
const SUN = '\u2600'
const MOON = '\u263d'
const ROW_HILIGHT = '#1b2436' // selected-row band, like the reference screenshot

const PULSE_MS = 500 // the live dot's on/off period

// --- the index board: a Solari split-flap -----------------------------------
// A real airport board does not fold a character in half - every flap carries a
// fixed set of whole characters on a drum, and a flap turning from one to
// another riffles through everything in between. So every frame here holds real
// characters, which is exactly what a terminal cell can draw. Flaps further
// right start later, and that lag is what makes the wave sweep left to right.
//
// A character its drum does not carry is painted on a real board, not flapped -
// the comma, the decimal point, the brackets and the arrow stay put, which is
// also what keeps digits from riffling through letters.
const ANIM_TICK_MS = 50 // how often the frame is re-derived, not how often it draws
const HOLD_MS = 5000
const FLAP_MS = 28 // one flap step
const STAGGER = 1 // flaps a column waits behind the column to its left
const MAX_FLAPS = 12 // longest riffle a single flap takes, so the wave stays brisk
// The wave front. It covers every column it passes, including the ones whose
// character does not change: a front drawn only where the text differs comes
// out full of holes and reads as noise, not as a sweep.
const EDGE = ['█', '▓']
const ROW_STAGGER = 2 // flaps each quote row waits behind the row above it
// A page turn has no sweep inside a row - every column lands together - so the
// cascade has to come from the rows, and they lag each other further apart.
const PAGE_ROW_STAGGER = 5
// A price update turns three numbers and the wave crosses from the price column
// to the right edge, which takes most of this. A page turn's row lands in
// EDGE + MAX_FLAPS steps, and the last row starts 4 * PAGE_ROW_STAGGER behind
// the first: (2 + 12 + 20) * 28 ms, rounded up so the last flap is never cut.
const FLIP_MS = 1450
const PAGE_FLIP_MS = 1100
const CYCLE_MS = HOLD_MS + FLIP_MS
const RESTING = Number.MAX_SAFE_INTEGER
// what the band signs itself with, bottom right
const CREDIT = 'darrell_tw_'

// no blank on the numeric drum: a space riffling through the middle of a price
// reads as a glitch, not as a flap. The leading pad a shorter number sits in is
// a space against a digit, which has no journey and simply swaps.
const NUM_DRUM = '0123456789'
const TEXT_DRUM = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ&.0123456789'

type Anim = {
  /** which index the cycle is settling on */
  slot: number
  /** how many steps into the turn, or RESTING while the card sits */
  flap: number
  /** the live dot's on/off phase */
  blink: number
}

function animState(t: number): Anim {
  const phase = t % CYCLE_MS
  return {
    slot: Math.floor(t / CYCLE_MS),
    flap: phase < FLIP_MS ? Math.floor(phase / FLAP_MS) : RESTING,
    blink: Math.floor(t / PULSE_MS),
  }
}

/**
 * one flap `step` turns into its journey from `from` to `to`.
 *
 * `together` makes every flap take the same number of steps whatever its
 * journey, so a whole row lands on one frame instead of settling left to right.
 * That is what a page turn needs: while the symbol column has settled and the
 * price column has not, the board is showing one company's name against
 * another's price, and half a second of that is a lie about a stock price.
 */
function flapChar(from: string, to: string, drum: string, step: number, together: boolean): string {
  if (from === to) return to
  const i = drum.indexOf(from)
  const j = drum.indexOf(to)
  if (i < 0 || j < 0) return step >= 0 ? to : from // painted, not flapped
  if (step < 0) return from
  const full = (j - i + drum.length) % drum.length
  // a long journey starts part way round, so one flap cannot hold up the wave
  const distance = together ? MAX_FLAPS : Math.min(full, MAX_FLAPS)
  if (step >= distance) return to
  // `distance` can be longer than the drum - MAX_FLAPS is 12 and the numeric
  // drum holds 10 - so this has to wrap both ways. A bare `% length` on a
  // negative start indexes off the front of the string and puts the word
  // `undefined` on the board.
  const start = (((j - distance) % drum.length) + drum.length) % drum.length
  return drum[(start + step) % drum.length]
}

/** how many steps a field takes to settle, given its per-column lag */
function flapSpan(width: number, stagger: number): number {
  return width * stagger + EDGE.length + MAX_FLAPS
}

/**
 * a whole field mid-turn; `flap` is already offset by where the field starts.
 * `stagger` 0 turns the whole field at once - see flapChar's `together`.
 */
function flapField(from: string, to: string, drum: string, flap: number, stagger = STAGGER): string {
  // past the last flap's longest journey the field has settled
  if (flap >= flapSpan(to.length, stagger)) return to
  const together = stagger === 0
  let out = ''
  for (let i = 0; i < to.length; i++) {
    const step = flap - i * stagger
    if (step < 0) out += from[i] ?? ' '
    else if (step < EDGE.length) out += EDGE[step]
    else out += flapChar(from[i] ?? ' ', to[i], drum, step - EDGE.length, together)
  }
  return out
}

/**
 * display columns [from, to) of `text`. A wide character the range cuts in half
 * cannot be drawn as a half, so it comes back as spaces - which is what keeps a
 * wipe over Chinese names from shifting every column to its right.
 */
function sliceCols(text: string, from: number, to: number): string {
  let out = ''
  let col = 0
  for (const ch of Array.from(text)) {
    const start = col
    const end = col + charWidth(ch)
    col = end
    if (end <= from || start >= to) continue
    if (start >= from && end <= to) out += ch
    else out += ' '.repeat(Math.min(end, to) - Math.max(start, from))
  }
  return out
}

/**
 * A field that cannot flap, turning by wipe instead: the same block front
 * sweeps across, the new text is behind it and the old text ahead of it. A
 * Chinese name has no drum to riffle through - there is no journey from 台 to
 * 鴻 - so the front is the whole animation, and it still reads as one board
 * turning because it is the same front the flapped fields use.
 */
function wipeField(from: string, to: string, width: number, step: number, span: number): string {
  if (step >= span) return padRight(to, width)
  if (step < 0) return padRight(from, width)
  // The front crosses the field in `span` steps whatever the field is wide, so
  // a three-letter name does not resolve long before the flaps beside it. The
  // -1 keeps one column covered until the very last step: a name that clears
  // early sits a real company against digits still riffling towards its price.
  const flap = Math.floor((step * (width + EDGE.length - 1)) / span)
  const settled = Math.min(width, Math.max(0, flap - EDGE.length + 1))
  let out = sliceCols(padRight(to, width), 0, settled)
  for (let c = settled; c < Math.min(width, flap + 1); c++) out += EDGE[flap - c]
  out += sliceCols(padRight(from, width), Math.min(width, Math.max(0, flap + 1)), width)
  return out
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - dispWidth(text)))
}

function padLeft(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - dispWidth(text))) + text
}

type IndexRow = { name: string; value: number; change: number; pct: number }
type Field = { text: string; fg: string; drum: string }

/**
 * An index card as the fields the board flaps. Every card is laid out to the
 * same widths, so a comma sits under a comma and a bracket under a bracket:
 * those are the painted flaps, and they only stay still if they line up.
 */
// The parenthetical (+1.16%) came off the index card too - the footer's job
// is 加權指數 24,329.53 ▲ +277.83 at a glance, and the % duplicated the pct
// column every quote row already carries.
function cardFields(idx: IndexRow, w: number[], market: MarketId): Field[] {
  const arrow = idx.change > 0 ? '▲' : idx.change < 0 ? '▼' : '-'
  const fg = tone(market, idx.change)
  return [
    { text: padRight(idx.name, w[0]), fg: DIM, drum: TEXT_DRUM },
    { text: padLeft(thousands(idx.value), w[1]), fg: WHITE, drum: NUM_DRUM },
    { text: arrow, fg, drum: '' },
    { text: padLeft(signed(idx.change), w[2]), fg, drum: NUM_DRUM },
  ]
}

/** the widest each field gets across every card, so the layout never shifts */
function cardWidths(board: IndexRow[]): number[] {
  const wide = (f: (i: IndexRow) => string) => Math.max(...board.map(i => dispWidth(f(i))))
  return [wide(i => i.name), wide(i => thousands(i.value)), wide(i => signed(i.change))]
}

/**
 * A right-aligned number mid-turn. Both texts are padded to one width, so the
 * column cannot jitter while the digits change length. A `turn` past this
 * field's own journey answers the settled text, which is the path every row
 * takes between updates.
 */
function flapRight(
  row: Row,
  right: number,
  from: string,
  to: string,
  fg: string,
  turn: number,
  left: number,
  stagger = STAGGER,
) {
  const width = Math.max(dispWidth(from), dispWidth(to))
  // with no per-column lag the field does not wait for the front to reach it:
  // the whole row turns as one, which is what keeps the columns consistent
  const lead = stagger === 0 ? 0 : (right - width - left) * stagger
  const text = flapField(padLeft(from, width), padLeft(to, width), NUM_DRUM, turn - lead, stagger)
  row.putRight(right, text, fg)
}

type TailPiece = { text: string; fg: string }

/** clear columns a footer tail leaves between itself and the index block */
const TAIL_GAP = 3

/**
 * The table footer's right-hand end: the clock (bare when the market is open
 * - 更新 said nothing the position on the row did not already say - 收盤
 * HH:MM when it is not), its live dot, the feed countdown, the source tag,
 * and the credit sign-off. `darrell_tw_` is a normal part of this footer now,
 * not the first thing a narrow terminal drops - so a tight row drops the
 * countdown first, then the credit, then the clock and dot, and keeps the
 * source tag as the one thing that never goes. The dot needs its own color
 * (ORANGE, not DIM), which is why this builds a run of colored pieces rather
 * than one `putRightIfFits` string the way `signOff` (the chart footer's
 * simpler tail) still does.
 */
function putFooterTail(
  row: Row,
  right: number,
  stampCore: string,
  dotChar: string,
  countdownText: string,
  sourceTag: string,
  sourceTagShort: string,
): void {
  const clockDot: TailPiece[] = [
    { text: stampCore, fg: DIM },
    ...(dotChar ? [{ text: ` ${dotChar}`, fg: ORANGE }] : []),
  ]
  const withCountdown = (base: TailPiece[]): TailPiece[] => [...base, { text: countdownText, fg: DIM }]
  const withSource = (base: TailPiece[]): TailPiece[] => [...base, { text: ` ${sourceTag}`, fg: DIM }]
  const withShortSource = (base: TailPiece[]): TailPiece[] => [...base, { text: ` ${sourceTagShort}`, fg: DIM }]
  const withCredit = (base: TailPiece[]): TailPiece[] => [...base, { text: ` · ${CREDIT}`, fg: DIM }]
  // Shorten the source tag before dropping anything, then drop the countdown,
  // then the credit, then the clock and dot - a source tag is the one thing
  // left standing on the tightest row. Every rung but the last has to leave
  // TAIL_GAP columns between the index block and the tail: a tail that lands
  // one column from the index reads as one crowded run of numbers, which is
  // the thing the footer was rebuilt to stop.
  const ladder: TailPiece[][] = [
    withCredit(withSource(withCountdown(clockDot))),
    withCredit(withShortSource(withCountdown(clockDot))),
    withCredit(withSource(clockDot)),
    withCredit(withShortSource(clockDot)),
    withShortSource(clockDot),
    [{ text: sourceTagShort, fg: DIM }],
  ]
  for (const [rung, pieces] of ladder.entries()) {
    const gap = rung === ladder.length - 1 ? 1 : TAIL_GAP
    const width = pieces.reduce((w, p) => w + dispWidth(p.text), 0)
    if (right - width < row.width() + gap) continue
    let col = right - width
    for (const p of pieces) {
      row.put(col, p.text, p.fg)
      col += dispWidth(p.text)
    }
    return
  }
}

/** how far into its turn the quote rows are; RESTING once they have settled */
function rowFlap(t: number, since: number, flipMs: number): number {
  const age = t - since
  return age >= 0 && age < flipMs ? Math.floor(age / FLAP_MS) : RESTING
}

/** whole seconds until the next feed request; -1 when nothing is fetching */
function secondsToFeed(t: number, nextFeedAt: number): number {
  if (!nextFeedAt) return -1
  // a clock skew between the hooks module and this surface must not print a
  // wild number, so the countdown is clamped to something a feed could mean
  return Math.max(0, Math.min(999, Math.ceil((nextFeedAt - t) / 1000)))
}

/** what the screen shows right now; equal ids mean there is nothing to repaint */
function frameId(t: number, st: State): string {
  const a = animState(t)
  const blink = st.blinks ? a.blink % 2 : 0
  return `${a.slot}:${a.flap}:${blink}:${rowFlap(t, st.since, st.flipMs)}:${secondsToFeed(t, st.nextFeedAt)}`
}

/** the same id with every animation stilled: only the countdown moves it */
function stillFrameId(t: number, st: State): string {
  return `still:${secondsToFeed(t, st.nextFeedAt)}`
}

// The frame timer is per instance, not per module: surface.every lives "until
// the returned function is called or the instance unmounts", and the instance
// is dropped whenever the band leaves the tree - pressing 收起 30分 is enough -
// or when a throw or a time-budget overrun unmounts it. Keeping the "already
// started" flag in a module-level variable therefore outlived the timer it was
// tracking: the next instance read tickMs === 50, skipped the install, and ran
// with no frame clock at all. The board then only redrew when the hooks module
// pushed new props every 3 s, so a one-second page turn showed one frozen
// mid-flip frame instead of twenty - the animation looked broken when what was
// actually missing was the redraws.
//
// A WeakMap keyed on the surface ties the flag to the same lifetime as the
// timer, so a remounted instance starts its own clock and a dropped one takes
// its entry with it.
type FrameClock = { ms: number; cancel: () => void }
const frameClocks = new WeakMap<object, FrameClock>()

// Clicking a quote opens its trend chart. A Client has no Button, so the board
// hit-tests the pointer itself: the render writes down which quote each cell
// belongs to, and the listener reads that map. The two are split because they
// live on different clocks - the listener is installed once per instance and
// outlives every page turn under it, so it must not close over one render's
// rows or a click would open the symbol that used to be there.
/** what a click posts back to register.tsx's ui.message hook - a table row, or a pnl header cell */
type PickResult = { pick: number } | { sortPnl: PnlSortKey }
type Picker = { hit: (x: number, y: number) => PickResult | undefined }
const pickers = new WeakMap<object, Picker>()

// The table view lost its title row: the market name, session state and
// hours moved into the button row register.tsx draws above this Client (that
// row also carries the market button now), so the table starts straight at
// the header. The chart view keeps its own title row - it names the symbol
// being charted, not the market, so it stays inside the board.
const TABLE_ROWS = 8 // header, rule, 5 quote rows, footer
// the chart view is `props.chartRows` tall (#12): title, plot, axis, volume, footer
const PNL_ROWS = 8 // title, header, 5 holding rows, totals - the same height
const PNL_PAGE_SIZE = 5
// as the table, so opening a chart no longer pushes the transcript up a line
const TABLE_QUOTE_ROWS = 5 // rows in the quote area, in single- or two-column mode
const MAX_TABLE_QUOTES = TABLE_QUOTE_ROWS * 2 // two-column mode holds 2 symbols a row

// --- display width (east-asian-wide chars count as 2) ----------------------
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
/** cuts `s` to at most `width` display columns; no `…` marker, whose width is ambiguous on CJK terminals */
function clipTo(s: string, width: number): string {
  let out = ''
  let w = 0
  for (const ch of Array.from(s)) {
    w += charWidth(ch)
    if (w > width) break
    out += ch
  }
  return out
}

type Cell = { ch: string; fg?: string; bg?: string }

// --- a row of the band: cells with independent fg/bg, column-addressed -----
class Row {
  cells: Cell[] = []
  width(): number {
    return this.cells.reduce((w, c) => w + charWidth(c.ch), 0)
  }
  padTo(col: number) {
    while (this.width() < col) this.cells.push({ ch: ' ' })
  }
  put(col: number, text: string, fg?: string, bg?: string) {
    this.padTo(Math.max(0, col))
    for (const ch of Array.from(text)) this.cells.push({ ch, fg, bg })
  }
  putRight(right: number, text: string, fg?: string, bg?: string) {
    this.put(right - dispWidth(text), text, fg, bg)
  }
  /** right-align only if it still fits after what is already on the line */
  putRightIfFits(right: number, text: string, fg?: string, bg?: string): boolean {
    if (right - dispWidth(text) < this.width() + 1) return false
    this.putRight(right, text, fg, bg)
    return true
  }
  putCells(col: number, cells: Cell[]) {
    this.padTo(Math.max(0, col))
    for (const c of cells) this.cells.push(c)
  }
  // paint the whole line's background (the selected row in the reference
  // screenshot); cells that carry their own bg - the logo badges - keep it
  fillBg(bg: string, width: number) {
    this.padTo(width)
    this.cells = this.cells.map(c => ({ ...c, bg: c.bg ?? bg }))
  }
}

// groups consecutive same-color cells into one span; takes the Text tag as a
// parameter since Row is built before we are inside the component's JSX scope
function rowChildren(row: Row, Text: TextTag): RenderNode[] {
  const out: RenderNode[] = []
  let run: { text: string; fg?: string; bg?: string } | null = null
  const flush = () => {
    if (!run) return
    out.push(!run.fg && !run.bg ? run.text : <Text color={run.fg} backgroundColor={run.bg}>{run.text}</Text>)
    run = null
  }
  for (const c of row.cells) {
    if (run && run.fg === c.fg && run.bg === c.bg) run.text += c.ch
    else {
      flush()
      run = { text: c.ch, fg: c.fg, bg: c.bg }
    }
  }
  flush()
  return out
}

// --- number formatting (no Intl: the hooks sandbox is not guaranteed to have
// a full ICU build, and toFixed + a grouping regex is enough here) ----------
function thousands(value: number, decimals = 2): string {
  const neg = value < 0
  const [int, frac] = Math.abs(value).toFixed(decimals).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}
function signed(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return sign + thousands(Math.abs(value), decimals)
}

// up is red and down is green on the Taiwan boards (台股 and 台指期), the
// other way round on the US board - the whole reason this mod tracks which
// market it is showing
function tone(market: MarketId, value: number): string {
  if (value === 0) return FLAT
  const up = market === 'us' ? UP_GREEN : DOWN_RED
  const down = market === 'us' ? DOWN_RED : UP_GREEN
  return value > 0 ? up : down
}

type Layout = {
  badgeCol: number
  symCol: number
  nameCol: number
  priceCol: number
  priceRight: number
  chgRight: number
  pctRight: number
  showName: boolean
}

// right-anchored numeric columns, capped at 74 so the table does not stretch
// across a very wide terminal. Price is the widest and brightest column - it
// is the number this band is for. Under ~46 columns the name goes.
function layout(width: number): Layout {
  const w = Math.max(46, width)
  const pctRight = Math.min(w - 1, 74)
  const chgRight = pctRight - 9
  const priceRight = chgRight - 11
  const priceCol = priceRight - 10 // reserved for the widest price, e.g. 1,396.14
  const nameCol = 9
  return {
    badgeCol: 1,
    symCol: 1,
    nameCol,
    priceCol,
    priceRight,
    chgRight,
    pctRight,
    showName: priceCol - nameCol >= 8,
  }
}

// Two symbols per row, when the page holds more than 5 (register.tsx decides
// when; see BoardProps.columns). 變更$ has no room next to a second symbol,
// so each half only carries 代號/名稱/價格/變更%, right-anchored the same way
// the single-column table anchors them.
type HalfLayout = {
  symCol: number
  nameCol: number
  priceCol: number
  priceRight: number
  pctRight: number
  showName: boolean
}

const TWO_COL_MAX = 104 // two halves need more room than one table's 74-column cap
const TWO_COL_GUTTER = 6 // clear columns between the halves, so 變更% and the
// next 代號 do not read as one run of digits
// Half-width floor, left to right: 代號 up to 6 chars + 1 gap (7) + a
// 4-character name + 1 gap (9 - CJK counts double, so 4 characters is 8
// columns) + the widest price, e.g. "1,396.14", + 1 gap (9) + the widest
// 變更% field, e.g. "▼ -100.00%" (10). Below this a half cannot hold
// 代號 + a name + 價格 + 變更% without cutting one of them, so the two-column
// table falls back to the single-column one instead of squeezing:
// 7 + 9 + 9 + 10 = 35 per half, twice that plus the gutter = 76. `layout2`
// spends that 76 out of `width - 1`, the same one column short of the raw
// terminal width the single-column `layout` reserves - so the terminal
// itself needs to be 77 columns or wider, not 76, before two columns fit.
const MIN_HALF_WIDTH = 35
const MIN_TWO_COL_WIDTH = MIN_HALF_WIDTH * 2 + TWO_COL_GUTTER // 76, out of `width - 1`

function layout2(width: number): [HalfLayout, HalfLayout] {
  const cap = Math.min(width - 1, TWO_COL_MAX)
  const halfW = Math.floor((cap - TWO_COL_GUTTER) / 2)
  const mkHalf = (leftEdge: number): HalfLayout => {
    const pctRight = leftEdge + halfW
    const priceRight = pctRight - 11
    const priceCol = priceRight - 9
    const nameCol = leftEdge + 7
    return { symCol: leftEdge, nameCol, priceCol, priceRight, pctRight, showName: priceCol - nameCol >= 8 }
  }
  const left = mkHalf(1)
  const right = mkHalf(left.pctRight + 1 + TWO_COL_GUTTER)
  return [left, right]
}

/** whether a terminal this wide can lay out two readable halves - see MIN_TWO_COL_WIDTH */
function fitsTwoColumns(width: number): boolean {
  return Math.min(width - 1, TWO_COL_MAX) >= MIN_TWO_COL_WIDTH
}

// --- pnl (損益) layout -------------------------------------------------------
// One column of right-anchored numeric fields: 張數/成本/現價/今日%/今日損益/
// 總損益/損益%. The same right-to-left reservation style as `layout` above,
// capped so the table does not stretch across a very wide terminal.
type PnlLayout = {
  symCol: number
  nameCol: number
  qtyRight: number
  costRight: number
  priceRight: number
  todayPctRight: number
  todayPnlRight: number
  totalPnlRight: number
  totalPnlPctRight: number
  showName: boolean
}

// Field-width budget, right to left (each gap is the field's own width + one
// column of air before the next field starts): 損益% 8 ("+100.00%"), 總損益
// 12 ("+9,999,999" plus room), 今日損益 12 (same shape as 總損益), 今日% 8,
// 現價 9 ("99,999.00" - 成本/現價 carry 2 decimals unless the contract says
// otherwise, see priceDecimalsOf in the pnl branch), 成本 9, 張數 6 ("999.9"
// - qty/1000, at most one decimal; "-12 口" for futures - see qtyLabel), name
// 12 (up to ~6 CJK characters), sym 6. Without the
// name column this is 77 of an 80-column band (name needs another 13, which
// an 80-column band does not have) - `showName` drops it there the same way
// the watchlist table's own `showName` does, rather than let it collide with
// 張數 the way it once did (元大台灣50 10,000 -> "元大台灣5010,000").
function pnlLayout(width: number): PnlLayout {
  const w = Math.max(60, width)
  const totalPnlPctRight = Math.min(w - 1, 96)
  const totalPnlRight = totalPnlPctRight - 9
  const todayPnlRight = totalPnlRight - 13
  const todayPctRight = todayPnlRight - 13
  const priceRight = todayPctRight - 9
  const costRight = priceRight - 10
  const qtyRight = costRight - 10
  const nameCol = 8
  return {
    symCol: 1,
    nameCol,
    qtyRight,
    costRight,
    priceRight,
    todayPctRight,
    todayPnlRight,
    totalPnlRight,
    totalPnlPctRight,
    showName: qtyRight - nameCol >= 13,
  }
}

/**
 * `張數`: qty/1000 with only the decimals it needs: `2`, `0.5`, and `0.01` for
 * an odd lot of 10 shares (one decimal turned 10 shares into `0.0`). 台指期
 * counts 口 instead, signed: `-3 口` is a short of three, the sign being the
 * direction (a 賣 tag would not fit the 6-column budget).
 */
function qtyLabel(qty: number, market: MarketId): string {
  if (market === 'tf') return `${qty} 口`
  const lots = qty / 1000
  return Number.isInteger(lots) ? String(lots) : lots.toFixed(3).replace(/0+$/, '')
}

/** `hh:mm`, or `hh:mm:ss` when the stamp is under a minute old - a tick-fed file moves every second and the title should show it */
function hhmmLocal(ms: number, now = 0): string {
  if (!ms) return '--:--'
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const base = `${two(d.getHours())}:${two(d.getMinutes())}`
  return now && now - ms < 60_000 ? `${base}:${two(d.getSeconds())}` : base
}

/** `+11.11%` / `-11.11%` / `0.00%` */
function pct(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toFixed(2)}%`
}

// --- chart panel -----------------------------------------------------------
// Half-block cells, two levels per row. The first half-block attempt merged body
// and wick into one blob; a two-colour cell (`▀`, fg top / bg bottom) keeps them apart.
const AXIS_W = 10
const BAR_STRIDE = 2 // one candle column + one gap column while they fit
// past 120 bars one per column plus the axis, more width buys nothing
const CHART_RIGHT_CAP = 134
const VOLUME_ROWS = 2
const VOLUME_MIN_ROWS = 12 // under this the two volume rows would starve the plot
const REF_LINE = '#3d4450' // the 昨結 dotted line and the session-boundary rule
const REF_LABEL = '#5a6370'
const TAG_INK = '#0d1117' // text on the filled last-price tag
const LABEL_W = 5 // "HH:MM"
const TICK_GAP = 8 // columns a time label needs before the next may start

function darken(hex: string): string {
  const v = hex.replace('#', '')
  const parts = [0, 2, 4].map(i => Math.max(0, parseInt(v.slice(i, i + 2), 16) - 0x45))
  return `#${parts.map(p => p.toString(16).padStart(2, '0')).join('')}`
}

/** the 曲線 mode's area shade for a tone - dark enough to sit behind the line */
function shadeOf(color: string): string {
  return color === DOWN_RED ? '#3b1d1d' : color === UP_GREEN ? '#1b2f1f' : '#262b31'
}

/** rows of the chart view: title, plot rows, axis, volume rows (16+ rows only), footer */
type ChartGeom = { plot: number; volume: number; axisRow: number; footRow: number }
function chartGeom(rows: number, hasVolume: boolean): ChartGeom {
  const volume = rows >= VOLUME_MIN_ROWS && hasVolume ? VOLUME_ROWS : 0
  const plot = rows - 3 - volume
  return { plot, volume, axisRow: 1 + plot, footRow: rows - 1 }
}

/** the newest bars that fit, right-aligned to the axis like a broker's intraday chart */
type BarWindow = { bars: Bar[]; stride: number; col0: number }
function barWindow(bars: Bar[], width: number): BarWindow {
  const stride = bars.length * BAR_STRIDE > width ? 1 : BAR_STRIDE
  const slots = Math.max(1, Math.min(bars.length, Math.floor((width - 1) / stride) + 1))
  const shown = bars.slice(-slots)
  return { bars: shown, stride, col0: width - ((shown.length - 1) * stride + 1) }
}

type Scale = { hi: number; lo: number }
/** the plotted range: the bars plus the reference prices, so 昨結 and the last price are always on scale */
function priceScale(bars: Bar[], anchors: number[]): Scale {
  let hi = -Infinity
  let lo = Infinity
  for (const [, bh, bl] of bars) {
    if (bh > hi) hi = bh
    if (bl < lo) lo = bl
  }
  for (const a of anchors) {
    if (!(a > 0)) continue
    if (a > hi) hi = a
    if (a < lo) lo = a
  }
  return { hi, lo }
}
/** price -> pixel row over `levels` pixels, 0 at the top */
function toPixel(sc: Scale, levels: number, price: number): number {
  const span = sc.hi - sc.lo || 1
  return Math.min(levels - 1, Math.max(0, Math.round(((sc.hi - price) / span) * (levels - 1))))
}

/** [column][pixel row] colours; a hole is an unlit pixel */
type Pixels = (string | undefined)[][]
function blankPixels(width: number, levels: number): Pixels {
  return Array.from({ length: width }, () => Array.from({ length: levels }, () => undefined))
}
/** writes two pixel rows per cell into `rows`, leaving unlit cells as they were */
function halfBlocks(px: Pixels, rows: Cell[][]): void {
  for (let c = 0; c < px.length; c++) {
    for (let r = 0; r < rows.length; r++) {
      const top = px[c][2 * r]
      const bot = px[c][2 * r + 1]
      if (top && bot) rows[r][c] = top === bot ? { ch: '█', fg: top } : { ch: '▀', fg: top, bg: bot }
      else if (top) rows[r][c] = { ch: '▀', fg: top }
      else if (bot) rows[r][c] = { ch: '▄', fg: bot }
    }
  }
}

function candlePixels(win: BarWindow, market: MarketId, sc: Scale, width: number, plotRows: number): Pixels {
  const levels = plotRows * 2
  const px = blankPixels(width, levels)
  for (let i = 0; i < win.bars.length; i++) {
    const c = win.col0 + i * win.stride
    const [o, bh, bl, cl] = win.bars[i]
    const body = cl === o ? FLAT : tone(market, cl - o)
    const wick = darken(body)
    for (let p = toPixel(sc, levels, bh); p <= toPixel(sc, levels, bl); p++) px[c][p] = wick
    for (let p = toPixel(sc, levels, Math.max(o, cl)); p <= toPixel(sc, levels, Math.min(o, cl)); p++) px[c][p] = body
  }
  return px
}

/** each bar's volume as a 2-row half-block histogram in the bar's tone */
function volumePixels(win: BarWindow, market: MarketId, width: number): { px: Pixels; max: number } {
  const levels = VOLUME_ROWS * 2
  const px = blankPixels(width, levels)
  let max = 0
  for (const bar of win.bars) max = Math.max(max, bar[4] ?? 0)
  for (let i = 0; i < win.bars.length; i++) {
    const [o, , , cl, v] = win.bars[i]
    if (!v || !max) continue
    const c = win.col0 + i * win.stride
    const color = cl === o ? FLAT : tone(market, cl - o)
    const lit = Math.max(1, Math.round((v / max) * levels))
    for (let p = levels - lit; p < levels; p++) px[c][p] = color
  }
  return { px, max }
}

// braille: 2 dot columns x 4 dot rows per cell, so 16 rows are 52 levels for the line
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
/** 曲線: each close as a continuous braille line, the area to 昨結 (`refRow`, -1 = none) shaded */
function lineCells(
  win: BarWindow,
  sc: Scale,
  width: number,
  plotRows: number,
  color: string,
  refRow: number,
  rows: Cell[][],
): void {
  const levels = plotRows * 4
  const bits = new Uint8Array(width * plotRows)
  const lineRow: number[] = Array.from({ length: width }, () => -1)
  const dot = (x: number, y: number) => {
    const c = Math.floor(x / 2)
    const r = Math.floor(y / 4)
    if (c < 0 || c >= width || r < 0 || r >= plotRows) return
    bits[r * width + c] |= BRAILLE_BITS[y % 4][x % 2]
    // the shade starts at the line's cell nearest 昨結 in this column
    if (lineRow[c] < 0 || (refRow >= 0 && Math.abs(r - refRow) < Math.abs(lineRow[c] - refRow))) lineRow[c] = r
  }
  const pts = win.bars.map((bar, i) => ({ x: (win.col0 + i * win.stride) * 2 + 1, y: toPixel(sc, levels, bar[3]) }))
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1] ?? a
    for (let x = a.x; x <= b.x; x++) {
      const t0 = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
      const t1 = b.x === a.x ? 0 : Math.min(1, (x + 1 - a.x) / (b.x - a.x))
      const y0 = Math.round(a.y + (b.y - a.y) * t0)
      const y1 = x === b.x ? y0 : Math.round(a.y + (b.y - a.y) * t1)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) dot(x, y)
    }
  }
  const shade = shadeOf(color)
  for (let c = 0; c < width; c++) {
    const lr = lineRow[c]
    if (lr < 0) continue
    if (refRow >= 0) {
      const from = Math.min(lr, refRow + (lr < refRow ? 1 : 0))
      const to = Math.max(lr, refRow - (lr > refRow ? 1 : 0))
      for (let r = from; r <= to; r++) if (r !== refRow) rows[r][c] = { ...rows[r][c], bg: shade }
    }
    for (let r = 0; r < plotRows; r++) {
      const b = bits[r * width + c]
      if (b) rows[r][c] = { ch: String.fromCodePoint(0x2800 + b), fg: color, bg: rows[r][c].bg }
    }
  }
}

type AxisLabel = { row: number; text: string; fg: string; bg?: string }
/**
 * Price axis: last-price tag, 昨結, then hi / lo and a label every ~4 rows -
 * one per row and strictly decreasing as text, so no two rows read the same (the 47,428-twice screenshot).
 */
function priceAxis(
  sc: Scale,
  plotRows: number,
  perRow: number,
  digits: number,
  prevClose: number,
  price: number,
  color: string,
): AxisLabel[] {
  const rowOf = (p: number) => Math.floor(toPixel(sc, plotRows * perRow, p) / perRow)
  const value = (text: string) => Number(text.replace(/,/g, ''))
  const out: AxisLabel[] = []
  const place = (row: number, text: string, fg: string, bg?: string) => {
    for (const l of out) {
      if (l.row === row || l.text === text) return
      if (l.row < row ? value(l.text) <= value(text) : value(l.text) >= value(text)) return
    }
    out.push({ row, text, fg, bg })
  }
  if (price > 0) place(rowOf(price), thousands(price, digits), TAG_INK, color)
  if (prevClose > 0) place(rowOf(prevClose), thousands(prevClose, digits), REF_LABEL)
  const steps = Math.max(1, Math.round((plotRows - 1) / 4))
  const span = sc.hi - sc.lo
  for (let i = 0; i <= steps; i++) {
    const row = Math.round((i * (plotRows - 1)) / steps)
    place(row, thousands(sc.hi - (span * row) / (plotRows - 1), digits), DIM)
  }
  return out
}

type Tick = { col: number; label: string }
type TimeAxis = { ticks: Tick[]; boundaries: number[] }
/** "HH:MM" of a bucket start in the market's own clock */
function hhmmAt(ms: number, offsetHours: number): string {
  const d = new Date(ms + offsetHours * 3_600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
/**
 * Ticks from the bars' own stamps: first and last bar, each session boundary (a gap
 * over a bar and an hour), then round times at the finest step whose labels do not collide.
 */
function timeAxis(win: BarWindow, width: number, offsetHours: number): TimeAxis | undefined {
  const stamps = win.bars.map(b => b[5])
  if (stamps.length === 0 || stamps.some(t => !(typeof t === 'number' && t > 0))) return undefined
  const ts = stamps as number[]
  let interval = Infinity
  for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) interval = Math.min(interval, ts[i] - ts[i - 1])
  if (!Number.isFinite(interval)) interval = 5 * 60_000
  const colOf = (i: number) => win.col0 + i * win.stride
  const boundaries: number[] = []
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > Math.max(1.5 * interval, 3_600_000)) boundaries.push(i)
  const step = [5, 10, 15, 30, 60, 120, 240, 480, 720, 1440].find(
    m => m * 60_000 >= interval && (m * 60_000 * win.stride) / interval >= TICK_GAP,
  )
  const wanted: number[] = [0, ts.length - 1, ...boundaries]
  if (step) {
    for (let i = 0; i < ts.length; i++) {
      const d = new Date(ts[i] + offsetHours * 3_600_000)
      if ((d.getUTCHours() * 60 + d.getUTCMinutes()) % step === 0) wanted.push(i)
    }
  }
  const ticks: Tick[] = []
  for (const i of wanted) {
    const col = Math.min(colOf(i), width - LABEL_W)
    if (ticks.some(t => Math.abs(t.col - col) < LABEL_W + 1)) continue
    ticks.push({ col, label: hhmmAt(ts[i], offsetHours) })
  }
  return { ticks, boundaries: boundaries.map(i => colOf(i) - (win.stride - 1)) }
}

// halfway between two "HH:MM" strings, for the session axis (bars without stamps)
function midTime(from: string, to: string): string {
  const mins = (hm: string) => {
    const [hh, mm] = hm.split(':')
    return Number(hh) * 60 + Number(mm)
  }
  // a 夜盤 (15:00-05:00) runs past midnight, so its end is a day later
  const end = mins(to) <= mins(from) ? mins(to) + 1440 : mins(to)
  const mid = Math.floor((mins(from) + end) / 2) % 1440
  return `${String(Math.floor(mid / 60)).padStart(2, '0')}:${String(mid % 60).padStart(2, '0')}`
}

/** volume for the title readout and the volume axis: whole numbers, millions past that */
function volText(v: number): string {
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : thousands(v, 0)
}

/**
 * A quote row's 代號 (and 名稱, if there is room): flapped on a page turn -
 * ticker codes are all on the text drum, so they riffle properly - or wiped,
 * since a Chinese name has no drum to riffle through. Shared by the
 * single-column loop and each half of the two-column one, so a page turn
 * animates the same way in both.
 */
function drawSymbolCell(
  r: Row,
  symCol: number,
  nameCol: number,
  showName: boolean,
  q: QuoteRow,
  rowStart: number,
  turned: boolean,
): void {
  if (turned && rowStart !== RESTING) {
    const wasCode = q.was?.code ?? q.code
    const codeW = Math.max(dispWidth(q.code), dispWidth(wasCode))
    r.put(symCol, flapField(padRight(wasCode, codeW), padRight(q.code, codeW), TEXT_DRUM, rowStart, 0), SYMBOL)
    if (showName) {
      const wasName = q.was?.name ?? q.name
      const nameW = Math.max(dispWidth(q.name), dispWidth(wasName))
      // It is paced to land with the flaps rather than ahead of them.
      r.put(nameCol, wipeField(wasName, q.name, nameW, rowStart, flapSpan(1, 0)), DIM)
    }
  } else {
    r.put(symCol, q.code, SYMBOL)
    if (showName) r.put(nameCol, q.name, DIM)
  }
}

/**
 * One symbol inside a two-column table row: 代號/名稱/價格/變更% only, at the
 * given half's own columns. `slot` is this quote's position within its half
 * (0..4), which is what the row-turn stagger below is offset by - each half
 * turns independently, since a two-column row can hold two symbols whose
 * prices moved on different ticks, or one that did not move at all.
 */
function drawTwoColQuote(r: Row, half: HalfLayout, q: QuoteRow, market: MarketId, rowTurn: number, slot: number): void {
  const turned = q.was?.code !== undefined
  const rowStart = turned ? rowTurn - slot * PAGE_ROW_STAGGER : RESTING
  drawSymbolCell(r, half.symCol, half.nameCol, half.showName, q, rowStart, turned)

  if (q.noData) {
    r.putRight(half.priceRight, '—', DIM)
    r.putRight(half.pctRight, '—', DIM)
    return
  }

  const color = tone(market, q.pct)
  const digits = q.decimals ?? 2
  const pctText = (v: number) => `${v > 0 ? '▲' : v < 0 ? '▼' : '-'} ${signed(v)}%`
  const turn = q.was ? rowTurn - slot * (turned ? PAGE_ROW_STAGGER : ROW_STAGGER) : RESTING
  const was = q.was ?? q
  const stagger = turned ? 0 : STAGGER
  flapRight(r, half.priceRight, thousands(was.price, digits), thousands(q.price, digits), WHITE, turn, half.priceCol, stagger)
  flapRight(r, half.pctRight, pctText(was.pct), pctText(q.pct), color, turn, half.priceCol, stagger)
}

export default function StockBandBoard(props: BoardProps | undefined, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements

  // the pnl view draws holdings, not the watchlist: a holdings-only futures
  // user has no quotes at all (empty `futures`) and still gets the view
  if (!props || !props.quotes || (props.quotes.length === 0 && props.view !== 'pnl')) {
    return <Text dimColor>stock-band: waiting for quotes</Text>
  }

  // One listener per instance, for the same lifetime reason the frame clock
  // has one: onPointer keeps a single listener, and a remounted board gets a
  // fresh entry. Only a left press picks - a drag, a right button and the
  // hover moves all fall through, so the row under the pointer is the row the
  // user aimed at.
  let picker = pickers.get(surface)
  if (!picker) {
    const own: Picker = { hit: () => undefined }
    pickers.set(surface, own)
    picker = own
    surface.onPointer(e => {
      if (e.type !== 'down' || e.button !== 'left') return
      const result = own.hit(e.x, e.y)
      if (result !== undefined) surface.post(result)
    })
  }

  // A page turn changes the symbols as well as the numbers, so its wave has the
  // whole row to cross and gets the longer budget.
  const isPageTurn = props.quotes.some(q => q.was?.code !== undefined)
  const still = props.animation === 'off'
  // the dot only pulses on demo prices; on real ones it steps per snapshot
  const blinks = props.phase === 'open' && props.source === 'demo'

  // The animation is driven off the wall clock, not off a tick count, so a
  // late timer callback cannot drift the flip. The timer only asks for a
  // repaint when the visible frame actually changes: a 5-second hold costs no
  // frames at all, which keeps this at about the same repaint rate as the
  // blink alone used to be.
  if (!surface.state) {
    // the first snapshot is not an update, so the rows do not turn for it
    const seed: State = {
      frame: '',
      turn: props.turn,
      since: 0,
      flipMs: FLIP_MS,
      nextFeedAt: props.nextFeedAt,
      blinks,
    }
    surface.setState({ ...seed, frame: still ? stillFrameId(Date.now(), seed) : frameId(Date.now(), seed) })
  }

  // A still board only repaints for the countdown, so it wants one frame a
  // second; with the countdown off as well it wants no timer at all and simply
  // redraws when the hooks module says the prices changed.
  const wanted = still ? (props.countdown && props.nextFeedAt ? 1000 : 0) : ANIM_TICK_MS
  const running = frameClocks.get(surface)
  if (!running || running.ms !== wanted) {
    running?.cancel()
    // the entry is written even for `wanted === 0`, so a board that wants no
    // timer does not try to install one on every single render
    const cancel =
      wanted > 0
        ? surface.every(wanted, () => {
            const s = surface.state
            if (!s) return
            const id = wanted === 1000 ? stillFrameId(Date.now(), s) : frameId(Date.now(), s)
            if (s.frame !== id) surface.setState({ ...s, frame: id })
          })
        : () => {}
    frameClocks.set(surface, { ms: wanted, cancel })
  }

  // a new snapshot or a page change starts the rows turning; the next render
  // sees turn matched and leaves the state alone, so this cannot loop
  // The turn the rows are drawn against has to be THIS pass's turn, not the one
  // the last pass left behind. Reading the old state here drew the frame that
  // starts a turn with every row already settled on its new values, and the
  // flip only began on the next frame - the new page arrived first and the
  // animation played afterwards, which reads as a jump followed by noise
  // rather than as a turn.
  const st = surface.state
  let turning = st
  if (st && props.turn !== st.turn) {
    turning = {
      ...st,
      turn: props.turn,
      since: Date.now(),
      flipMs: isPageTurn ? PAGE_FLIP_MS : FLIP_MS,
      nextFeedAt: props.nextFeedAt,
      blinks,
    }
    surface.setState(turning)
  } else if (st && (props.nextFeedAt !== st.nextFeedAt || blinks !== st.blinks)) {
    turning = { ...st, nextFeedAt: props.nextFeedAt, blinks }
    surface.setState(turning)
  }
  const anim = still ? { slot: 0, flap: RESTING, blink: 0 } : animState(Date.now())
  const rowTurn = !still && turning ? rowFlap(Date.now(), turning.since, turning.flipMs) : RESTING
  const ticks = anim.blink
  const tillFeed = props.countdown ? secondsToFeed(Date.now(), props.nextFeedAt) : -1

  const lay = layout(surface.columns || 80)
  const open = props.phase === 'open'
  const rows = Array.from(
    { length: props.view === 'chart' ? Math.max(8, props.chartRows) : props.view === 'pnl' ? PNL_ROWS : TABLE_ROWS },
    () => new Row(),
  )
  const quotes = props.quotes.slice(0, MAX_TABLE_QUOTES)
  // the feed names itself - 證交所 即時 and Yahoo 即時 are not the same claim -
  // and only a source that did not say falls back to a generic label
  const sourceName =
    props.source === 'demo'
      ? '示範資料（未接 API）'
      : props.sourceLabel || (props.source === 'live' ? '即時報價' : '報價檔')
  // The version rides with the source tag so a wide band answers "which build
  // is this" without being asked, and a narrow one drops it first: which
  // prices you are looking at still matters more than which build drew them.
  const sourceTag = props.version ? `${sourceName} · ${props.version}` : sourceName
  // The demo tag is the longest thing this row ever carries, and it is the one
  // whose full form is optional: `示範資料` already says the prices are fake,
  // the parenthetical only says why. Shortening it buys eight columns of air
  // between the index block and the tail before anything has to be dropped.
  const sourceTagShort = props.source === 'demo' ? '示範資料' : sourceName
  // The band signs itself in the bottom-right corner. On a row too tight for
  // both, the data source wins: which prices you are looking at matters more
  // than who wrote the thing drawing them.
  const signOff = (row: Row, right: number) => {
    for (const tail of [
      `${sourceTag} · ${CREDIT}`,
      `${sourceTagShort} · ${CREDIT}`,
      sourceTag,
      sourceTagShort,
    ]) {
      if (row.putRightIfFits(right, tail, DIM)) return
    }
  }

  if (props.view === 'chart') {
    const focus = Math.max(0, Math.min(quotes.length - 1, props.focus))
    const q = quotes[focus]
    const color = tone(props.market, q.pct)
    const digits = q.decimals ?? 2
    const width = surface.columns || 80
    const chartRight = Math.max(lay.pctRight, Math.min(width - 1, CHART_RIGHT_CAP))
    const plotW = Math.max(10, chartRight - lay.badgeCol - AXIS_W)
    const bars = q.bars ?? []
    const hasVolume = bars.some(b => (b[4] ?? 0) > 0)
    const geom = chartGeom(rows.length, hasVolume)
    const win = barWindow(bars, plotW)
    const last = bars[bars.length - 1]

    // row 0: which symbol this is, its price, the last bar, what the bars are
    const title = rows[0]
    title.put(lay.symCol, q.code, SYMBOL)
    title.put(title.width() + 1, q.name, DIM)
    title.put(title.width() + 2, thousands(q.price, digits), WHITE)
    const arrow = q.pct > 0 ? '▲' : q.pct < 0 ? '▼' : '-'
    title.put(title.width() + 1, `${arrow} ${signed(q.change, digits)} (${signed(q.pct)}%)`, color)
    const readout = last
      ? `開 ${thousands(last[0], digits)} 高 ${thousands(last[1], digits)} 低 ${thousands(last[2], digits)} 收 ${thousands(last[3], digits)}` +
        (last[4] !== undefined ? ` 量 ${volText(last[4])}` : '')
      : ''
    // sheds the badge, then the readout, then the bar label - least essential first
    const badge = `${props.marketLabel} ${open ? `${SUN} 盤中` : `${MOON} 休市`}`
    const ladder: [string, string][] = [
      [readout, `${props.barLabel} · ${badge}`],
      [readout, props.barLabel],
      ['', `${props.barLabel} · ${badge}`],
      ['', props.barLabel],
      ['', badge],
    ]
    for (const [note, tag] of ladder) {
      if (note && title.width() + 2 + dispWidth(note) + 1 + dispWidth(tag) > chartRight) continue
      if (note) title.put(title.width() + 2, note, DIM)
      if (title.putRightIfFits(chartRight, tag, DIM)) break
    }

    // rows 1..plot: the plot, with the price axis on the right
    const plotCells: Cell[][] = Array.from({ length: geom.plot }, () =>
      Array.from({ length: plotW }, () => ({ ch: ' ' }) as Cell),
    )
    const axis = rows[geom.axisRow]
    if (bars.length === 0) {
      rows[1 + Math.floor(geom.plot / 2)].put(lay.badgeCol + 2, '沒有 K 棒資料（報價檔未提供 bars）', DIM)
    } else {
      const sc = priceScale(win.bars, [q.prevClose, q.price])
      const perRow = props.chartMode === 'line' ? 4 : 2
      const refRow = q.prevClose > 0 ? Math.floor(toPixel(sc, geom.plot * perRow, q.prevClose) / perRow) : -1
      const time = timeAxis(win, plotW, props.utcOffsetHours)
      // 昨結 and the session rules go under the bars, which overwrite them
      if (refRow >= 0) for (let c = 0; c < plotW; c++) plotCells[refRow][c] = { ch: '┈', fg: REF_LINE }
      for (const c of time?.boundaries ?? []) {
        if (c < 0 || c >= plotW) continue
        for (let r = 0; r < geom.plot; r++) plotCells[r][c] = { ch: '│', fg: REF_LINE }
      }
      if (props.chartMode === 'line') lineCells(win, sc, plotW, geom.plot, color, refRow, plotCells)
      else halfBlocks(candlePixels(win, props.market, sc, plotW, geom.plot), plotCells)
      for (let j = 0; j < geom.plot; j++) rows[1 + j].putCells(lay.badgeCol, plotCells[j])
      for (const l of priceAxis(sc, geom.plot, perRow, digits, q.prevClose, q.price, color)) {
        rows[1 + l.row].putRight(chartRight, l.text, l.fg, l.bg)
      }

      // the volume rows, under the axis, sharing the bars' columns
      if (geom.volume > 0) {
        const vol = volumePixels(win, props.market, plotW)
        const volCells: Cell[][] = Array.from({ length: geom.volume }, () =>
          Array.from({ length: plotW }, () => ({ ch: ' ' }) as Cell),
        )
        for (const c of time?.boundaries ?? []) {
          if (c >= 0 && c < plotW) for (let r = 0; r < geom.volume; r++) volCells[r][c] = { ch: '│', fg: REF_LINE }
        }
        halfBlocks(vol.px, volCells)
        for (let j = 0; j < geom.volume; j++) rows[geom.axisRow + 1 + j].putCells(lay.badgeCol, volCells[j])
        rows[geom.axisRow + 1].putRight(chartRight, `量 ${volText(vol.max)}`, DIM)
      }
    }

    // the time axis: the bars' own stamps when they carry them, else the session's bounds
    const time = bars.length > 0 ? timeAxis(win, plotW, props.utcOffsetHours) : undefined
    const axisCells: Cell[] = Array.from({ length: plotW }, () => ({ ch: '─', fg: RULE }) as Cell)
    const label = (col: number, text: string) => {
      const at = Math.max(0, Math.min(plotW - dispWidth(text), col))
      Array.from(text).forEach((ch, i) => (axisCells[at + i] = { ch, fg: DIM }))
    }
    if (time) for (const t of time.ticks) label(t.col, t.label)
    else {
      label(0, props.sessionOpen)
      label(Math.floor((plotW - LABEL_W) / 2), midTime(props.sessionOpen, props.sessionClose))
      label(plotW - LABEL_W, props.sessionClose)
    }
    axis.putCells(lay.badgeCol, axisCells)

    // the last row: where you are in the list, and the data source
    const foot = rows[geom.footRow]
    foot.put(lay.symCol, `${quotes.length} 檔中第 ${focus + 1} 檔`, DIM)
    signOff(foot, chartRight)
    // the table is not on screen here, so there is nothing under the pointer
    // to pick; the named buttons above the band move between symbols instead
    picker.hit = () => undefined
  } else if (props.view === 'pnl') {
    const lay = pnlLayout(surface.columns || 80)
    // 成本/現價 reuse the table's own price formatter - `thousands()` at 2
    // decimals, the same call the watchlist table's price column makes
    // regardless of market (e.g. 2,436.04) - unless the row carries its
    // contract's own `decimals` (futures). `decimals` stays market-dependent
    // for money that is NOT a price - 今日損益/總損益 and the totals row read
    // as integer TWD, the same way the rest of the band's TWD figures do (US
    // keeps cents throughout).
    const priceDecimalsOf = (row: Holding) => row.decimals ?? 2
    const decimals = props.market === 'us' ? 2 : 0
    const futures = props.market === 'tf'
    // register.tsx has already sorted the full list by props.pnlSortKey/Dir
    // and clamped holdingsScroll to it - this only slices the window and
    // marks which header cell is active.
    const holdings = props.holdings
    const scroll = props.holdingsScroll
    const page = holdings.slice(scroll, scroll + PNL_PAGE_SIZE)

    // row 0: title - what this is, where the numbers came from, how many
    // positions, and when the snapshot was taken. A demo price anywhere on
    // the band means these are demo prices too, so the title says so instead
    // of reading as a real portfolio.
    const title = rows[0]
    const demoTag = props.source === 'demo' ? ' · 示範價格' : ''
    title.put(
      lay.symCol,
      `${futures ? '期貨庫存損益' : '庫存損益'} · ${props.holdingsSource || '沒有庫存資料'} · ${holdings.length} 檔 · 更新 ${hhmmLocal(props.holdingsAt, props.now)}${demoTag}`,
      DIM,
    )

    // row 1: column headers, right-anchored the same way the watchlist
    // table's are. Five of them are sortable - the active one carries an
    // arrow (↓/↑) the way the watchlist header marks `↓變更%`, and this
    // records each sortable cell's own column span so the picker below can
    // hit-test a click against it without duplicating this layout a second
    // time.
    const head = rows[1]
    const sortHits: { key: PnlSortKey; x0: number; x1: number }[] = []
    const arrow = props.pnlSortDir === 'desc' ? '↓' : '↑'
    const sortable = (key: PnlSortKey, label: string) => (props.pnlSortKey === key ? `${arrow}${label}` : label)
    const putLeftSortable = (col: number, key: PnlSortKey, label: string) => {
      const text = sortable(key, label)
      head.put(col, text, HEAD)
      sortHits.push({ key, x0: col, x1: col + dispWidth(text) })
    }
    const putRightSortable = (right: number, key: PnlSortKey, label: string) => {
      const text = sortable(key, label)
      head.putRight(right, text, HEAD)
      sortHits.push({ key, x0: right - dispWidth(text), x1: right })
    }
    putLeftSortable(lay.symCol, 'code', '代號')
    if (lay.showName) head.put(lay.nameCol, '名稱', HEAD)
    head.putRight(lay.qtyRight, futures ? '口數' : '張數', HEAD)
    head.putRight(lay.costRight, '成本', HEAD)
    head.putRight(lay.priceRight, '現價', HEAD)
    putRightSortable(lay.todayPctRight, 'today', '今日%')
    putRightSortable(lay.todayPnlRight, 'todayPnl', '今日損益')
    putRightSortable(lay.totalPnlRight, 'totalPnl', '總損益')
    putRightSortable(lay.totalPnlPctRight, 'totalPnlPct', '損益%')
    // header cells only - no row is a click target yet (item 8 of the
    // original spec still holds for the data rows themselves)
    picker.hit = (x, y) => {
      if (y !== 1) return undefined
      const hit = sortHits.find(h => x >= h.x0 && x < h.x1)
      return hit ? { sortPnl: hit.key } : undefined
    }

    if (holdings.length === 0) {
      rows[2].put(
        lay.symCol,
        futures
          ? '沒有期貨庫存：永豐 fetcher 沒有回報任何部位'
          : '沒有庫存資料：寫 .claude/stock-holdings.json，或在 stock-band.json 加 holdings（見 README）',
        DIM,
      )
    } else {
      // rows 2..6: one holding a row, 5 per page - fewer than 5 on the last
      // page just leaves the remaining rows blank (filled with a
      // non-breaking space below, same as every other view). 現價/今日%/
      // 今日損益/總損益/損益% flap the same way the watchlist table's price/
      // change/pct do - same `rowTurn`, same `flapRight`/`flapField`, no
      // second animation system: a mount/page/sort turn flaps every visible
      // row (h.was.code set, see buildProps' pricedForDisplay), a live
      // price tick flaps only the rows that actually moved (h.was.price
      // alone, from quotesFile.prev - see pricedHoldings).
      for (let i = 0; i < page.length; i++) {
        const h = page[i]
        const r = rows[2 + i]
        const turned = h.was?.code !== undefined
        const rowStart = turned ? rowTurn - i * PAGE_ROW_STAGGER : RESTING

        // symbol/name cell - the same primitives drawSymbolCell (table)
        // uses, inlined because Holding and QuoteRow share no common type.
        // The name is clipped short of the 張數/口數 field: a contract name
        // from the fetcher (小型元大台灣50ETF期貨 202610) is twice the budget.
        const nameBudget = lay.qtyRight - 7 - lay.nameCol
        const name = clipTo(h.name, nameBudget)
        if (turned && rowStart !== RESTING) {
          const wasCode = h.was?.code ?? h.code
          const codeW = Math.max(dispWidth(h.code), dispWidth(wasCode))
          r.put(lay.symCol, flapField(padRight(wasCode, codeW), padRight(h.code, codeW), TEXT_DRUM, rowStart, 0), SYMBOL)
          if (lay.showName) {
            const wasName = clipTo(h.was?.name ?? h.name, nameBudget)
            const nameW = Math.max(dispWidth(name), dispWidth(wasName))
            r.put(lay.nameCol, wipeField(wasName, name, nameW, rowStart, flapSpan(1, 0)), DIM)
          }
        } else {
          r.put(lay.symCol, h.code, SYMBOL)
          if (lay.showName) r.put(lay.nameCol, name, DIM) // dim at rest too, as the table draws its names
        }

        // 張數/成本 never change intraday - drawn static, same as the
        // table's own 代號/名稱 columns on a plain price update
        const priceDecimals = priceDecimalsOf(h)
        r.putRight(lay.qtyRight, qtyLabel(h.qty, props.market), WHITE)
        r.putRight(lay.costRight, thousands(h.cost, priceDecimals), DIM)

        // × multiplier turns points into money (1 for stocks); qty carries the
        // direction, so a short's P&L rises when the price falls. 損益% is the
        // position's return (signed the same way), 今日% the contract's own move.
        const short = h.qty < 0 ? -1 : 1
        const todayPnl = (h.price - h.prevClose) * h.qty * h.multiplier
        const totalPnl = (h.price - h.cost) * h.qty * h.multiplier
        const totalPnlPct = h.cost ? (h.price / h.cost - 1) * 100 * short : 0
        const todayPct = h.prevClose ? (h.price / h.prevClose - 1) * 100 : 0

        const turn = h.was ? rowTurn - i * (turned ? PAGE_ROW_STAGGER : ROW_STAGGER) : RESTING
        const stagger = turned ? 0 : STAGGER
        // was-side values are derived from was.price using the CURRENT
        // cost/qty/prevClose (assumed stable within a tick) - exactly how
        // quoteRow() derives `was.change`/`was.pct` from `was.price` alone
        const wasPrice = h.was?.price ?? h.price
        const wasTodayPct = h.prevClose ? (wasPrice / h.prevClose - 1) * 100 : 0
        const wasTodayPnl = (wasPrice - h.prevClose) * h.qty * h.multiplier
        const wasTotalPnl = (wasPrice - h.cost) * h.qty * h.multiplier
        const wasTotalPnlPct = h.cost ? (wasPrice / h.cost - 1) * 100 * short : 0
        // one shared left anchor for the whole row's sweep, same role
        // lay.priceCol plays for the table (flapRight's own `left` param)
        const left = lay.priceRight - 9

        flapRight(r, lay.priceRight, thousands(wasPrice, priceDecimals), thousands(h.price, priceDecimals), WHITE, turn, left, stagger)
        flapRight(r, lay.todayPctRight, pct(wasTodayPct), pct(todayPct), tone(props.market, todayPct), turn, left, stagger)
        flapRight(r, lay.todayPnlRight, signed(wasTodayPnl, decimals), signed(todayPnl, decimals), tone(props.market, todayPnl), turn, left, stagger)
        flapRight(r, lay.totalPnlRight, signed(wasTotalPnl, decimals), signed(totalPnl, decimals), tone(props.market, totalPnl), turn, left, stagger)
        flapRight(r, lay.totalPnlPctRight, pct(wasTotalPnlPct), pct(totalPnlPct), tone(props.market, totalPnlPct), turn, left, stagger)
      }
    }

    // row 7: portfolio totals, over every holding (not just this page) -
    // the one number on this board that has to add up whichever page you
    // are looking at.
    // Signed sums carry the P&L (a short's exposure is negative), the |qty|
    // sums are what 市值/成本 print - gross notional, never negative - and
    // what 損益% is measured against. Identical for stocks, where qty > 0.
    const foot = rows[7]
    const value = holdings.reduce((sum, row) => sum + row.price * row.qty * row.multiplier, 0)
    const cost = holdings.reduce((sum, row) => sum + row.cost * row.qty * row.multiplier, 0)
    const notionalValue = holdings.reduce((sum, row) => sum + row.price * Math.abs(row.qty) * row.multiplier, 0)
    const notionalCost = holdings.reduce((sum, row) => sum + row.cost * Math.abs(row.qty) * row.multiplier, 0)
    const pnlTotal = value - cost
    const pnlTotalPct = notionalCost ? (pnlTotal / notionalCost) * 100 : 0
    const todayTotal = holdings.reduce((sum, row) => sum + (row.price - row.prevClose) * row.qty * row.multiplier, 0)
    let col = lay.symCol
    const put = (text: string, fg?: string) => {
      foot.put(col, text, fg)
      col = foot.width()
    }
    put('市值 ', DIM)
    put(thousands(notionalValue, decimals), WHITE)
    put('  成本 ', DIM)
    put(thousands(notionalCost, decimals), WHITE)
    put('  總損益 ', DIM)
    put(`${signed(pnlTotal, decimals)} (${pct(pnlTotalPct)})`, tone(props.market, pnlTotal))
    put('  今日 ', DIM)
    put(signed(todayTotal, decimals), tone(props.market, todayTotal))
  } else {
    // row 0: column headers. row 1: rule. The market name, session state,
    // hours and market clock used to open this view as its own title row;
    // they now live in the button row register.tsx draws above this Client
    // (that row also carries the market button), so the table starts
    // straight at the header - one fewer half-empty row on screen.
    //
    // Two-column mode also falls back to one column at render time when the
    // terminal is too narrow for a readable half, even if register.tsx asked
    // for two - see fitsTwoColumns.
    const halves = props.columns === 2 && fitsTwoColumns(surface.columns || 80) ? layout2(surface.columns || 80) : undefined
    const pctRight = halves ? halves[1].pctRight : lay.pctRight

    // rows 2..6 hold the quotes; row 0 is the header and row 1 the rule. In
    // two-column mode the left half owns everything up to its 變更% column and
    // the right half the rest, so the gutter between them belongs to the left
    // row rather than to nothing. A width-triggered fallback to one column
    // draws only the first five, so only those five can be picked.
    const pickable = halves ? quotes.length : Math.min(quotes.length, TABLE_QUOTE_ROWS)
    picker.hit = (x, y) => {
      const row = y - 2
      if (row < 0 || row >= TABLE_QUOTE_ROWS) return undefined
      const index = halves && x > halves[0].pctRight ? row + TABLE_QUOTE_ROWS : row
      return index < pickable ? { pick: index } : undefined
    }

    const head = rows[0]
    if (halves) {
      // Two symbols per row: 變更$ has no room next to a second symbol, so
      // each half only labels 代號/價格/變更%.
      for (const half of halves) {
        head.put(half.symCol, '代號', HEAD)
        head.putRight(half.priceRight, '價格', HEAD)
        head.putRight(half.pctRight, props.sorted ? '↓變更%' : '變更%', HEAD)
      }
    } else {
      head.put(lay.symCol, '代號', HEAD)
      head.putRight(lay.priceRight, '價格', HEAD)
      head.putRight(lay.chgRight, '變更$', HEAD)
      head.putRight(lay.pctRight, props.sorted ? '↓變更%' : '變更%', HEAD)
    }
    // the rule doubles as the page indicator: it is the one full-width line on
    // the board with nothing else competing for its right-hand end
    const pageTag = props.pageCount > 1 ? ` ${props.page + 1}/${props.pageCount} ` : ''
    const ruleW = Math.max(0, pctRight - lay.badgeCol - dispWidth(pageTag))
    rows[1].put(lay.badgeCol, '─'.repeat(ruleW), RULE)
    if (pageTag) rows[1].put(rows[1].width(), pageTag, DIM)

    // rows 2..6: one quote each in single-column mode, two in two-column mode
    // (the hooks module already sorted and trimmed the list to what fits).
    // register.tsx pages 10 at a time once it decides on two columns, so a
    // width-triggered fallback to one column here must still cap itself at
    // TABLE_QUOTE_ROWS (5) rather than looping over all 10 it was handed -
    // there are only 5 single-column rows on the board to draw into.
    const single = halves ? [] : quotes.slice(0, TABLE_QUOTE_ROWS)
    let topMover = 0
    for (let i = 1; i < single.length; i++) {
      if (Math.abs(single[i].pct) > Math.abs(single[topMover].pct)) topMover = i
    }

    if (halves) {
      // Column-major off the existing sort: the left half is ranks 1..5, the
      // right half ranks 6..10, so the biggest gainers head the left column
      // and the biggest fallers end the right one under the default change%
      // sort. There is no single "this row" to stripe when it can hold two
      // unrelated symbols, so the top-mover highlight is single-column only.
      for (let i = 0; i < TABLE_QUOTE_ROWS; i++) {
        const r = rows[2 + i]
        const left = quotes[i]
        const right = quotes[i + TABLE_QUOTE_ROWS]
        if (left) drawTwoColQuote(r, halves[0], left, props.market, rowTurn, i)
        if (right) drawTwoColQuote(r, halves[1], right, props.market, rowTurn, i)
      }
    } else {
      for (let i = 0; i < single.length; i++) {
        const q = single[i]
        const r = rows[2 + i]
        // A page turn is a row turn that also changes the symbol, so the wave
        // starts at the left edge and the two text columns turn with the
        // numbers. A price update leaves them alone - they did not change,
        // and a real board does not flap what did not change.
        const turned = q.was?.code !== undefined
        const rowStart = turned ? rowTurn - i * PAGE_ROW_STAGGER : RESTING
        drawSymbolCell(r, lay.symCol, lay.nameCol, lay.showName, q, rowStart, turned)

        if (q.noData) {
          r.putRight(lay.priceRight, '—', DIM)
          r.putRight(lay.chgRight, '—', DIM)
          r.putRight(lay.pctRight, '—', DIM)
          continue
        }

        const color = tone(props.market, q.pct)
        const digits = q.decimals ?? 2
        const pctText = (v: number) => `${v > 0 ? '▲' : v < 0 ? '▼' : '-'} ${signed(v)}%`
        // A row turns only when its price actually moved: flapping a number
        // that did not change is noise, and a real board flaps only what
        // changed. Each field's wave front is offset by its own column, so
        // the numbers turn as one sweep across the row instead of at the
        // same instant. The wave starts at the first number, not at the left
        // edge: the symbol and the name never change, and a front that
        // crawls across them spends the whole turn before it reaches
        // anything that moves. Rows lag each other slightly so the board
        // turns top to bottom, like a departures board. A price update
        // sweeps left to right from the price column, because only the
        // numbers changed and the sweep has nothing to contradict. A page
        // turn changed the symbol too, so its columns turn together
        // (stagger 0) and land on one frame - no window where the name and
        // the price belong to different companies.
        const turn = q.was ? rowTurn - i * (turned ? PAGE_ROW_STAGGER : ROW_STAGGER) : RESTING
        const was = q.was ?? q
        const left = lay.priceCol
        const stagger = turned ? 0 : STAGGER
        flapRight(r, lay.priceRight, thousands(was.price, digits), thousands(q.price, digits), WHITE, turn, left, stagger)
        flapRight(r, lay.chgRight, signed(was.change, digits), signed(q.change, digits), color, turn, left, stagger)
        flapRight(r, lay.pctRight, pctText(was.pct), pctText(q.pct), color, turn, left, stagger)
        if (props.highlight && i === topMover) r.fillBg(ROW_HILIGHT, lay.pctRight)
      }
    }

    // row 7: the index board on the left, and on the right the clock/收盤
    // stamp, the live dot and the feed countdown - moved down here from the
    // old title row, so they can keep running off THIS Client's own frame
    // clock rather than a static row the hook tree draws once. With more than
    // one index the left side is a split-flap: the card holds, folds, and the
    // next index is there. One index (Taiwan, or a feed that answered with
    // only one) just sits still - the flip has nothing to turn to.
    const foot = rows[7]
    const board = props.indices.length > 0 ? props.indices : [props.index]
    const slot = board.length > 1 ? anim.slot % board.length : 0
    const idx = board[slot]
    const widths = cardWidths(board)
    const to = cardFields(idx, widths, props.market)
    const outgoing = board[(slot + board.length - 1) % board.length]
    const from = cardFields(outgoing, widths, props.market)
    // one index has nothing to turn to, so it never flaps
    const flap = board.length > 1 ? anim.flap : RESTING

    // the wave carries on across the field boundaries: each field's flaps start
    // where the previous field's left off, so the row turns as one board
    let offset = 0
    for (let f = 0; f < to.length; f++) {
      const text = flapField(from[f].text, to[f].text, to[f].drum, flap - offset)
      foot.put(f === 0 ? lay.symCol : foot.width() + 1, text, to[f].fg)
      offset += dispWidth(to[f].text) + 1
    }
    // The dot is the only thing on this board that says "still live", so it
    // has to move for a reason. On real quotes it flips once per snapshot the
    // feed accepted: a dead feed leaves it frozen. Demo prices change on every
    // redraw, so there the board's own timer is the honest signal.
    const beat = props.source === 'demo' ? ticks : props.seq
    // Open: the bare clock - its place at the row's right end already says
    // this is a live stamp, so 更新 repeated that. Closed: 收盤 HH:MM, since
    // a bare clock there could read as still updating.
    putFooterTail(
      foot,
      pctRight,
      open ? props.clock : `收盤 ${props.clock}`,
      open ? (beat % 2 === 0 ? '●' : '○') : '',
      tillFeed >= 0 ? ` · ${tillFeed}s` : '',
      sourceTag,
      sourceTagShort,
    )
  }

  // an empty <Text> collapses to zero height, so blank rows hold a
  // non-breaking space to keep their line
  for (const r of rows) if (r.cells.length === 0) r.cells.push({ ch: '\u00a0' })
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Text>{rowChildren(r, Text)}</Text>
      ))}
    </Box>
  )
}
