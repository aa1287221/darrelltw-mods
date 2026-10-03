// The desktop Code tab's layout (board.tsx: deskBoard/deskRow). The desktop
// draws Text in a proportional font, so there the board lays every row out as
// fixed-width Boxes instead of space-padded Text, and draws block and braille
// cells as coloured Boxes. Pinned here, against the real ui.render props for
// surface "desktop" and "terminal":
//   - only the desktop Client gets `desktop: true`; the terminal's props are
//     the same object minus that key (nothing else may differ)
//   - the terminal tree has no Box rows (it is still one Text per row)
//   - on desktop every row is a row Box exactly one line tall (height 1, no
//     shrink, overflow hidden), so nothing can push the rows below it out of
//     the Client; no Text ever holds a Text (a truncating Text inside another
//     grew every row to 24px); a text cell is a Box a positive integer `ch`
//     wide, no shrink, of truncating Texts (a rule glyph run may fold
//     instead), one string each
//   - laying every text cell's text out at its own start column (after the
//     margins; a flush-right cell's ends at its Box's end) rebuilds the
//     terminal row's glyphs and colours exactly, and every other column is
//     painted the way the terminal shows it: a blank's bg by a Box, a █ ▀ ▄ or
//     braille cell by Boxes whose top and bottom halves carry its two colours
//     (or, past the node budget, the cell's one brighter colour); a row's
//     nodes end at or before the Client's width, at it when a text cell ends
//     the row
//   - the tree stays inside what the page takes (`Os` in the desktop app's
//     renderer: 2000 nodes, depth 32 - the board budgets 1600 - and 262144
//     characters of JSON): for every view here, and for a worst-case chart
//     (200 bars, every bar reversing, volume on) at 95 and 191 columns and
//     10 and 30 rows, where it must still draw half-row pixels; past the
//     budget the board steps down to one colour per pixel cell, then to the
//     terminal's own rows without colour, and still fits
// for the table at 100, 95 (odd) and 190/191 columns, 損益, the chart (K線 and
// 曲線) and the one-line ticker; the right-anchored last header cell is
// drawn flush right; and the single-column table's highlighted top-mover row
// keeps its bg on every column up to where the terminal's fillBg ends.
//
// Usage: node desktop-cells.mjs $OUT/register.js $OUT/board.js <proj>
// <proj> is a copy of the fit-rows fixture: no `tw` list (the built-in 20
// symbols, demo prices off a fixed clock), feed off, pageMs 0, tw holdings.
import { readFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, projDir] = process.argv

const TAIPEI = 8
const clock = Date.UTC(2026, 8, 17, 10 - TAIPEI, 30) // Thursday 10:30 台北: 台股 open, demo walk
Date.now = () => clock

const home = `${projDir}/home`
await mkdir(`${home}/.claude`, { recursive: true })
const $ = {
  clock: { now: async () => clock, every: () => {} },
  fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${projDir}/${p}`)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async () => { throw new Error('desktop-cells: no network expected') } },
  env: { get: async name => (name === 'HOME' ? home : undefined) },
  session: { cwd: async () => projDir },
  plugin: { root: projDir },
  process: { run: async () => { throw new Error('desktop-cells: no spawn expected') } },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const draw = async (surface, hostProps) => {
  const tree = await handlers.get('ui.render')($, { props: hostProps, surface }, async () => ({ kids: [] }))
  const btns = []
  let props
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress })
    for (const k of [...(n.kids ?? []), n.props?.children]) walk(k)
  }
  walk(tree)
  return { btns, props }
}
const press = (btns, label) => btns.find(b => b.label === label || b.label.startsWith(label))?.press()

const board = (await import(boardPath)).default
const render = (props, columns) => {
  let state
  const surface = {
    columns, rows: 40,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  return board(props, surface)
}

// board.tsx's charWidth: the same east-asian wide ranges
const charWidth = ch => {
  const cp = ch.codePointAt(0) ?? 0
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
  return wide ? 2 : 1
}
const dispWidth = s => Array.from(s).reduce((w, ch) => w + charWidth(ch), 0)
const text = n => n == null || n === false ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : (n.kids ?? []).map(text).join('')

// --- the page's own limits: `Os` and the JSON length check in the desktop app's renderer ---
// (h() builds {type, props, kids}; the page gets {type, props, children} with
// undefined props dropped, so the tree is put in that shape first)
const pageShape = n => typeof n === 'string' ? n : {
  type: n.type,
  props: Object.fromEntries(Object.entries(n.props ?? {}).filter(([k, v]) => k !== 'children' && v !== undefined && typeof v !== 'function')),
  children: (n.kids ?? []).filter(k => k != null && k !== false && k !== '').map(pageShape),
}
const pageSize = tree => {
  const root = pageShape(tree)
  const stack = [{ value: root, depth: 0, nesting: 0, child: true }]
  let nodes = 0, depth = 0, nesting = 0
  for (let e = stack.pop(); e !== undefined; e = stack.pop()) {
    const v = e.value
    const obj = typeof v === 'object' && v !== null
    const typed = obj && 'type' in v
    const d = typed ? e.depth + 1 : e.depth
    const n = obj ? e.nesting + 1 : e.nesting
    if (typed || (e.child && typeof v === 'string')) nodes++
    depth = Math.max(depth, d)
    nesting = Math.max(nesting, n)
    if (obj) for (const x of Object.values(v)) stack.push({ value: x, depth: d, nesting: n, child: Array.isArray(v) })
  }
  return { nodes, depth, nesting, json: JSON.stringify(root).length }
}

// --- the terminal's colours, per column ---
const isRule = s => s !== '' && Array.from(s).every(ch => '─┈│'.includes(ch))
const isPixel = ch => { const cp = ch.codePointAt(0) ?? 0; return ch === '█' || ch === '▀' || ch === '▄' || (cp > 0x2800 && cp <= 0x28ff) }
/** what the terminal shows in a pixel cell's top and bottom half: a braille half is lit if any of its dots is (1,2,4,5 / 3,6,7,8) */
const halves = c => {
  if (c.ch === '█') return [c.fg, c.fg]
  if (c.ch === '▀') return [c.fg, c.bg]
  if (c.ch === '▄') return [c.bg, c.fg]
  const dots = c.ch.codePointAt(0) - 0x2800
  return [dots & 0x1b ? c.fg : c.bg, dots & 0xe4 ? c.fg : c.bg]
}
const luma = hex => { const v = parseInt(hex.slice(1, 7), 16); return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff) }
/** the same cell in one colour: the lit half, or the brighter of two */
const whole = ([t, b]) => { const c = !t || !b ? t ?? b : luma(b) > luma(t) ? b : t; return [c, c] }
const samePair = (a, b) => a && b && a[0] === b[0] && a[1] === b[1]

/** a terminal row as columns: {ch, fg, bg, bold}, and {cont} for the second column of a wide glyph */
const termColumns = row => {
  const cols = []
  for (const k of row.kids ?? []) {
    const style = typeof k === 'string' ? {} : { fg: k.props.color, bg: k.props.backgroundColor, bold: k.props.bold === true }
    for (const ch of Array.from(text(k))) {
      cols.push({ ch, ...style })
      if (charWidth(ch) === 2) cols.push({ cont: true })
    }
  }
  return cols
}

/**
 * A desktop row laid back out as columns: text cells put their glyphs at
 * their start column, every other Box paints its columns' [top, bottom].
 * Returns the columns, where the last node ends, and whether a text cell
 * ends the row.
 */
const deskColumns = (row, problems, where) => {
  const cols = []
  const at = c => (cols[c] ??= {})
  let x = 0
  let lastIsText = false
  for (const node of row.kids ?? []) {
    if (node?.type !== 'Box') { problems.push(`${where}: a ${node?.type ?? typeof node} straight in the row`); continue }
    const w = node.props.width
    x += node.props.marginLeft ?? 0
    if (!Number.isInteger(w) || w < 1) problems.push(`${where}: a node ${w} wide`)
    if (node.props.flexShrink !== 0) problems.push(`${where}: a node may shrink`)
    const kids = node.kids ?? []
    lastIsText = kids.length > 0 && kids.every(k => k?.type === 'Text')
    if (lastIsText) {
      for (const t of kids) {
        if (t.kids.length !== 1 || typeof t.kids[0] !== 'string') problems.push(`${where}: a Text holds ${JSON.stringify(t.kids).slice(0, 60)} - one string, never a Text`)
        if (t.props.wrap !== 'truncate' && !isRule(text(t))) problems.push(`${where}: "${text(t)}" does not truncate`)
      }
      const s = kids.map(text).join('')
      const flush = node.props.justifyContent === 'flex-end'
      for (let c = x; c < x + w; c++) at(c).box = node.props.backgroundColor ?? null
      let c = flush ? x + w - dispWidth(s) : x
      if (c < x) problems.push(`${where}: "${s}" (${dispWidth(s)}) overflows its ${w}-column cell`)
      for (const t of kids) {
        for (const ch of Array.from(text(t))) {
          Object.assign(at(c), { ch, fg: t.props.color, bg: t.props.backgroundColor, bold: t.props.bold === true })
          if (charWidth(ch) === 2) at(c + 1).cont = true
          c += charWidth(ch)
        }
      }
    } else {
      const bg = node.props.backgroundColor
      const inner = kids[0]
      let pair
      if (kids.length === 0 && node.props.height === undefined) pair = [bg, bg]
      else if (kids.length === 0 && node.props.height === '50%' && node.props.alignSelf === 'flex-start') pair = [bg, undefined]
      else if (kids.length === 0 && node.props.height === '50%' && node.props.alignSelf === 'flex-end') pair = [undefined, bg]
      else if (kids.length === 1 && inner?.type === 'Box' && inner.props.height === '50%' && (inner.kids ?? []).length === 0 &&
        node.props.flexDirection === 'column' && node.props.justifyContent === 'flex-end') pair = [bg, inner.props.backgroundColor]
      else problems.push(`${where}: a Box that is neither a text cell, a bg blank nor pixels: ${JSON.stringify(node.props)}`)
      if (pair && !pair[0] && !pair[1]) problems.push(`${where}: a Box that paints nothing`)
      for (let c = x; c < x + w; c++) at(c).paint = pair
    }
    x += w
  }
  return { cols, end: x, lastIsText }
}

/**
 * Asserts one board on both surfaces; `level` is what the desktop drew: 0
 * half-row pixels, 1 one colour per pixel cell, 2/3 the terminal's own rows
 * (with/without colour). Returns the desktop cells as [width|text] rows for a
 * human to read.
 */
const checkBoard = (name, deskProps, columns) => {
  const termProps = { ...deskProps }
  delete termProps.desktop
  const termRows = render(termProps, columns).kids
  const deskTree = render(deskProps, columns)
  const deskRows = deskTree.kids
  ok(termRows.every(r => r.type === 'Text'), `${name}: the terminal draws one Text per row, as before`)
  ok(deskTree.type === 'Box' && deskTree.props.flexDirection === 'column' && deskRows.length === termRows.length,
    `${name}: the desktop draws a column of ${termRows.length} rows (${deskRows.length})`)

  const problems = []
  const table = []
  let exactMiss = 0
  let wholeMiss = 0
  let rowText = 0
  deskRows.forEach((row, i) => {
    const where = `row ${i}`
    const p = row.props ?? {}
    if (row.type !== 'Box' || p.flexDirection !== 'row' || p.height !== 1 || p.flexShrink !== 0 || p.overflow !== 'hidden') {
      problems.push(`${where} is not a one-line row Box: ${JSON.stringify(p)}`)
    }
    const term = termColumns(termRows[i])
    if (row.kids?.[0]?.type === 'Text') {
      // a level-2/3 row: the terminal's own runs in one Text
      rowText++
      if (row.kids.length !== 1 || text(row.kids[0]) !== text(termRows[i])) problems.push(`${where}: the fallback row is not the terminal row`)
      return
    }
    const { cols, end, lastIsText } = deskColumns(row, problems, where)
    if (end > columns) problems.push(`${where}: its nodes end at ${end}, past the Client's ${columns}`)
    if (lastIsText && end !== columns) problems.push(`${where}: a text cell ends the row at ${end}, not at the Client's edge ${columns}`)
    for (let c = 0; c < Math.max(term.length, cols.length); c++) {
      const t = term[c]
      const d = cols[c] ?? {}
      if (t?.cont) {
        if (!d.cont) problems.push(`${where} col ${c}: the second half of a wide glyph is not`)
      } else if (t && isPixel(t.ch)) {
        const want = halves(t)
        if (!samePair(d.paint, want)) exactMiss++
        if (!samePair(d.paint, whole(want))) wholeMiss++
        if (!samePair(d.paint, want) && !samePair(d.paint, whole(want))) problems.push(`${where} col ${c}: "${t.ch}" ${want} painted ${d.paint}`)
      } else if (t && t.ch !== ' ') {
        if (d.ch !== t.ch || d.fg !== t.fg || d.bg !== t.bg || d.bold !== t.bold) {
          problems.push(`${where} col ${c}: "${t.ch}" ${t.fg}/${t.bg}${t.bold ? ' bold' : ''} drawn as "${d.ch ?? ''}" ${d.fg}/${d.bg}${d.bold ? ' bold' : ''}`)
        }
      } else {
        // a blank (or past the row's end): no glyph, and the terminal's bg
        const bg = t?.bg
        if (d.ch !== undefined && (d.ch !== ' ' || d.bg !== bg)) problems.push(`${where} col ${c}: a blank drawn as "${d.ch}"/${d.bg}`)
        else if (d.ch === undefined) {
          const shown = d.paint ? (d.paint[0] === d.paint[1] ? d.paint[0] : 'two colours') : d.box ?? undefined
          if (shown !== bg) problems.push(`${where} col ${c}: a blank with bg ${bg} painted ${shown}`)
        }
      }
    }
    const cells = (row.kids ?? []).map(n => `${n.props.marginLeft ? ' '.repeat(n.props.marginLeft) : ''}[${n.props.width}${n.props.justifyContent ? '>' : ''}|${n.kids?.[0]?.type === 'Text' ? text(n) : n.props.height ? '▀' : '█'}]`)
    table.push(`${String(end).padStart(4)} ${cells.join('')}`)
  })
  const level = rowText > 0 ? (deskRows.some(r => (r.kids?.[0]?.kids ?? []).some(k => typeof k === 'object')) ? 2 : 3) : exactMiss === 0 ? 0 : 1
  if (level === 1 && wholeMiss > 0) problems.push(`${wholeMiss} pixel columns are neither their two colours nor their one`)
  if (rowText > 0 && rowText !== deskRows.length) problems.push(`only ${rowText} of ${deskRows.length} rows fell back to the terminal's`)
  ok(problems.length === 0, `${name}: every row is one line of fixed-width nodes that ends inside the Client, each text cell's glyphs sit in the terminal's columns, and every other column is painted the terminal's way${problems.length ? `\n  ${problems.slice(0, 12).join('\n  ')}${problems.length > 12 ? `\n  ... ${problems.length - 12} more` : ''}` : ''}`)
  const size = pageSize(deskTree)
  ok(size.nodes <= 1600 && size.depth <= 32 && size.nesting <= 66 && size.json <= 200000,
    `${name}: the page takes it - ${size.nodes} nodes (budget 1600), depth ${size.depth}, ${size.json} JSON chars; drawn at level ${level}`)
  return { table, deskRows, level, size }
}

/** asserts one view on both surfaces off the real ui.render props */
const check = async (name, hostProps, columns) => {
  const term = await draw('terminal', hostProps)
  const desk = await draw('desktop', hostProps)
  const { desktop, ...rest } = desk.props
  ok(desktop === true && !('desktop' in term.props), `${name}: only the desktop Client carries desktop: true`)
  ok(JSON.stringify(rest) === JSON.stringify(term.props), `${name}: the desktop props are the terminal's plus that one key`)
  return { ...checkBoard(name, desk.props, columns), props: desk.props }
}

const show = lines => { for (const l of lines) console.log(l) }

let r = await check('table @100', { maxRows: 20, bodyColumns: 100 }, 100)
show(r.table)
ok(r.level === 0, `table @100: drawn in full (level ${r.level})`)
{
  // two columns end exactly at the Client's edge on an even width: the last
  // header cell has nothing after it, so it takes the blank before it and
  // draws flush right rather than lose its last glyph to an ellipsis
  const head = r.deskRows[0].kids
  const lastCell = head[head.length - 1]
  ok(text(lastCell) === '↓變更%' && lastCell.props.justifyContent === 'flex-end' && lastCell.props.width > dispWidth('↓變更%'),
    `table @100: the last header cell ↓變更% is flush right with the blank before it as slack (${lastCell.props.width} wide)`)
}
// the top-mover highlight is single-column only: the same props at columns 1
{
  const props = { ...r.props, columns: 1, highlight: true }
  const res = checkBoard('highlight @100', props, 100)
  const termRows = render({ ...props, desktop: undefined }, 100).kids
  const HILIGHT = '#1b2436'
  const hi = termRows.findIndex(row => (row.kids ?? []).some(k => k?.props?.backgroundColor === HILIGHT))
  const nodes = hi >= 0 ? res.deskRows[hi].kids : []
  const last = nodes[nodes.length - 1]
  console.log(`highlighted row ${hi}:`, nodes.map(c => `[${c.props.width}${c.props.backgroundColor ? '/bg' : ''}|${text(c)}]`).join(''))
  ok(hi >= 0 && nodes.slice(0, -1).every(c => c.props.backgroundColor === HILIGHT), `highlight: every node but the last paints the row's bg on its Box (row ${hi})`)
  ok(last && last.props.backgroundColor === undefined && last.kids.every(k => k.props.backgroundColor === HILIGHT), "highlight: the edge-wide last cell leaves its Box bare and its runs paint the bg, so the band ends where the terminal's does")
}
r = await check('table @95', { maxRows: 20, bodyColumns: 95 }, 95)
show(r.table)
r = await check('table @190', { maxRows: 20, bodyColumns: 190 }, 190)
ok(r.props.columns === 4, `table @190: four symbol columns on desktop too (${r.props.columns})`)
r = await check('table @191', { maxRows: 20, bodyColumns: 191 }, 191)
ok(r.props.columns === 4, `table @191: four symbol columns (${r.props.columns})`)
r = await check('ticker @100', { maxRows: 3, bodyColumns: 100 }, 100)
ok(r.props.layout === 'ticker', `ticker @100: the one-line ticker (${r.props.layout})`)

press((await draw('terminal', {})).btns, '台股庫存')
r = await check('損益 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.props.view === 'pnl', `損益 @100: the pnl view (${r.props.view})`)
show(r.table)

press((await draw('terminal', {})).btns, '台股')
press((await draw('terminal', {})).btns, '趨勢圖')
r = await check('K線 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.props.view === 'chart' && r.level === 0, `K線 @100: the chart view, half-row pixels (${r.props.view}, level ${r.level})`)
const chartProps = r.props
press((await draw('terminal', { maxRows: 20, bodyColumns: 100 })).btns, '曲線')
r = await check('曲線 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.props.chartMode === 'line' && r.level === 0, `曲線 @100: the line chart, half-row pixels (${r.props.chartMode}, level ${r.level})`)
show(r.table)

// --- the node budget -------------------------------------------------------
// The worst chart for the node count: 200 bars, every bar reversing (a colour
// change at every column, so no two pixel cells merge), volume on. At the
// desktop's own size (maxRows 12, so 10 board rows) and at 30 rows it must
// stay inside the page's limits in full detail.
const p0 = chartProps.quotes[chartProps.focus].price
const reversing = []
let px = p0 * 0.97
for (let i = 0; i < 200; i++) {
  const o = px
  const c = o + (i % 2 ? -1 : 1) * p0 * 0.004 * (1 + (i % 7) / 3) + p0 * 0.0003
  px = c
  reversing.push([o, Math.max(o, c) + p0 * 0.002, Math.min(o, c) - p0 * 0.002, c, 1000 + ((i * 37) % 900)])
}
const withBars = (bars, rows, mode, quote = {}) => ({
  ...chartProps, chartMode: mode, chartRows: rows, boardRows: rows,
  quotes: chartProps.quotes.map((q, i) => (i === chartProps.focus ? { ...q, ...quote, bars } : q)),
})
for (const columns of [95, 191]) {
  for (const rows of [10, 30]) {
    for (const mode of ['candle', 'line']) {
      const res = checkBoard(`worst ${mode} ${columns}x${rows}`, withBars(reversing, rows, mode), columns)
      ok(res.level === 0, `worst ${mode} ${columns}x${rows}: still half-row pixels (level ${res.level}, ${res.size.nodes} nodes)`)
    }
  }
}
// Past the budget the board draws less detail rather than nothing.
// Blocks: every bar spans the whole plot, alternating in colour, its wick one
// pixel past its body at both ends - every column lit top to bottom, its top
// and bottom cells two-colour, no volume. At 191x14 that is 1668 nodes in
// half-row pixels (over budget) and 1422 in one colour per cell.
// Tall candles: the same with 30 rows and volume, over budget in any colour,
// so only the terminal's rows without colour fit.
const blocks = []
{
  const hi = p0 * 1.01
  const lo = p0 * 0.99
  const wick = (hi - lo) / (2 * (14 - 3) - 1) // one pixel of the 14-row board's 11 plot rows
  for (let i = 0; i < 200; i++) blocks.push(i % 2 ? [hi - wick, hi, lo, lo + wick] : [lo + wick, hi, lo, hi - wick])
}
const tall = []
for (let i = 0; i < 200; i++) {
  const up = i % 2 === 0
  tall.push([up ? p0 * 0.9 : p0 * 1.1, p0 * 1.12, p0 * 0.88, up ? p0 * 1.1 : p0 * 0.9, 1000 + i])
}
let res = checkBoard('blocks 191x14', withBars(blocks, 14, 'candle', { prevClose: p0, price: p0 }), 191)
ok(res.level === 1, `blocks 191x14: over budget in half rows, drawn one colour per cell (level ${res.level}, ${res.size.nodes} nodes)`)
res = checkBoard('tall candles 191x30', withBars(tall, 30, 'candle'), 191)
ok(res.level === 3, `tall candles 191x30: over budget in any colour, drawn as the terminal's rows without colour (level ${res.level}, ${res.size.nodes} nodes)`)

done()
