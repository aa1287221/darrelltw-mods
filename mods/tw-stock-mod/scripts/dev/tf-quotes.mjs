// 台指期 (tf) at the runtime-dir file seam: a `futures-quotes.json` the 永豐
// fetcher wrote (same shape as stock-quotes.json plus per-quote multiplier /
// decimals / resolved) prices the 台指期 table, names 永豐 in the footer,
// feeds the chart view its own 5 分 K bars, and is dropped once older than
// the stale window. Yahoo is never asked for a futures symbol's bars. A second
// project guards the stock side: its project-level `.claude/stock-quotes.json`
// override still drives 台股 exactly as before and never leaks into tf.
//
// Usage: node tf-quotes.mjs $OUT/register.js $OUT/board.js <tf-proj> <tw-proj>
// <tf-proj>/.claude/stock-band.json pins `market: "tf"` with feed "auto" (so
// the feedBars path is live and only the tf short-circuit keeps Yahoo out);
// <tw-proj> pins tw, feed off, with an override quotes file and a `futures`
// list. The fixture files are (re)written here so their asOf tracks the
// harness clock. The clock is fixed at a 夜盤 minute, so nothing depends on
// when this runs.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, tfDir, twDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const CLOCK = taipei(17, 21, 0) // Thursday 21:00 台北: 夜盤 open, 台股/美股 closed
const QUOTE_STALE_MS = 120_000
const runtimeDirFor = dir => `${dir}/home/.claude/stock-band/${dir.replace(/^\/+/, '').replace(/\//g, '-')}/`

// Derived from a real fetcher file (2026-09-18): TXFR1 is the alias row and
// carries `resolved`; SRFJ6 is the non-index contract (multiplier 1000, 2
// decimals). Bars are [o, h, l, c], trimmed to eight. `decimals: 0` on TXF is
// a fixture value - real files say 2 - and the band must follow the file.
const TXF_BARS = [
  [47294, 47300, 47250, 47251], [47251, 47285, 47248, 47283], [47285, 47300, 47275, 47282], [47282, 47303, 47268, 47289],
  [47290, 47341, 47278, 47279], [47281, 47300, 47271, 47296], [47294, 47305, 47274, 47284], [47286, 47344, 47286, 47335],
]
const SRF_BARS = [
  [109.45, 109.45, 109.4, 109.45], [109.45, 109.5, 109.4, 109.45], [109.5, 109.55, 109.45, 109.55], [109.55, 109.6, 109.5, 109.6],
  [109.6, 109.7, 109.55, 109.65], [109.65, 109.8, 109.6, 109.8], [109.8, 110.1, 109.75, 110.05], [110.05, 110.4, 110.0, 110.35],
]
const futuresFile = (asOf, txfPrice = 47557.0) => ({
  asOf,
  dataAt: asOf - 5_000,
  market: 'tf',
  source: '永豐',
  barLabel: '5 分 K（永豐）',
  quotes: {
    TXFR1: { price: txfPrice, prevClose: 47428.0, name: '臺股期貨 近月', multiplier: 200.0, decimals: 0, bars: TXF_BARS, resolved: 'TXFJ6' },
    SRFJ6: { price: 110.35, prevClose: 108.3, name: '小型元大台灣50ETF期貨 202610', multiplier: 1000.0, decimals: 2, bars: SRF_BARS },
  },
})
const writeFutures = async (dir, asOf, txfPrice) => {
  const runtime = runtimeDirFor(dir)
  await mkdir(runtime, { recursive: true })
  await writeFile(`${runtime}futures-quotes.json`, JSON.stringify(futuresFile(asOf, txfPrice), null, 1))
}

/** boots one fresh register.js against `dir`; `tag` defeats the ESM module cache */
async function boot(dir, tag) {
  const timers = []
  const logs = []
  const fetched = []
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
    // every URL is recorded before the (failed) answer, so a request the band
    // should never make shows up here whatever it would have got back
    http: { fetch: async u => { fetched.push(String(u)); return { ok: false, status: 404, text: '' } } },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('tf-quotes: no spawn expected') } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  const draw = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
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
  return { draw, poll, setConfig, logs, fetched }
}

// board.tsx rendered to text lines, the way file-bars.mjs does it
const board = (await import(boardPath)).default
const boardText = props => {
  let state
  const surface = {
    columns: 100, rows: 9,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const text = (node, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
    if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) text(k, acc)
    return acc
  }
  return (out.kids ?? []).map(row => text(row, []).join(''))
}
const show = lines => { for (const l of lines) console.log('|' + l + '|') }
const pct = (price, prev) => ((price - prev) / prev) * 100

// The fixture is on disk BEFORE session.start: a path that is missing at the
// first poll is only retried every tenth poll (readOptional's MISS_EVERY).
await writeFutures(tfDir, CLOCK - 10_000)
const band = await boot(tfDir, 'tf')

// --- path 4: fresh file -> the 台指期 table draws it -------------------------
let { props: q, btns } = await band.draw()
console.log(`tf table: market=${q.market} phase=${q.phase} source=${q.source} label=${q.sourceLabel} bars=${q.barLabel}`)
console.log('rows:', q.quotes.map(r => `${r.code} "${r.name}" price=${r.price} pct=${r.pct.toFixed(3)} dec=${r.decimals} noData=${!!r.noData}`).join('  '))
ok(q.market === 'tf' && q.phase === 'open', `pinned tf, 夜盤 open: ${q.market} ${q.phase}`)
let txf = q.quotes.find(r => r.code === 'TXFR1')
let srf = q.quotes.find(r => r.code === 'SRFJ6')
ok(txf && !txf.noData && txf.price === 47557, `TXFR1 priced from the file: ${txf?.price}`)
ok(srf && !srf.noData && srf.price === 110.35, `SRFJ6 priced from the file: ${srf?.price}`)
ok(txf?.prevClose === 47428 && Math.abs(txf.pct - pct(47557, 47428)) < 1e-9, `TXFR1 今日% from prevClose (昨結): ${txf?.pct}`)
ok(srf?.prevClose === 108.3 && Math.abs(srf.pct - pct(110.35, 108.3)) < 1e-9, `SRFJ6 今日% from prevClose: ${srf?.pct}`)
ok(q.source === 'file', `source is the file: ${q.source}`)
ok(q.sourceLabel === '永豐', `footer names the file's source: ${q.sourceLabel}`)
ok(q.barLabel === '5 分 K（永豐）', `bar label from the file: ${q.barLabel}`)
ok(q.index.name === '台指近' && q.index.value === 47557 && q.index.change === 129 && Math.abs(q.index.pct - pct(47557, 47428)) < 1e-9,
  `footer index is 台指近's own price/change: ${q.index.name} ${q.index.value} ${q.index.change} ${q.index.pct}`)

// --- path 11: the alias row shows what it resolved to ----------------------
ok(txf?.name === '台指近 (TXFJ6)', `alias row: config name + resolved month: "${txf?.name}"`)
ok(srf?.name === '小型元大台灣50ETF期貨 202610', `month row without a config name: file name, no suffix: "${srf?.name}"`)

// --- decimals follow the file -----------------------------------------------
ok(txf?.decimals === 0 && srf?.decimals === 2, `row decimals from the file: TXF ${txf?.decimals}, SRF ${srf?.decimals}`)
let lines = boardText(q)
show(lines)
const rowOf = code => lines.find(l => l.includes(code)) ?? ''
ok(/47,557\b/.test(rowOf('TXFR1')) && !rowOf('TXFR1').includes('47,557.00'), `TXFR1 drawn with 0 decimals: ${rowOf('TXFR1').trim()}`)
ok(/\+129\b/.test(rowOf('TXFR1')) && !rowOf('TXFR1').includes('+129.00'), 'TXFR1 change column also 0 decimals')
ok(rowOf('SRFJ6').includes('110.35') && rowOf('SRFJ6').includes('+2.05'), `SRFJ6 drawn with 2 decimals: ${rowOf('SRFJ6').trim()}`)
ok(rowOf('TXFR1').includes('台指近 (TXFJ6)'), 'name column shows the resolved month')
ok(lines.some(l => l.includes('永豐')) && !lines.some(l => l.includes('示範')), 'footer says 永豐, never 示範')
ok(lines.some(l => /^\s*台指近\s+47,557\.00 ▲ \+129\.00 \+0\.27%/.test(l)), `footer card: 台指近 price ▲ change pct%: ${lines.find(l => /^\s*台指近\s/.test(l))?.trim()}`)

// --- path 8: chart view on a tf symbol - file bars, no Yahoo ---------------
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await band.draw())
// requestBars is fire-and-forget and feedBars awaits the clock before it
// would fetch, so give a forbidden request every chance to land first
await new Promise(r => setTimeout(r, 100))
;({ props: q, btns } = await band.draw())
const focused = q.quotes[q.focus]
console.log(`chart: view=${q.view} focus=${focused?.code} bars=${focused?.bars?.length} barLabel=${q.barLabel}`)
console.log('fetched:', band.fetched)
ok(q.view === 'chart', 'chart view opened')
ok(focused?.bars?.length === 8, `focused row carries the file's bars: ${focused?.bars?.length}`)
ok(!band.fetched.some(u => u.includes('/finance/chart/')), 'no Yahoo chart URL fetched for a tf symbol')
ok(band.fetched.length === 0, `no request of any kind for a tf-only session: ${band.fetched.length}`)
ok(q.barLabel === '5 分 K（永豐）', `chart keeps the file's bar label, no Yahoo badge: ${q.barLabel}`)
lines = boardText(q)
show(lines)
ok(!lines.some(l => l.includes('沒有 K 棒資料')), 'chart draws candles, not the no-bars notice')
// SRFJ6 sorts first (bigger 今日%) and its contract name is long enough that
// the board's fit rule drops the title tag at 100 columns, as it would for a
// long stock name - so the tag is checked on the alias row's chart instead
btns.find(b => b.label.startsWith('下一檔 ▶')).press()
;({ props: q, btns } = await band.draw())
await new Promise(r => setTimeout(r, 100))
;({ props: q, btns } = await band.draw())
lines = boardText(q)
show(lines)
ok(q.quotes[q.focus]?.code === 'TXFR1' && q.quotes[q.focus]?.bars?.length === 8, `next symbol: TXFR1 with its own file bars: ${q.quotes[q.focus]?.bars?.length}`)
ok(lines[0].includes('5 分 K（永豐）'), `chart title carries the file's bar label: ${lines[0].trim()}`)
ok(/47,557\b/.test(lines[0]) && !lines[0].includes('47,557.00'), 'chart title honours 0 decimals')
ok(band.fetched.length === 0, 'still no request after moving to the second contract')
btns.find(b => b.label === '回清單').press()

// --- path 4b: a NEW snapshot (later asOf, TXFR1 moved) -> the rows flap from
// the old price: `was` carries it and `turn` advances once; re-reading the
// same snapshot advances nothing
;({ props: q } = await band.draw())
const turnBefore = q.turn
const seqBefore = q.seq
await band.poll()
;({ props: q } = await band.draw())
ok(q.turn === turnBefore, `re-reading the same snapshot does not start a turn: ${turnBefore} -> ${q.turn}`)
await writeFutures(tfDir, CLOCK - 5_000, 47600.0)
await band.poll()
;({ props: q } = await band.draw())
txf = q.quotes.find(r => r.code === 'TXFR1')
srf = q.quotes.find(r => r.code === 'SRFJ6')
ok(q.turn === turnBefore + 1, `a new snapshot starts exactly one turn: ${turnBefore} -> ${q.turn}`)
ok(q.seq > seqBefore, `the live dot beats on a new file snapshot: seq ${seqBefore} -> ${q.seq}`)
ok(txf?.price === 47600 && txf?.was?.price === 47557, `TXFR1 flaps from the previous file price: was=${txf?.was?.price} now=${txf?.price}`)
ok(srf?.price === 110.35 && srf?.was === undefined, `SRFJ6 (unchanged) gets no was, so only the moved row flaps (quoteRow's rule): was=${srf?.was?.price}`)
await writeFutures(tfDir, CLOCK - 10_000)
await band.poll()

// --- path 5: the same file, older than the stale window -> no-data, never demo
await writeFutures(tfDir, CLOCK - QUOTE_STALE_MS - 1)
await band.poll()
;({ props: q } = await band.draw())
console.log('stale rows:', q.quotes.map(r => `${r.code} price=${r.price} noData=${!!r.noData}`).join('  '), `source=${q.source} label=${q.sourceLabel}`)
ok(q.quotes.length === 2 && q.quotes.every(r => r.noData === true), 'stale file: every tf row is a no-data row')
ok(q.quotes.every(r => r.price === 0), 'stale file: no price at all, not the file price and not a demo walk')
ok(q.source !== 'demo', `stale file: the footer does not claim 示範 prices for dashes: ${q.source}`)
ok(q.index.value === 0 && q.index.change === 0, `stale file: footer index falls back to 0, never the stale price: ${q.index.value}`)
lines = boardText(q)
show(lines)
ok(!lines.some(l => l.includes('示範')), 'stale file: board footer never says 示範')
ok(!lines.some(l => l.includes('47,557') || l.includes('110.35')), 'stale file: the stale prices are not drawn')

// a file exactly at the window edge is still fresh (the boundary is >, not >=)
await writeFutures(tfDir, CLOCK - QUOTE_STALE_MS)
await band.poll()
;({ props: q } = await band.draw())
ok(q.quotes.every(r => !r.noData), 'file aged exactly QUOTE_STALE_MS is still used')

// a file stamped in the future would never go stale: past a minute of clock
// slack it is refused, inside it it is used
await writeFutures(tfDir, CLOCK + 10 * 60_000)
await band.poll()
;({ props: q } = await band.draw())
ok(q.quotes.every(r => r.noData), 'a file stamped 10 min in the future is not used')
await writeFutures(tfDir, CLOCK + 30_000)
await band.poll()
;({ props: q } = await band.draw())
ok(q.quotes.every(r => !r.noData), 'a file 30 s ahead (clock slack) is still used')

// --- path 3 guard: the stock override is untouched, and never leaks into tf -
{
  const quotesPath = `${twDir}/.claude/stock-quotes.json`
  const raw = JSON.parse(await readFile(quotesPath, 'utf8'))
  raw.asOf = CLOCK - 10_000
  await writeFile(quotesPath, JSON.stringify(raw, null, 2))
}
const tw = await boot(twDir, 'tw')
let { props: r } = await tw.draw()
console.log('tw rows:', r.quotes.map(x => `${x.code} price=${x.price} noData=${!!x.noData} dec=${x.decimals}`).join('  '), `source=${r.source}`)
ok(r.market === 'tw' && r.source === 'file', `tw override still drives 台股: ${r.market} ${r.source}`)
ok(r.quotes.find(x => x.code === '1111')?.price === 105, 'tw override price wins (1111 = 105)')
ok(r.quotes.every(x => x.decimals === undefined), 'stock rows carry no decimals field (board default 2, unchanged)')
ok(r.sourceLabel === '' , `override without a source name keeps the generic label: "${r.sourceLabel}"`)
await tw.setConfig({ market: 'tf' })
;({ props: r } = await tw.draw())
console.log('tf rows in the tw project:', r.quotes.map(x => `${x.code} price=${x.price} noData=${!!x.noData}`).join('  '))
ok(r.market === 'tf' && r.quotes.length === 1 && r.quotes[0].noData === true, 'a stock override (no market field) never prices tf')
ok(tw.fetched.length === 0, 'feed off: the tw project made no request')

done()
