import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , modPath, cfgPath] = process.argv
const cfgText = await readFile(cfgPath, 'utf8')
const handlers = new Map(); const timers = []; const logs = []
const $ = {
  clock: { now: async () => Date.now(), every: (ms, fn) => timers.push({ ms, fn }) },
  fs: { read: async p => { if (p === '.claude/stock-band.json') return cfgText; throw new Error('ENOENT') } },
  ui: { log: m => logs.push(m), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); const text = await r.text(); logs.push(`FETCH ${r.status} ${url.split('?')[0]}`); return { ok: r.ok, status: r.status, text } } },
}
const { register } = await import(modPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
const next = async () => ({ type: 'next', kids: [] })
await handlers.get('session.start')($, {}, next)
const walk = (n, hit) => { if (!n || typeof n !== 'object') return; hit(n); for (const k of n.kids ?? []) walk(k, hit) }
const draw = async () => handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
const board = t => { let p; walk(t, n => { if (n.type === 'Client') p = n.props.props }); return p }
let tree = await draw()
let p = board(tree)
console.log('before switch:', p.market, p.sourceLabel, p.quotes[0].code, p.quotes[0].price)
// the other market's tab (the cycling button this used to press twice is gone)
const other = p.market === 'tw' ? 'us' : 'tw'
let press
walk(tree, n => { if (n.type === 'Button' && n.props.key === `stock-band:tab:${other}`) press = n.props.onPress })
press()
await new Promise(r => setTimeout(r, 2500)) // the switch asks for a tick of its own
tree = await draw(); p = board(tree)
console.log('after switch (before next feed tick):', p.market, p.source, p.sourceLabel)

tree = await draw(); p = board(tree)
console.log('after the switch-triggered tick:', p.market, p.source, p.sourceLabel, p.quotes[0].code, p.quotes[0].price)
console.log('log:', logs.join(' | '))
