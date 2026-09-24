// Proves the feed stays inside its request budget (REQUESTS_PER_HOUR) once
// holdings widen what it fetches, against the REAL register.tsx (bundled):
// the feed prices the watchlist UNION every holding not on it, so 15 US
// symbols + 6 held elsewhere + the 3 indices is 24 symbols - two spark
// requests a tick, not one.
//
//   (1) holdings known at boot: an hour of the feed timer sends no more
//       than REQUESTS_PER_HOUR spark requests, and the boot log names the
//       real per-tick cost
//   (2) holdings that arrive mid-session (the timer was sized for one
//       request a tick): the next hour still stays inside the budget
//   (3) the countdown (props.nextFeedAt) names a tick that will actually
//       send, never one the budget will skip
//   (4) the budget holds back only the budgeted requests: with futures
//       listed, the broker heartbeat is still written every timer tick, so
//       the 永豐 fetcher never reads the gated gaps as "nobody is watching"
//   (5) a feedMs just under the widened interval (23.5 s vs 24 s) still
//       stays inside the budget - the gate cannot round it through
//
// Usage: node feed-budget.mjs <register.js>
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'

const [, , modPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

const REQUESTS_PER_HOUR = 300 // hooks/constants.ts
const HOUR = 3_600_000
// Tue 2026-09-22 11:00 New York (EDT) - the US session is open all hour
const US_OPEN = Date.UTC(2026, 8, 22, 15, 0)

const WATCHLIST = Array.from({ length: 15 }, (_, i) => ({ code: `W${i}`, name: `W${i}`, prevClose: 100 }))
const HELD = Array.from({ length: 6 }, (_, i) => ({ code: `H${i}`, qty: 10, cost: 50 }))
const configText = (holdings, extra = {}) =>
  JSON.stringify({
    ...extra,
    market: 'us',
    // `us`, not `auto`: auto budgets the dearest market, and the built-in
    // 20-symbol tw list would cost two requests on its own
    feed: 'us',
    feedMs: extra.feedMs ?? 15000,
    refreshMs: 3000,
    pageMs: 0,
    us: WATCHLIST,
    tw: [],
    ...(holdings ? { holdings: { us: holdings } } : {}),
  })

const SPARK_BODY = JSON.stringify({
  spark: {
    result: [{ symbol: 'W0', response: [{ meta: { regularMarketPrice: 101, previousClose: 100, regularMarketTime: US_OPEN / 1000 } }] }],
  },
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

let moduleTick = 0
async function boot(holdings, extra = {}) {
  moduleTick += 1
  const url = pathToFileURL(modPath)
  url.search = `?case=${moduleTick}`
  const { register } = await import(url.href)

  const files = { '.claude/stock-band.json': configText(holdings, extra) }
  const sparks = []
  const heartbeats = []
  const timers = []
  const logs = []
  let clock = US_OPEN
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => {
        if (path.includes('heartbeat')) heartbeats.push(clock)
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
        if (u.includes('/v7/finance/spark')) sparks.push(clock)
        return { ok: true, status: 200, headers: {}, text: SPARK_BODY }
      },
    },
  }
  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)

  const poll = timers.find(t => t.ms === 3000)
  const feedTimer = timers.find(t => t !== poll)
  const probe = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
    return findClient(tree)?.props?.props
  }
  /** advance the clock in feed-timer steps for `ms`, polling as the host would */
  const run = async ms => {
    const end = clock + ms
    while (clock + feedTimer.ms <= end) {
      clock += feedTimer.ms
      await poll.fn()
      await feedTimer.fn()
      await new Promise(r => setTimeout(r, 0))
    }
  }
  const setHoldings = h => {
    files['.claude/stock-band.json'] = configText(h, extra)
  }
  return { run, probe, sparks, heartbeats, logs, feedTimer, setHoldings, poll, get clock() { return clock } }
}

const inHour = (sparks, from) => sparks.filter(t => t > from && t <= from + HOUR).length

// --- (1) holdings known at boot ------------------------------------------------
{
  const s = await boot(HELD)
  const start = s.clock
  await s.run(HOUR)
  const n = inHour(s.sparks, start)
  ok(n <= REQUESTS_PER_HOUR, `(1) an hour with 21 symbols + 3 indices sends ${n} spark requests (budget ${REQUESTS_PER_HOUR})`)
  ok(s.logs.some(l => /2 requests per tick/.test(l)), `(1) the boot log names 2 requests per tick (${s.logs.find(l => /requests per tick/.test(l)) ?? 'no such log'})`)
}

// --- (2) holdings that arrive mid-session ----------------------------------------
{
  const s = await boot(undefined)
  ok(s.feedTimer.ms === 15000, `(2) sanity: with no holdings the feed timer is 15s (got ${s.feedTimer.ms / 1000}s)`)
  s.setHoldings(HELD)
  await s.poll.fn()
  const start = s.clock
  await s.run(HOUR)
  const n = inHour(s.sparks, start)
  ok(n <= REQUESTS_PER_HOUR, `(2) holdings added mid-session: the next hour sends ${n} spark requests (budget ${REQUESTS_PER_HOUR})`)
  ok(n >= REQUESTS_PER_HOUR * 0.6, `(2) ...without starving the feed either (${n} requests, 2 a tick)`)

  // --- (3) the countdown names a tick that sends --------------------------------
  const before = s.sparks.length
  const p = await s.probe()
  const due = p?.nextFeedAt
  ok(typeof due === 'number' && due > s.clock, `(3) nextFeedAt is in the future (${due - s.clock}ms ahead)`)
  while (s.clock < due) await s.run(s.feedTimer.ms)
  ok(s.sparks.length > before, '(3) the tick the countdown named did send')
}

// --- (4) the heartbeat is never held back by the budget --------------------------
{
  // 23:00 Taipei is inside the 夜盤, so a futures list keeps tf - and its
  // heartbeat - live all hour
  const s = await boot(undefined, { futures: [{ code: 'TXFR1', name: '台指近' }], twSources: ['shioaji'] })
  s.setHoldings(HELD)
  await s.poll.fn()
  const start = s.clock
  const ticksBefore = s.heartbeats.length
  await s.run(10 * 60_000)
  const ticks = Math.floor((10 * 60_000) / s.feedTimer.ms)
  const beats = s.heartbeats.length - ticksBefore
  ok(beats >= ticks - 1, `(4) ${beats} heartbeats over ${ticks} timer ticks while Yahoo is budget-gated`)
  const gaps = s.heartbeats.slice(ticksBefore).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1)
  const widest = Math.max(...gaps)
  ok(widest <= s.feedTimer.ms, `(4) the widest heartbeat gap is ${widest / 1000}s - never past the fetcher's 90 s patience`)
  ok(inHour(s.sparks, start) * 6 <= REQUESTS_PER_HOUR + 6, '(4) ...while the spark requests still keep to the budget')
}

// --- (5) a feedMs just under the widened interval --------------------------------
{
  const s = await boot(undefined, { feedMs: 23500 })
  ok(s.feedTimer.ms === 23500, `(5) sanity: the timer is 23.5 s (got ${s.feedTimer.ms / 1000}s)`)
  s.setHoldings(HELD) // two requests a tick now: a 24 s interval
  await s.poll.fn()
  const start = s.clock
  await s.run(HOUR)
  const n = inHour(s.sparks, start)
  ok(n <= REQUESTS_PER_HOUR, `(5) an hour at a 23.5 s timer against a 24 s interval sends ${n} (budget ${REQUESTS_PER_HOUR})`)
}

done()
