// The K 線 pane (prototype) at its seams: the pane's ui.render tree and the
// band's entry points into it (趨勢圖, a table-row pick, 開 pane, 回 band), the
// pane's own controls (上一檔／下一檔, 寬度, 回 band, 關閉), the viewport-derived
// width, the no-Client fallback, board.tsx's tall volume panel, and the band's
// isolation: its Client props for one fixed frame sequence are identical with
// and without pane renders in between (P4 - the sequence moves the opened code
// onto page 2 and rewrites the quotes so two ranks cross). With the gate off
// (TW_STOCK_CHART_PANE unset) the band behaves as base (P12).
//
// Usage: node chart-pane.mjs $OUT/register.js $OUT/board.js <fixture-dir>
// Writes its own projects under <fixture-dir>/ (no network, fixed clock).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, fixtureDir] = process.argv

const CLOCK = 1789596000000 // 2026-09-17 10:00 台北, 台股盤中 (chart-nav's clock)
const PANE = 'stock-chart'
const CODES = ['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108']
const sleep = ms => new Promise(r => setTimeout(r, ms))
// rank k (1-based) is CODES[k - 1]: prices 109 - k over prevClose 100, so the change order is the list order
const PRICES = Object.fromEntries(CODES.map((c, i) => [c, 109 - (i + 1)]))
const MIN = 60_000
const BARS = Array.from({ length: 60 }, (_, i) => {
  const base = 100 + Math.sin(i * 0.5) * 2
  return [base, base + 0.8, base - 0.8, base + 0.3 * Math.cos(i), 100 + ((i * 37) % 90), CLOCK - (59 - i) * 5 * MIN]
})
const quoteFile = (prices, asOf) => ({
  asOf,
  market: 'tw',
  quotes: Object.fromEntries(
    CODES.map(c => [c, { price: prices[c], prevClose: 100, name: `測${c.slice(3)}`, ...(c === '1101' ? { bars: BARS } : {}) }]),
  ),
})
const cfg = {
  market: 'tw',
  feed: 'off',
  pageMs: 0,
  sort: 'change',
  columns: 1,
  tw: CODES.map((c, i) => ({ code: c, name: `測${i + 1}`, prevClose: 100 })),
  us: [],
}
const Q2 = { ...PRICES, '1106': 110, '1101': 101 } // 1106 jumps from rank 6 to 1, 1101 falls to 8

const board = (await import(boardPath)).default
let bootSeq = 0

/** one fresh register.js on its own project dir; `rig.calls` records the $.ui calls */
async function boot(dir, quotes = quoteFile(PRICES, CLOCK), gate = true) {
  await mkdir(`${dir}/.claude`, { recursive: true })
  await writeFile(`${dir}/.claude/stock-band.json`, JSON.stringify(cfg))
  await writeFile(`${dir}/.claude/stock-quotes.json`, JSON.stringify(quotes))
  const timers = []
  const hooks = []
  const calls = { open: [], close: [], log: [], invalidate: 0 }
  const rig = { calls, timers, openAnswer: { isPlaced: true }, writeQuotes: async q => writeFile(`${dir}/.claude/stock-quotes.json`, JSON.stringify(q)) }
  /** runs every hook registered for `event` whose filter matches `e`, in order; `fallback` is the end of the chain */
  const run = (event, e, fallback) => {
    const list = hooks.filter(x => x.event === event && Object.entries(x.filter ?? {}).every(([k, v]) => e[k] === v))
    const step = (i, ee) => (i < list.length ? list[i].fn($, ee, nx => step(i + 1, nx)) : fallback(ee))
    return step(0, e)
  }
  const $ = {
    clock: { now: async () => CLOCK, every: (ms, fn) => timers.push(fn) },
    fs: { read: async p => (await readFile(p.startsWith('/') ? p : `${dir}/${p}`)).toString() },
    ui: {
      log: m => calls.log.push(String(m)),
      invalidate: () => { calls.invalidate++ },
      resolve: async e => ({
        Box: 'Box',
        Text: 'Text',
        Button: 'Button',
        ...(e?.surface === 'terminal' || e?.surface === 'desktop' ? { Client: 'Client' } : {}),
      }),
      open: async args => { calls.open.push(args); return rig.openAnswer },
      close: async args => {
        calls.close.push(args)
        await run('ui.close', { id: args.id, origin: { kind: 'plugin' } }, () => undefined)
      },
      panes: async () => [],
    },
    http: { fetch: async () => ({ ok: false, status: 404, text: '' }) },
    env: { get: async name => (name === 'HOME' ? `${dir}/home` : name === 'TW_STOCK_CHART_PANE' && gate ? '1' : undefined) },
    session: { cwd: async () => dir },
    plugin: { root: dir },
    process: { run: async () => { throw new Error('chart-pane: no spawn expected') } },
  }
  const { register } = await import(`${regPath}?chart-pane=${++bootSeq}`)
  register((event, a, b) => hooks.push({ event, filter: typeof a === 'object' ? a : undefined, fn: typeof a === 'function' ? a : b }))
  await run('session.start', {}, () => ({}))
  return { rig, run }
}

/** the rendered tree as data: buttons (with their presses), the Client's props, and every text */
const collect = tree => {
  const out = { btns: [], texts: [], client: undefined, clientProps: undefined }
  const walk = n => {
    if (n == null || n === false) return
    if (typeof n === 'string' || typeof n === 'number') { out.texts.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'Client') { out.client = n.props.props; out.clientProps = n.props }
    if (n.type === 'Button') out.btns.push({ label: n.props.label, key: n.props.key, press: n.props.onPress })
    ;(n.kids ?? []).forEach(walk)
  }
  walk(tree)
  return out
}

/** `viewport` null leaves it out (never seen); `scroll` null leaves scroll.bodyRows out */
async function drawBand(run, { viewport = 120, props = {} } = {}) {
  const e = {
    component: 'AbovePrompt',
    props: { maxRows: 20, bodyColumns: 120, ...props },
    surface: 'terminal',
    ...(viewport === null ? {} : { viewport: { columns: viewport } }),
  }
  return collect(await run('ui.render', e, () => ({ kids: [] })))
}
async function drawPane(run, { viewport = 120, surface = 'terminal', scroll = { bodyRows: 46 }, bodyColumns = 89 } = {}) {
  const e = {
    component: 'Pane',
    requestId: PANE,
    props: {
      title: 'K線',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      ...(scroll === null ? {} : { scroll }),
    },
    surface,
    ...(viewport === null ? {} : { viewport: { columns: viewport } }),
  }
  return collect(await run('ui.render', e, () => ({ kids: [] })))
}
async function press(out, label) {
  const b = out.btns.find(x => (typeof label === 'function' ? label(x.label) : x.label === label))
  if (!b) throw new Error(`no button ${label}`)
  await b.press()
}
const pick = (run, k) => run('ui.message', { element: 'stock-band:table', module: 'hooks/board.tsx', data: { pick: k } }, () => ({}))
const scenario = async (name, fn) => {
  try { await fn() } catch (err) { ok(false, `${name} threw: ${err.message}`) }
}
const focusCode = c => c.quotes?.[c.focus]?.code

// --- board.tsx rendered to text -------------------------------------------
const textOf = n => {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return (n.kids ?? []).map(textOf).join('') + (n.props?.children != null ? textOf(n.props.children) : '')
}
function drawBoard(props) {
  let state
  const surface = {
    columns: 120, rows: 40, elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: () => {},
  }
  board(props, surface)
  const out = board(props, surface)
  return (out.kids ?? []).map(textOf)
}
/** the volume label sits on the first volume row; the title row can carry a 量 readout too, so skip row 0 */
const volumeRow = rows => rows.slice(1).findIndex(t => t.includes('量 ')) + 1

// --- scenarios -------------------------------------------------------------
await scenario('P1', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p1`)
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  const a = rig.calls.open[0] ?? {}
  ok(rig.calls.open.length === 1, `P1 趨勢圖 calls $.ui.open once (${rig.calls.open.length} calls)`)
  ok(a.id === PANE && a.focus === true && a.closeOnEscape === true, 'P1 open args: id stock-chart, focus, closeOnEscape')
  ok(!('columns' in a), 'P1 open args carry no columns (預設 width)')
  ok(String(a.title).includes('1101'), `P1 title names the opened code (${a.title})`)
  const after = await drawBand(run)
  ok(after.client?.view === 'table', `P1 band stays on the table (view ${after.client?.view})`)
})

await scenario('P2', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p2`)
  await drawBand(run)
  await pick(run, 2)
  const a = rig.calls.open[0] ?? {}
  ok(rig.calls.open.length === 1 && String(a.title).includes('1103'), `P2 pick 2 opens the pane on rank 3 (${a.title})`)
  const after = await drawBand(run)
  ok(after.client?.view === 'table', 'P2 band stays on the table after a row pick')
})

await scenario('P3', async () => {
  const { run } = await boot(`${fixtureDir}/p3`)
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  const pane = await drawPane(run)
  ok(!!pane.client, 'P3 pane draws a Client')
  ok(pane.client?.view === 'chart', `P3 pane Client view chart (${pane.client?.view})`)
  ok(pane.clientProps?.height === 44, `P3 Client height 44 (${pane.clientProps?.height})`)
  ok(pane.clientProps?.width === 89, `P3 Client width 89 (${pane.clientProps?.width})`)
  ok(focusCode(pane.client ?? {}) === '1101', `P3 focused row is the opened code (${focusCode(pane.client ?? {})})`)
  ok(pane.texts.some(t => t.includes('89×46') && t.includes('dock')), 'P3 state line names 89×46 and dock')
  const noScroll = await drawPane(run, { scroll: null })
  ok(noScroll.clientProps?.height === 22, `P3 missing scroll.bodyRows falls back to 24 rows (height ${noScroll.clientProps?.height})`)
})

/** one run of P4's frame sequence; `withPane` adds the opened pane and its renders between the band's frames */
async function sequence(dir, withPane, gate = true) {
  const { rig, run } = await boot(dir, undefined, gate)
  const frames = []
  let paneDraws = 0
  let band = await drawBand(run)
  const frame = async () => { band = await drawBand(run); frames.push(JSON.stringify(band.client ?? null)); return band }
  const paneFrame = async () => { if (withPane) { const p = await drawPane(run); if (p.client) paneDraws++ } }
  frames.push(JSON.stringify(band.client ?? null))
  await press(band, l => l.startsWith('翻頁'))
  await frame() // page 2: ranks 6-8
  await frame()
  if (withPane) { if (gate) await pick(run, 0); await paneFrame() } // opens on rank 6 (1106), which sits on page 2
  await press(band, l => l.startsWith('翻頁'))
  await frame() // back on page 1
  await paneFrame()
  for (const fn of rig.timers) { await fn(); await sleep(400) }
  await rig.writeQuotes(quoteFile(Q2, CLOCK + 1000))
  for (const fn of rig.timers) { await fn(); await sleep(400) }
  await frame()
  await paneFrame()
  await frame()
  return { frames, paneDraws, calls: rig.calls }
}

await scenario('P4', async () => {
  const a = await sequence(`${fixtureDir}/p4-band`, false)
  const b = await sequence(`${fixtureDir}/p4-pane`, true)
  ok(b.paneDraws > 0, `P4 the pane drew during the sequence (${b.paneDraws} draws, positive control)`)
  ok(JSON.parse(a.frames[2]).page === 1 && a.frames[2].includes('"code":"1106"'), 'P4 the opened code 1106 sits on band page 2')
  ok(a.frames.at(-1) !== a.frames[3], 'P4 the quotes rewrite changes what the band draws (positive control)')
  const diff = a.frames.findIndex((f, i) => f !== b.frames[i])
  ok(a.frames.length === b.frames.length && diff < 0, `P4 band Client props identical with and without pane renders${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
})

await scenario('P5', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p5`)
  rig.openAnswer = { isPlaced: false, reason: '測試：沒有位置' }
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  const after = await drawBand(run)
  ok(after.client?.view === 'chart', `P5 band switches to chart view when the pane is not placed (${after.client?.view})`)
  ok(focusCode(after.client ?? {}) === '1101', 'P5 band chart is on the opened code')
  ok(rig.calls.log.some(m => m.includes('測試：沒有位置')), 'P5 $.ui.log carries the reason')
  ok(rig.calls.close.some(c => c.id === PANE), 'P5 an unplaced pane is closed again (no ghost pane)')
})

await scenario('P6', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p6`)
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  const pane = await drawPane(run)
  await press(pane, '關閉')
  ok(rig.calls.close.length === 1 && rig.calls.close[0].id === PANE, 'P6 關閉 calls $.ui.close({ id: stock-chart })')
  await run('ui.close', { id: PANE, origin: { kind: 'person' } }, () => undefined)
  await press(await drawBand(run), '趨勢圖')
  ok(rig.calls.open.length === 2, `P6 after a person close, 趨勢圖 opens again (${rig.calls.open.length} opens)`)
})

/** P7: the width toggle's open args for one viewport (null = never seen) */
async function widthAt(dir, viewport) {
  const { rig, run } = await boot(dir)
  await press(await drawBand(run, { viewport }), '趨勢圖')
  const pane = await drawPane(run, { viewport })
  await press(pane, l => l.startsWith('寬度'))
  const wide = rig.calls.open.at(-1) ?? {}
  await press(await drawPane(run, { viewport }), l => l.startsWith('寬度'))
  const back = rig.calls.open.at(-1) ?? {}
  return { wide: wide.columns, back: 'columns' in back }
}
await scenario('P7', async () => {
  const w200 = await widthAt(`${fixtureDir}/p7-200`, 200)
  ok(w200.wide === 120, `P7 viewport 200: 寬 opens at 120 columns (${w200.wide})`)
  const w150 = await widthAt(`${fixtureDir}/p7-150`, 150)
  ok(w150.wide === 100, `P7 viewport 150: 寬 opens at 100 columns, 90 raised to the floor (${w150.wide})`)
  ok(!w200.back && !w150.back, 'P7 預設 opens with no columns')
  const none = await widthAt(`${fixtureDir}/p7-none`, null)
  ok(none.wide === 100, `P7 viewport never seen (140): 寬 opens at 100 columns (${none.wide})`)
})

await scenario('P8', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p8`)
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  await press(await drawPane(run), '回 band')
  ok(rig.calls.close.some(c => c.id === PANE), 'P8 回 band closes the pane')
  const chart = await drawBand(run)
  ok(chart.client?.view === 'chart' && focusCode(chart.client ?? {}) === '1101', `P8 回 band shows the pane's code in the band chart (${chart.client?.view})`)
  const before = rig.calls.open.length
  await press(chart, '開 pane')
  ok(rig.calls.open.length === before + 1 && String(rig.calls.open.at(-1).title).includes('1101'), 'P8 開 pane opens the pane on the focused code')
  const table = await drawBand(run)
  ok(table.client?.view === 'table', `P8 開 pane puts the band back on the table (${table.client?.view})`)
})

await scenario('P9', async () => {
  const { run } = await boot(`${fixtureDir}/p9`)
  await press(await drawBand(run), '趨勢圖')
  const v = await drawPane(run, { surface: 'vscode' })
  ok(!v.client, 'P9 vscode pane has no Client')
  ok(v.texts.some(t => t.includes('K 線 pane 只在終端與桌面版顯示')), 'P9 vscode pane draws the one-line fallback')
})

await scenario('P10', async () => {
  const { run } = await boot(`${fixtureDir}/p10`)
  const band = await drawBand(run)
  await press(band, '趨勢圖')
  const pane = await drawPane(run)
  ok(pane.client?.tallVolume === true, 'P10 pane Client props carry tallVolume: true')
  const bandNow = await drawBand(run)
  ok(!('tallVolume' in (bandNow.client ?? {})), 'P10 band Client props have no tallVolume key')
  const base = bandNow.client
  const chart = { ...base, view: 'chart', layout: 'full', focus: 0, timeframes: [], timeframe: '5', chartMode: 'candle' }
  const tall44 = drawBoard({ ...chart, boardRows: 44, chartRows: 44, tallVolume: true })
  ok(tall44.length === 44 && volumeRow(tall44) === 44 - 1 - 7, `P10 44 rows with tallVolume: volume label on row ${44 - 1 - 7} (got ${volumeRow(tall44)})`)
  const plain44 = drawBoard({ ...chart, boardRows: 44, chartRows: 44 })
  ok(volumeRow(plain44) === 44 - 1 - 2, `P10 44 rows without tallVolume keep 2 volume rows (label on row ${44 - 1 - 2}, got ${volumeRow(plain44)})`)
  const short16 = drawBoard({ ...chart, boardRows: 16, chartRows: 16, tallVolume: true })
  ok(short16.length === 16 && volumeRow(short16) === 16 - 1 - 2, `P10 16 rows with tallVolume keep 2 volume rows (got ${volumeRow(short16)})`)
})

await scenario('P11', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p11`)
  await press(await drawBand(run), '趨勢圖')
  const pane = await drawPane(run)
  const focusBefore = (await drawBand(run)).client?.focus
  await press(pane, l => l.startsWith('下一檔'))
  const [first, second] = [rig.calls.open[0] ?? {}, rig.calls.open.at(-1) ?? {}]
  ok(rig.calls.open.length === 2, `P11 下一檔 re-opens the pane once more (${rig.calls.open.length} opens)`)
  const same = JSON.stringify({ ...first, title: 0 }) === JSON.stringify({ ...second, title: 0 })
  ok(same && String(second.title).includes('1102'), `P11 re-open passes the same args, retitled to 1102 (${second.title})`)
  const paneAfter = await drawPane(run)
  ok(focusCode(paneAfter.client ?? {}) === '1102', `P11 pane moves to 1102 (${focusCode(paneAfter.client ?? {})})`)
  const bandAfter = (await drawBand(run)).client
  ok(bandAfter?.focus === focusBefore, `P11 band focus unchanged (${bandAfter?.focus} vs ${focusBefore})`)
})

// P12 (gate off, the env unset): 趨勢圖 and a row pick enter the band chart as on base, and the pane is never opened
await scenario('P12', async () => {
  const { rig, run } = await boot(`${fixtureDir}/p12`, undefined, false)
  await press(await drawBand(run), '趨勢圖')
  const chart = await drawBand(run)
  ok(chart.client?.view === 'chart' && focusCode(chart.client ?? {}) === '1101', `P12 gate off: 趨勢圖 enters the band chart on the first row (${chart.client?.view})`)
  ok(chart.client?.view === 'chart' && !chart.btns.some(b => b.label === '開 pane'), 'P12 gate off: the band chart row has no 開 pane button')
  const pk = await boot(`${fixtureDir}/p12-pick`, undefined, false)
  await drawBand(pk.run)
  await pick(pk.run, 2)
  const picked = await drawBand(pk.run)
  ok(picked.client?.view === 'chart' && focusCode(picked.client ?? {}) === '1103', `P12 gate off: a row pick enters the band chart on that row (${picked.client?.view})`)
  ok(rig.calls.open.length === 0 && rig.calls.close.length === 0 && pk.rig.calls.open.length === 0, `P12 gate off: no $.ui.open / $.ui.close (${rig.calls.open.length + pk.rig.calls.open.length} open, ${rig.calls.close.length} close)`)
  const plain = await sequence(`${fixtureDir}/p12-plain`, false, false)
  const drawn = await sequence(`${fixtureDir}/p12-drawn`, true, false)
  const diff = plain.frames.findIndex((f, i) => f !== drawn.frames[i])
  ok(plain.frames.length === drawn.frames.length && diff < 0 && drawn.calls.open.length === 0, `P12 gate off: band frames identical with pane renders in between${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
})

done()
