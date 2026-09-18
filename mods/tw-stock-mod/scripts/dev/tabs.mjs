// Market tabs (issue #9): the single cycling market button becomes one plain
// Button per stop of buildCycle() - key `stock-band:tab:<market>[:pnl]` - so a
// stop is one press away instead of up to five. The current stop's label is
// wrapped `[台指期]` and drawn at full strength; every other tab is dimColor.
// Width: the tabs never drop; sessionNote, then taipeiNote, then the session
// badge give way as the row narrows. Chart view keeps the tab row.
//
// Usage: node tabs.mjs $OUT/register.js <holdings-proj> <plain-proj>
// <holdings-proj> is run-checks' tf-pnl fixture (feed off, `futures` list
// rewritten here); this script writes the runtime-dir futures-holdings.json
// and a config `holdings.us` block so all six stops exist. <plain-proj> has
// neither futures nor holdings: three tabs.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir, plainDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const CLOCK = taipei(17, 21, 0) // Thursday 21:00 台北: 夜盤 open, 台股/美股 closed
const runtimeDirFor = dir => `${dir}/home/.claude/stock-band/${dir.replace(/^\/+/, '').replace(/\//g, '-')}/`
const runtime = runtimeDirFor(projDir)

const holdingsFile = {
  asOf: CLOCK - 30_000,
  market: 'tf',
  source: '永豐 期貨',
  holdings: [
    { code: 'TXFJ6', name: '臺股期貨 202610', qty: 1, cost: 47400.0, price: 47500.0, prevClose: 47428.0, multiplier: 200.0, direction: 'Buy' },
  ],
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
    http: { fetch: async () => { throw new Error('tabs: no network expected') } },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('tabs: no spawn expected') } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  const draw = async (columns = 120) => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns } }, async () => ({ kids: [] }))
    const btns = [], texts = []; let props
    const walk = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') props = n.props.props
      if (n.type === 'Button') btns.push({ key: n.props.key, label: n.props.label, dim: !!n.props.dimColor, plain: !!n.props.plain, press: n.props.onPress })
      if (n.type === 'Text') texts.push((n.kids ?? []).filter(k => typeof k === 'string').join(''))
      for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
    walk(tree)
    const tabs = btns.filter(b => typeof b.key === 'string' && b.key.startsWith('stock-band:tab:'))
    return { btns, texts, props, tabs }
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
  return { draw, poll, setConfig, logs }
}

/** the tab labels as drawn, in row order */
const labels = tabs => tabs.map(t => t.label).join('|')
/** the one tab drawn as selected: `[label]`, not dim; '' when none/many */
const selected = tabs => {
  const marked = tabs.filter(t => /^\[.+\]$/.test(t.label) && !t.dim)
  return marked.length === 1 ? marked[0].label.slice(1, -1) : ''
}
/** presses the tab whose bare label is `name` (a missing one is left to the assertion after it) */
const pressTab = (tabs, name) => tabs.find(t => t.label.replace(/^\[|\]$/g, '') === name)?.press()

// --- 3 tabs: no futures, no holdings ------------------------------------------
const plain = await boot(plainDir, 'tabs-plain')
await plain.setConfig({ market: 'us' })
let { tabs, btns } = await plain.draw()
console.log('plain buttons:', btns.map(b => `${b.key}=${b.label}${b.dim ? '(dim)' : ''}`).join('  '))
ok(tabs.length === 3, `no futures, no US holdings: three tabs (got ${tabs.length})`)
ok(labels(tabs).replace(/[[\]]/g, '') === '美股|台股|台股庫存', `tab labels 美股|台股|台股庫存: ${labels(tabs)}`)
ok(tabs.map(t => t.key).join('|') === 'stock-band:tab:us|stock-band:tab:tw|stock-band:tab:tw:pnl', `tab keys: ${tabs.map(t => t.key).join('|')}`)
ok(tabs.length > 0 && tabs.every(t => t.plain), 'tabs are plain Buttons (no [ ] chrome of their own)')
ok(!btns.some(b => b.key === 'stock-band:market'), 'the cycling market button is gone')
ok(selected(tabs) === '美股', `the pinned 美股 stop is the one marked tab: "${selected(tabs)}"`)
ok(tabs.filter(t => t.dim).length === 2, `the two other tabs are dim: ${tabs.filter(t => t.dim).length}`)

// each tab lands where the old cycle landed: market + view, mark moves
pressTab(tabs, '台股庫存')
let { tabs: t2, props: p2 } = await plain.draw()
ok(p2.market === 'tw' && p2.view === 'pnl', `台股庫存 tab lands on the tw pnl view in one press: ${p2.market}/${p2.view}`)
ok(selected(t2) === '台股庫存', `mark moved to 台股庫存: "${selected(t2)}"`)
ok(t2.filter(t => t.dim).length === 2 && !t2.find(t => t.key === 'stock-band:tab:tw:pnl').dim, 'only the selected tab is at full strength')
pressTab(t2, '台股')
;({ tabs: t2, props: p2 } = await plain.draw())
ok(p2.market === 'tw' && p2.view === 'table', `台股 tab lands on the tw table: ${p2.market}/${p2.view}`)
ok(selected(t2) === '台股', `mark moved to 台股: "${selected(t2)}"`)
pressTab(t2, '美股')
;({ tabs: t2, props: p2 } = await plain.draw())
ok(p2.market === 'us' && p2.view === 'table', `美股 tab lands back on the us table: ${p2.market}/${p2.view}`)
ok(selected(t2) === '美股', `mark back on 美股: "${selected(t2)}"`)

// --- 5 then 6 tabs: futures list + tf holdings file, then US holdings too -------
await mkdir(runtime, { recursive: true })
await writeFile(`${runtime}futures-holdings.json`, JSON.stringify(holdingsFile, null, 1))
const band = await boot(projDir, 'tabs-full')
await band.setConfig({ market: 'us', futures: [{ code: 'TXFR1', name: '台指近' }], holdings: { us: [] } })
;({ tabs } = await band.draw())
ok(tabs.length === 5 && labels(tabs).replace(/[[\]]/g, '') === '美股|台股|台股庫存|台指期|期貨庫存', `no US holdings: five tabs, no 美股庫存: ${labels(tabs)}`)

await band.setConfig({ holdings: { us: [{ code: 'AAPL', qty: 10, cost: 200 }] } })
;({ tabs, btns } = await band.draw())
console.log('full buttons:', btns.map(b => `${b.key}=${b.label}${b.dim ? '(dim)' : ''}`).join('  '))
ok(tabs.length === 6, `futures + tf holdings + US holdings: six tabs (got ${tabs.length})`)
ok(labels(tabs).replace(/[[\]]/g, '') === '美股|美股庫存|台股|台股庫存|台指期|期貨庫存', `six tab labels in cycle order: ${labels(tabs)}`)
ok(tabs.map(t => t.key).join('|') === 'stock-band:tab:us|stock-band:tab:us:pnl|stock-band:tab:tw|stock-band:tab:tw:pnl|stock-band:tab:tf|stock-band:tab:tf:pnl', `six tab keys: ${tabs.map(t => t.key).join('|')}`)
ok(selected(tabs) === '美股', `美股 marked at the start: "${selected(tabs)}"`)

// direct landing: 美股 → 期貨庫存 in ONE press (the old cycle needed five)
pressTab(tabs, '期貨庫存')
let { tabs: t3, props: p3 } = await band.draw()
ok(p3.market === 'tf' && p3.view === 'pnl', `期貨庫存 from 美股 in one press: ${p3.market}/${p3.view}`)
ok(p3.holdings.length === 1 && p3.holdingsSource === '永豐 期貨', `tf pnl view shows the file's position: ${p3.holdings.length} from ${p3.holdingsSource}`)
ok(selected(t3) === '期貨庫存', `mark on 期貨庫存: "${selected(t3)}"`)
ok(t3.filter(t => !t.dim).length === 1, 'exactly one tab at full strength')

// pressing the tab already selected changes nothing
pressTab(t3, '期貨庫存')
;({ tabs: t3, props: p3 } = await band.draw())
ok(p3.market === 'tf' && p3.view === 'pnl' && selected(t3) === '期貨庫存', 'pressing the selected tab again stays put')

// chart view: tab row stays with the chart buttons; 台指期 leaves the chart
pressTab(t3, '台股')
;({ tabs: t3, btns } = await band.draw())
btns.find(b => b.label === '趨勢圖')?.press()
;({ tabs: t3, btns, props: p3 } = await band.draw())
ok(p3.view === 'chart' && p3.market === 'tw', `趨勢圖 opens the tw chart: ${p3.market}/${p3.view}`)
ok(t3.length === 6, `the tab row stays in chart view: ${t3.length} tabs`)
ok(selected(t3) === '台股', `chart view still marks the market it charts: "${selected(t3)}"`)
const rowKeys = btns.map(b => b.key)
ok(rowKeys.includes('stock-band:tab:tf:pnl') && rowKeys.indexOf('stock-band:prev') > rowKeys.indexOf('stock-band:tab:tf:pnl') && rowKeys.includes('stock-band:list'), `◀/▶/回清單 follow the tabs: ${rowKeys.join(' ')}`)
pressTab(t3, '台指期')
;({ tabs: t3, props: p3 } = await band.draw())
ok(p3.view === 'table' && p3.market === 'tf', `台指期 from the chart leaves the chart for the tf table: ${p3.market}/${p3.view}`)
ok(p3.quotes.length === 1 && p3.quotes[0].code === 'TXFR1', `tf table lists the futures code: ${p3.quotes.map(q => q.code)}`)
ok(selected(t3) === '台指期', `mark on 台指期: "${selected(t3)}"`)
// the same market's own tab also leaves the chart (chart-nav's tw-on-tw case)
btns = (await band.draw()).btns
btns.find(b => b.label === '趨勢圖')?.press()
;({ tabs: t3, props: p3 } = await band.draw())
ok(p3.view === 'chart', 'chart open on tf')
pressTab(t3, '台指期')
;({ props: p3 } = await band.draw())
ok(p3.view === 'table' && p3.market === 'tf', `the charted market's own tab leaves the chart: ${p3.market}/${p3.view}`)

// --- width: tabs never drop; sessionNote → taipeiNote → badge give way ----------
pressTab((await band.draw()).tabs, '美股') // 美股 at 21:00 台北: closed, sessionNote in ET, taipeiNote set
const SIX = '美股|美股庫存|台股|台股庫存|台指期|期貨庫存'
const shape = ({ texts, props }) => {
  const badge = texts.some(t => /盤中|休市/.test(t))
  const session = props.sessionNote !== '' && texts.includes(props.sessionNote)
  const taipei = props.taipeiNote !== '' && texts.includes(props.taipeiNote)
  return { badge, session, taipei, name: `${badge ? 'badge' : '-'}/${session ? 'session' : '-'}/${taipei ? 'taipei' : '-'}` }
}
const ALLOWED = ['badge/session/taipei', 'badge/-/taipei', 'badge/-/-', '-/-/-']
const seen = []
let allTabs = true, rank = -1, monotone = true
for (let cols = 130; cols >= 60; cols -= 1) {
  const d = await band.draw(cols)
  if (labels(d.tabs).replace(/[[\]]/g, '') !== SIX) allTabs = false
  const s = shape(d)
  const r = ALLOWED.indexOf(s.name)
  if (r < rank) monotone = false
  if (r >= 0) rank = r
  seen.push(`${cols}:${s.name}`)
}
const at74 = shape(await band.draw(74))
const at130 = shape(await band.draw(130))
console.log('width sweep:', seen.filter((s, i, a) => i === 0 || s.split(':')[1] !== a[i - 1].split(':')[1]).join('  '))
ok(allTabs, 'all six tabs at every width from 130 down to 60')
ok(at130.name === 'badge/session/taipei', `130 cols: badge + sessionNote + taipeiNote all shown: ${at130.name}`)
ok(at74.name === '-/-/-', `74 cols: six tabs only, notes and badge gone: ${at74.name}`)
ok(monotone && seen.every(s => ALLOWED.includes(s.split(':')[1])), `drop order sessionNote → taipeiNote → badge, never a tab: ${[...new Set(seen.map(s => s.split(':')[1]))].join(' → ')}`)
ok(new Set(seen.map(s => s.split(':')[1])).size === 4, 'each of the four rungs is reached somewhere in the sweep')

// --- width, three-tab default: what a plain user sees at the 74-col cap ---------
// Pinned so the threshold is recorded, not implied: base drew sessionNote
// unconditionally; the tab row's fits() gate lets it back in from ~82 cols.
pressTab((await plain.draw()).tabs, '台股')
const plain74 = shape(await plain.draw(74))
const plain100 = shape(await plain.draw(100))
console.log('three tabs:', `74:${plain74.name}`, `100:${plain100.name}`)
ok(plain74.name === 'badge/-/-', `three tabs at 74 cols: badge stays, sessionNote already gone: ${plain74.name}`)
ok(plain100.name === 'badge/session/-', `three tabs at 100 cols (台股, no taipeiNote): badge + sessionNote: ${plain100.name}`)

// --- cleanup: the shared fixture goes back to its documented shape -------------
await rm(`${runtime}futures-holdings.json`, { force: true })
await band.setConfig({ market: 'us', futures: [], holdings: { us: [] } })
done()
