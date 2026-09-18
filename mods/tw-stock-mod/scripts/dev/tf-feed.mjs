// Feed independence from the screen, at the host seam the 永豐 fetcher hangs
// off: `$.fs.write` (the heartbeat) and `$.process.run` (the spawn argv). With
// 美股 on screen during 夜盤 the band still writes the heartbeat every feed
// tick, naming `tf` in it (path 7); the fetcher is spawned once with BOTH
// `--codes` and `--futures` whichever market asked first; a Yahoo back-off
// never stops the heartbeat; and a project without `futures` writes no
// heartbeat outside 台股 hours at all (the stock-only guard).
//
// Usage: node tf-feed.mjs $OUT/register.js <proj>
// <proj>/.claude/stock-band.json is rewritten here per scenario (the base
// fixture pins `market: "us"`, feed "auto", twSources ["shioaji"], a
// `futures` list). Each scenario boots a fresh module instance: the spawn
// window and the shioaji warning are module-level state. No network: the
// HTTP stub answers an empty body (nothing usable, no back-off) unless a
// scenario flips it to 429.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const THU = 17, FRI = 18 // 2026-09-17 is a Thursday
const REFRESH_MS = 3_000
const FEED_MS = 30_000
const HEARTBEAT = 'stock-band.heartbeat'
const FUTURES_CODES = 'TXFR1,SRFJ6'

const baseConfig = JSON.parse(await readFile(`${projDir}/.claude/stock-band.json`, 'utf8'))
const setConfig = async patch =>
  writeFile(`${projDir}/.claude/stock-band.json`, JSON.stringify({ ...baseConfig, ...patch }, null, 2))

/** boots one fresh register.js against projDir at `clock`; `tag` defeats the ESM module cache */
async function boot(tag, clock) {
  const timers = []
  const logs = []
  const fetched = []
  const writes = []
  const spawns = []
  let httpStatus = 200
  const home = `${projDir}/home`
  await mkdir(`${home}/.claude`, { recursive: true })
  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async p => (await readFile(p.startsWith('/') ? p : `${projDir}/${p}`)).toString(),
      write: async (p, text) => { writes.push({ path: p, text }) },
    },
    ui: {
      log: m => logs.push(String(m)),
      invalidate: () => {},
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: {
      fetch: async u => { fetched.push(String(u)); return { ok: httpStatus === 200, status: httpStatus, text: '{}' } },
    },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => projDir },
    plugin: { root: projDir },
    process: { run: async argv => { spawns.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
  }
  const handlers = new Map()
  const { register } = await import(`${regPath}?${tag}`)
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

  /** fires only the feed timer (the poll timer is the one on refreshMs) and lets it settle */
  const feedTick = async at => {
    if (at !== undefined) clock = at
    const feedTimers = timers.filter(t => t.ms !== REFRESH_MS)
    if (feedTimers.length !== 1) throw new Error(`expected one feed timer, got ${feedTimers.length}`)
    feedTimers[0].fn()
    await new Promise(r => setTimeout(r, 150))
  }
  const draw = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
    let props
    const walk = n => { if (!n || typeof n !== 'object') return
      if (n.type === 'Client') props = n.props.props
      for (const k of [...(n.kids ?? []), n.props?.children]) walk(k) }
    walk(tree)
    return props
  }
  const heartbeats = () => writes.filter(w => w.path.endsWith(HEARTBEAT))
  /** the parsed heartbeat: `{ ts, markets }` from the JSON form, or `{ ts }` from the legacy bare number */
  const lastHeartbeat = () => {
    const last = heartbeats().at(-1)
    if (!last) return undefined
    try { return JSON.parse(last.text) } catch { return { ts: Number(last.text), legacy: true } }
  }
  const argOf = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const setHttp = status => { httpStatus = status }
  return { feedTick, draw, heartbeats, lastHeartbeat, argOf, setHttp, logs, fetched, writes, spawns }
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

// --- path 7: 22:00 Thursday, 美股 on screen, futures listed -----------------
await setConfig({})
let band = await boot('night', taipei(THU, 22, 0))
let props = await band.draw()
console.log(`on screen: ${props.market} ${props.phase}; heartbeats=${band.heartbeats().length} spawns=${band.spawns.length}`)
ok(props.market === 'us', `美股 pinned on screen: ${props.market}`)
ok(band.heartbeats().length === 1, `first feed tick wrote the heartbeat once: ${band.heartbeats().length}`)
let hb = band.lastHeartbeat()
console.log('heartbeat:', band.heartbeats().at(-1)?.text)
ok(hb && !hb.legacy && hb.ts === taipei(THU, 22, 0), `heartbeat is JSON with ts = now: ${JSON.stringify(hb)}`)
ok(hb && sameSet(hb.markets ?? [], ['tf']), `heartbeat names tf only (tw is off screen, not wanted): ${JSON.stringify(hb?.markets)}`)

// the spawn: one process, both code lists, from the tf route alone
ok(band.spawns.length === 1, `one spawn on the first tick: ${band.spawns.length}`)
let argv = band.spawns[0] ?? []
console.log('spawn argv:', argv.slice(3).join(' '))
ok(argv.some(a => String(a).endsWith('fetch-quotes-shioaji.py')), 'spawned the shioaji fetcher script')
ok(band.argOf(argv, '--codes') === '2330', `--codes carries the tw list: ${band.argOf(argv, '--codes')}`)
ok(band.argOf(argv, '--futures') === FUTURES_CODES, `--futures carries the futures list: ${band.argOf(argv, '--futures')}`)
ok(band.argOf(argv, '--heartbeat')?.endsWith(HEARTBEAT), `--heartbeat points at the runtime-dir heartbeat: ${band.argOf(argv, '--heartbeat')}`)

// every feed tick writes it again; the spawn is not repeated inside 60 s
await band.feedTick(taipei(THU, 22, 0) + FEED_MS)
ok(band.heartbeats().length === 2, `second feed tick wrote the heartbeat again: ${band.heartbeats().length}`)
ok(sameSet(band.lastHeartbeat()?.markets ?? [], ['tf']), 'second heartbeat still names tf')
ok(band.spawns.length === 1, `no respawn inside the 60 s window: ${band.spawns.length}`)
await band.feedTick(taipei(THU, 22, 0) + 2 * FEED_MS + 1_000)
ok(band.heartbeats().length === 3, `third feed tick wrote the heartbeat: ${band.heartbeats().length}`)
ok(band.spawns.length === 2, `futures file still stale after 60 s: respawn attempted (${band.spawns.length})`)
ok(band.argOf(band.spawns[1] ?? [], '--futures') === FUTURES_CODES, 'the respawn carries --futures too')

// tf is shioaji-only: no Yahoo/MIS request for 台股, no "永豐路線沒有出價" for tw
console.log('fetched:', band.fetched.map(u => u.slice(0, 70)))
ok(!band.fetched.some(u => u.includes('2330') || u.includes('mis.twse')), 'no Yahoo/MIS 台股 request from a tf feed')
ok(!band.logs.some(l => l.includes('永豐路線沒有出價')), 'tf-only feed never raises the tw shioaji warning')
console.log('logs:', band.logs)

// a Yahoo back-off (美股 429) must not stop the heartbeat: the fetcher would exit
band.setHttp(429)
await band.feedTick(taipei(THU, 22, 0) + 3 * FEED_MS + 1_000)
ok(band.logs.some(l => l.includes('HTTP 429')), 'the 429 was logged as a back-off')
const before = band.heartbeats().length
await band.feedTick(taipei(THU, 22, 0) + 4 * FEED_MS + 1_000)
ok(band.heartbeats().length === before + 1, `heartbeat written during the Yahoo back-off: ${band.heartbeats().length - before}`)
ok(sameSet(band.lastHeartbeat()?.markets ?? [], ['tf']), 'back-off heartbeat still names tf')

// --- guard: futures empty -> no tf feed, no heartbeat outside 台股 hours ------
await setConfig({ futures: [] })
band = await boot('plain', taipei(THU, 22, 0))
props = await band.draw()
console.log(`futures []: on screen ${props.market}; heartbeats=${band.heartbeats().length} spawns=${band.spawns.length}`)
ok(band.heartbeats().length === 0, `no heartbeat at 22:00 without futures: ${band.heartbeats().length}`)
ok(band.spawns.length === 0, `no spawn at 22:00 without futures: ${band.spawns.length}`)
await band.feedTick(taipei(THU, 22, 0) + FEED_MS)
ok(band.heartbeats().length === 0 && band.spawns.length === 0, 'still nothing on the next tick')

// --- 台股 hours: the tw route spawns with --futures as well -------------------
await setConfig({ market: 'tw' })
band = await boot('day', taipei(FRI, 10, 0))
props = await band.draw()
console.log(`10:00 tw: on screen ${props.market} ${props.phase}; heartbeat=${band.heartbeats().at(-1)?.text}`)
ok(props.market === 'tw' && props.phase === 'open', '台股 open on screen at 10:00')
hb = band.lastHeartbeat()
ok(hb && sameSet(hb.markets ?? [], ['tw', 'tf']), `10:00 heartbeat names tw and tf (日盤 open too): ${JSON.stringify(hb?.markets)}`)
argv = band.spawns[0] ?? []
console.log('spawn argv:', argv.slice(3).join(' '))
ok(band.spawns.length === 1 && band.argOf(argv, '--codes') === '2330', `tw spawn carries --codes: ${band.argOf(argv, '--codes')}`)
ok(band.argOf(argv, '--futures') === FUTURES_CODES, `tw spawn carries --futures: ${band.argOf(argv, '--futures')}`)
// 13:40: 台股 closed (13:30) but 日盤 runs to 13:45 - tf stays wanted
await band.feedTick(taipei(FRI, 13, 40))
ok(sameSet(band.lastHeartbeat()?.markets ?? [], ['tw', 'tf']), `13:40 heartbeat keeps tf: ${JSON.stringify(band.lastHeartbeat()?.markets)}`)
// 14:00: both sessions closed - tf drops out (tw stays: its closing snapshot is the file route's, never liveBy's)
await band.feedTick(taipei(FRI, 14, 0))
ok(!(band.lastHeartbeat()?.markets ?? []).includes('tf'), `14:00 heartbeat no longer names tf: ${JSON.stringify(band.lastHeartbeat()?.markets)}`)
// 15:00: 夜盤 opens - tf is back with 台股 closed
await band.feedTick(taipei(FRI, 15, 0))
ok((band.lastHeartbeat()?.markets ?? []).includes('tf'), `15:00 heartbeat names tf again: ${JSON.stringify(band.lastHeartbeat()?.markets)}`)

// --- 台股 hours without futures: --futures is still passed, as an empty string
await setConfig({ market: 'tw', futures: [] })
band = await boot('day-plain', taipei(FRI, 10, 0))
argv = band.spawns[0] ?? []
console.log('spawn argv:', argv.slice(3).join(' '))
ok(band.spawns.length === 1, `stock-only tw spawn happened: ${band.spawns.length}`)
ok(argv.includes('--futures') && band.argOf(argv, '--futures') === '', `stock-only spawn passes --futures "" : ${JSON.stringify(band.argOf(argv, '--futures'))}`)
ok(sameSet(band.lastHeartbeat()?.markets ?? [], ['tw']), `stock-only heartbeat names tw only: ${JSON.stringify(band.lastHeartbeat()?.markets)}`)

// --- tf pinned with a non-shioaji tw route: heartbeat names tf, never tw -----
await setConfig({ market: 'tf', twSources: ['yahoo'] })
band = await boot('tf-yahoo', taipei(THU, 22, 0))
hb = band.lastHeartbeat()
ok(hb && sameSet(hb.markets ?? [], ['tf']), `tf pinned, tw via Yahoo: heartbeat names tf only: ${JSON.stringify(hb?.markets)}`)
ok(band.spawns.length === 1 && band.argOf(band.spawns[0], '--futures') === FUTURES_CODES, 'tf still spawns the fetcher (永豐 is its only route)')

await setConfig({})
done()
