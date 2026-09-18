// Render the real board.tsx's pnl view against real props and print the 8
// rows as text. Same stub host as board-harness.mjs, plus two extra steps:
//
// 1. Press the 台股庫存 tab (key stock-band:tab:tw:pnl) through the real hook
//    chain, same as a real click - the pnl view is a stop on the tab row,
//    not a separate 損益 button. Asserts the stop is actually reached.
// 2. Optionally post a `{ sortPnl: key }` message straight into ui.message
//    (the same message a header-cell click sends - see board.tsx's picker),
//    to prove the sort/direction toggle without a pty.
//
// Usage: node pnl-harness.mjs <board.js> <register.js> <projectDir> [pluginRoot] [columns] [sortPnlKey ...]
// Each extra trailing arg after columns is one more sortPnl press, applied
// in order (so `today today` presses the same key twice: once to switch to
// it, once more to flip its direction).
import { readFile } from 'node:fs/promises'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, cfgPath, pluginRoot, colsArg, ...sortPresses] = process.argv
const COLS = colsArg ? Number(colsArg) : 120

// --- pull real props out of register.tsx -----------------------------------
const projDir = cfgPath
const handlers = new Map()
const $ = {
  clock: { now: async () => Date.now(), every: () => {} },
  fs: { read: async p => readFile(new URL('file://' + projDir + '/' + p)).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
  http: { fetch: async (url, init) => { const r = await fetch(url, { headers: init?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  session: { cwd: async () => projDir },
  env: { get: async () => undefined },
  process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  plugin: { root: pluginRoot ?? '' },
}
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of n.kids ?? []) walk(k, f) }

async function render() {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: COLS } }, async () => ({ kids: [] }))
  let props
  const buttons = []
  walk(tree, n => {
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') buttons.push(n)
  })
  return { tree, props, buttons }
}

// --- 1. press the 台股庫存 tab ----------------------------------------------
let cur = await render()
const pnlTab = cur.buttons.find(b => b.props.key === 'stock-band:tab:tw:pnl')
if (!pnlTab) {
  console.error('no 台股庫存 tab found - buttons were:', cur.buttons.map(b => b.props.label))
  process.exit(1)
}
pnlTab.props.onPress()
cur = await render()
const marketLabel = cur.buttons.find(b => b.props.key === 'stock-band:tab:tw:pnl')?.props.label
console.log(`台股庫存 tab pressed -> label "${marketLabel}", view=${cur.props?.view}`)
if (cur.props?.view !== 'pnl' || marketLabel !== '[台股庫存]') {
  console.error(`FAIL: expected the pnl stop with the tab marked "[台股庫存]", got view=${cur.props?.view} label="${marketLabel}"`)
  process.exit(1)
}
console.log('buttons (pnl stop):', cur.buttons.map(b => b.props.label).join('  '))

// --- 2. render the board's pnl view -----------------------------------------
const board = (await import(boardPath)).default
let state
const surface = {
  columns: COLS,
  rows: 8,
  elements: { Box: 'Box', Text: 'Text' },
  get state() { return state },
  setState: s => { state = s },
  every: () => () => {},
  onPointer: () => {},
}

function text(node, acc) {
  if (node == null || node === false) return acc
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
  const kids = [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]
  for (const k of kids) text(k, acc)
  return acc
}

function printBoard(props, tag) {
  console.log(`--- ${tag} (pnlSortKey=${props.pnlSortKey} pnlSortDir=${props.pnlSortDir}) ---`)
  state = undefined
  board(props, surface) // first call seeds state
  const out = board(props, surface)
  const rows = out.kids ?? []
  for (const row of rows) console.log('|' + text(row, []).join('') + '|')
}

printBoard(cur.props, 'default sort')

// --- 3. optional trailing sortPnl presses, straight through ui.message -----
// There is no ui.scroll step here on purpose: the engine only raises
// ui.scroll for a band taller than maxRows, and this Client is a fixed 8
// rows - see the note near pnlScroll in register.tsx (tried it in 0.9.0,
// reverted in 0.9.1, zero events on the real build with --debug).
for (const step of sortPresses) {
  const key = step
  const result = await handlers.get('ui.message')(
    $,
    { element: 'stock-band:table', module: 'hooks/board.tsx', data: { sortPnl: key } },
    async () => ({ kids: [] }),
  )
  if (!result || typeof result !== 'object') {
    console.error(`FAIL: ui.message did not accept { sortPnl: "${key}" }`)
    process.exit(1)
  }
  cur = await render()
  printBoard(cur.props, `after { sortPnl: "${key}" }`)
}
