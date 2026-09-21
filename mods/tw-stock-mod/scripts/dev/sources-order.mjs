// Proves twSources' merge/alias/default/fallthrough semantics against the
// REAL register.tsx (bundled), with a stub host that fakes the user-level
// and project config files, $.env.get("HOME"), $.session.cwd and
// $.process.run (so no real shioaji script or ~/.claude file is touched),
// but hits the real Yahoo/MIS endpoints the same way harness.mjs does.
//
// Usage: node sources-order.mjs <register.js>
import { pathToFileURL } from 'node:url'

const [, , modPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

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

// `homeVar` picks which environment variable carries the home directory, and
// `cwd` what $.session.cwd() answers - both so a case can stand in for
// Windows, where $HOME is unset and a project path looks like `D:\app`.
async function runCase(label, { userText, projectText, quotesText, homeVar = 'HOME', cwd = '/fake-project' } = {}) {
  const home = '/fake-home'
  const files = {}
  if (userText !== undefined) files[`${home}/.claude/stock-band.json`] = userText
  if (projectText !== undefined) files['.claude/stock-band.json'] = projectText
  if (quotesText !== undefined) files['.claude/stock-quotes.json'] = quotesText

  const logs = []
  const processRuns = []
  const $ = {
    clock: { now: async () => Date.now(), every: () => {} },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => {
        files[path] = text
      },
    },
    env: { get: async name => (name === homeVar ? home : undefined) },
    session: { cwd: async () => cwd },
    process: {
      run: async (argv, init) => {
        processRuns.push({ argv, init })
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    plugin: { root: '/fake-plugin-root' },
    ui: {
      log: m => logs.push(m),
      invalidate: () => {},
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: {
      fetch: async (url, init) => {
        const res = await fetch(url, { headers: init?.headers })
        const text = await res.text()
        logs.push(`FETCH ${res.status} ${url}`)
        return { ok: res.ok, status: res.status, text }
      },
    },
  }

  // A fresh module instance per case - register.tsx keeps module-level
  // mutable state (config, lastFile, liveBy, ...) that must not leak
  // between cases sharing one process.
  moduleTick += 1
  const url = pathToFileURL(modPath)
  url.search = `?case=${moduleTick}`
  const { register } = await import(url.href)

  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async e => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)
  // session.start already awaits its own first feed() to completion before
  // returning, so no extra wait should be needed - this is a small buffer
  // against anything unawaited rather than a load-bearing delay.
  await new Promise(r => setTimeout(r, 200))

  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
  const client = findClient(tree)
  const p = client?.props?.props

  console.log(`=== ${label} ===`)
  console.log(`market=${p?.market} source=${p?.source} sourceLabel=${p?.sourceLabel}`)
  console.log(`process.run calls: ${processRuns.length}` + (processRuns[0] ? ` (argv[3..5]: ${processRuns[0].argv.slice(3, 6).join(' ')})` : ''))
  const fetches = logs.filter(l => l.startsWith('FETCH'))
  for (const f of fetches) console.log(f.replace(/&_=\d+/, '').slice(0, 100))
  console.log()
  return { p, logs, processRuns }
}

// (a) user file + project file merge, project wins: user sets twSources
// ["mis"] and market "us"; project sets only market "tw" - the merged
// config must fetch Taiwan (project's market wins) through MIS (only the
// user file states twSources at all).
const a = await runCase('(a) user+project merge, project market wins, user twSources applies', {
  userText: JSON.stringify({ twSources: ['mis'], market: 'us' }),
  projectText: JSON.stringify({ market: 'tw' }),
})
const aOk = a.p?.market === 'tw' && a.logs.some(l => l.includes('mis.twse.com.tw'))
console.log(`(a) PASS=${aOk}\n`)

// (b) legacy singular twSource -> ["mis"]
const b = await runCase('(b) twSource: "mis" aliases to ["mis"]', {
  projectText: JSON.stringify({ market: 'tw', twSource: 'mis' }),
})
const bOk = b.logs.some(l => l.includes('mis.twse.com.tw'))
console.log(`(b) PASS=${bOk}\n`)

// (c) default is ["yahoo"] with no twSources/twSource stated at all
const c = await runCase('(c) default twSources is ["yahoo"]', {
  projectText: JSON.stringify({ market: 'tw' }),
})
const cOk = c.logs.some(l => l.includes('query1.finance.yahoo.com')) && c.p?.sourceLabel === 'Yahoo 延遲'
console.log(`(c) PASS=${cOk}\n`)

// (d) ["shioaji", "yahoo"] with no quotes file (shioaji has nothing fresh) -
// the tick must fall through to yahoo THIS SAME TICK and the footer must
// read Yahoo 延遲, not demo prices.
const d = await runCase('(d) shioaji stale falls through to yahoo this tick', {
  projectText: JSON.stringify({
    market: 'tw',
    twSources: ['shioaji', 'yahoo'],
    shioaji: { python: 'python3', env: '/nonexistent-env-file', interval: 10 },
  }),
})
const dOk = d.processRuns.length === 1 && d.logs.some(l => l.includes('query1.finance.yahoo.com')) && d.p?.sourceLabel === 'Yahoo 延遲'
console.log(`(d) PASS=${dOk}\n`)

// (e) ["capital", "yahoo"], same fallthrough as (d) but through the other
// broker route - and its spawn must be the PLAIN argv (python, script, ...),
// never the /bin/sh + nohup wrapper, since 群益 only runs on Windows where
// neither exists. `--detach` is what stands in for the backgrounding there,
// so its presence is the thing worth pinning: without it $.process.run would
// hang on the fetcher's pipes for the whole 15 s timeout.
const e = await runCase('(e) capital stale falls through to yahoo this tick', {
  projectText: JSON.stringify({
    market: 'tw',
    twSources: ['capital', 'yahoo'],
    capital: { python: 'python', env: '/nonexistent-env-file', dll: 'C:/nope/SKCOM.dll', interval: 10 },
  }),
})
const eArgv = e.processRuns[0]?.argv ?? []
const eOk =
  e.processRuns.length === 1 &&
  eArgv[0] === 'python' &&
  String(eArgv[1]).endsWith('fetch-quotes-capital.py') &&
  eArgv.includes('--detach') &&
  eArgv.includes('--dll') &&
  e.logs.some(l => l.includes('query1.finance.yahoo.com')) &&
  e.p?.sourceLabel === 'Yahoo 延遲'
console.log(`(e) PASS=${eOk}\n`)

// (f) Windows shape: no $HOME (only %USERPROFILE%) and a drive-letter cwd.
// The runtime dir must still land under the home directory - falling back to
// `<project>/.claude/` would write one person's live prices and PID file into
// a shared repo - and its slug must be a legal directory name, so the drive
// colon and the backslashes all become "-" (`D:\app` -> `D--app`).
const f = await runCase('(f) windows: USERPROFILE home + drive-letter cwd', {
  homeVar: 'USERPROFILE',
  cwd: 'D:\\fake-project',
  projectText: JSON.stringify({
    market: 'tw',
    twSources: ['capital', 'yahoo'],
    capital: { python: 'python', env: '/nonexistent-env-file', dll: 'C:/nope/SKCOM.dll', interval: 10 },
  }),
})
const fArgv = f.processRuns[0]?.argv ?? []
const fOutDir = fArgv[fArgv.indexOf('--out-dir') + 1]
const fOk = f.processRuns.length === 1 && fOutDir === '/fake-home/.claude/stock-band/D--fake-project/'
console.log(`(f) out-dir=${fOutDir}`)
console.log(`(f) PASS=${fOk}\n`)

const allOk = aOk && bOk && cOk && dOk && eOk && fOk
console.log(allOk ? 'ALL PASS' : 'SOME FAILED')
process.exit(allOk ? 0 : 1)
