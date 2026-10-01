// Rank cross, after the sticky order (see sticky-rank.mjs). This file used to
// assert the opposite: that two symbols swapping rank mid-page marks the row
// with was.code (PR-a). The table no longer re-sorts on every snapshot, so a
// pct swap does not move anyone - there is no occupant change to mark, and
// that old assertion is superseded, not weakened. What this still guards:
//   1. a pct swap keeps the order and flaps prices only (was without code);
//   2. an occupant change that DOES happen outside a page turn (the watchlist
//      grows, so the order is re-ranked) is still marked with was.code - the
//      PR-a safety net in buildProps' else branch.
// Single page (pageMs:0), feed off, so no page turn or network is involved.
// register.tsx's props are the battlefield; board.tsx is only printed for
// eyes (its flap timeline is not this bug's business, see README).
//
// Usage: node rank-cross.mjs <board.js> <register.js> <projDir>
import { readFile, writeFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'
const [, , boardPath, regPath, projDir] = process.argv

// 2026-09-17T10:00:00+08:00 (週四台股盤中) - 跟 chart-nav.mjs 用同一個錨點，
// 純粹圖個一致，數值本身對這支的斷言沒有特殊意義。
let clock = 1789596000000
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
  fs: { read: async p => readFile(p.startsWith('/') ? p : `${projDir}/${p}`).then(b => b.toString()) },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async () => { throw new Error('rank-cross fixture runs feed:"off" - $.http.fetch should never be called') } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500))

const walk = (n, f) => { if (!n || typeof n !== 'object') return; f(n); for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, f) }
const drawProps = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, async () => ({ kids: [] }))
  let props
  walk(tree, n => { if (n.type === 'Client') props = n.props.props })
  return props
}

// --- board.tsx 純為人眼核對，跟 board-harness.mjs 同一套渲染方式 -----------
const board = (await import(boardPath)).default
const boardText = props => {
  let state
  const surface = {
    columns: 100, rows: 9,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  const text = (node, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
    if (Array.isArray(node)) { for (const n of node) text(n, acc); return acc }
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) text(k, acc)
    return acc
  }
  return (out.kids ?? []).map(row => text(row, []).join(''))
}

let props = await drawProps()
console.log('對調前板面：')
for (const line of boardText(props)) console.log('|' + line + '|')
ok(props.view === 'table', '起始是清單畫面')

const beforeOrder = props.quotes.map(q => q.code)
console.log(`對調前名次  ${props.quotes.map(q => `${q.code}(${q.pct}%)`).join(' > ')}`)
ok(props.quotes.every(q => q.was === undefined), '交叉前沒有任何一列在翻牌狀態')

// swap the top two pcts (same trick as chart-nav.mjs)
const quotesPath = `${projDir}/.claude/stock-quotes.json`
const configPath = `${projDir}/.claude/stock-band.json`
const before = JSON.parse(await readFile(quotesPath, 'utf8'))
const [topCode, secondCode] = beforeOrder
const swapped = {
  ...before,
  asOf: (clock += 1000),
  quotes: { ...before.quotes, [topCode]: before.quotes[secondCode], [secondCode]: before.quotes[topCode] },
}
await writeFile(quotesPath, JSON.stringify(swapped, null, 2))
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

props = await drawProps()
console.log('\n對調後板面（名次凍結）：')
for (const line of boardText(props)) console.log('|' + line + '|')
ok(props.quotes.map(q => q.code).join() === beforeOrder.join(), `pct 對調後名次凍結，沒有人換位：${props.quotes.map(q => q.code).join(' > ')}`)
ok(props.quotes.every(q => q.was?.code === undefined), '沒有任何一列換代碼（was.code 全空）')
const moved = props.quotes.filter(q => q.was !== undefined)
ok(
  moved.some(q => q.code === topCode) && moved.some(q => q.code === secondCode),
  `價格變動的兩列仍只翻價格（was 有 price、沒有 code）：${moved.map(q => q.code).join(' ')}`,
)

// grow the watchlist: a NEW top-ranked symbol re-ranks the order, every row below
// it changes occupant, and that must still show as was.code (no page turn here)
const config = JSON.parse(await readFile(configPath, 'utf8'))
config.tw = [...config.tw, { code: '4444', name: '丁', prevClose: 100 }]
await writeFile(configPath, JSON.stringify(config, null, 2))
const grown = JSON.parse(await readFile(quotesPath, 'utf8'))
await writeFile(quotesPath, JSON.stringify({ ...grown, asOf: (clock += 1000), quotes: { ...grown.quotes, 4444: { price: 110, prevClose: 100, name: '丁' } } }, null, 2))
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

props = await drawProps()
console.log('\n新增代碼後板面：')
for (const line of boardText(props)) console.log('|' + line + '|')
ok(props.quotes[0].code === '4444', `新增的最高漲幅代碼排第一：${props.quotes.map(q => q.code).join(' > ')}`)
// frozen order was 1111, 2222, 3333: row 0 and row 2 change occupant, row 1 (2222) does not
ok(props.quotes[0].was?.code === beforeOrder[0], `第 0 列換了人（${beforeOrder[0]} -> 4444），沒有 page turn 也要有 was.code (PR-a)`)
ok(props.quotes[2].was?.code === beforeOrder[2], `第 2 列換了人（${beforeOrder[2]} -> ${props.quotes[2].code}），同樣要有 was.code`)
ok(props.quotes[1].was?.code === undefined, '第 1 列同一檔（2222），沒有 was.code')

done()
