// 期貨庫存 (tf pnl) at the runtime-dir file seam: a `futures-holdings.json`
// the 永豐 fetcher wrote (stock-holdings.json shape plus per-row multiplier,
// qty already signed - Sell is negative) adds a 期貨庫存 stop to the market
// button whenever it holds a position, with or without a `futures` list, and
// the pnl view prices every row × its own multiplier, in 口, at the contract's
// decimals, 紅漲綠跌, sorted and paged like 台股庫存. A fresh
// `futures-quotes.json` wins for price/prevClose/decimals; once stale the
// holdings file's own numbers stand in. A project with neither file is the
// guard: its cycle has no futures stop at all.
//
// Usage: node tf-pnl.mjs $OUT/register.js $OUT/board.js <proj> <plain-proj>
// <proj>/.claude/stock-band.json pins `market: "us"` with feed off and an
// EMPTY `futures` list (the holdings-only user of path 10); <plain-proj> has
// no futures and gets no file. Both runtime files are written here, stamped
// off the fixed 夜盤 clock, before session.start (a path missing at the first
// poll is only retried every tenth poll - readOptional's MISS_EVERY).
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, projDir, plainDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const CLOCK = taipei(17, 21, 0) // Thursday 21:00 台北: 夜盤 open, 台股/美股 closed
const QUOTE_STALE_MS = 120_000
const runtimeDirFor = dir => `${dir}/home/.claude/stock-band/${dir.replace(/^\/+/, '').replace(/\//g, '-')}/`
const RED = '#e5534b' // board.tsx DOWN_RED: "up" on the Taiwan boards
const GREEN = '#3fb950' // board.tsx UP_GREEN: "down" on the Taiwan boards

// Every qty/cost here is made up. SRFJ6 is the non-index contract (×1000, 2
// decimals); TXFJ6 the Sell side (qty -3, ×200, 0 decimals - a fixture
// value, real files say 2) and a LOSING short (price above cost) so its
// tone must be green while its 今日% is red; TMFJ6 (×10, +150 points) is
// the sort discriminator: unmultiplied its 今日損益 beats SRFJ6's, multiplied
// it does not. The four fillers have no quote and price off the file; they
// push the list to 7 rows, so 翻頁 has a second page (rows 6-7).
const holdingsFile = asOf => ({
  asOf,
  market: 'tf',
  source: '永豐 期貨',
  holdings: [
    { code: 'SRFJ6', name: '小型元大台灣50ETF期貨 202610', qty: 2, cost: 107.2276, price: 110.0, prevClose: 108.3, multiplier: 1000.0, direction: 'Buy' },
    { code: 'TXFJ6', name: '臺股期貨 202610', qty: -3, cost: 47400.0, price: 47500.0, prevClose: 47428.0, multiplier: 200.0, direction: 'Sell' },
    { code: 'TMFJ6', name: '微型臺指期貨 202610', qty: 1, cost: 47450.0, price: 47580.0, prevClose: 47450.0, multiplier: 10.0, direction: 'Buy' },
    { code: 'MXFJ6', name: '小型臺指期貨 202610', qty: 1, cost: 47500.0, price: 47520.0, prevClose: 47428.0, multiplier: 50.0, direction: 'Buy' },
    { code: 'TEJ6', name: '電子期貨 202610', qty: 1, cost: 2400.0, price: 2410.0, prevClose: 2405.0, multiplier: 4000.0, direction: 'Buy' },
    { code: 'TFJ6', name: '金融期貨 202610', qty: 2, cost: 2100.0, price: 2090.0, prevClose: 2095.0, multiplier: 1000.0, direction: 'Buy' },
    { code: 'GTFJ6', name: '櫃買期貨 202610', qty: 1, cost: 300.0, price: 301.0, prevClose: 300.5, multiplier: 4000.0, direction: 'Buy' },
  ],
})
const quotesFile = asOf => ({
  asOf,
  dataAt: asOf - 5_000,
  market: 'tf',
  source: '永豐',
  barLabel: '5 分 K（永豐）',
  quotes: {
    SRFJ6: { price: 110.35, prevClose: 108.3, name: '小型元大台灣50ETF期貨 202610', multiplier: 1000.0, decimals: 2 },
    TXFJ6: { price: 47557.0, prevClose: 47428.0, name: '臺股期貨 202610', multiplier: 200.0, decimals: 0 },
    TMFJ6: { price: 47600.0, prevClose: 47450.0, name: '微型臺指期貨 202610', multiplier: 10.0, decimals: 0 },
  },
})
const runtime = runtimeDirFor(projDir)
const writeRuntime = async (name, data) => {
  await mkdir(runtime, { recursive: true })
  await writeFile(`${runtime}${name}`, JSON.stringify(data, null, 1))
}

/** boots one fresh register.js against `dir`; `tag` defeats the ESM module cache */
async function boot(dir, tag) {
  const timers = []
  const logs = []
  let invalidates = 0
  const home = `${dir}/home`
  await mkdir(`${home}/.claude`, { recursive: true })
  const $ = {
    clock: { now: async () => CLOCK, every: (ms, fn) => timers.push(fn) },
    fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${dir}/${p}`)).toString() },
    ui: {
      log: m => logs.push(String(m)),
      invalidate: () => { invalidates++ },
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: { fetch: async () => { throw new Error('tf-pnl: no network expected') } },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('tf-pnl: no spawn expected') } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  const draw = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 120 } }, async () => ({ kids: [] }))
    const btns = []; let props
    const walk = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') props = n.props.props
      if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress })
      for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
    walk(tree)
    return { btns, props }
  }
  /** fires the poll timer and waits for it to finish (the callback itself is fire-and-forget) */
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
  /** the same message a pnl header-cell click posts (see board.tsx's picker) */
  const sortPnl = async key => {
    await handlers.get('ui.message')($, { element: 'stock-band:table', module: 'hooks/board.tsx', data: { sortPnl: key } }, async () => ({ kids: [] }))
  }
  /** presses the market button `n` times and returns the labels it landed on */
  const walkCycle = async n => {
    const seen = []
    for (let i = 0; i < n; i++) {
      const { btns } = await draw()
      btns.find(b => b.label.endsWith('▾')).press()
      const { btns: after } = await draw()
      seen.push(after.find(b => b.label.endsWith('▾')).label)
    }
    return seen
  }
  return { draw, poll, setConfig, sortPnl, walkCycle, logs }
}

// board.tsx rendered to rows of colored spans, so the tone can be asserted
// as well as the text (the plain text walker the other harnesses use drops
// the color)
const board = (await import(boardPath)).default
const boardRows = props => {
  let state
  const surface = {
    columns: 120, rows: 8,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const spans = (node, color, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push({ text: String(node), color }); return acc }
    if (Array.isArray(node)) { for (const n of node) spans(n, color, acc); return acc }
    const own = node.props?.color ?? color
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) spans(k, own, acc)
    return acc
  }
  return (out.kids ?? []).map(row => spans(row, undefined, []))
}
const textOf = row => row.map(s => s.text).join('')
const show = rows => { for (const row of rows) console.log('|' + textOf(row) + '|') }
const rowOf = (rows, code) => rows.find(r => textOf(r).includes(code)) ?? []
/** the color of the span holding `needle` on a row */
const colorOf = (row, needle) => row.find(s => s.text.includes(needle))?.color
const codesOn = props => (props?.holdings ?? []).map(x => x.code).join(',')
/** presses the button with that label; a missing one is left to the assertion after it, so a red run keeps going */
const press = (btns, label) => btns.find(b => b.label === label)?.press()

// --- fixtures on disk first, then boot ---------------------------------------
await writeRuntime('futures-holdings.json', holdingsFile(CLOCK - 30_000))
await writeRuntime('futures-quotes.json', quotesFile(CLOCK - 10_000))
const band = await boot(projDir, 'tf-pnl')

// --- path 10 (pnl half): 期貨庫存 stop with an empty `futures` list ----------
const cycle = await band.walkCycle(4)
console.log('cycle, holdings file + futures []:', ['美股 ▾', ...cycle].join(' → '))
ok(cycle.join('|') === '台股 ▾|台股庫存 ▾|期貨庫存 ▾|美股 ▾', '美股 → 台股 → 台股庫存 → 期貨庫存 → 美股')
ok(!cycle.includes('台指期 ▾'), 'no 台指期 table stop without a futures list')

// land on the pnl stop (bounded: on unchanged code it never appears)
let cur = await band.draw()
for (let i = 0; i < 6 && cur.btns.find(b => b.label.endsWith('▾'))?.label !== '期貨庫存 ▾'; i++) {
  cur.btns.find(b => b.label.endsWith('▾'))?.press()
  cur = await band.draw()
}
let { props: p, btns } = cur
const label = btns.find(b => b.label.endsWith('▾'))?.label
console.log(`landed: label "${label}" market=${p.market} view=${p.view} source=${p.holdingsSource} rows=${p.holdings.length}`)
ok(label === '期貨庫存 ▾' && p.market === 'tf' && p.view === 'pnl', `market button reads 期貨庫存 on the tf pnl stop: "${label}" ${p.market}/${p.view}`)
ok(p.holdings.length === 7, `every position of the file is listed: ${p.holdings.length}`)
ok(p.holdingsSource === '永豐 期貨', `holdings source is the file's: ${p.holdingsSource}`)
ok(btns.some(b => b.label === '翻頁 1/2'), `7 rows page as 5 + 2: ${btns.map(b => b.label).join('  ')}`)

// --- path 9: signed qty, multiplier, decimals per row -------------------------
const holding = code => p.holdings.find(x => x.code === code)
let srf = holding('SRFJ6'), txf = holding('TXFJ6'), mxf = holding('MXFJ6')
console.log('rows:', p.holdings.map(x => `${x.code} qty=${x.qty} ×${x.multiplier} dec=${x.decimals} price=${x.price} prev=${x.prevClose} "${x.name}"`).join('\n      '))
ok(srf?.qty === 2 && srf?.multiplier === 1000, `SRFJ6 Buy: qty +2 × 1000: qty=${srf?.qty} ×${srf?.multiplier}`)
ok(txf?.qty === -3 && txf?.multiplier === 200, `TXFJ6 Sell: qty -3 × 200: qty=${txf?.qty} ×${txf?.multiplier}`)
ok(srf?.price === 110.35 && srf?.prevClose === 108.3, `SRFJ6 priced from the fresh quotes file, not its own 110.0: ${srf?.price}/${srf?.prevClose}`)
ok(txf?.price === 47557 && txf?.prevClose === 47428, `TXFJ6 priced from the fresh quotes file: ${txf?.price}`)
ok(mxf?.price === 47520 && mxf?.prevClose === 47428, `MXFJ6 has no quote: the holdings file's own price/prevClose: ${mxf?.price}/${mxf?.prevClose}`)
ok(srf?.decimals === 2 && txf?.decimals === 0, `decimals from the matching quote: SRF ${srf?.decimals}, TXF ${txf?.decimals}`)
ok(mxf?.decimals === undefined, `no quote, no decimals field (board default 2): ${mxf?.decimals}`)
ok(srf?.name === '小型元大台灣50ETF期貨 202610', `no config name: the contract name from the file: "${srf?.name}"`)

// --- the board: 口, headers, P&L × multiplier, tone ---------------------------
// default sort is 總損益 desc; TEJ6 (+40,000) leads, TXFJ6 (-94,200) is last
let rows = boardRows(p)
show(rows)
ok(textOf(rows[0]).includes('期貨庫存') && textOf(rows[0]).includes('永豐 期貨') && textOf(rows[0]).includes('7 檔'), `title names the futures view and its source: ${textOf(rows[0]).trim()}`)
ok(textOf(rows[1]).includes('口數') && !textOf(rows[1]).includes('張數'), `header says 口數, not 張數: ${textOf(rows[1]).trim()}`)
ok(codesOn(p) === 'TEJ6,SRFJ6,GTFJ6,TMFJ6,MXFJ6,TFJ6,TXFJ6', `default sort 總損益 desc × multiplier: ${codesOn(p)}`)
let srfRow = rowOf(rows, 'SRFJ6')
ok(/\b2 口/.test(textOf(srfRow)) && !textOf(srfRow).includes('0.002'), `SRFJ6 qty reads 2 口, never ÷1000: ${textOf(srfRow).trim()}`)
ok(textOf(srfRow).includes('110.35') && textOf(srfRow).includes('107.23'), 'SRFJ6 price/cost at 2 decimals')
ok(textOf(srfRow).includes('+4,100') && textOf(srfRow).includes('+6,245'), 'SRFJ6 今日損益 (110.35-108.3)×2×1000 = +4,100, 總損益 (110.35-107.2276)×2×1000 = +6,245')
ok(textOf(srfRow).includes('+2.91%') && textOf(srfRow).includes('+1.89%'), 'SRFJ6 損益% +2.91%, 今日% +1.89%')
ok(colorOf(srfRow, '+6,245') === RED && colorOf(srfRow, '+4,100') === RED, `SRFJ6 gains draw red (台股 rule): ${colorOf(srfRow, '+6,245')}`)
let mxfRow = rowOf(rows, 'MXFJ6')
ok(textOf(mxfRow).includes('47,520.00') && textOf(mxfRow).includes('+4,600') && textOf(mxfRow).includes('+1,000'), `MXFJ6 (no quote): file price at the default 2 decimals, P&L × 50: ${textOf(mxfRow).trim()}`)
let tmfRow = rowOf(rows, 'TMFJ6')
ok(textOf(tmfRow).includes('+1,500') && /\b47,600\b/.test(textOf(tmfRow)) && !textOf(tmfRow).includes('47,600.00'), `TMFJ6: +150 points × 1 × 10 = +1,500 at 0 decimals: ${textOf(tmfRow).trim()}`)
const foot = textOf(rows[7])
ok(foot.includes('總損益 -61,455 (-0.13%)'), `totals: 總損益 is the signed sum × multiplier: ${foot.trim()}`)
ok(foot.includes('今日 -55,200'), 'totals: 今日 is the signed sum × multiplier')
ok(foot.includes('市值 46,630,900') && foot.includes('成本 46,503,955'), '市值/成本 totals are gross notional (|qty| × multiplier), never negative for a short')

// page 2 holds the two losers, the Sell row among them
press(btns, '翻頁 1/2')
;({ props: p, btns } = await band.draw())
rows = boardRows(p)
show(rows)
ok(btns.some(b => b.label === '翻頁 2/2') && p.holdingsScroll === 5, `翻頁 moves to page 2 (scroll ${p.holdingsScroll})`)
ok(textOf(rows[2]).includes('TFJ6') && textOf(rows[3]).includes('TXFJ6') && textOf(rows[4]).trim() === '', 'page 2 draws rows 6-7 and leaves the rest blank')
let txfRow = rowOf(rows, 'TXFJ6')
ok(/-3 口/.test(textOf(txfRow)), `TXFJ6 Sell qty reads -3 口: ${textOf(txfRow).trim()}`)
ok(/\b47,557\b/.test(textOf(txfRow)) && !textOf(txfRow).includes('47,557.00') && /\b47,400\b/.test(textOf(txfRow)), 'TXFJ6 price/cost at 0 decimals')
ok(textOf(txfRow).includes('-77,400') && textOf(txfRow).includes('-94,200'), 'TXFJ6 short: price up 129 → 今日損益 (47557-47428)×-3×200 = -77,400, 總損益 (47557-47400)×-3×200 = -94,200')
ok(textOf(txfRow).includes('+0.27%') && textOf(txfRow).includes('-0.33%'), 'TXFJ6: 今日% is the contract move (+0.27%), 損益% the position return (-0.33%)')
ok(colorOf(txfRow, '-94,200') === GREEN && colorOf(txfRow, '-77,400') === GREEN && colorOf(txfRow, '-0.33%') === GREEN, `TXFJ6 losses draw green: ${colorOf(txfRow, '-94,200')}`)
ok(colorOf(txfRow, '+0.27%') === RED, `TXFJ6 今日% (the contract rose) draws red: ${colorOf(txfRow, '+0.27%')}`)
press(btns, '翻頁 2/2')
;({ props: p, btns } = await band.draw())
ok(p.holdingsScroll === 0 && btns.some(b => b.label === '翻頁 1/2'), '翻頁 wraps back to page 1')

// --- sort by every key, like 台股庫存 --------------------------------------------
const sortCase = async (key, expect, why) => {
  await band.sortPnl(key)
  ;({ props: p, btns } = await band.draw())
  console.log(`sort ${key} ${p.pnlSortDir}: ${codesOn(p)}`)
  ok(p.pnlSortKey === key && codesOn(p) === expect, `${why}: ${codesOn(p)}`)
}
await sortCase('today', 'SRFJ6,TMFJ6,TXFJ6,TEJ6,MXFJ6,GTFJ6,TFJ6', '今日% desc is the contract move, sign-free')
await sortCase('todayPnl', 'TEJ6,MXFJ6,SRFJ6,GTFJ6,TMFJ6,TFJ6,TXFJ6', '今日損益 desc ranks × multiplier (TMFJ6 +150 pts × 10 sits below SRFJ6 +2.05 × 1000)')
await sortCase('totalPnlPct', 'SRFJ6,TEJ6,GTFJ6,TMFJ6,MXFJ6,TXFJ6,TFJ6', '損益% desc ranks the short by its position return (negative)')
await sortCase('totalPnlPct', 'TFJ6,TXFJ6,MXFJ6,TMFJ6,GTFJ6,TEJ6,SRFJ6', 'same key again flips to asc')
await sortCase('code', 'TXFJ6,TMFJ6,TFJ6,TEJ6,SRFJ6,MXFJ6,GTFJ6', 'code desc')
await sortCase('code', 'GTFJ6,MXFJ6,SRFJ6,TEJ6,TFJ6,TMFJ6,TXFJ6', 'code asc')
await sortCase('totalPnl', 'TEJ6,SRFJ6,GTFJ6,TMFJ6,MXFJ6,TFJ6,TXFJ6', '總損益 desc again')
rows = boardRows(p)
ok(textOf(rows[1]).includes('↓總損益'), `the active header carries the arrow: ${textOf(rows[1]).trim()}`)

// --- quotes file stale → the holdings file's own price/prevClose/decimals ------
await writeRuntime('futures-quotes.json', quotesFile(CLOCK - QUOTE_STALE_MS - 1))
await band.poll()
;({ props: p, btns } = await band.draw())
srf = p.holdings.find(x => x.code === 'SRFJ6'); txf = p.holdings.find(x => x.code === 'TXFJ6')
console.log('stale quotes:', p.holdings.map(x => `${x.code} price=${x.price} dec=${x.decimals}`).join('  '))
ok(srf?.price === 110.0 && srf?.prevClose === 108.3, `stale quotes: SRFJ6 falls back to the holdings file's 110.0: ${srf?.price}`)
ok(txf?.price === 47500 && txf?.decimals === undefined, `stale quotes: TXFJ6 at its file price, decimals back to the default: ${txf?.price} dec=${txf?.decimals}`)
rows = boardRows(p)
ok(textOf(rowOf(rows, 'TXFJ6')).includes('47,500.00'), 'stale quotes: TXFJ6 draws 2 decimals (no contract decimals to follow)')
ok(p.holdings.length === 7, 'stale quotes never drop a position')
await writeRuntime('futures-quotes.json', quotesFile(CLOCK - 10_000))
await band.poll()

// --- a `futures` list beside the file: both stops, config name wins -----------
await band.setConfig({ futures: [{ code: 'SRFJ6', name: '小台50' }] })
;({ props: p } = await band.draw())
ok(p.holdings.find(x => x.code === 'SRFJ6')?.name === '小台50', `config futures name wins over the file's contract name: "${p.holdings.find(x => x.code === 'SRFJ6')?.name}"`)
await band.setConfig({ market: 'us' })
const both = await band.walkCycle(5)
console.log('cycle, file + futures list:', ['美股 ▾', ...both].join(' → '))
ok(both.join('|') === '台股 ▾|台股庫存 ▾|台指期 ▾|期貨庫存 ▾|美股 ▾', '美股 → 台股 → 台股庫存 → 台指期 → 期貨庫存 → 美股')

// --- the file goes away: the stop goes with it, the table stop stays ----------
await rm(`${runtime}futures-holdings.json`)
await band.poll()
await band.setConfig({ market: 'us' })
const gone = await band.walkCycle(4)
console.log('cycle, file removed:', ['美股 ▾', ...gone].join(' → '))
ok(gone.join('|') === '台股 ▾|台股庫存 ▾|台指期 ▾|美股 ▾', 'no holdings file: no 期貨庫存 stop, 台指期 stays')
ok(!band.logs.some(l => /spawn|network/.test(l)), `feed off: nothing spawned or fetched: ${band.logs.join(' | ')}`)

// --- guard: a project with neither futures nor a file ----------------------------
const plain = await boot(plainDir, 'plain')
await plain.setConfig({ market: 'us' })
const plainCycle = await plain.walkCycle(3)
console.log('cycle without futures or a file:', ['美股 ▾', ...plainCycle].join(' → '))
ok(plainCycle.join('|') === '台股 ▾|台股庫存 ▾|美股 ▾', 'no futures, no file: 美股 → 台股 → 台股庫存 → 美股')

done()
