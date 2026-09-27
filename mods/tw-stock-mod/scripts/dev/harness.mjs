// Drive the real register.tsx against the real endpoints with a stub host.
// Usage: node harness.mjs <register.js> <config.json> [ticks]
import { readFile } from 'node:fs/promises'

const [, , modPath, cfgPath, ticksArg] = process.argv
const ticks = Number(ticksArg ?? 1)

globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

const cfgText = await readFile(cfgPath, 'utf8')

const handlers = new Map()
const timers = []
const logs = []

const $ = {
  clock: {
    now: async () => Date.now(),
    every: (ms, fn) => timers.push({ ms, fn }),
  },
  fs: {
    read: async path => {
      if (path === '.claude/stock-band.json') return cfgText
      throw new Error('ENOENT ' + path)
    },
  },
  ui: {
    log: m => logs.push(m),
    invalidate: () => {},
    resolve: async () => ({
      Box: 'Box',
      Button: 'Button',
      Client: 'Client',
      Text: 'Text',
    }),
  },
  http: {
    fetch: async (url, init) => {
      const res = await fetch(url, { headers: init?.headers })
      const text = await res.text()
      logs.push(`FETCH ${res.status} ${url.slice(0, 110)}`)
      return { ok: res.ok, status: res.status, text }
    },
  },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => process.cwd() },
  process: {},
}

const { register } = await import(modPath)
register((event, a, b) => {
  const handler = typeof a === 'function' ? a : b
  handlers.set(event, handler)
})

const next = async () => ({ type: 'next', props: {}, kids: [] })
await handlers.get('session.start')($, {}, next)

function findClient(node) {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Client') return node
  for (const k of node.kids ?? []) {
    const hit = findClient(k)
    if (hit) return hit
  }
  return undefined
}

for (let t = 0; t < ticks; t++) {
  if (t > 0) {
    // run every registered interval once, the way the host's clock would
    for (const timer of timers) await timer.fn()
    await new Promise(r => setTimeout(r, 1500))
  }
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
  const client = findClient(tree)
  const p = client?.props?.props
  if (!p) {
    console.log('NO BOARD DRAWN')
    continue
  }
  console.log(`--- tick ${t}`)
  console.log(
    JSON.stringify(
      {
        market: p.market,
        phase: p.phase,
        clock: p.clock,
        source: p.source,
        sourceLabel: p.sourceLabel,
        seq: p.seq,
        index: p.index,
        indices: p.indices,
        rows: p.quotes.map(q => ({
          code: q.code,
          name: q.name,
          price: q.price,
          change: q.change,
          pct: Number(q.pct?.toFixed(2)),
          series: q.series?.length,
          bars: q.bars?.length,
        })),
      },
      null,
      1,
    ),
  )
}
console.log('--- log')
for (const l of logs) console.log(l)
