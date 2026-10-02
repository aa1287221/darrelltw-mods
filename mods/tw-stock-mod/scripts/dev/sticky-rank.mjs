// Sticky rank order: with sort 'change' the table must NOT re-rank on every
// snapshot. A re-sort that swaps occupants mid-page made board.tsx read a
// crossed rank as a page turn, so the full-row flap (code + name + price)
// replayed on nearly every quote. The order is now frozen per market and only
// refreshed on a page turn, a market switch, a watchlist change, or demo ->
// real data; between those only prices flap (a `was` with no code/name).
//
// Fixture: 12 symbols per market, two pages (columns 1), a quotes file naming
// no market (drives tw and us alike), feed off. Every snapshot permutes the
// prices so most ranks cross.
//
// Usage: node sticky-rank.mjs <register.js> <projDir>
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv

// 2026-09-17T10:00:00+08:00, same anchor as rank-cross.mjs
let clock = 1789596000000
const PAGE_MS = 60_000
const N = 12
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
  fs: { read: async p => readFile(p.startsWith('/') ? p : `${projDir}/${p}`).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async () => { throw new Error('sticky-rank runs feed:"off" - $.http.fetch should never be called') } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}

const codes = { tw: [], us: [] }
for (let i = 0; i < N; i++) {
  codes.tw.push(`T${String(i).padStart(2, '0')}`)
  codes.us.push(`U${String(i).padStart(2, '0')}`)
}
const writeConfig = async extra => {
  await mkdir(`${projDir}/.claude`, { recursive: true })
  const list = m => codes[m].map(code => ({ code, name: code, prevClose: 100 }))
  await writeFile(`${projDir}/.claude/stock-band.json`, JSON.stringify({
    market: 'tw', sort: 'change', feed: 'off', refreshMs: 1000, pageMs: PAGE_MS, columns: 1,
    tw: list('tw'), us: list('us'), ...extra,
  }, null, 2))
}
// snapshot k: a permutation of 94..105 per market, a different one each k
const priceOf = (i, k) => 94 + ((i * 5 + k * 7) % N) + (k % 2 ? 0.5 : 0)
const writeQuotes = async k => {
  const quotes = {}
  for (const m of ['tw', 'us']) codes[m].forEach((code, i) => { quotes[code] = { price: priceOf(i, k), prevClose: 100, name: code } })
  await writeFile(`${projDir}/.claude/stock-quotes.json`, JSON.stringify({ asOf: clock, quotes }, null, 2))
}
const expectedOrder = (m, k) => codes[m].map((code, i) => ({ code, p: priceOf(i, k) })).sort((a, b) => b.p - a.p).map(x => x.code)

await writeConfig()
// a stale snapshot, so the board starts on the demo walk (a MISSING file is only
// re-read every 10th poll, which would make this section crawl)
await writeFile(`${projDir}/.claude/stock-quotes.json`, JSON.stringify({ asOf: 1, quotes: { [codes.tw[0]]: { price: 100, prevClose: 100 } } }))
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500))

const draw = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  const btns = []
  let props
  const walk = n => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') btns.push({ key: n.props.key, press: n.props.onPress })
    for (const c of [...(n.kids ?? []), n.props?.children]) walk(c)
  }
  walk(tree)
  return { props, btns }
}
const poll = async () => { for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) } }
const snapshot = async k => { clock += 1000; await writeQuotes(k); await poll(); return (await draw()).props }
const codeFlaps = p => p.quotes.filter(q => q.was?.code !== undefined).length
const priceFlaps = p => p.quotes.filter(q => q.was !== undefined && q.was.code === undefined).length
const order = p => p.quotes.map(q => q.code).join(' ')

// --- demo walk -> first real snapshot: the demo ranks must not stay frozen -----------
let props = (await draw()).props
ok(order(props) !== expectedOrder('tw', 0).slice(0, props.quotes.length).join(' '), `control: the demo walk ranks differently from snapshot 0 (${order(props)})`)
props = await snapshot(0)

// --- first real snapshot, then N sticky snapshots ----------------------------
ok(props.view === 'table' && props.market === 'tw', 'on the tw table')
ok(props.pageCount >= 2, `fixture has >= 2 pages (pageCount ${props.pageCount})`)
const perPage = props.quotes.length
ok(props.quotes.length === perPage && perPage < N, `page 0 holds ${perPage} of ${N} rows`)
ok(order(props) === expectedOrder('tw', 0).slice(0, perPage).join(' '), 'first real snapshot: page 0 is ranked by the real pcts, not the demo walk')
const frozen = order(props)

let totalPriceFlaps = 0
let totalCodeFlaps = 0
for (let k = 1; k <= 6; k++) {
  const turnBefore = props.turn
  props = await snapshot(k)
  const cf = codeFlaps(props)
  const pf = priceFlaps(props)
  totalCodeFlaps += cf
  totalPriceFlaps += pf
  const wouldCross = expectedOrder('tw', k).slice(0, perPage).join(' ') !== frozen
  console.log(`snapshot ${k}: code-flaps ${cf}  price-flaps ${pf}  turn +${props.turn - turnBefore}  ranks would cross: ${wouldCross}`)
  ok(wouldCross, `snapshot ${k}: the fixture really does cross ranks (control)`)
  ok(cf === 0, `snapshot ${k}: no row changes occupant (${cf} rows with was.code)`)
  ok(order(props) === frozen, `snapshot ${k}: page 0 keeps its occupants in the frozen order`)
  ok(props.turn > turnBefore, `snapshot ${k}: the new snapshot still starts a (price-only) turn`)
}
ok(totalPriceFlaps > 0, `price-only flaps still happen (${totalPriceFlaps} rows across 6 snapshots; positive control)`)
ok(totalCodeFlaps === 0, 'zero code/name flaps across all 6 snapshots')

// --- a page turn re-ranks and flaps every row ------------------------------------
const turnBeforePage = (await draw()).props.turn
clock += PAGE_MS
await writeQuotes(7)
await poll()
props = (await draw()).props
const exp7 = expectedOrder('tw', 7)
ok(props.page === 1, `autoPage turned to page 1 (page ${props.page})`)
ok(props.turn > turnBeforePage, 'the page turn advances turn')
ok(codeFlaps(props) === props.quotes.length && props.quotes.length > 0, `page turn: every row flaps code/name (${codeFlaps(props)}/${props.quotes.length})`)
ok(order(props) === exp7.slice(perPage, perPage * 2).join(' '), 'page turn re-ranks: page 1 is ranks 7.. by the current pcts')
// each further turn (pageCount is 3: 5 + 5 + 2 rows) re-ranks by the newest pcts, wrapping to page 0
let pk = 7
for (const want of [2, 0]) {
  const prevLen = props.quotes.length
  clock += PAGE_MS
  await writeQuotes(++pk)
  await poll()
  props = (await draw()).props
  const slice = expectedOrder('tw', pk).slice(want * perPage, want * perPage + perPage)
  ok(props.page === want && order(props) === slice.join(' '), `page turn to ${want}: re-ranked by the newest pcts`)
  // a row with no counterpart on the page it turned from (2 rows -> 5) has nothing to turn away from
  ok(codeFlaps(props) === Math.min(prevLen, props.quotes.length), `page turn to ${want}: every row with an outgoing row flaps (${codeFlaps(props)})`)
}
const frozen8 = order(props)
clock += 3000 // past the page-turn window, so only the snapshot itself is under test
props = await snapshot(++pk)
ok(codeFlaps(props) === 0 && order(props) === frozen8, 'after the turn the order is frozen again (no occupant change)')

// --- market switch tw -> us -> tw ----------------------------------------------------
const press = async key => { const { btns } = await draw(); btns.find(b => b.key === key)?.press() ; return (await draw()).props }
props = await press('stock-band:tab:us')
ok(props.market === 'us' && props.page === 0, `switched to us at page 0 (${props.market}/${props.page})`)
ok(order(props) === expectedOrder('us', pk).slice(0, perPage).join(' '), 'us table is ranked by the current us pcts on landing')
const usFrozen = order(props)
let usCode = 0
for (let i = 0; i < 4; i++) { props = await snapshot(++pk); usCode += codeFlaps(props) }
ok(usCode === 0 && order(props) === usFrozen, `us: later snapshots keep the frozen order, no code flaps (${usCode})`)
props = await press('stock-band:tab:tw')
ok(props.market === 'tw' && props.page === 0, 'back on tw at page 0')
ok(order(props) === expectedOrder('tw', pk).slice(0, perPage).join(' '), 'switching back re-ranks tw by the newest pcts')
const twFrozen = order(props)
props = await snapshot(++pk)
ok(codeFlaps(props) === 0 && order(props) === twFrozen, 'tw after the switch: frozen again, no code flaps')

// --- watchlist code set change re-ranks ---------------------------------------------------
codes.tw.pop()
await writeConfig()
clock += 1000
await writeQuotes(++pk)
await poll()
props = (await draw()).props
ok(order(props) === expectedOrder('tw', pk).slice(0, perPage).join(' '), 'a changed watchlist re-ranks')

done()
