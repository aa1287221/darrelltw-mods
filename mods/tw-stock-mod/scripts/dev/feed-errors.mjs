// Proves the feed's failure handling against the REAL register.tsx (bundled),
// with a stub host whose $.http.fetch is scripted per host (yahoo / mis /
// pionex): a throw, a 429, a request that never settles.
//
//   (1) a THROWN Yahoo request backs Yahoo off - the next tick inside the
//       back-off sends nothing, the first one past it tries again
//   (2) a thrown route falls through to the next `twSources` entry in the
//       same tick instead of unwinding the whole tick
//   (3) a Yahoo back-off does not hold 證交所 (per-host back-off)
//   (4) a request that never settles does not latch the feed forever: past
//       IN_FLIGHT_STUCK_MS the next tick goes ahead
//   (5) ...and when that abandoned request finally answers, its older
//       prices do not replace what the newer tick already published
//
// Usage: node feed-errors.mjs <register.js>
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'

const [, , modPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

// Tue 2026-09-22 10:00 Taipei - 台股 open, so marketNeedsFeed() is true every tick
const TW_OPEN = Date.UTC(2026, 8, 22, 2, 0)
const FEED_MS = 30_000
const STUCK_MS = 120_000 // hooks/constants.ts's IN_FLIGHT_STUCK_MS

const hostOf = u =>
  u.includes('finance.yahoo.com') ? 'yahoo' : u.includes('mis.twse.com.tw') ? 'mis' : u.includes('pionex') ? 'pionex' : 'other'

const SPARK_BODY = JSON.stringify({
  spark: {
    result: [
      { symbol: '2330.TW', response: [{ meta: { regularMarketPrice: 1100, previousClose: 1000, regularMarketTime: TW_OPEN / 1000 } }] },
      { symbol: '^TWII', response: [{ meta: { regularMarketPrice: 20000, previousClose: 19900, regularMarketTime: TW_OPEN / 1000 } }] },
    ],
  },
})
const MIS_BODY = JSON.stringify({
  rtcode: '0000',
  msgArray: [
    { c: '2330', n: '台積電', z: '1105', y: '1000', tlong: String(TW_OPEN) },
    { c: 't00', n: '發行量加權股價指數', z: '20010', y: '19900', tlong: String(TW_OPEN) },
  ],
})

function findClient(node) {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Client') return node
  for (const k of node.kids ?? []) {
    const hit = findClient(k)
    if (hit) return hit
  }
  return undefined
}

/**
 * A fresh module instance per case (register.tsx keeps module-level state),
 * a hand-driven clock, and `answer(host, n)` deciding each request: return a
 * response object, 'throw', or 'hang'.
 */
let moduleTick = 0
async function boot(twSources, answer) {
  moduleTick += 1
  const url = pathToFileURL(modPath)
  url.search = `?case=${moduleTick}`
  const { register } = await import(url.href)

  const files = {
    '.claude/stock-band.json': JSON.stringify({
      market: 'tw',
      feed: 'auto',
      twSources,
      feedMs: FEED_MS,
      refreshMs: 3000,
      pageMs: 0,
      tw: [{ code: '2330', name: '台積電', prevClose: 1000 }],
      us: [],
    }),
  }
  const calls = []
  const timers = []
  const logs = []
  let clock = TW_OPEN
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => {
        files[path] = text
      },
    },
    env: { get: async name => (name === 'HOME' ? '/fake-home' : undefined) },
    session: { cwd: async () => '/fake-project' },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    plugin: { root: '/fake-plugin-root' },
    ui: {
      log: m => logs.push(m),
      invalidate: () => {},
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: {
      fetch: async u => {
        const host = hostOf(u)
        const n = calls.filter(c => c.host === host).length
        calls.push({ host, at: clock })
        const r = answer(host, n)
        if (r === 'throw') throw new Error(`getaddrinfo ENOTFOUND (${host})`)
        if (r === 'hang') return new Promise(() => {})
        if (r && typeof r.then === 'function') return r // a deferred answer the case resolves itself
        return { ok: r.status >= 200 && r.status < 300, headers: {}, text: '', ...r }
      },
    },
  }

  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  // a hanging boot feed() never resolves, so session.start is not awaited
  // past a short real delay
  await Promise.race([handlers.get('session.start')($, {}, next), new Promise(r => setTimeout(r, 300))])

  const probe = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
    return findClient(tree)?.props?.props
  }
  // the feed timer is the one registered at feedInterval(); fire only it so
  // the 3s poll's own reads stay out of the way
  const tick = async ms => {
    clock += ms
    for (const t of timers.filter(t => t.ms >= FEED_MS)) {
      await Promise.race([t.fn(), new Promise(r => setTimeout(r, 300))])
    }
    await new Promise(r => setTimeout(r, 50))
  }
  const count = host => calls.filter(c => c.host === host).length
  return { probe, tick, count, logs }
}

// --- (1) a thrown Yahoo request backs Yahoo off -----------------------------
{
  const { tick, count, logs } = await boot(['yahoo'], () => 'throw')
  ok(count('yahoo') === 1, `(1) boot tick tried Yahoo once (got ${count('yahoo')})`)
  ok(logs.some(l => /network error/.test(l) && /next try in 60s/.test(l)), '(1) the throw is logged as a network error with a 60s back-off')
  await tick(FEED_MS)
  ok(count('yahoo') === 1, `(1) +30s: still inside the back-off, no new request (got ${count('yahoo')})`)
  await tick(FEED_MS)
  ok(count('yahoo') === 2, `(1) +60s: back-off over, Yahoo tried again (got ${count('yahoo')})`)
  ok(logs.some(l => /next try in 120s/.test(l)), '(1) the second failure doubles the back-off to 120s')
}

// --- (2) a thrown route falls through to the next twSources entry -----------
{
  const { probe, count } = await boot(['mis', 'yahoo'], host =>
    host === 'mis' ? 'throw' : { status: 200, text: SPARK_BODY },
  )
  const p = await probe()
  ok(count('mis') === 1 && count('yahoo') === 1, `(2) one tick tried 證交所 then Yahoo (mis=${count('mis')}, yahoo=${count('yahoo')})`)
  ok(p?.source === 'live' && p?.sourceLabel === 'Yahoo 延遲', `(2) Yahoo priced the board (source=${p?.source}, label=${p?.sourceLabel})`)
}

// --- (3) a Yahoo back-off does not hold 證交所 -------------------------------
{
  // yahoo first and 429'ing, mis second and healthy
  const { probe, tick, count } = await boot(['yahoo', 'mis'], host =>
    host === 'yahoo' ? { status: 429 } : { status: 200, text: MIS_BODY },
  )
  ok(count('yahoo') === 1 && count('mis') === 1, `(3) boot: Yahoo 429'd, 證交所 answered (yahoo=${count('yahoo')}, mis=${count('mis')})`)
  await tick(FEED_MS)
  const p = await probe()
  ok(count('yahoo') === 1, `(3) +30s: Yahoo still backed off, not retried (got ${count('yahoo')})`)
  ok(count('mis') === 2, `(3) +30s: 證交所 kept feeding through Yahoo's back-off (got ${count('mis')})`)
  ok(p?.sourceLabel === '證交所 即時', `(3) the board is priced by 證交所 (label=${p?.sourceLabel})`)
}

// --- (4) a request that never settles does not latch the feed ----------------
{
  const { tick, count, logs } = await boot(['yahoo'], (host, n) => (n === 0 ? 'hang' : { status: 200, text: SPARK_BODY }))
  ok(count('yahoo') === 1, `(4) boot tick sent one request, which hangs (got ${count('yahoo')})`)
  await tick(FEED_MS)
  ok(count('yahoo') === 1, `(4) +30s: the hung request still holds the latch (got ${count('yahoo')})`)
  await tick(STUCK_MS)
  ok(count('yahoo') === 2, `(4) past IN_FLIGHT_STUCK_MS the next tick goes ahead (got ${count('yahoo')})`)
  ok(logs.some(l => /never settled/.test(l)), '(4) the abandoned tick is logged')
}

// --- (5) a late answer from the abandoned tick is dropped -------------------
{
  let answerLate
  const late = new Promise(resolve => {
    answerLate = resolve
  })
  const sparkAt = price =>
    JSON.stringify({
      spark: {
        result: [{ symbol: '2330.TW', response: [{ meta: { regularMarketPrice: price, previousClose: 1000, regularMarketTime: TW_OPEN / 1000 } }] }],
      },
    })
  const { probe, tick, count } = await boot(['yahoo'], (host, n) => (n === 0 ? late : { status: 200, text: sparkAt(1200) }))
  await tick(STUCK_MS + FEED_MS)
  let p = await probe()
  const row = () => p?.quotes?.find(q => q.code === '2330')
  ok(count('yahoo') === 2 && row()?.price === 1200, `(5) the newer tick published 1200 (requests=${count('yahoo')}, price=${row()?.price})`)
  answerLate({ ok: true, status: 200, headers: {}, text: sparkAt(900) })
  await new Promise(r => setTimeout(r, 100))
  p = await probe()
  ok(row()?.price === 1200, `(5) the abandoned tick's late 900 did not replace it (price=${row()?.price})`)
}

done()
