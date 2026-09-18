// 台指期 (tf) market, at the config-file seam: a project whose stock-band.json
// carries a `futures` list gets a third market with 日盤 08:45-13:45 and 夜盤
// 15:00-翌日 05:00, a 台指期 tab on the tab row, and no-data rows
// (never the demo walk) until a quotes source exists. A project without
// `futures` must behave exactly as before - that guard runs last, on a fresh
// module instance. No network: feed is "off" in both fixtures.
//
// Usage: node tf-market.mjs $OUT/register.js <proj-with-futures> <proj-without>
// Both dirs must hold .claude/stock-band.json; this script rewrites the
// `market` pin in place to probe each market's phase at the same instant.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir, plainDir] = process.argv

const TAIPEI = 8
/** an exact Taipei wall-clock minute in 2026-09, as epoch ms */
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const label = ms => `${new Date(ms + TAIPEI * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} 台北`
// 2026-09-17 is a Thursday; 19 Sat, 20 Sun, 21 Mon
const THU = 17, FRI = 18, SAT = 19, SUN = 20, MON = 21

/** boots one fresh register.js against `dir`; `tag` defeats the ESM module cache */
async function boot(dir, tag) {
  let clock = taipei(THU, 21, 0)
  const timers = []
  const logs = []
  let invalidates = 0
  const home = `${dir}/home`
  await mkdir(`${home}/.claude`, { recursive: true })
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
    fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${dir}/${p}`)).toString() },
    ui: {
      log: m => logs.push(String(m)),
      invalidate: () => { invalidates++ },
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: { fetch: async () => { throw new Error('tf-market: no network expected') } },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('tf-market: no spawn expected') } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  const draw = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 120 } }, async () => ({ kids: [] }))
    const btns = [], texts = []; let props
    const walk = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') props = n.props.props
      if (n.type === 'Button') btns.push({ key: n.props.key, label: n.props.label, press: n.props.onPress })
      if (n.type === 'Text') texts.push((n.kids ?? []).filter(k => typeof k === 'string').join(''))
      for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
    walk(tree)
    return { btns, texts, props }
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
  const at = ms => { clock = ms }
  return { draw, poll, setConfig, at, logs }
}

const band = await boot(projDir, 'futures')

// --- path 6: sessions, one market pinned at a time ---------------------------
const badge = texts => texts.find(t => t.startsWith('☀') || t.startsWith('☽')) ?? ''
const probe = async (pin, ms, expectPhase, why) => {
  band.at(ms)
  const { props, texts } = await band.draw()
  const got = props.market === pin ? props.phase : `market=${props.market}`
  console.log(`${label(ms)}  ${pin.padEnd(4)} ${String(got).padEnd(10)} ${badge(texts).padEnd(6)} ${props.sessionNote}`)
  ok(props.market === pin && props.phase === expectPhase, `${label(ms)} ${pin} ${expectPhase}: ${why}`)
  return props
}

await band.setConfig({ market: 'tf' })
let p = await probe('tf', taipei(THU, 21, 0), 'open', '夜盤 21:00 open')
ok(badge((await band.draw()).texts).startsWith('☀'), '21:00 tf badge is the sun')
await probe('tf', taipei(FRI, 4, 59), 'open', 'Thursday 夜盤 still open at 04:59')
p = await probe('tf', taipei(FRI, 5, 0), 'closed', '夜盤 closes at 05:00')
ok(p.sessionNote === '下次開盤 08:45', `05:00 note names the 日盤 next: ${p.sessionNote}`)
await probe('tf', taipei(FRI, 8, 44), 'closed', 'before 日盤 open')
await probe('tf', taipei(FRI, 8, 45), 'open', '日盤 opens 08:45')
await probe('tf', taipei(FRI, 13, 44), 'open', '日盤 still open at 13:44')
p = await probe('tf', taipei(FRI, 13, 45), 'closed', '日盤 closes at 13:45 (not 13:30 like 台股)')
ok(p.sessionNote === '下次開盤 15:00', `13:45 note names the 夜盤 next: ${p.sessionNote}`)
ok(p.clock === '13:45', `closed clock is the 日盤 close: ${p.clock}`)
await probe('tf', taipei(FRI, 15, 0), 'open', '夜盤 opens 15:00')
await probe('tf', taipei(SAT, 3, 0), 'open', 'Friday 夜盤 runs into Saturday 03:00')
p = await probe('tf', taipei(SAT, 5, 0), 'closed', 'Friday 夜盤 ends Saturday 05:00')
ok(p.clock === '05:00', `Saturday closed clock is the 夜盤 close: ${p.clock}`)
p = await probe('tf', taipei(SAT, 15, 0), 'closed', 'no session starts Saturday')
ok(p.sessionNote === '下個交易日 08:45', `Saturday note points at Monday: ${p.sessionNote}`)
p = await probe('tf', taipei(SUN, 21, 0), 'closed', 'no session starts Sunday')
ok(p.sessionNote === '下次開盤 08:45', `Sunday 21:00 note names Monday 08:45: ${p.sessionNote}`)
await probe('tf', taipei(MON, 3, 0), 'closed', 'no Sunday 夜盤, so Monday 03:00 is closed')
p = await probe('tf', taipei(MON, 8, 45), 'open', 'Monday 日盤 opens')
ok(p.sessionOpen === '08:45' && p.sessionClose === '13:45', `日盤 axis bounds: ${p.sessionOpen}-${p.sessionClose}`)
p = await probe('tf', taipei(THU, 22, 0), 'open', '夜盤 22:00 open')
ok(p.sessionOpen === '15:00' && p.sessionClose === '05:00', `夜盤 axis bounds: ${p.sessionOpen}-${p.sessionClose}`)
ok(p.taipeiNote === '', 'tf trades on Taipei time, no restatement')

await band.setConfig({ market: 'tw' })
await probe('tw', taipei(THU, 21, 0), 'closed', '台股 closed at 21:00 while tf is open')
await probe('tw', taipei(FRI, 13, 40), 'closed', '台股 closed at 13:40 (tw unchanged: 13:30 close)')
await band.setConfig({ market: 'us' })
await probe('us', taipei(THU, 21, 0), 'closed', '美股 closed at 21:00 Taipei (09:00 ET)')
await probe('us', taipei(THU, 22, 0), 'open', '美股 open at 22:00 Taipei (10:00 ET)')

// --- auto market pick --------------------------------------------------------
await band.setConfig({ market: 'auto' })
const auto = async (ms, market, phase, why) => {
  band.at(ms)
  const { props } = await band.draw()
  console.log(`${label(ms)}  auto -> ${props.market} ${props.phase}`)
  ok(props.market === market && props.phase === phase, `${label(ms)} auto picks ${market} ${phase}: ${why}`)
}
await auto(taipei(THU, 21, 0), 'tf', 'open', 'neither tw nor us open, tf is')
await auto(taipei(THU, 22, 0), 'us', 'open', 'us open wins over tf')
await auto(taipei(THU, 10, 0), 'tw', 'open', 'tw open wins over tf 日盤')
await auto(taipei(THU, 14, 0), 'tw', 'closed', 'everything closed: existing rule, tf never wins the closed race')
await auto(taipei(SAT, 3, 0), 'us', 'open', 'Saturday 03:00 Taipei is Friday 15:00 ET: us still open')
await auto(taipei(SAT, 4, 30), 'tf', 'open', 'Saturday 04:30: us closed at 04:00, Friday 夜盤 runs to 05:00')

// --- no quotes source yet: no-data marker, never the demo walk ---------------
await band.setConfig({ market: 'tf' })
band.at(taipei(THU, 21, 0))
let { props: q, btns } = await band.draw()
console.log('tf rows:', q.quotes.map(r => `${r.code}/${r.name} price=${r.price} noData=${!!r.noData}`).join('  '))
ok(q.quotes.length === 2, `2 futures rows (invalid entries dropped): ${q.quotes.length}`)
ok(q.quotes.map(r => r.code).sort().join() === 'SRFJ6,TXFR1', 'rows are the two valid codes')
ok(q.quotes.find(r => r.code === 'SRFJ6')?.name === '小台50', 'config name used')
ok(q.quotes.find(r => r.code === 'TXFR1')?.name === 'TXFR1', 'no name falls back to the code')
ok(q.quotes.every(r => r.noData === true), 'every tf row is a no-data row')
ok(q.marketLabel === '台指期', `market label: ${q.marketLabel}`)
ok(q.pageCount === 1, 'two rows fit one page')
btns.find(b => b.label === '趨勢圖').press()
;({ props: q, btns } = await band.draw())
ok(q.view === 'chart', 'chart view opens on a tf row')
ok(q.quotes[q.focus]?.bars === undefined, 'chart view does not invent demo bars for tf')
btns.find(b => b.label === '回清單').press()

// --- invalid entries: dropped, logged once ---------------------------------
await band.poll(); await band.poll(); await band.poll()
const dropLogs = band.logs.filter(l => /futures/.test(l))
console.log('log lines mentioning futures:', dropLogs)
ok(dropLogs.length === 1, `invalid futures entries logged exactly once across polls: ${dropLogs.length}`)

// --- path 10 (table half): 台指期 tab on the row ----------------------------
/** the tab row's bare labels (the selected one is drawn `[label]`) */
const tabLabels = btns => btns.filter(b => b.key?.startsWith('stock-band:tab:')).map(b => b.label.replace(/^\[|\]$/g, ''))
/** presses every tab in row order and returns `label=market/view` per landing */
const pressEachTab = async band => {
  const seen = []
  for (const name of tabLabels((await band.draw()).btns)) {
    const { btns } = await band.draw()
    btns.find(b => b.key?.startsWith('stock-band:tab:') && b.label.replace(/^\[|\]$/g, '') === name)?.press()
    const { props } = await band.draw()
    seen.push(`${name}=${props.market}/${props.view}`)
  }
  return seen
}
await band.setConfig({ market: 'us' })
const tabs = tabLabels((await band.draw()).btns)
console.log('tabs with futures:', tabs.join(' · '))
ok(tabs.join('|') === '美股|台股|台股庫存|台指期', '美股 · 台股 · 台股庫存 · 台指期')
const landed = await pressEachTab(band)
console.log('each tab lands:', landed.join('  '))
ok(landed.join('|') === '美股=us/table|台股=tw/table|台股庫存=tw/pnl|台指期=tf/table', 'each tab lands on its own market + view')
;({ props: q } = await band.draw())

// --- path 1 guard: no `futures` => no tf anywhere ---------------------------
const plain = await boot(plainDir, 'plain')
await plain.setConfig({ market: 'auto' })
plain.at(taipei(THU, 21, 0))
let { props: r } = await plain.draw()
ok(r.market !== 'tf', `no futures: auto never lands on tf (got ${r.market})`)
await plain.setConfig({ market: 'us' })
const plainTabs = tabLabels((await plain.draw()).btns)
console.log('tabs without futures:', plainTabs.join(' · '))
ok(plainTabs.join('|') === '美股|台股|台股庫存', 'no futures: tabs are 美股 · 台股 · 台股庫存, no 台指期')
const plainLanded = await pressEachTab(plain)
ok(plainLanded.join('|') === '美股=us/table|台股=tw/table|台股庫存=tw/pnl', `no futures: each tab lands where the old cycle did: ${plainLanded.join('  ')}`)
ok(!plain.logs.some(l => /futures/.test(l)), 'no futures: nothing logged about futures')

done()
