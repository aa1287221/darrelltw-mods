// The desktop Code tab's layout (board.tsx: deskRow). The desktop draws Text
// in a proportional font, so there the board lays every row out as fixed-width
// Box cells instead of space-padded Text. Pinned here, against the real
// ui.render props for surface "desktop" and "terminal":
//   - only the desktop Client gets `desktop: true`; the terminal's props are
//     the same object minus that key (nothing else may differ)
//   - the terminal tree has no Box rows (it is still one Text per row)
//   - on desktop every row is a row Box of cell Boxes, each a positive integer
//     `ch` wide, no shrink, holding one `wrap="truncate"` Text whose text fits
//     in the cell and whose runs are all Texts (a Text of bare strings can be
//     drawn monospace there, off the Box's `ch`); the cells add up to the Client's width (the last one runs to
//     the edge); and laying each cell's text out at its own start column
//     rebuilds the terminal row exactly - every column starts where it does on
//     the terminal
// for the table at 100 and 190 columns, 損益, the chart (K線 and 曲線) and the
// one-line ticker; and the single-column table's highlighted top-mover row
// keeps its bg on every cell up to where the terminal's fillBg ends.
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

/** asserts one view on both surfaces; returns the desktop cells as [width, text] rows for a human to read */
const check = async (name, hostProps, columns) => {
  const term = await draw('terminal', hostProps)
  const desk = await draw('desktop', hostProps)
  const { desktop, ...rest } = desk.props
  ok(desktop === true && !('desktop' in term.props), `${name}: only the desktop Client carries desktop: true`)
  ok(JSON.stringify(rest) === JSON.stringify(term.props), `${name}: the desktop props are the terminal's plus that one key`)

  const termRows = render(term.props, columns).kids
  const deskRows = render(desk.props, columns).kids
  ok(termRows.every(r => r.type === 'Text'), `${name}: the terminal draws one Text per row, as before`)
  ok(deskRows.length === termRows.length, `${name}: same row count on both (${deskRows.length} / ${termRows.length})`)

  const problems = []
  const table = []
  deskRows.forEach((row, i) => {
    if (row.type !== 'Box' || row.props.flexDirection !== 'row') { problems.push(`row ${i} is not a row Box`); return }
    let rebuilt = ''
    let sum = 0
    const cells = []
    for (const cell of row.kids) {
      const inner = cell.kids?.[0]
      const t = text(cell)
      const w = cell.props.width
      if (cell.type !== 'Box' || !Number.isInteger(w) || w < 1) problems.push(`row ${i}: cell width ${w}`)
      if (cell.props.flexShrink !== 0) problems.push(`row ${i}: a cell may shrink`)
      if (cell.kids?.length !== 1 || inner?.type !== 'Text' || inner.props.wrap !== 'truncate') problems.push(`row ${i}: a cell is not one truncating Text`)
      if ((inner?.kids ?? []).some(k => typeof k !== 'object')) problems.push(`row ${i}: a cell's Text holds a bare string (the desktop may draw it monospace)`)
      if (dispWidth(t) > w) problems.push(`row ${i}: "${t}" (${dispWidth(t)}) overflows its ${w}-column cell`)
      rebuilt += t + ' '.repeat(Math.max(0, w - dispWidth(t)))
      sum += w
      cells.push(`[${w}|${t}]`)
    }
    if (sum !== columns) problems.push(`row ${i}: cells add up to ${sum}, not ${columns}`)
    if (rebuilt.trimEnd() !== text(termRows[i]).trimEnd()) problems.push(`row ${i}: cells at their own columns do not rebuild the terminal row\n  term |${text(termRows[i])}|\n  desk |${rebuilt}|`)
    table.push(`${String(sum).padStart(4)} ${cells.join('')}`)
  })
  ok(problems.length === 0, `${name}: every desktop cell is a positive fixed width, fits its text, rows add up to ${columns}, and each column starts where the terminal's does${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`)
  return { table, term, desk }
}

const show = lines => { for (const l of lines) console.log(l) }

let r = await check('table @100', { maxRows: 20, bodyColumns: 100 }, 100)
show(r.table)
// the top-mover highlight is single-column only: the same props at columns 1
{
  const props = { ...r.desk.props, columns: 1, highlight: true }
  const termRows = render({ ...props, desktop: undefined }, 100).kids
  const deskRows = render(props, 100).kids
  const HILIGHT = '#1b2436'
  const hi = termRows.findIndex(row => (row.kids ?? []).some(k => k?.props?.backgroundColor === HILIGHT))
  const cells = hi >= 0 ? deskRows[hi].kids : []
  const last = cells[cells.length - 1]
  console.log(`highlighted row ${hi}:`, cells.map(c => `[${c.props.width}${c.props.backgroundColor ? '/bg' : ''}|${text(c)}]`).join(''))
  ok(hi >= 0 && cells.slice(0, -1).every(c => c.props.backgroundColor === HILIGHT), `highlight: every cell but the last paints the row's bg on its Box (row ${hi})`)
  ok(last && last.props.backgroundColor === undefined && last.kids[0].kids.every(k => k.props.backgroundColor === HILIGHT), "highlight: the edge-wide last cell leaves its Box bare and its runs paint the bg, so the band ends where the terminal's does")
}
r = await check('table @190', { maxRows: 20, bodyColumns: 190 }, 190)
ok(r.desk.props.columns === 4, `table @190: four symbol columns on desktop too (${r.desk.props.columns})`)
r = await check('ticker @100', { maxRows: 3, bodyColumns: 100 }, 100)
ok(r.desk.props.layout === 'ticker', `ticker @100: the one-line ticker (${r.desk.props.layout})`)

press((await draw('terminal', {})).btns, '台股庫存')
r = await check('損益 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.desk.props.view === 'pnl', `損益 @100: the pnl view (${r.desk.props.view})`)
show(r.table)

press((await draw('terminal', {})).btns, '台股')
press((await draw('terminal', {})).btns, '趨勢圖')
r = await check('K線 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.desk.props.view === 'chart', `K線 @100: the chart view (${r.desk.props.view})`)
press((await draw('terminal', { maxRows: 20, bodyColumns: 100 })).btns, '曲線')
r = await check('曲線 @100', { maxRows: 20, bodyColumns: 100 }, 100)
ok(r.desk.props.chartMode === 'line', `曲線 @100: the line chart (${r.desk.props.chartMode})`)

done()
