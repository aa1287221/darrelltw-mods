// The broker fetcher's spawn at a desktop session's start, against the REAL
// register.tsx (bundled), at the host seam the fetcher hangs off
// ($.process.run, the spawn argv).
//
// The desktop app runs inside a Windows job, and quitting it takes the
// detached 永豐 fetcher down with it - so at the next session start the
// runtime quotes file can still be fresh from a fetcher that is already dead,
// and a band that spawns only once that file is stale left 報價 and 期貨庫存
// frozen for up to two minutes. On the desktop the band now spawns once per
// route even while the file is fresh (the fetcher's pidfile turns a spare into
// a quiet exit before login); the terminal keeps the old rule exactly.
//
//   (a) terminal, 夜盤 open, a fresh futures-quotes.json kept fresh: no spawn
//       at boot, on terminal draws (which ask for no feed tick) or over five
//       minutes of feed ticks
//   (b) desktop, the same file 28 s old (the incident's age): the first
//       desktop draw alone - no timer fired - spawns the shioaji fetcher
//       once, with --pidfile and --heartbeat; later draws ask for nothing;
//       five minutes of ticks with the file kept fresh spawn nothing more;
//       a spare that never writes is respawned on the stale rule as before
//   (c) a stale file: the desktop spawns exactly when the terminal does
//       (boot, then at most once a minute while it stays stale)
//   (d) the tree ui.render returns is untouched: the frame that sends the
//       spare equals the next one, a terminal frame is the same after it,
//       and - given a baseline bundle - every frame, and the spawn and
//       heartbeat timelines of (a) and (c), equal the baseline's
//   (e) 台股 hours, a fresh stock-quotes.json: one spare for the shioaji
//       route (台股 and 日盤 share it) and one for the capital route (its own
//       script, the plain --detach argv); none on the terminal
//   (f) only the freshness test is bypassed: nothing while 收起 (the spare
//       goes out on 展開), nothing while 台指期 is closed, nothing with feed off
//
// Usage: node desktop-respawn.mjs $OUT/register.js [<baseline register.js>]
// Either may be a path or a file:// URL. In-memory fs, fixed clock, no
// network, no fixture directory; nothing is spawned for real.
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'

const [, , regArg, baseArg] = process.argv

const TAIPEI = 8
const taipei = (day, hh, mm) => Date.UTC(2026, 8, day, hh - TAIPEI, mm)
const THU = 17, FRI = 18 // 2026-09-17 is a Thursday
const NIGHT = taipei(THU, 22, 0) // 夜盤 open, 台股 closed
const DAY = taipei(FRI, 10, 0) // 台股 and 日盤 open
const BREAK = taipei(FRI, 14, 30) // 日盤 closed at 13:45, 夜盤 opens at 15:00
const REFRESH_MS = 3_000
const FEED_MS = 30_000
const HOME = '/fake-home'
const RUNTIME = `${HOME}/.claude/stock-band/fake-project/` // runtimeDir() for cwd /fake-project
const FUTURES = `${RUNTIME}futures-quotes.json`
const STOCKS = `${RUNTIME}stock-quotes.json`
const WIN_ROOT = 'C:/fake-plugin-root' // a drive letter: the plain argv with --log + --detach
const POSIX_ROOT = '/fake-plugin-root' // the /bin/sh + nohup wrapper

const BASE_CONFIG = {
  market: 'tf',
  feed: 'auto',
  twSources: ['shioaji'],
  feedMs: FEED_MS,
  refreshMs: REFRESH_MS,
  pageMs: 0,
  tw: [{ code: '2330', name: '台積電', prevClose: 1000 }],
  us: [],
  futures: [{ code: 'TXFR1', name: '台指近' }],
}
const WRITERS = {
  [FUTURES]: asOf => JSON.stringify({ asOf, market: 'tf', quotes: { TXFR1: { price: 23010, prevClose: 22950, name: '台指近' } } }),
  [STOCKS]: asOf => JSON.stringify({ asOf, market: 'tw', quotes: { 2330: { price: 1010, prevClose: 1000, name: '台積電' } } }),
}
/** runtime files as a fetcher last wrote them, `age` ms before `clock` */
const written = (clock, age, paths) => Object.fromEntries(paths.map(p => [p, WRITERS[p](clock - age)]))

const settle = () => new Promise(r => setTimeout(r, 30))
const next = async () => ({ type: 'next', props: {}, kids: [] })
const urlOf = arg => (arg.startsWith('file:') ? new URL(arg) : pathToFileURL(arg))
const argOf = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
const scriptOf = argv => argv.find(a => String(a).endsWith('.py')) ?? ''
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

let instance = 0
/**
 * One fresh register.js instance (module state is per instance) booted at
 * `clock`, with `files` (runtime paths) in its in-memory fs beside the
 * project config. `tick` advances the clock and fires the poll, then the
 * feed timer; `live` rewrites every runtime quotes file first, as a fetcher
 * that is up would.
 */
async function boot({ bundle = regArg, clock, config = {}, files = {}, root = WIN_ROOT }) {
  const url = urlOf(bundle)
  url.search = `?case=${++instance}`
  const { register } = await import(url.href)
  const fs = { '.claude/stock-band.json': JSON.stringify({ ...BASE_CONFIG, ...config }), ...files }
  const spawns = []
  const heartbeats = []
  const timers = []
  let now = clock
  const $ = {
    clock: { now: async () => now, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async p => {
        if (p in fs) return fs[p]
        throw new Error(`ENOENT ${p}`)
      },
      write: async (p, text) => {
        if (p.endsWith('stock-band.heartbeat')) heartbeats.push(now)
        fs[p] = text
      },
    },
    env: { get: async name => (name === 'HOME' ? HOME : undefined) },
    session: { cwd: async () => '/fake-project' },
    plugin: { root },
    process: { run: async argv => { spawns.push({ at: now, argv }); return { exitCode: 0, stdout: '', stderr: '' } } },
    ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
    http: { fetch: async () => ({ ok: true, status: 200, headers: {}, text: '{}' }) },
  }
  const handlers = new Map()
  register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
  await handlers.get('session.start')($, {}, next)
  await settle()
  const poll = timers.find(t => t.ms === REFRESH_MS)
  const feed = timers.find(t => t !== poll)

  /** one ui.render on `surface`, then a settle for whatever it asked for */
  const draw = async surface => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface, viewport: { columns: 100 } }, next)
    const btns = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (n.type === 'Button') btns.push(n.props)
      for (const k of n.kids ?? []) walk(k)
    }
    walk(tree)
    await settle()
    /** presses the first button whose label starts with `label`, then settles like a draw */
    const press = async label => {
      btns.find(b => b.label.startsWith(label))?.onPress()
      await settle()
    }
    return { tree, press }
  }
  const tick = async (at, live = false) => {
    now = at
    if (live) for (const p of Object.keys(WRITERS)) if (p in fs) fs[p] = WRITERS[p](now - 2_000)
    poll.fn()
    await settle()
    feed?.fn()
    await settle()
  }
  return { draw, tick, spawns, heartbeats }
}

/** boots, draws once on `surface`, runs the feed ticks at `ticks` (ms after boot); spawn and heartbeat times, ms after boot */
async function timeline(bundle, { surface, clock, files, ticks, live = false, root }) {
  const band = await boot({ bundle, clock, files, root })
  await band.draw(surface)
  for (const t of ticks) await band.tick(clock + t, live)
  return { spawns: band.spawns.map(s => s.at - clock), heartbeats: band.heartbeats.map(t => t - clock) }
}
const FIVE_MIN = Array.from({ length: 10 }, (_, i) => (i + 1) * FEED_MS)
const STALE_TICKS = [30_000, 61_000, 90_000, 122_000]
const fresh = clock => written(clock, 28_000, [FUTURES])
const stale = clock => written(clock, 10 * 60_000, [FUTURES])
const freshRun = surface => ({ surface, clock: NIGHT, files: fresh(NIGHT), ticks: FIVE_MIN, live: true })
const staleRun = surface => ({ surface, clock: NIGHT, files: stale(NIGHT), ticks: STALE_TICKS })

// --- (a) terminal, fresh file: no spawn, and a terminal draw asks for nothing --
{
  const band = await boot({ clock: NIGHT, files: fresh(NIGHT) })
  ok(band.spawns.length === 0 && band.heartbeats.length === 1, `(a) boot tick: heartbeat written, no spawn while the file is fresh (spawns=${band.spawns.length})`)
  for (let i = 0; i < 3; i++) await band.draw('terminal')
  ok(band.heartbeats.length === 1, `(a) three terminal draws asked for no feed tick (heartbeats=${band.heartbeats.length})`)
  for (const t of FIVE_MIN) await band.tick(NIGHT + t, true)
  ok(band.spawns.length === 0, `(a) five minutes of feed ticks with the file fresh: no spawn (spawns=${band.spawns.length})`)
  ok(band.heartbeats.length === 1 + FIVE_MIN.length, `(a) ...and a heartbeat on every tick (${band.heartbeats.length})`)
}

// --- (b) desktop, the dead fetcher's fresh file: one spare, at the first draw --
{
  const band = await boot({ clock: NIGHT, files: fresh(NIGHT) })
  ok(band.spawns.length === 0, `(b) boot tick (before any draw) still spawns nothing (spawns=${band.spawns.length})`)
  const beats = band.heartbeats.length
  await band.draw('desktop')
  ok(band.spawns.length === 1, `(b) the first desktop draw alone spawned the fetcher once, no timer fired (spawns=${band.spawns.length})`)
  const argv = band.spawns[0]?.argv ?? []
  console.log('spawn argv:', argv.slice(1).join(' '))
  ok(scriptOf(argv).endsWith('/scripts/fetch-quotes-shioaji.py'), `(b) it is the shioaji fetcher (${scriptOf(argv)})`)
  ok(argOf(argv, '--pidfile') === `${RUNTIME}stock-shioaji.pid`, `(b) --pidfile, so a spare beside a live fetcher exits before login (${argOf(argv, '--pidfile')})`)
  ok(argOf(argv, '--heartbeat') === `${RUNTIME}stock-band.heartbeat`, `(b) --heartbeat (${argOf(argv, '--heartbeat')})`)
  ok(argOf(argv, '--futures') === 'TXFR1' && argv.includes('--detach'), `(b) --futures TXFR1, and the Windows --detach argv (${argOf(argv, '--futures')})`)
  ok(band.heartbeats.length === beats + 1, `(b) the draw asked for exactly one feed tick (heartbeats ${beats} -> ${band.heartbeats.length})`)
  for (let i = 0; i < 4; i++) await band.draw('desktop')
  ok(band.spawns.length === 1 && band.heartbeats.length === beats + 1, `(b) four more desktop draws ask for nothing (spawns=${band.spawns.length}, heartbeats=${band.heartbeats.length})`)
  for (const t of FIVE_MIN) await band.tick(NIGHT + t, true)
  ok(band.spawns.length === 1, `(b) five minutes of ticks with the file kept fresh: no second spawn (spawns=${band.spawns.length})`)
}
{
  // the spare never writes (a failed login): the file goes stale at +92 s and the old rule takes over
  const band = await boot({ clock: NIGHT, files: fresh(NIGHT) })
  await band.draw('desktop')
  for (const t of [30_000, 59_000, 90_000, 120_000, 150_000]) await band.tick(NIGHT + t)
  const at = band.spawns.map(s => (s.at - NIGHT) / 1000)
  ok(same(at, [0, 120]), `(b) a spare that never writes: respawned on the first stale tick, not inside 60 s (spawns at ${at.join(', ')} s)`)
}

// --- (c) a stale file: the desktop spawns when the terminal does ---------------
{
  const term = await timeline(regArg, staleRun('terminal'))
  const desk = await timeline(regArg, staleRun('desktop'))
  console.log(`stale: terminal spawns at ${term.spawns.join(', ')} ms, desktop at ${desk.spawns.join(', ')} ms`)
  ok(same(term.spawns, [0, 61_000, 122_000]), `(c) terminal: boot spawn, then once a minute while stale (${term.spawns.join(', ')})`)
  ok(same(desk.spawns, term.spawns), `(c) desktop: the same spawns, tick for tick (${desk.spawns.join(', ')})`)
}

// --- (d) the tree ui.render returns ----------------------------------------------
/** the frames of one boot: terminal, desktop (sends the spare), desktop again, terminal again */
async function frames(bundle) {
  const band = await boot({ bundle, clock: NIGHT, files: fresh(NIGHT) })
  const out = []
  for (const surface of ['terminal', 'desktop', 'desktop', 'terminal']) out.push(JSON.stringify((await band.draw(surface)).tree))
  return { out, spawns: band.spawns.length }
}
{
  const { out: [t1, d1, d2, t2], spawns } = await frames(regArg)
  ok(spawns === 1, `(d) sanity: the desktop frame sent its spare (spawns=${spawns})`)
  ok(d1 === d2, `(d) the frame that sends the spare is the frame after it (${d1.length} chars)`)
  ok(t1 === t2, `(d) a terminal frame is the same before and after a desktop one (${t1.length} chars)`)
  if (baseArg) {
    const base = await frames(baseArg)
    const names = ['terminal', 'desktop (first)', 'desktop (second)', 'terminal (after)']
    ;[t1, d1, d2, t2].forEach((f, i) => ok(f === base.out[i], `(d) baseline: the ${names[i]} frame is identical`))
    for (const [name, run] of [['(a) fresh', freshRun('terminal')], ['(c) stale', staleRun('terminal')]]) {
      const mine = await timeline(regArg, run)
      const theirs = await timeline(baseArg, run)
      ok(same(mine, theirs), `(d) baseline: ${name} terminal timeline identical - spawns [${mine.spawns}] heartbeats ${mine.heartbeats.length}`)
    }
    // the desktop's one intended difference: its first draw asks for a feed tick (one more heartbeat)
    const mine = await timeline(regArg, staleRun('desktop'))
    const theirs = await timeline(baseArg, staleRun('desktop'))
    ok(same(mine.spawns, theirs.spawns), `(d) baseline: (c) stale desktop spawns identical - [${mine.spawns}]`)
    ok(mine.heartbeats.length === theirs.heartbeats.length + 1, `(d) baseline: ...plus the one feed tick its first draw asks for (heartbeats ${theirs.heartbeats.length} -> ${mine.heartbeats.length})`)
  } else {
    console.log('(d) no baseline bundle given: old-vs-new comparison skipped')
  }
}

// --- (e) 台股 hours: the stock file, for both broker routes ------------------------
{
  const files = written(DAY, 28_000, [STOCKS, FUTURES])
  const cfg = { market: 'tw' }
  const term = await boot({ clock: DAY, files, config: cfg, root: POSIX_ROOT })
  await term.draw('terminal')
  for (const t of FIVE_MIN.slice(0, 6)) await term.tick(DAY + t, true)
  ok(term.spawns.length === 0, `(e) shioaji, terminal: no spawn while both files are fresh (spawns=${term.spawns.length})`)
  const desk = await boot({ clock: DAY, files, config: cfg, root: POSIX_ROOT })
  await desk.draw('desktop')
  const argv = desk.spawns[0]?.argv ?? []
  console.log('spawn argv:', argv.slice(0, 2).join(' '), '...', argv.slice(7).join(' '))
  ok(desk.spawns.length === 1, `(e) shioaji, desktop: one spare for 台股 and 日盤 together (spawns=${desk.spawns.length})`)
  ok(argv[0] === '/bin/sh' && scriptOf(argv).endsWith('fetch-quotes-shioaji.py'), `(e) ...the shioaji fetcher in its /bin/sh wrapper (${argv[0]})`)
  ok(argOf(argv, '--codes') === '2330' && argOf(argv, '--futures') === 'TXFR1', `(e) ...with --codes and --futures (${argOf(argv, '--codes')} / ${argOf(argv, '--futures')})`)
  for (const t of FIVE_MIN.slice(0, 6)) await desk.tick(DAY + t, true)
  ok(desk.spawns.length === 1, `(e) ...and no second one while they stay fresh (spawns=${desk.spawns.length})`)
}
{
  const files = written(DAY, 28_000, [STOCKS])
  const cfg = { market: 'tw', twSources: ['capital'], futures: [] }
  const term = await boot({ clock: DAY, files, config: cfg })
  await term.draw('terminal')
  for (const t of FIVE_MIN.slice(0, 6)) await term.tick(DAY + t, true)
  ok(term.spawns.length === 0, `(e) capital, terminal: no spawn while the file is fresh (spawns=${term.spawns.length})`)
  const desk = await boot({ clock: DAY, files, config: cfg })
  await desk.draw('desktop')
  const argv = desk.spawns[0]?.argv ?? []
  console.log('spawn argv:', argv.slice(1).join(' '))
  ok(desk.spawns.length === 1 && scriptOf(argv).endsWith('/scripts/fetch-quotes-capital.py'), `(e) capital, desktop: one spare of its own script (${scriptOf(argv)})`)
  ok(argOf(argv, '--pidfile') === `${RUNTIME}stock-capital.pid` && argv.includes('--detach'), `(e) ...its own pidfile, plain --detach argv (${argOf(argv, '--pidfile')})`)
  for (const t of FIVE_MIN.slice(0, 6)) await desk.tick(DAY + t, true)
  ok(desk.spawns.length === 1, `(e) ...and no second one while it stays fresh (spawns=${desk.spawns.length})`)
}

// --- (f) only the freshness test is bypassed ----------------------------------------
{
  const band = await boot({ clock: NIGHT, files: fresh(NIGHT) })
  await (await band.draw('terminal')).press('收起')
  await band.draw('desktop')
  await band.tick(NIGHT + FEED_MS, true)
  ok(band.spawns.length === 0, `(f) 收起: the first desktop draw and a tick while snoozed spawn nothing (spawns=${band.spawns.length})`)
  await (await band.draw('desktop')).press('股票列')
  ok(band.spawns.length === 1, `(f) ...展開 sends the spare at once (spawns=${band.spawns.length})`)
}
{
  const band = await boot({ clock: BREAK, files: fresh(BREAK) })
  await band.draw('desktop')
  for (const t of FIVE_MIN.slice(0, 4)) await band.tick(BREAK + t, true)
  ok(band.spawns.length === 0 && band.heartbeats.length === 0, `(f) 台指期 closed (14:30): no spawn, no heartbeat (spawns=${band.spawns.length}, heartbeats=${band.heartbeats.length})`)
}
{
  const band = await boot({ clock: NIGHT, files: fresh(NIGHT), config: { feed: 'off' } })
  await band.draw('desktop')
  ok(band.spawns.length === 0 && band.heartbeats.length === 0, `(f) feed off: the desktop draw spawns nothing (spawns=${band.spawns.length})`)
}

done()
