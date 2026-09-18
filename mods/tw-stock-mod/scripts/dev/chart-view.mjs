// The chart view at its two seams - the ui.render tree (control row + Client
// props) and board.tsx rendered to text (#12, band half): a configurable
// height (chartRows, default 16, clamped to maxRows - 2), a y axis whose
// labels never repeat (the 47,428-twice screenshot), the 昨結 dotted line and
// last-price tag, an x axis read off the bars' own timestamps (19:40-23:00
// bars must not print the session's 15:00 / 05:00), one bar per column when
// they would not fit two apart, volume rows at 16 rows and none at 8,
// timeframe buttons that switch bars + label, the 曲線 mode's braille line and
// shaded area, the title readout, and a row with 4-element bars keeping the
// old session axis with no timeframe buttons.
//
// Usage: node chart-view.mjs $OUT/register.js $OUT/board.js <tf-proj> <tw-proj>
// <tf-proj> pins tf with a `futures` list (the harness writes its runtime-dir
// futures-quotes.json: six-element bars plus a barsBy block on TXFR1, bars
// alone on SRFJ6); <tw-proj> pins tw, feed off, with a project-level
// stock-quotes.json whose bars are the old [o, h, l, c] shape.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, tfDir, twDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const CLOCK = taipei(17, 23, 0) + 30_000 // Thursday 23:00:30 台北: 夜盤 open
const runtimeDirFor = dir => `${dir}/home/.claude/stock-band/${dir.replace(/^\/+/, '').replace(/\//g, '-')}/`
const COLS = 120

// --- fixture bars ------------------------------------------------------------
// A deterministic walk: `[o, h, l, c, v, ts]`, ts = bucket start in ms.
function walk(start, count, stepMs, firstTs, amp, dec) {
  const r = v => Number(v.toFixed(dec))
  const out = []
  let p = start
  for (let i = 0; i < count; i++) {
    const o = p
    const c = r(o + amp * (Math.sin(i * 0.7) + 0.4 * Math.cos(i * 1.9)))
    const hi = r(Math.max(o, c) + amp * 0.3 * (1 + Math.sin(i * 1.3) ** 2))
    const lo = r(Math.min(o, c) - amp * 0.3 * (1 + Math.cos(i * 0.9) ** 2))
    out.push([o, hi, lo, c, 100 + ((i * 37) % 53), firstTs + i * stepMs])
    p = c
  }
  return out
}
const MIN = 60_000
const TXF_5 = walk(47420, 40, 5 * MIN, taipei(17, 19, 40), 30, 0) // 19:40 .. 22:55
const TXF_1 = walk(47480, 120, MIN, taipei(17, 21, 0), 12, 0) // 21:00 .. 22:59
const TXF_15 = walk(47380, 32, 15 * MIN, taipei(17, 15, 0), 45, 0) // 15:00 .. 22:45
// 60 分: 夜盤 Wed 15:00-04:00, 日盤 Thu 08:00-13:00, 夜盤 Thu 15:00-22:00 -
// two session boundaries for the axis rule
const TXF_60 = [
  ...walk(47200, 14, 60 * MIN, taipei(16, 15, 0), 60, 0),
  ...walk(47350, 6, 60 * MIN, taipei(17, 8, 0), 60, 0),
  ...walk(47400, 8, 60 * MIN, taipei(17, 15, 0), 60, 0),
]
const SRF_5 = walk(109.4, 40, 5 * MIN, taipei(17, 19, 40), 0.25, 2)
// a 2-point range at 0 decimals: interpolated labels round to the same text
// (47,429 twice) unless the axis dedups them - the screenshot's bug, in miniature
const MXF_5 = Array.from({ length: 30 }, (_, i) => [47429, 47430, 47428, i % 2 ? 47430 : 47429, 40 + (i % 7), taipei(17, 20, 30) + i * 5 * MIN])
const SRF_PREV = Number((SRF_5[SRF_5.length - 1][3] + 0.3).toFixed(2)) // a down day, so it sorts behind TXFR1
const futuresFile = asOf => ({
  asOf,
  dataAt: asOf - 5_000,
  market: 'tf',
  source: '永豐',
  barLabel: '5 分 K（永豐）',
  quotes: {
    TXFR1: {
      price: TXF_5[TXF_5.length - 1][3], prevClose: 47428, name: '臺股期貨 近月', multiplier: 200, decimals: 0, resolved: 'TXFJ6',
      bars: TXF_5,
      barsBy: { 1: TXF_1, 5: TXF_5, 15: TXF_15, 60: TXF_60 },
    },
    MXFR1: { price: 47430, prevClose: 47428, name: '小型臺指 近月', multiplier: 50, decimals: 0, resolved: 'MXFJ6', bars: MXF_5 },
    SRFJ6: { price: SRF_5[SRF_5.length - 1][3], prevClose: SRF_PREV, name: '小型元大台灣50ETF期貨 202610', multiplier: 1000, decimals: 2, bars: SRF_5 },
  },
})
const writeFutures = async (dir, asOf) => {
  const runtime = runtimeDirFor(dir)
  await mkdir(runtime, { recursive: true })
  await writeFile(`${runtime}futures-quotes.json`, JSON.stringify(futuresFile(asOf)))
}

/** boots one fresh register.js against `dir`; `tag` defeats the ESM module cache */
async function boot(dir, tag) {
  const timers = []
  let invalidates = 0
  const home = `${dir}/home`
  await mkdir(`${home}/.claude`, { recursive: true })
  const $ = {
    clock: { now: async () => CLOCK, every: (ms, fn) => timers.push(fn) },
    fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${dir}/${p}`)).toString() },
    ui: { log: () => {}, invalidate: () => { invalidates++ }, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
    http: { fetch: async () => ({ ok: false, status: 404, text: '' }) },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('chart-view: no spawn expected') } },
  }
  // a previous run's setConfig may have left chartRows behind in a reused fixture dir
  {
    const cfgPath = `${dir}/.claude/stock-band.json`
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
    delete cfg.chartRows
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2))
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  /** `hostProps` stands in for the AbovePrompt props (`maxRows`); the stubs elsewhere pass {} */
  const draw = async (hostProps = {}) => {
    const tree = await handlers.get('ui.render')($, { props: hostProps, surface: 'terminal', viewport: { columns: COLS } }, async () => ({ kids: [] }))
    const btns = []; let props; let client
    const walkTree = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') { props = n.props.props; client = n.props }
      if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress, key: n.props.key })
      for (const k of [...(n.kids ?? []), n.props?.children]) walkTree(k) }
    walkTree(tree)
    return { btns, props, client }
  }
  const poll = async () => {
    const before = invalidates
    for (const fn of timers) fn()
    for (let i = 0; i < 200 && invalidates === before; i++) await new Promise(r => setTimeout(r, 10))
    if (invalidates === before) throw new Error('poll never finished')
  }
  const setConfig = async patch => {
    const cur = JSON.parse(await readFile(`${dir}/.claude/stock-band.json`, 'utf8'))
    await writeFile(`${dir}/.claude/stock-band.json`, JSON.stringify({ ...cur, ...patch }, null, 2))
    await poll()
  }
  return { draw, poll, setConfig }
}

// board.tsx rendered twice (the first pass seeds its state), then read back as
// rows of spans `{ text, fg, bg }` - the colours are what the shaded area and
// the price tag are made of, so plain text is not enough here
const board = (await import(boardPath)).default
const render = props => {
  let state
  const surface = {
    columns: COLS, rows: 40,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const spans = (node, acc, fg, bg) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push({ text: String(node), fg, bg }); return acc }
    if (Array.isArray(node)) { for (const n of node) spans(n, acc, fg, bg); return acc }
    const f = node.props?.color ?? fg
    const b = node.props?.backgroundColor ?? bg
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) spans(k, acc, f, b)
    return acc
  }
  return (out.kids ?? []).map(row => spans(row, [], undefined, undefined))
}
const textOf = rows => rows.map(r => r.map(s => s.text).join(''))
const show = lines => { for (const l of lines) console.log('|' + l + '|') }
const grouped = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const CANDLE = /[▀▄█]/
const BRAILLE = /[\u2800-\u28ff]/
/** columns (0-based display cols, ASCII-only rows) that hold a candle glyph in any of `rows` */
const candleCols = rows => {
  const cols = new Set()
  for (const line of rows) for (let i = 0; i < line.length; i++) if (CANDLE.test(line[i])) cols.add(i)
  return [...cols].sort((a, b) => a - b)
}
/** the axis labels of `rows`, top to bottom: the last numeric token on each line */
const axisNumbers = rows =>
  rows.map(l => l.match(/-?[\d,]+(?:\.\d+)?(?=\s*$)/)?.[0]).filter(Boolean).map(s => Number(s.replace(/,/g, '')))
const strictlyDecreasing = a => a.every((v, i) => i === 0 || v < a[i - 1])
const hhmmOf = ms => { const d = new Date(ms + TAIPEI * 3_600_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` }
const undefinedPaths = (v, path = 'props', acc = []) => {
  if (v === undefined) acc.push(path)
  else if (Array.isArray(v)) v.forEach((x, i) => undefinedPaths(x, `${path}[${i}]`, acc))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) undefinedPaths(x, `${path}.${k}`, acc)
  return acc
}

// ============================================================================
await writeFutures(tfDir, CLOCK - 10_000)
const band = await boot(tfDir, 'tf')

// --- 16 rows by default, the whole layout --------------------------------------
let { props: q, btns, client } = await band.draw()
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns, client } = await band.draw())
let rows = render(q)
let lines = textOf(rows)
console.log(`chart: view=${q.view} focus=${q.quotes[q.focus]?.code} bars=${q.quotes[q.focus]?.bars?.length} label=${q.barLabel} rows=${lines.length}`)
console.log('buttons:', btns.map(b => `[${b.label}]`).join(' '))
show(lines)
ok(q.view === 'chart' && q.quotes[q.focus]?.code === 'TXFR1', `chart opened on TXFR1: ${q.quotes[q.focus]?.code}`)
ok(undefinedPaths(q).length === 0, `no undefined anywhere in the Client props: ${undefinedPaths(q).slice(0, 3).join(', ') || 'clean'}`)
ok(q.chartRows === 16, `chartRows absent -> 16: ${q.chartRows}`)
ok(lines.length === 16, `the board draws 16 rows: ${lines.length}`)
ok(client?.height === 16, `Client height follows chartRows: ${client?.height}`)
ok(q.quotes[q.focus]?.bars?.length === 40 && q.quotes[q.focus].bars[0].length === 6, `40 six-element bars reached the board: ${q.quotes[q.focus]?.bars?.length} x ${q.quotes[q.focus]?.bars?.[0]?.length}`)
const PLOT = lines.slice(1, 12) // rows 1..11 at 16 rows: 11 plot rows, 22 levels
const AXIS = lines[12] ?? ''
const VOL = lines.slice(13, 15)
let ys = axisNumbers(PLOT)
console.log('y labels:', ys.join(' > '))
ok(ys.length >= 3, `at least three y labels: ${ys.length}`)
ok(new Set(ys).size === ys.length, `no two y labels are equal (the 47,428-twice bug): ${ys.join(', ')}`)
ok(strictlyDecreasing(ys), `y labels strictly decreasing top to bottom: ${ys.join(' > ')}`)
ok(ys.slice(1, -1).every(v => v < ys[0] && v > ys[ys.length - 1]), `every middle label lies strictly between hi ${ys[0]} and lo ${ys[ys.length - 1]}`)
ok(ys.includes(47428), '昨結 47,428 is one of the axis labels')
ok(PLOT.some(l => l.includes('┈')), 'the 昨結 dotted line runs across the plot')
const PRICE = TXF_5[TXF_5.length - 1][3]
ok(ys.includes(PRICE), `the last price ${PRICE} is tagged on the axis`)
const tagSpan = rows.slice(1, 12).flat().find(s => s.text.includes(grouped(PRICE)))
ok(tagSpan?.bg !== undefined, `the last-price tag is drawn as a filled tag (bg set): ${JSON.stringify(tagSpan)}`)
ok(AXIS.includes('19:40') && AXIS.includes('22:55'), `first and last bar labelled on the x axis: ${AXIS.trim()}`)
ok(AXIS.includes('21:00') && AXIS.includes('22:00'), `round-time ticks on the x axis: ${AXIS.trim()}`)
ok(!AXIS.includes('15:00') && !AXIS.includes('05:00'), 'the session bounds 15:00 / 05:00 are gone from the axis')
ok(VOL.some(l => CANDLE.test(l)), 'two volume rows under the axis at 16 rows')
ok((lines[15] ?? '').includes('檔中第') , `row 16 is the footer: ${(lines[15] ?? '').trim()}`)
let cols5 = candleCols(PLOT)
ok(cols5.length === 40, `40 bars -> 40 candle columns: ${cols5.length}`)
ok(cols5.every((c, i) => i === 0 || c - cols5[i - 1] === 2), 'two columns apart while they fit (stride 2)')
ok(cols5[cols5.length - 1] === candleCols(VOL)[candleCols(VOL).length - 1], 'volume bars sit under their candles')
const last5 = TXF_5[TXF_5.length - 1]
const readout = `開 ${grouped(last5[0])} 高 ${grouped(last5[1])} 低 ${grouped(last5[2])} 收 ${grouped(last5[3])} 量 ${last5[4]}`
ok((lines[0] ?? '').includes(readout), `title row reads out the last bar: "${readout}" in "${(lines[0] ?? '').trim()}"`)
ok((lines[0] ?? '').includes('5 分 K（永豐）'), `title keeps the bar label: ${(lines[0] ?? '').trim()}`)

// --- timeframe buttons -----------------------------------------------------------
const tfBtn = (list, label) => list.find(b => b.label === label || b.label === `[${label}]`)
ok(['1分', '5分', '15分', '60分'].every(l => tfBtn(btns, l)), 'timeframe buttons 1分 5分 15分 60分 on the control row')
ok(tfBtn(btns, '5分')?.label === '[5分]', `5分 is the marked timeframe: ${tfBtn(btns, '5分')?.label}`)
ok(btns.some(b => b.label === '[K線]') && btns.some(b => b.label === '曲線'), 'K線 / 曲線 pair, K線 marked')

tfBtn(btns, '1分').press()
;({ props: q, btns } = await band.draw())
rows = render(q); lines = textOf(rows)
console.log(`1分: bars=${q.quotes[q.focus]?.bars?.length} label=${q.barLabel}`)
show(lines)
ok(q.quotes[q.focus]?.bars?.length === 120, `1分 -> 120 bars: ${q.quotes[q.focus]?.bars?.length}`)
ok(q.barLabel === '1 分 K（永豐）' && (lines[0] ?? '').includes('1 分 K（永豐）'), `bar label follows the timeframe: ${q.barLabel}`)
ok(tfBtn(btns, '1分')?.label === '[1分]' && tfBtn(btns, '5分')?.label === '5分', 'the mark moved to 1分')
let cols1 = candleCols(lines.slice(1, 12))
ok(cols1.length >= 100, `120 bars at ${COLS} cols: one bar per column, ${cols1.length} columns drawn`)
ok(cols1[cols1.length - 1] - cols1[0] + 1 === cols1.length, 'candle columns are contiguous (stride 1)')
ok((lines[12] ?? '').includes('22:59') && (lines[12] ?? '').includes('22:00'), `1分 axis: last bar 22:59 and a round tick: ${(lines[12] ?? '').trim()}`)
ys = axisNumbers(lines.slice(1, 12))
ok(new Set(ys).size === ys.length && strictlyDecreasing(ys), `1分 y labels still unique and decreasing: ${ys.join(' > ')}`)

tfBtn(btns, '60分').press()
;({ props: q, btns } = await band.draw())
rows = render(q); lines = textOf(rows)
console.log(`60分: bars=${q.quotes[q.focus]?.bars?.length} label=${q.barLabel}`)
show(lines)
ok(q.quotes[q.focus]?.bars?.length === 28, `60分 -> 28 bars: ${q.quotes[q.focus]?.bars?.length}`)
ok(q.barLabel === '60 分 K（永豐）', `60 分 label: ${q.barLabel}`)
ok((lines[12] ?? '').includes('08:00'), `60分 axis marks the 日盤 start 08:00 (session boundary): ${(lines[12] ?? '').trim()}`)
ok(lines.slice(1, 12).some(l => l.includes('│')), 'a session boundary rule runs through the plot')
ok((lines[12] ?? '').includes(hhmmOf(TXF_60[0][5])) && (lines[12] ?? '').includes(hhmmOf(TXF_60[27][5])), 'first and last 60 分 bars labelled')

tfBtn(btns, '5分').press()
;({ props: q, btns } = await band.draw())
ok(q.quotes[q.focus]?.bars?.length === 40 && q.barLabel === '5 分 K（永豐）', 'back to 5分: 40 bars, 5 分 label')

// --- 曲線 mode ------------------------------------------------------------------
btns.find(b => b.label === '曲線').press()
;({ props: q, btns } = await band.draw())
rows = render(q); lines = textOf(rows)
console.log(`曲線: mode=${q.chartMode}`)
show(lines)
ok(q.chartMode === 'line', `chartMode line: ${q.chartMode}`)
ok(btns.some(b => b.label === '[曲線]') && btns.some(b => b.label === 'K線'), '曲線 marked, K線 plain')
ok(lines.slice(1, 12).some(l => BRAILLE.test(l)), 'the price line is drawn with braille cells')
ok(!lines.slice(1, 12).some(l => CANDLE.test(l)), 'no candle glyphs in 曲線 mode')
ok(rows.slice(1, 12).flat().some(s => s.bg !== undefined && !/\d/.test(s.text)), 'the area to 昨結 is shaded (bg on plot cells)')
ok(lines.slice(1, 12).some(l => l.includes('┈')), '昨結 dotted line still there in 曲線 mode')
ok(lines.slice(13, 15).some(l => CANDLE.test(l)), 'volume rows still drawn in 曲線 mode')
ys = axisNumbers(lines.slice(1, 12))
ok(new Set(ys).size === ys.length && strictlyDecreasing(ys), `曲線 y labels unique and decreasing: ${ys.join(' > ')}`)

// remembered for the session: leave and re-enter
btns.find(b => b.label === '回清單').press()
;({ props: q, btns } = await band.draw())
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await band.draw())
ok(q.chartMode === 'line', `曲線 persists across 回清單 / 趨勢圖: ${q.chartMode}`)
// ...and per market: 台股's chart starts on K線
btns.find(b => b.key === 'stock-band:tab:tw').press()
;({ props: q, btns } = await band.draw())
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await band.draw())
ok(q.market === 'tw' && q.chartMode === 'candle', `the other market keeps its own mode (tw candle): ${q.market} ${q.chartMode}`)
btns.find(b => b.key === 'stock-band:tab:tf').press()
;({ props: q, btns } = await band.draw())
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await band.draw())
ok(q.market === 'tf' && q.chartMode === 'line', `back on tf the 曲線 mode is still remembered: ${q.chartMode}`)
btns.find(b => b.label === 'K線').press()
;({ props: q, btns } = await band.draw())
ok(q.chartMode === 'candle' && !textOf(render(q)).slice(1, 12).some(l => BRAILLE.test(l)), 'K線 brings the candles back')

// --- the tight range (MXFR1): two grid rows round to the same text ----------------
btns.find(b => b.label.startsWith('下一檔 ▶')).press()
;({ props: q, btns } = await band.draw())
lines = textOf(render(q))
console.log('MXFR1 (2-point range):')
show(lines)
ok(q.quotes[q.focus]?.code === 'MXFR1', `next symbol is MXFR1: ${q.quotes[q.focus]?.code}`)
ys = axisNumbers(lines.slice(1, 12))
ok(ys.length >= 3 && new Set(ys).size === ys.length && strictlyDecreasing(ys), `a 2-point range still labels uniquely: ${ys.join(' > ')}`)
ok(ys[0] === 47430 && ys[ys.length - 1] === 47428 && ys.includes(47429), `47,430 tag, 47,429 once, 47,428 昨結: ${ys.join(' > ')}`)

// --- the row without barsBy (SRFJ6): bars alone, no timeframe buttons ------------
btns.find(b => b.label.startsWith('下一檔 ▶')).press()
;({ props: q, btns } = await band.draw())
lines = textOf(render(q))
ok(q.quotes[q.focus]?.code === 'SRFJ6', `next symbol is SRFJ6: ${q.quotes[q.focus]?.code}`)
ok(!btns.some(b => /^\[?\d+分\]?$/.test(b.label)), `no timeframe buttons for a row without barsBy: ${btns.map(b => b.label).join(' ')}`)
ok(q.quotes[q.focus]?.bars?.length === 40 && q.barLabel === '5 分 K（永豐）', 'SRFJ6 draws its own 5 分 bars')
ys = axisNumbers(lines.slice(1, 12))
ok(ys.includes(SRF_PREV) && new Set(ys).size === ys.length && strictlyDecreasing(ys), `2-decimal axis with 昨結 ${SRF_PREV}, unique and decreasing: ${ys.join(' > ')}`)
btns.find(b => b.label === '◀ 上一檔').press()
;({ btns } = await band.draw())
btns.find(b => b.label === '◀ 上一檔').press()

// --- height: the maxRows clamp and chartRows config ---------------------------------
;({ props: q, client } = await band.draw({ maxRows: 12 }))
ok(q.chartRows === 10 && textOf(render(q)).length === 10 && client.height === 10, `maxRows 12 clamps 16 -> 10: ${q.chartRows}`)
;({ props: q } = await band.draw({ maxRows: 9 }))
ok(q.chartRows === 8, `the 8-row floor holds under a tiny maxRows: ${q.chartRows}`)
;({ props: q } = await band.draw({ maxRows: 60 }))
ok(q.chartRows === 16, `a tall band does not grow past the config: ${q.chartRows}`)

await band.setConfig({ chartRows: 8 })
;({ props: q, btns } = await band.draw())
lines = textOf(render(q))
console.log('chartRows 8:')
show(lines)
ok(q.chartRows === 8 && lines.length === 8, `chartRows: 8 -> 8 rows: ${lines.length}`)
ok((lines[6] ?? '').includes('19:40') && (lines[6] ?? '').includes('22:55') && (lines[7] ?? '').includes('檔中第'), 'today\'s layout: title, 5 plot rows, axis at row 7, footer at row 8')
ok(!lines.slice(1, 6).some(l => l.includes('量')), 'no volume rows at 8 rows')
ys = axisNumbers(lines.slice(1, 6))
ok(new Set(ys).size === ys.length && strictlyDecreasing(ys) && ys.includes(47428), `8-row axis: single labels, 昨結 among them: ${ys.join(' > ')}`)

await band.setConfig({ chartRows: 30 })
;({ props: q } = await band.draw())
lines = textOf(render(q))
ok(lines.length === 30 && (lines[26] ?? '').includes('19:40') && lines.slice(27, 29).some(l => CANDLE.test(l)), `chartRows: 30 -> axis at row 27, volume at 28-29: ${lines.length}`)
await band.setConfig({ chartRows: 3 })
;({ props: q } = await band.draw())
ok(q.chartRows === 8, `chartRows below 8 is raised to 8: ${q.chartRows}`)
await band.setConfig({ chartRows: 11 })
;({ props: q } = await band.draw())
lines = textOf(render(q))
ok(lines.length === 11 && (lines[9] ?? '').includes('19:40') && !CANDLE.test(lines[10] ?? ''), 'under 12 rows the volume rows are dropped (axis at row 10, footer last)')

// ============================================================================
// --- the stock side: 4-element bars, no ts, no barsBy -------------------------------
// the old [o, h, l, c] shape, written here so a rerun starts from the same file
const TSMC_BARS = [
  [1165.0, 1172.0, 1164.0, 1170.5], [1170.5, 1176.0, 1168.0, 1174.0], [1174.0, 1183.0, 1173.5, 1181.5], [1181.5, 1190.0, 1180.0, 1188.0],
  [1188.0, 1191.0, 1184.0, 1185.0], [1185.0, 1189.5, 1183.0, 1189.0], [1189.0, 1192.0, 1186.5, 1187.5], [1187.5, 1190.0, 1185.0, 1188.0],
]
const twQuotesPath = `${twDir}/.claude/stock-quotes.json`
const writeTw = bars =>
  writeFile(twQuotesPath, JSON.stringify({ asOf: CLOCK - 10_000, market: 'tw', quotes: { 2330: { price: 1188.0, prevClose: 1165.0, name: '台積電', ...(bars ? { bars } : {}) } } }, null, 2))
await writeTw(TSMC_BARS)
const tw = await boot(twDir, 'tw')
;({ props: q, btns } = await tw.draw())
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await tw.draw())
lines = textOf(render(q))
console.log(`tw chart: focus=${q.quotes[q.focus]?.code} bars=${q.quotes[q.focus]?.bars?.length} rows=${lines.length}`)
console.log('buttons:', btns.map(b => `[${b.label}]`).join(' '))
show(lines)
ok(q.market === 'tw' && q.quotes[q.focus]?.bars?.length === 8, `2330 has its 8 file bars: ${q.quotes[q.focus]?.bars?.length}`)
ok(!btns.some(b => /^\[?\d+分\]?$/.test(b.label)), 'a stock row shows no timeframe buttons')
ok(btns.some(b => b.label === '[K線]'), 'the K線 / 曲線 pair is still there for a stock')
ok(lines.length === 16, `16 rows for a stock too: ${lines.length}`)
ok((lines[14] ?? '').includes('09:00') && (lines[14] ?? '').includes('13:30'), `bars without ts fall back to the session axis: ${(lines[14] ?? '').trim()}`)
ok(!lines.slice(13, 15).some(l => l.includes('量')) && (lines[15] ?? '').includes('檔中第'), 'no volume without v: the plot takes the rows, footer last')
ys = axisNumbers(lines.slice(1, 14))
ok(new Set(ys).size === ys.length && strictlyDecreasing(ys), `stock axis labels unique and decreasing: ${ys.join(' > ')}`)
ok(undefinedPaths(q).length === 0, 'no undefined in the stock chart props')

// no bars at all: the control row is exactly what it was before #12
const before = btns.map(b => b.label)
await writeTw(undefined)
await tw.poll()
;({ props: q, btns } = await tw.draw())
lines = textOf(render(q))
console.log('buttons (no bars):', btns.map(b => `[${b.label}]`).join(' '))
ok((q.quotes[q.focus]?.bars?.length ?? 0) === 0 && lines.some(l => l.includes('沒有 K 棒資料')), 'no bars: the notice is drawn')
const legacy = before.filter(l => !/^\[?\d+分\]?$/.test(l) && l !== '[K線]' && l !== '曲線' && l !== 'K線' && l !== '[曲線]')
ok(JSON.stringify(btns.map(b => b.label)) === JSON.stringify(legacy), `no bars -> no chart controls, the control row is the pre-#12 one: ${btns.map(b => b.label).join(' ')}`)

done()
