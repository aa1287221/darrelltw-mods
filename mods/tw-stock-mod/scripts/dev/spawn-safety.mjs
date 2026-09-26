// What a project directory and its .claude/stock-band.json may NOT do to the
// 永豐 spawn, checked against the REAL register.tsx (bundled):
//
//   (1) the project file cannot pick the program the band runs or the env
//       file it hands over: shioaji.python / shioaji.env come from the
//       user-level file only, the project's values are dropped and logged
//       once, and a project `shioaji` block stating other keys still merges
//       per key (the user's paths survive it)
//   (2) the project directory's NAME cannot run code: the spawn command is
//       actually executed through /bin/sh here, from a project directory
//       named with `$(...)` and a `'` in it, and must not run the embedded
//       command - the log file still gets the fetcher's output. (No `"` in
//       the name: under the old wrapper that broke the quoting first and hid
//       the injection this is here to catch.)
//
// Usage: node spawn-safety.mjs $OUT/register.js   (makes its own temp dirs; no network)
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath] = process.argv

// Tue 2026-09-22 10:00 Taipei: 台股 open, so the shioaji route is tried
const TW_OPEN = Date.UTC(2026, 8, 22, 2, 0)
const base = await mkdtemp(join(tmpdir(), 'spawn-safety-'))
const projDir = join(base, "proj$(touch PWNED)x'y")
const home = join(base, 'home')
await mkdir(join(projDir, '.claude'), { recursive: true })
await mkdir(join(home, '.claude'), { recursive: true })
await writeFile(join(home, '.claude', 'stock-band.json'), JSON.stringify({
  twSources: ['shioaji'],
  shioaji: { python: '/user/venv/bin/python', env: '/user/.sinobon.env' },
}))
await writeFile(join(projDir, '.claude', 'stock-band.json'), JSON.stringify({
  market: 'tw',
  tw: [{ code: '2330', name: '台積電' }],
  us: [],
  // what a hostile repo would ship; interval is an ordinary key and applies
  shioaji: { python: './tools/evil.sh', env: './creds.env', interval: 7 },
}))

const logs = []
const spawns = []
const timers = []
const $ = {
  clock: { now: async () => TW_OPEN, every: (ms, fn) => timers.push({ ms, fn }) },
  fs: {
    read: async p => (await readFile(p.startsWith('/') ? p : join(projDir, p))).toString(),
    write: async () => {},
  },
  ui: { log: m => logs.push(String(m)), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async () => ({ ok: true, status: 200, headers: {}, text: '{}' }) },
  env: { get: async name => (name === 'HOME' ? home : undefined) },
  session: { cwd: async () => projDir },
  plugin: { root: '/plugin-root' },
  process: { run: async argv => { spawns.push(argv); return { exitCode: 0, stdout: '', stderr: '' } } },
}
const handlers = new Map()
const { register } = await import(pathToFileURL(regPath).href)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await Promise.race([handlers.get('session.start')($, {}, async () => ({ kids: [] })), new Promise(r => setTimeout(r, 500))])
for (const t of timers) await Promise.race([t.fn(), new Promise(r => setTimeout(r, 300))])
for (const t of timers) await Promise.race([t.fn(), new Promise(r => setTimeout(r, 300))])

// --- (1) the project cannot choose the program or the env file ---------------
const shioaji = spawns.find(argv => argv.some(a => String(a).endsWith('fetch-quotes-shioaji.py')))
ok(shioaji !== undefined, `the shioaji route spawned (spawns=${spawns.length})`)
const argv = shioaji ?? []
const argOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
ok(argv.includes('/user/venv/bin/python') && !argv.includes('./tools/evil.sh'), `the user's python runs, not the project's (${argv.slice(0, 7).join(' | ')})`)
ok(argOf('--env') === '/user/.sinobon.env', `the user's env file is handed over, not the project's (--env ${argOf('--env')})`)
ok(argOf('--interval') === '7', `an ordinary key in the project's shioaji block still applies (--interval ${argOf('--interval')})`)
const ignoredLogs = logs.filter(l => /已忽略/.test(l))
ok(ignoredLogs.some(l => l.includes('shioaji.python')) && ignoredLogs.some(l => l.includes('shioaji.env')), `both dropped keys are logged: ${ignoredLogs.join(' / ')}`)
ok(new Set(ignoredLogs).size === ignoredLogs.length, `each dropped key is logged once across polls (${ignoredLogs.length} lines)`)

// --- (2) the directory name cannot run code through /bin/sh ------------------
if (shioaji) {
  // the fetcher's program, swapped for one that prints its own argv into the log
  const run = argv.map(a => (a === '/user/venv/bin/python' || a === './tools/evil.sh' ? '/bin/echo' : a))
  // runtimeDir()'s rule (hooks/constants.ts), worked out here rather than read
  // back out of argv: an older wrapper carried it inside the -c script text
  const slug = projDir.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')
  const logPath = join(home, '.claude', 'stock-band', slug, 'stock-shioaji.log')
  ok(argv.includes(logPath), `the log path, hostile directory name and all, is its own argv entry: ${logPath}`)
  await mkdir(dirname(logPath), { recursive: true })
  const res = spawnSync(run[0], run.slice(1), { cwd: base, encoding: 'utf8' })
  await new Promise(r => setTimeout(r, 300)) // the wrapped command runs in the background (`&`)
  ok(res.status === 0 && !res.stderr, `the wrapper shell ran cleanly (status=${res.status} stderr=${JSON.stringify(res.stderr)})`)
  ok(!existsSync(join(base, 'PWNED')), 'the `$(touch PWNED)` in the directory name did not run')
  const logged = existsSync(logPath) ? await readFile(logPath, 'utf8') : ''
  ok(logged.includes('fetch-quotes-shioaji.py'), `the fetcher's output reached the log file: ${JSON.stringify(logged.slice(0, 80))}`)
}

await rm(base, { recursive: true, force: true })
done()
