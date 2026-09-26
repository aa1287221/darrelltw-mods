// What the band does around and after a close, against the REAL register.tsx
// (bundled) with a stubbed network and a clock this script moves:
//
//   (1) a delayed Yahoo answer (13:10 prices read at 13:30:20) is not frozen
//       as the close: the feed keeps asking until an answer has traded at
//       13:30, then stops for the night
//   (2) an answer that never reaches the close (a halted symbol, a holiday)
//       stops the feed 30 minutes after the close anyway
//   (3) a 永豐 file carrying the closing price keeps 台股 priced all weekend,
//       and the heartbeat stops naming `tw`, so the fetcher is not kept
//       polling the broker all night
//   (4) a futures file last written at 13:44:55 still prices 台指期 at 14:30
//       (it used to drop to 無報價 two minutes after the close)
//   (5) a close of 0 in a file is "not known": the row and the 台指期 index
//       card read flat, not the whole price as the day's change
//   (6) collapsing the band (收起) stops the HTTP feed but not the broker
//       heartbeat, and 展開 asks for prices right away
//   (7) with the chart up on a closed market, K bars are re-read until 30
//       minutes after the close and then not again all night - and they stay
//       drawn instead of expiring after 15 minutes
//   (8) the chart's K-bar request is paid for out of the budget: opening it
//       on a list that just fits stretches the tick
//   (9) US daylight saving switches at 02:00 New York time, not at 00:00 UTC;
//       and lastCloseAt is the close's own minute (at 13:30:20 it used to
//       answer 13:30:20, which a price traded at 13:30:00 never reaches)
//  (10) a held broker file does not hide a close Yahoo fetched after it; 台指期
//       lets its fetcher go at the close; a legacy override naming no market
//       is not the US close
//  (11) the grace cap and the fetchers' 2-minute health rule, a Yahoo close of
//       0, and a Friday file expiring at Monday's open
//
// Usage: node close-snapshot.mjs $OUT/register.js $OUT/markets.js   (no network)
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'

const [, , regPath, marketsPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

const MIN = 60_000
const HOUR = 60 * MIN
/** Taipei wall clock in September 2026 */
const taipei = (day, hh, mm, ss = 0) => Date.UTC(2026, 8, day, hh - 8, mm, ss)
const HOME = '/fake-home'
const PROJECT = '/fake-project'
const RUNTIME = `${HOME}/.claude/stock-band/fake-project/`

const walk = (n, f) => {
  if (!n || typeof n !== 'object') return
  f(n)
  for (const k of [...(n.kids ?? []), ...(n.props?.children != null ? [n.props.children].flat() : [])]) walk(k, f)
}

/** a spark answer pricing 2330 and AAPL (and the index) as traded at `tradedAt` */
const sparkBody = (tradedAt, price = 1000, previousClose = 990) =>
  JSON.stringify({
    spark: {
      result: ['2330.TW', '^TWII', 'AAPL'].map(symbol => ({
        symbol,
        response: [{ meta: { regularMarketPrice: price, previousClose, regularMarketTime: tradedAt / 1000 } }],
      })),
    },
  })
const CHART_BODY = JSON.stringify({
  chart: {
    result: [{
      timestamp: [0, 1, 2].map(i => (taipei(22, 13, 15) + i * 5 * MIN) / 1000),
      indicators: { quote: [{ open: [1, 2, 3], high: [2, 3, 4], low: [0.5, 1.5, 2.5], close: [1.5, 2.5, 3.5], volume: [10, 20, 30] }] },
    }],
  },
})

let instance = 0
async function boot({ config, files: extraFiles = {}, clock: start, tradedAt = start }) {
  instance += 1
  const url = pathToFileURL(regPath)
  url.search = `?case=${instance}`
  const { register } = await import(url.href)
  const files = { '.claude/stock-band.json': JSON.stringify(config), ...extraFiles }
  const sparks = []
  const charts = []
  const heartbeats = []
  const spawns = []
  const logs = []
  const timers = []
  let clock = start
  const net = { tradedAt, price: 1000, previousClose: 990 }
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => {
        if (path.includes('heartbeat')) heartbeats.push({ at: clock, markets: JSON.parse(text).markets })
        files[path] = text
      },
    },
    env: { get: async name => (name === 'HOME' ? HOME : undefined) },
    session: { cwd: async () => PROJECT },
    process: { run: async argv => { spawns.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
    plugin: { root: '/fake-plugin-root' },
    ui: { log: m => logs.push(String(m)), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
    http: {
      fetch: async u => {
        if (u.includes('/v7/finance/spark')) {
          sparks.push(clock)
          return { ok: true, status: 200, headers: {}, text: sparkBody(net.tradedAt, net.price, net.previousClose) }
        }
        if (u.includes('/v8/finance/chart')) {
          charts.push(clock)
          return { ok: true, status: 200, headers: {}, text: CHART_BODY }
        }
        return { ok: false, status: 404, headers: {}, text: '' }
      },
    },
  }
  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)
  const poll = timers.find(t => t.ms === config.refreshMs)
  const feedTimer = timers.find(t => t !== poll)
  const settle = () => new Promise(r => setTimeout(r, 0))
  const draw = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100, rows: 30 } }, next)
    let props
    const buttons = []
    walk(tree, n => {
      if (n.type === 'Client') props = n.props.props
      if (n.type === 'Button') buttons.push(n.props)
    })
    return { props, buttons }
  }
  const press = async prefix => {
    const { buttons } = await draw()
    const b = buttons.find(x => String(x.label).startsWith(prefix))
    if (!b) throw new Error(`no button "${prefix}" among ${buttons.map(x => x.label).join(' | ')}`)
    b.onPress()
    await settle()
  }
  /** walk the clock forward in feed-timer steps, polling and redrawing as the host would */
  const run = async ms => {
    const end = clock + ms
    while (clock + feedTimer.ms <= end) {
      clock += feedTimer.ms
      await poll.fn()
      await feedTimer.fn()
      await draw()
      await settle()
    }
  }
  return {
    run, draw, press, sparks, charts, heartbeats, spawns, logs, files, net,
    get clock() { return clock },
    setClock(t) { clock = t },
  }
}

const TW_YAHOO = {
  market: 'tw', feed: 'tw', twSources: ['yahoo'], feedMs: 30000, refreshMs: 3000, pageMs: 0,
  tw: [{ code: '2330', name: '台積電' }], us: [],
}

// --- (1) a delayed answer is not the close -----------------------------------
{
  // Yahoo ~20 minutes behind
  const s = await boot({ config: TW_YAHOO, clock: taipei(22, 13, 30, 20), tradedAt: taipei(22, 13, 10) })
  await s.run(6 * MIN)
  ok(s.sparks.length >= 5, `(1) answers still at 13:10 after the close keep the feed asking: ${s.sparks.length} requests by 13:36`)
  s.net.tradedAt = taipei(22, 13, 30)
  await s.run(2 * MIN)
  const atClose = s.sparks.length
  await s.run(3 * HOUR)
  ok(s.sparks.length === atClose, `(1) once an answer traded at 13:30 the feed stops for the night (${s.sparks.length - atClose} more in 3 h)`)
  const { props } = await s.draw()
  ok(props.source === 'live' && props.quotes[0]?.price === 1000, `(1) the board still shows the closing snapshot at 16:40 (source=${props.source})`)
}

// --- (2) an answer that never reaches the close stops after the grace ---------
{
  const s = await boot({ config: TW_YAHOO, clock: taipei(22, 13, 30, 20), tradedAt: taipei(22, 13, 10) })
  await s.run(31 * MIN)
  const after = s.sparks.length
  await s.run(3 * HOUR)
  ok(after >= 50 && s.sparks.length === after, `(2) a 13:10 answer forever: asked until 14:00 (${after} requests), then none in 3 h (${s.sparks.length - after})`)
}

// --- (3) a broker file with the close holds all weekend, heartbeat off --------
{
  const file = {
    asOf: taipei(25, 13, 30, 8), dataAt: taipei(25, 13, 30), market: 'tw', source: '永豐 即時',
    quotes: { 2330: { price: 1005, prevClose: 1000, name: '台積電' } },
  }
  const s = await boot({
    config: { ...TW_YAHOO, twSources: ['shioaji', 'yahoo'] },
    files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) },
    clock: taipei(26, 10, 0), // Saturday
  })
  await s.run(2 * HOUR)
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === '2330')
  ok(props.source !== 'demo' && row && !row.noData && row.price === 1005, `(3) Saturday 12:00: 台股 still on Friday's 永豐 close (source=${props.source} price=${row?.price} noData=${row?.noData})`)
  const twBeats = s.heartbeats.filter(b => b.markets.includes('tw'))
  ok(twBeats.length === 0, `(3) the heartbeat never names tw over the weekend (${twBeats.length} of ${s.heartbeats.length})`)
  ok(s.spawns.length === 0 && s.sparks.length === 0, `(3) no fetcher spawn and no Yahoo request (${s.spawns.length} spawns, ${s.sparks.length} sparks)`)
}
// ...and a broker file written before the close keeps the fetcher going for it
{
  const file = {
    asOf: taipei(22, 13, 29, 55), dataAt: taipei(22, 13, 29, 50), market: 'tw',
    quotes: { 2330: { price: 1005, prevClose: 1000 } },
  }
  const s = await boot({
    config: { ...TW_YAHOO, twSources: ['shioaji', 'yahoo'] },
    files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) },
    clock: taipei(22, 13, 30, 10),
  })
  await s.run(MIN)
  ok(s.heartbeats.some(b => b.markets.includes('tw')), '(3) at 13:31 with a 13:29:55 file the heartbeat still names tw - the close is not in yet')
  s.files[`${RUNTIME}stock-quotes.json`] = JSON.stringify({ ...file, asOf: taipei(22, 13, 31, 30), dataAt: taipei(22, 13, 30) })
  await s.run(MIN)
  const n = s.heartbeats.length
  await s.run(HOUR)
  ok(s.heartbeats.slice(n).every(b => !b.markets.includes('tw')), '(3) once the file carries 13:30 the heartbeat drops tw')
}

// --- (4) a futures file from just before the close ---------------------------
const TF = { market: 'tf', feed: 'tw', twSources: ['yahoo'], feedMs: 30000, refreshMs: 3000, pageMs: 0, futures: [{ code: 'TXFR1', name: '台指近' }], tw: [], us: [] }
const futuresFile = (asOf, prevClose) => JSON.stringify({
  asOf, dataAt: asOf - 5000, market: 'tf', quotes: { TXFR1: { price: 23000, prevClose, name: '台指近' } },
})
{
  const s = await boot({ config: TF, files: { [`${RUNTIME}futures-quotes.json`]: futuresFile(taipei(22, 13, 44, 55), 22900) }, clock: taipei(22, 14, 30) })
  await s.run(MIN)
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === 'TXFR1')
  ok(row && !row.noData && row.price === 23000, `(4) 14:30: 台指期 still priced off the 13:44:55 file (price=${row?.price} noData=${row?.noData})`)
}

// --- (5) a close of 0 is not a close -------------------------------------------
{
  const s = await boot({ config: TF, files: { [`${RUNTIME}futures-quotes.json`]: futuresFile(taipei(22, 10, 29, 50), 0) }, clock: taipei(22, 10, 30) })
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === 'TXFR1')
  ok(row && !row.noData && row.change === 0, `(5) a futures close of 0 reads flat, not +23000 (change=${row?.change})`)
  ok(props.index.change === 0, `(5) the 台指期 index card reads flat too (change=${props.index.change})`)
}
{
  const file = { asOf: taipei(22, 10, 29, 50), market: 'tw', quotes: { 2330: { price: 1005, prevClose: 0 } } }
  const s = await boot({ config: { ...TW_YAHOO, feed: 'off' }, files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) }, clock: taipei(22, 10, 30) })
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === '2330')
  ok(row && row.price === 1005 && row.change === 0, `(5) a stock close of 0 reads flat too (price=${row?.price} change=${row?.change})`)
}

// --- (6) snooze keeps the heartbeat, wake asks right away ---------------------
{
  const s = await boot({
    config: { ...TW_YAHOO, futures: [{ code: 'TXFR1', name: '台指近' }] },
    clock: taipei(22, 10, 30),
  })
  await s.run(MIN)
  await s.press('收起')
  const sparks = s.sparks.length
  const beats = s.heartbeats.length
  await s.run(10 * MIN)
  ok(s.sparks.length === sparks, `(6) no Yahoo request while collapsed (${s.sparks.length - sparks})`)
  ok(s.heartbeats.length - beats >= 19, `(6) the broker heartbeat keeps going while collapsed (${s.heartbeats.length - beats} in 10 min)`)
  await s.press('股票列')
  ok(s.sparks.length === sparks + 1, `(6) 展開 asks for prices at once (${s.sparks.length - sparks} request)`)
}

// --- (7) K bars on a closed market --------------------------------------------
{
  const s = await boot({ config: TW_YAHOO, clock: taipei(22, 13, 50), tradedAt: taipei(22, 13, 30) })
  await s.run(MIN)
  await s.press('趨勢圖')
  await s.run(20 * MIN) // to 14:11
  const byGrace = s.charts.length
  ok(byGrace >= 5, `(7) bars re-read every 2 min until 14:00 (${byGrace} requests by 14:11)`)
  await s.run(6 * HOUR)
  ok(s.charts.length === byGrace, `(7) then none all evening (${s.charts.length - byGrace} in 6 h)`)
  const { props } = await s.draw()
  const bars = props.quotes[props.focus]?.bars?.length ?? 0
  ok(props.view === 'chart' && bars === 3, `(7) and the bars are still drawn at 20:11 (${bars} bars)`)
}

// --- (8) the chart's requests come out of the budget --------------------------
{
  // 20 codes + the index = 2 Yahoo requests a tick: 24 s is exactly 300/hour
  // on its own, so the chart's 30/hour has to stretch the tick
  const list = Array.from({ length: 20 }, (_, i) => ({ code: String(1101 + i), name: `S${i}` }))
  const s = await boot({ config: { ...TW_YAHOO, tw: list, feedMs: 24000 }, clock: taipei(22, 10, 0) })
  await s.run(2 * MIN)
  ok(!s.logs.some(l => /asked every 48s/.test(l)), '(8) the table alone fits the budget at 24 s')
  await s.press('趨勢圖')
  await s.run(2 * MIN)
  ok(s.logs.some(l => /asked every 48s/.test(l)), `(8) with the chart up the tick stretches: ${s.logs.filter(l => /asked every/.test(l)).join(' / ')}`)
}

// --- (9) US daylight saving at 02:00 local -------------------------------------
{
  const { MARKETS, lastCloseAt } = await import(pathToFileURL(marketsPath).href)
  const off = MARKETS.us.offset
  // 2026: DST from Sun 03-08 07:00 UTC to Sun 11-01 06:00 UTC
  ok(off(Date.UTC(2026, 2, 8, 6, 59)) === -5 && off(Date.UTC(2026, 2, 8, 7, 0)) === -4, '(9) March: EDT starts at 02:00 EST, not at 00:00 UTC')
  ok(off(Date.UTC(2026, 2, 8, 1, 0)) === -5, '(9) Saturday 20:00 in New York (Sun 01:00 UTC) is still EST')
  ok(off(Date.UTC(2026, 10, 1, 5, 59)) === -4 && off(Date.UTC(2026, 10, 1, 6, 0)) === -5, '(9) November: EST returns at 02:00 EDT')
  ok(off(Date.UTC(2026, 10, 1, 2, 0)) === -4, '(9) Saturday 22:00 in New York (Sun 02:00 UTC) is still EDT')
  ok(off(Date.UTC(2026, 6, 1)) === -4 && off(Date.UTC(2026, 0, 15)) === -5, '(9) mid-summer EDT, mid-winter EST')
  // what (1) and (3) stand on: the close is a minute boundary, not `now` less whole minutes
  ok(lastCloseAt(taipei(22, 13, 30, 20), 'tw') === taipei(22, 13, 30), '(1) at 13:30:20 the last close is 13:30:00')
  ok(lastCloseAt(taipei(26, 10, 0, 45), 'tw') === taipei(25, 13, 30), '(3) on Saturday the last close is Friday 13:30:00')
}

// --- (10) the verifier's follow-ups on 3bada85 ---------------------------------
// a 永豐 file that died at 13:28:30 (a 13:25 price) does not paint over the
// 13:30 close Yahoo fetched after it
{
  const file = { asOf: taipei(22, 13, 28, 30), dataAt: taipei(22, 13, 25), market: 'tw', source: '永豐 即時', quotes: { 2330: { price: 1001, prevClose: 990 } } }
  const s = await boot({
    config: { ...TW_YAHOO, twSources: ['shioaji', 'yahoo'] },
    files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) },
    clock: taipei(22, 13, 30, 20), tradedAt: taipei(22, 13, 30),
  })
  await s.run(5 * MIN)
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === '2330')
  ok(s.sparks.length > 0 && row?.price === 1000 && props.source === 'live', `(10) the fetched 13:30 close wins over a held 13:25 file (price=${row?.price} source=${props.source})`)
}
// 台指期 lets its fetcher go at the close: no heartbeat, no respawn of a dead one
{
  const s = await boot({ config: TF, files: { [`${RUNTIME}futures-quotes.json`]: futuresFile(taipei(22, 13, 44, 55), 22900) }, clock: taipei(22, 13, 45, 30) })
  await s.run(30 * MIN)
  const tfBeats = s.heartbeats.filter(b => b.markets.includes('tf'))
  ok(tfBeats.length === 0 && s.spawns.length === 0, `(10) after 13:45 the heartbeat never names tf and nothing respawns (${tfBeats.length} beats, ${s.spawns.length} spawns)`)
}
// a legacy override naming no market is not the US close
{
  const legacy = { asOf: taipei(22, 10, 0), quotes: { 2330: { price: 1005, prevClose: 1000 } } }
  const s = await boot({
    config: { market: 'us', feed: 'us', feedMs: 30000, refreshMs: 3000, pageMs: 0, us: [{ code: 'AAPL', name: 'Apple' }], tw: [] },
    files: { '.claude/stock-quotes.json': JSON.stringify(legacy) },
    clock: taipei(22, 10, 0, 30), // 22:00 ET the evening before: US closed
    tradedAt: Date.UTC(2026, 8, 21, 20, 0), // Mon 16:00 ET
  })
  await s.run(5 * MIN)
  const { props } = await s.draw()
  ok(props.source === 'live' && s.sparks[0] <= taipei(22, 10, 1, 30), `(10) the US board takes Yahoo's close, not a Taiwan override with no market - asked on the first tick (source=${props.source}, ${s.sparks.length} requests)`)
}

// --- (11) test gaps the verifier's mutation run found --------------------------
// a broker file that never reaches the close: the fetcher is kept (and a dead
// one respawned on the 2-minute rule) until 14:00, and let go after
{
  const file = { asOf: taipei(22, 13, 29, 55), dataAt: taipei(22, 13, 29, 50), market: 'tw', quotes: { 2330: { price: 1005, prevClose: 1000 } } }
  const s = await boot({
    config: { ...TW_YAHOO, twSources: ['shioaji'] },
    files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) },
    clock: taipei(22, 13, 30, 10),
  })
  await s.run(20 * MIN)
  ok(s.spawns.length >= 2, `(11) a dead fetcher whose file went stale after the close is respawned (${s.spawns.length} spawns by 13:50)`)
  await s.run(15 * MIN) // to 14:05
  const late = s.heartbeats.filter(b => b.at > taipei(22, 14, 0) && b.markets.includes('tw'))
  const before = s.heartbeats.filter(b => b.at < taipei(22, 14, 0) && b.markets.includes('tw'))
  ok(before.length > 0 && late.length === 0, `(11) the heartbeat names tw until 14:00 and not after (${before.length} before, ${late.length} after)`)
}
// an old futures file during the session counts as a dead fetcher
{
  const s = await boot({ config: TF, files: { [`${RUNTIME}futures-quotes.json`]: futuresFile(taipei(22, 10, 20), 22900) }, clock: taipei(22, 10, 30) })
  await s.run(MIN)
  ok(s.spawns.length >= 1, `(11) a 10-minute-old futures file at 10:30 gets the fetcher respawned (${s.spawns.length} spawns)`)
}
// a Yahoo close of 0 is not a close either
{
  const s = await boot({ config: TW_YAHOO, clock: taipei(22, 10, 30) })
  s.net.previousClose = 0
  await s.run(MIN)
  const { props } = await s.draw()
  const row = props.quotes.find(q => q.code === '2330')
  ok(row?.price === 1000 && row.change === 0, `(11) a Yahoo previousClose of 0 reads flat (change=${row?.change})`)
}
// Friday's closing file is gone by Monday 09:05
{
  const file = { asOf: taipei(25, 13, 30, 8), dataAt: taipei(25, 13, 30), market: 'tw', quotes: { 2330: { price: 1005, prevClose: 1000 } } }
  const s = await boot({ config: { ...TW_YAHOO, feed: 'off' }, files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) }, clock: taipei(28, 9, 5) })
  const { props } = await s.draw()
  ok(props.source === 'demo', `(11) Monday 09:05: Friday's file no longer drives the board (source=${props.source})`)
}
// ...and on a closed market, a file from before the last close never held at all
{
  const file = { asOf: taipei(21, 13, 0), market: 'tw', quotes: { 2330: { price: 1005, prevClose: 1000 } } }
  const s = await boot({ config: { ...TW_YAHOO, feed: 'off' }, files: { [`${RUNTIME}stock-quotes.json`]: JSON.stringify(file) }, clock: taipei(22, 8, 0) })
  const { props } = await s.draw()
  ok(props.source === 'demo', `(11) Tuesday 08:00: a Monday 13:00 file is not Monday's close (source=${props.source})`)
}

done()
