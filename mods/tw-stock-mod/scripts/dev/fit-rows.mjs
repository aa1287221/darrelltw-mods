// Fit every view to the band (#13): the table and 損益 views size themselves
// from the host's `maxRows` the way the chart already does (header + rule +
// q quote rows + footer, q = rows − 3 capped at 5; a 4/5-row band merges the
// header into the rule and folds the footer into the button row; ≤ 3 rows is
// a one-line ticker that rotates on pageMs), `columns: "auto"` picks 1–4
// symbol columns off `bodyColumns`, and a stub host with no `maxRows` keeps
// today's fixed 8-row board so every other harness stays byte-identical.
//
// Usage: node fit-rows.mjs $OUT/register.js $OUT/board.js <proj>
// <proj> pins tw with NO `tw` list (the built-in 20 symbols, demo prices off
// a fixed clock), feed off, pageMs 0, and seven `holdings.tw` for 損益.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, projDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
let clock = taipei(17, 10, 30) // Thursday 10:30 台北: 台股 open, demo walk
const COLS = 100 // wide enough for two columns, too narrow for three

/** boots one fresh register.js against `dir`; `tag` defeats the ESM module cache */
async function boot(dir, tag) {
  const timers = []
  let invalidates = 0
  const home = `${dir}/home`
  await mkdir(`${home}/.claude`, { recursive: true })
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
    fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${dir}/${p}`)).toString() },
    ui: { log: () => {}, invalidate: () => { invalidates++ }, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
    http: { fetch: async () => { throw new Error('fit-rows: no network expected') } },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('fit-rows: no spawn expected') } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  /** `hostProps` stands in for the AbovePrompt props (`maxRows`, `bodyColumns`); no viewport, so bodyColumns has to be what sizes the band */
  const draw = async (hostProps = {}) => {
    const tree = await handlers.get('ui.render')($, { props: hostProps, surface: 'terminal' }, async () => ({ kids: [] }))
    const btns = [], texts = []; let props; let client
    const walkTree = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') { props = n.props.props; client = n.props }
      if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress, key: n.props.key })
      if (n.type === 'Text') texts.push((n.kids ?? []).filter(k => typeof k === 'string').join(''))
      for (const k of [...(n.kids ?? []), n.props?.children]) walkTree(k) }
    walkTree(tree)
    // the tree is the button row (one Box row) over the Client: what the host counts against maxRows
    const treeRows = 1 + (client?.height ?? 0)
    return { btns, texts, props, client, treeRows }
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

// board.tsx rendered twice (the first pass seeds its state), read back as text rows
const board = (await import(boardPath)).default
const render = (props, columns = COLS) => {
  let state
  const surface = {
    columns, rows: 40,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const text = node => {
    if (node == null || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join('')
    return [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])].map(text).join('')
  }
  return (out.kids ?? []).map(text)
}
const show = lines => { for (const l of lines) console.log('|' + l + '|') }
const count = (line, needle) => line.split(needle).length - 1
const press = (btns, label) => btns.find(b => b.label === label || b.label.startsWith(label))?.press()

// ============================================================================
const band = await boot(projDir, 'fit')

// --- no maxRows (a stub host): today's fixed 8-row, two-column board ----------
let { props: p, client, treeRows, btns } = await band.draw({})
let lines = render(p)
console.log(`stub host: view=${p.view} rows=${lines.length} columns=${p.columns} page ${p.page + 1}/${p.pageCount}`)
show(lines)
ok(p.quotes.length === 10 && p.columns === 2 && p.pageCount === 2, `no maxRows: the 20-symbol list pages 10 at a time in two columns: ${p.quotes.length}/${p.columns}/${p.pageCount}`)
ok(client.height === 8 && lines.length === 8, `no maxRows: the table Client is 8 rows: height=${client.height} drawn=${lines.length}`)
;({ props: p } = await band.draw({ bodyColumns: 190 }))
ok(p.columns === 2, `no maxRows: bodyColumns alone does not widen the table (today's list-length rule): ${p.columns}`)

// --- the table view across maxRows 20 / 9 / 7 / 5 / 4 / 3 ----------------------
const table = async maxRows => {
  const d = await band.draw({ maxRows, bodyColumns: COLS })
  const rows = render(d.props)
  console.log(`\ntable maxRows ${maxRows}: tree ${d.treeRows} rows, Client ${d.client.height}, layout=${d.props.layout} quoteRows=${d.props.quoteRows} columns=${d.props.columns} page ${d.props.page + 1}/${d.props.pageCount}`)
  show(rows)
  ok(d.treeRows <= maxRows, `maxRows ${maxRows}: the tree (${d.treeRows}) fits, no host window`)
  ok(rows.length === d.client.height, `maxRows ${maxRows}: the board draws exactly the Client height: ${rows.length} vs ${d.client.height}`)
  return { ...d, rows }
}
let t = await table(20)
ok(t.client.height === 8 && t.props.quoteRows === 5 && t.props.layout === 'full', `maxRows 20: today's 8-row table, 5 quote rows: ${t.client.height}/${t.props.quoteRows}/${t.props.layout}`)
ok(t.rows[0].includes('代號') && t.rows[1].includes('─') && t.rows[7].includes('darrell_tw_'), 'maxRows 20: header, rule and footer where they always were')
t = await table(9)
ok(t.client.height === 8 && t.props.quoteRows === 5, `maxRows 9: still the 8-row table: ${t.client.height}/${t.props.quoteRows}`)
t = await table(7)
ok(t.props.quoteRows === 3 && t.client.height === 6 && t.props.layout === 'full', `maxRows 7: 3 quote rows, header + rule + 3 + footer = 6: ${t.props.quoteRows}/${t.client.height}/${t.props.layout}`)
ok(t.props.quotes.length === 6 && t.props.pageCount === 4, `maxRows 7: paging follows the reduced page (3 rows × 2 columns = 6, 4 pages): ${t.props.quotes.length}/${t.props.pageCount}`)
ok(t.rows[5].includes('darrell_tw_') && t.rows.slice(2, 5).every(r => /\d/.test(r)), 'maxRows 7: quotes on rows 3-5, footer on row 6')
// AC says "1 quote row" at 5, but the same AC wants a merged header and a folded
// footer there, and the ticket's own 4-row band shows 2 quotes - a taller band
// cannot show fewer. Pinned: merged + folded + every budget row used (3 quotes).
t = await table(5)
ok(t.props.layout === 'compact' && t.client.height === 4, `maxRows 5: compact layout, 4 rows: ${t.props.layout}/${t.client.height}`)
ok(t.rows[0].includes('代號') && t.rows[0].includes('─'), `maxRows 5: the column titles sit on the rule: "${t.rows[0].trim()}"`)
ok(!t.rows.some(r => r.includes('darrell_tw_')), 'maxRows 5: no footer row on the board')
ok(t.texts.some(x => /\d\d:\d\d:\d\d · 示範資料/.test(x)), `maxRows 5: the footer (clock · source tag) folded into the button row: ${t.texts.filter(x => x.trim()).join(' | ')}`)
ok(t.props.quoteRows >= 1 && t.props.quoteRows === 3, `maxRows 5: quote rows ≥ 1 (3 - every row of the budget used): ${t.props.quoteRows}`)
t = await table(4)
ok(t.props.layout === 'compact' && t.props.quoteRows === 2 && t.client.height === 3, `maxRows 4: merged header + 2 quote rows: ${t.props.layout}/${t.props.quoteRows}/${t.client.height}`)
t = await table(3)
ok(t.props.layout === 'ticker' && t.client.height === 1, `maxRows 3: one ticker line: ${t.props.layout}/${t.client.height}`)
ok(t.props.columns === 3 && t.props.quotes.length === 3 && t.props.pageCount === 7, `maxRows 3 at 100 cols: three 代號 價格 ▲pct cells, 7 pages: ${t.props.columns}/${t.props.quotes.length}/${t.props.pageCount}`)
ok(t.props.quotes.every(q => t.rows[0].includes(q.code)) && count(t.rows[0], '%') === 3, `ticker line carries every cell's code and pct: "${t.rows[0].trim()}"`)
ok(!t.btns.some(b => b.label === '趨勢圖') && t.btns.some(b => b.label.startsWith('翻頁')), 'ticker: 翻頁 stays (it rotates the line), 趨勢圖 goes (no chart can fit)')

// --- 損益 across 7 / 5 / 4 -------------------------------------------------------
press((await band.draw({})).btns, '台股庫存')
const pnl = async maxRows => {
  const d = await band.draw({ maxRows, bodyColumns: COLS })
  const rows = render(d.props)
  console.log(`\n損益 maxRows ${maxRows}: tree ${d.treeRows}, Client ${d.client.height}, layout=${d.props.layout} quoteRows=${d.props.quoteRows}`)
  show(rows)
  ok(d.treeRows <= maxRows, `損益 maxRows ${maxRows}: the tree (${d.treeRows}) fits`)
  ok(rows.length === d.client.height, `損益 maxRows ${maxRows}: drawn ${rows.length} = Client ${d.client.height}`)
  return { ...d, rows }
}
let n = await pnl(20)
ok(n.props.view === 'pnl' && n.client.height === 8 && n.props.quoteRows === 5, `損益 maxRows 20: today's 8 rows, 5 holdings a page: ${n.props.view}/${n.client.height}/${n.props.quoteRows}`)
n = await pnl(7)
ok(n.props.quoteRows === 3 && n.client.height === 6, `損益 maxRows 7: title + header + 3 holdings + totals: ${n.props.quoteRows}/${n.client.height}`)
ok(n.rows[5].includes('市值') && n.btns.some(b => b.label === '翻頁 1/3'), `損益 maxRows 7: totals on the last row, 7 holdings page 3 at a time: ${n.btns.map(b => b.label).join(' ')}`)
press(n.btns, '翻頁')
;({ props: p } = await band.draw({ maxRows: 7, bodyColumns: COLS }))
ok(p.holdingsScroll === 3, `損益 翻頁 moves by the reduced page: scroll ${p.holdingsScroll}`)
n = await pnl(5)
ok(n.props.quoteRows === 1 && n.client.height === 4 && n.rows[3].includes('市值'), `損益 maxRows 5: one holding, four rows: ${n.props.quoteRows}/${n.client.height}`)
n = await pnl(4)
ok(n.props.layout === 'ticker' && n.client.height === 1, `損益 maxRows 4: under its 4-row minimum, the ticker: ${n.props.layout}/${n.client.height}`)

// --- chart across 20 / 9 / 7 ---------------------------------------------------
press((await band.draw({})).btns, '台股')
press((await band.draw({})).btns, '趨勢圖')
const chart = async maxRows => {
  const d = await band.draw({ maxRows, bodyColumns: COLS })
  const rows = render(d.props)
  console.log(`\nchart maxRows ${maxRows}: tree ${d.treeRows}, Client ${d.client.height}, layout=${d.props.layout} chartRows=${d.props.chartRows}`)
  ok(d.treeRows <= maxRows, `chart maxRows ${maxRows}: the tree (${d.treeRows}) fits`)
  ok(rows.length === d.client.height, `chart maxRows ${maxRows}: drawn ${rows.length} = Client ${d.client.height}`)
  return { ...d, rows }
}
let c = await chart(20)
ok(c.props.view === 'chart' && c.client.height === 16, `chart maxRows 20: the 16-row chart: ${c.props.view}/${c.client.height}`)
c = await chart(9)
ok(c.props.chartRows === 8 && c.client.height === 8, `chart maxRows 9: the 8-row floor: ${c.props.chartRows}`)
c = await chart(7)
ok(c.props.layout === 'ticker' && c.client.height === 1, `chart maxRows 7: cannot fit 8, the ticker: ${c.props.layout}/${c.client.height}`)
show(c.rows)
press((await band.draw({ maxRows: 20, bodyColumns: COLS })).btns, '回清單')

// --- columns off bodyColumns, 20 symbols, a tall band ---------------------------
const wide = async (bodyColumns, extra = {}) => {
  const d = await band.draw({ maxRows: 20, bodyColumns, ...extra })
  const rows = render(d.props, bodyColumns)
  console.log(`\nbodyColumns ${bodyColumns}: columns=${d.props.columns} quoteRows=${d.props.quoteRows} page ${d.props.page + 1}/${d.props.pageCount} 翻頁=${d.btns.some(b => b.label.startsWith('翻頁'))}`)
  show(rows)
  return { ...d, rows }
}
let w = await wide(190)
ok(w.props.columns === 4 && w.props.quoteRows === 5 && w.props.quotes.length === 20, `190 cols: 4 columns × 5 rows hold all 20: ${w.props.columns}/${w.props.quoteRows}/${w.props.quotes.length}`)
ok(w.props.pageCount === 1 && !w.btns.some(b => b.label.startsWith('翻頁')), `190 cols: one page, 翻頁 hidden: ${w.props.pageCount}`)
ok(count(w.rows[0], '代號') === 4 && count(w.rows[0], '價格') === 4, `190 cols: four 代號/價格 headers on the board: "${w.rows[0].trim()}"`)
ok(w.rows.slice(2, 7).every(r => count(r, '%') === 4), '190 cols: every quote row carries four pct cells')
w = await wide(130)
ok(w.props.columns === 3 && w.props.pageCount === 2 && count(w.rows[0], '代號') === 3, `130 cols: 3 columns (15 a page, 2 pages): ${w.props.columns}/${w.props.pageCount}`)
w = await wide(100)
ok(w.props.columns === 2 && w.props.pageCount === 2 && count(w.rows[0], '代號') === 2, `100 cols: 2 columns: ${w.props.columns}/${w.props.pageCount}`)
w = await wide(74)
ok(w.props.columns === 1 && w.props.pageCount === 4 && w.rows[0].includes('變更$'), `74 cols: the single-column table with 變更$: ${w.props.columns}/${w.props.pageCount}`)
w = await wide(76)
ok(w.props.columns === 1, `76 cols: still one column (two need 77): ${w.props.columns}`)
w = await wide(77)
ok(w.props.columns === 2, `77 cols: two columns, the README's threshold: ${w.props.columns}`)
await band.setConfig({ columns: 2 })
w = await wide(190)
ok(w.props.columns === 2 && w.props.pageCount === 2 && count(w.rows[0], '代號') === 2, `explicit columns: 2 at 190 cols still forces 2: ${w.props.columns}/${w.props.pageCount}`)
await band.setConfig({ columns: 'auto', tw: [{ code: '2330', name: '台積電', prevClose: 1000 }, { code: '2317', name: '鴻海', prevClose: 200 }, { code: '2454', name: '聯發科', prevClose: 1500 }] })
w = await wide(190)
ok(w.props.columns === 1 && w.rows[0].includes('變更$'), `a 3-symbol list at 190 cols stays single-column (columns follow need, not just width): ${w.props.columns}`)
await band.setConfig({ tw: undefined })

// --- the ticker rotates on pageMs, with the page-turn flap ---------------------
await band.setConfig({ pageMs: 4000 })
;({ props: p } = await band.draw({ maxRows: 3, bodyColumns: COLS }))
ok(p.layout === 'ticker' && p.page === 0 && p.pageCount === 7, `ticker on page 1/${p.pageCount}`)
const codes0 = p.quotes.map(q => q.code).join(' ')
await band.poll() // seeds the page clock at the current instant
clock += 4100
await band.poll()
;({ props: p } = await band.draw({ maxRows: 3, bodyColumns: COLS }))
lines = render(p)
console.log(`\nticker after pageMs: page ${p.page + 1}/${p.pageCount} was=${p.quotes.map(q => q.was?.code).join(',')}`)
show(lines)
ok(p.page === 1, `the ticker turned to page 2 after pageMs: page ${p.page + 1}`)
ok(p.quotes.every(q => typeof q.was?.code === 'string') && p.quotes.map(q => q.was.code).join(' ') === codes0, `the new cells carry was.code (the page-turn flap) from the cells they replace: ${p.quotes.map(q => q.was?.code).join(' ')}`)
clock += 4100
await band.poll()
;({ props: p } = await band.draw({ maxRows: 3, bodyColumns: COLS }))
ok(p.page === 2, `and keeps rotating: page ${p.page + 1}`)
await band.setConfig({ pageMs: 0 })

done()
