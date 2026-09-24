// The market tab row: stops, cycle order, labels and their display widths.

import { MARKETS } from './markets.ts'
import type { MarketId } from './markets.ts'

// The market button is the title itself, and its label is just the stop ON
// THE BAND, nothing else: 美股 ▾ / 台股 ▾ for a table stop, 美股庫存 ▾ /
// 台股庫存 ▾ for a pnl stop. It used to append 固定 to distinguish a pinned
// market from the same market in auto mode, which is a distinction the
// label has no business carrying: the two draw identical boards and only
// differ hours later, at the handover.
//
// This is now ONLY the `select` style's on-screen width proxy (leftCoreWidth
// below) - the ▾ suffix reads as "opens a dropdown", which is what `select`
// actually draws. `cycle`'s own Button (mobile's fallback, an explicit
// `marketSwitcher: "cycle"`, or `tabs` collapsing for width - see
// cycleButtonLabel) draws a different label shape now, `‹ 美股 2/5 ›`, so it
// no longer borrows this function's ▾ text.
export function marketButtonLabel(marketLabel: string, pnl: boolean): string {
  return `${marketLabel}${pnl ? '庫存' : ''} ▾`
}

// The `select` style's own prefix. The width budget below and the Select
// element itself must read the SAME constant: the framework draws this text
// before the value, so a budget that leaves it out under-counts the control
// by its width and can keep the Taipei restatement on screen after it stops
// fitting. The label costs `市場` plus the framework's own separator, which a
// hook cannot measure - SELECT_LABEL_CHROME_COLS covers that separator.
export const MARKET_SELECT_LABEL = '市場'
export const SELECT_LABEL_CHROME_COLS = 2

// A stop's packed identity: the plain MarketId for a table stop, or
// `${MarketId}:pnl` for that market's holdings stop - see marketStops()/
// onSelectMarket. crypto never gets the `:pnl` half (see marketStops()'s own
// comment), so only tw/us/tf ever carry one.
export type MarketSelectValue = MarketId | 'tw:pnl' | 'us:pnl' | 'tf:pnl'

/** one stop any of the market-switcher styles can land on */
export type MarketStop = { value: MarketSelectValue; market: MarketId; pnl: boolean; label: string }

/** one stop on the market button's cycle - a market's table, or its pnl view */
export type CycleStop = { market: MarketId; pnl: boolean }

export function sameStop(a: CycleStop, b: CycleStop): boolean {
  return a.market === b.market && a.pnl === b.pnl
}

// A stop's label is just the stop ON THE BAND, nothing else: 美股 / 台股 for
// a table stop, 美股庫存 / 台股庫存 / 期貨庫存 for a pnl stop (MARKETS'
// holdingsLabel - 期貨庫存, not 台指期庫存).
function stopLabel(stop: CycleStop): string {
  const conf = MARKETS[stop.market]
  return stop.pnl ? conf.holdingsLabel : conf.label
}

export function stopOf(market: MarketId, pnl: boolean): MarketStop {
  const value = (pnl ? `${market}:pnl` : market) as MarketSelectValue
  return { value, market, pnl, label: stopLabel({ market, pnl }) }
}

/** `select`'s own options - a marketStops() list's value/label, in the same order */
export function marketSelectOptions(stops: MarketStop[]): { value: MarketSelectValue; label: string }[] {
  return stops.map(({ value, label }) => ({ value, label }))
}

/**
 * The market button's cycle, in marketStops() order: 台股 → [台股庫存] →
 * [台指期] → [期貨庫存] → 美股 → [美股庫存] → 加密貨幣 → back to 台股. A
 * market's pnl stop is only in the cycle when marketStops() included it
 * (holdings actually exist for that market) - see marketStops()'s own doc
 * comment for why that has to be a live check, not a fixed list. `cycle`'s
 * "n/total" label (see cycleButtonLabel) reads its denominator off
 * `cycle.length` at the call site, so a stop count that grows or shrinks
 * with the data never makes that label lie.
 * This is what mobile still walks with a single button (no `ui_select`
 * message yet - see the Select capability check in AbovePrompt's
 * ui.render), what an explicit `marketSwitcher: "cycle"` always draws, and
 * what `tabs` falls back to when the terminal is too narrow for its own
 * Buttons (see tabsGroupWidth). `select` never walks this at all - a
 * dropdown names the destination outright, there is no "next stop" to
 * compute.
 */
export function buildCycle(stops: MarketStop[]): CycleStop[] {
  return stops.map(({ market, pnl }) => ({ market, pnl }))
}

/**
 * The stop after `current`. `current` is always whichever stop is ACTUALLY
 * on screen right now, auto-picked-by-clock or pinned - buildProps already
 * resolves `market`/`view` that way, so the very first press (still in
 * `auto`) lands on the next stop after whatever the clock was already
 * showing, never a jump back onto the stop already on screen. `cycle` is
 * this render's own `buildCycle(marketStops(config))` - passed in rather
 * than rebuilt here, so a single render only computes `marketStops()` once
 * (see AbovePrompt's ui.render).
 */
export function nextCycleStop(current: CycleStop, cycle: CycleStop[]): CycleStop {
  const idx = cycle.findIndex(s => s.market === current.market && s.pnl === current.pnl)
  return cycle[(idx < 0 ? 0 : idx + 1) % cycle.length]
}

/**
 * `cycle`'s own label - the one Button shared by mobile's fallback, an
 * explicit `marketSwitcher: "cycle"`, and `tabs`'s narrow-terminal fallback
 * (see tabsGroupWidth): `‹ 美股 2/5 ›`, current stop name plus its position
 * in the cycle out of the total, so a press's destination and "how many more
 * presses to get back here" are both on the button before it is pressed.
 */
export function cycleButtonLabel(marketLabel: string, pnl: boolean, pos: number, total: number): string {
  return `‹ ${marketLabel}${pnl ? '庫存' : ''} ${pos}/${total} ›`
}

/**
 * `tabs`'s own per-stop label - a stop's full `美股庫存` shortens to
 * `·庫存` here: the holdings Button always draws immediately after its
 * market's own Button (see marketStops()'s order), so adjacency alone says
 * which market it belongs to and the label does not have to repeat the name.
 */
export function tabLabel(stop: MarketStop): string {
  return stop.pnl ? '·庫存' : stop.label
}

/**
 * What `tabs`'s Buttons cost in columns: every label's display width, plus
 * one column for each gap the row draws between them (see the explicit
 * `<Text> </Text>` siblings in the tabs row below) - same "no way to measure
 * what the framework actually renders" caveat marketLabel's own comment
 * already carries for `select`/`cycle`; this reservation is the label text
 * alone, not the Button chrome around it. Computed off however many stops
 * `stops` actually holds (see marketStops()) - a market with no holdings
 * draws one fewer Button, so this must shrink with it rather than assume a
 * fixed count. The tabs-fit check in AbovePrompt's ui.render adds
 * RIGHT_BUTTON_GROUP_COLS's own 40-column reservation on top of this before
 * deciding whether tabs fit, the same "budget vs `cols`" shape showTaipei
 * already uses.
 */
export function tabsGroupWidth(stops: MarketStop[]): number {
  const labels = stops.map(tabLabel)
  return labels.reduce((sum, l) => sum + dispWidth(l), 0) + (labels.length - 1)
}

// The fork's tab row (`tabbar`): one plain Button per stop; the stop on
// screen reads `[台指期]` at full strength, every other tab is dimColor.
// Plain (no `[ label ]` chrome) so six tabs cost ~45 columns, not ~67.
export function forkTabLabel(stop: MarketStop, current: CycleStop): string {
  return sameStop(stop, current) ? `[${stop.label}]` : stop.label
}
export function tabKey(stop: CycleStop): string {
  return `stock-band:tab:${stop.market}${stop.pnl ? ':pnl' : ''}`
}
/** display width of the whole fork tab row: labels, single-space gaps, the mark's brackets */
export function tabRowWidth(stops: MarketStop[]): number {
  return stops.reduce((w, s) => w + dispWidth(s.label), 0) + Math.max(0, stops.length - 1) + 2
}

// --- the title/button row ----------------------------------------------
// This module draws the row directly with Box/Text/Button (docs/api-notes.md:
// a Client surface has no Button), so it needs its own copies of the colors
// and the display-width math board.tsx uses for the same session badge - the
// two files never import each other (a Client module loads by literal path
// only; see docs/api-notes.md).
export const ORANGE = '#d97757'
export const MOON_BLUE = '#8ab4f8' // the closed-session moon, so 休市 still reads at a glance
export const DIM = '#6e7681'
export const SUN = '☀'
export const MOON = '☽'

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
export function dispWidth(s: string): number {
  let w = 0
  for (const ch of Array.from(s)) w += charWidth(ch)
  return w
}

// rough width of the right-hand button group (翻頁 X/Y, 趨勢圖, 收起 30分, plus
// the gaps a Button draws around its own label) - there is no way to measure
// what the framework actually renders from inside the hook, so the left group
// treats this as a fixed reservation when it decides which of the session
// notes / badge after the tabs still fit.
export const RIGHT_BUTTON_GROUP_COLS = 40
