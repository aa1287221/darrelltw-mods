// The K 線 pane (prototype) at its seams: the pane's ui.render tree and the
// band's entry points into it (趨勢圖, a table-row pick, 開 pane, 回 band), the
// pane's own controls (上一檔／下一檔, 寬度, 回 band, 關閉), the viewport-derived
// width, the no-Client fallback, board.tsx's tall volume panel, and the band's
// isolation: its Client props for one fixed frame sequence are identical with
// and without pane renders in between (P4 - the sequence moves the opened code
// onto page 2 and rewrites the quotes so two ranks cross; P4b-P4e cover the
// re-rank, auto-page and 損益 page-turn state). With the gate off
// (TW_STOCK_CHART_PANE unset) the band behaves as base (P12).
//
// Usage: node chart-pane.mjs $OUT/register.js $OUT/board.js <fixture-dir> $OUT/base-register.js
// Writes its own projects under <fixture-dir>/ (no network, mutable clock from 2026-09-17).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, boardPath, fixtureDir, baseRegPath] = process.argv

const CLOCK = 1789596000000 // 2026-09-17 10:00 台北, 台股盤中 (chart-nav's clock)
const PAGE_TURN_WINDOW_MS = 2500 // register.tsx PAGE_TURN_WINDOW_MS
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
let BAND_ROWS = 20 // P4d-P4e shrink the band so it pages sooner and its 損益 page is shorter than the pane's

/** one fresh register.js on its own project dir; `rig.calls` records the $.ui calls */
async function boot(dir, quotes = quoteFile(PRICES, CLOCK), gate = true, reg = regPath) {
  await mkdir(`${dir}/.claude`, { recursive: true })
  await writeFile(`${dir}/.claude/stock-band.json`, JSON.stringify(cfg))
  await writeFile(`${dir}/.claude/stock-quotes.json`, JSON.stringify(quotes))
  const timers = []
  const hooks = []
  const calls = { open: [], close: [], log: [], invalidate: 0 }
  const rig = { calls, timers, now: CLOCK, openAnswer: { isPlaced: true }, writeQuotes: async q => writeFile(`${dir}/.claude/stock-quotes.json`, JSON.stringify(q)) }
  /** runs every hook registered for `event` whose filter matches `e`, in order; `fallback` is the end of the chain */
  const run = (event, e, fallback) => {
    const list = hooks.filter(x => x.event === event && Object.entries(x.filter ?? {}).every(([k, v]) => e[k] === v))
    const step = (i, ee) => (i < list.length ? list[i].fn($, ee, nx => step(i + 1, nx)) : fallback(ee))
    return step(0, e)
  }
  const $ = {
    clock: { now: async () => rig.now, every: (ms, fn) => timers.push(fn) },
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
  const { register } = await import(`${reg}?chart-pane=${++bootSeq}`)
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
    props: { maxRows: BAND_ROWS, bodyColumns: 120, ...props },
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

/** one run of P4's frame sequence; `withPane` adds the opened pane and its renders between the band's frames;
 * `tail` appends a 翻頁 press whose band frame comes after a pane frame (P4b: the re-rank a press asks for) */
async function sequence(dir, withPane, gate = true, reg = regPath, tail = false) {
  const { rig, run } = await boot(dir, undefined, gate, reg)
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
  await frame() // back on page 1, inside the page-turn window: the rank-cross check is off
  await paneFrame() // the pane draws page 2 in that same window
  // the window closes: the band's rank-cross check now compares against lastShown, which the pane also writes
  rig.now += PAGE_TURN_WINDOW_MS + 1000
  await frame()
  await paneFrame()
  await frame()
  for (const fn of rig.timers) { await fn(); await sleep(400) }
  await rig.writeQuotes(quoteFile(Q2, rig.now))
  for (const fn of rig.timers) { await fn(); await sleep(400) }
  await frame()
  await paneFrame()
  await frame()
  if (tail) { await press(band, l => l.startsWith('翻頁')); await paneFrame(); await frame() }
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

/** P4 with the band's last press a 翻頁 whose frame comes after one pane frame: the re-rank that press asks for */
await scenario('P4b', async () => {
  const a = await sequence(`${fixtureDir}/p4b-band`, false, true, regPath, true)
  const b = await sequence(`${fixtureDir}/p4b-pane`, true, true, regPath, true)
  const diff = a.frames.findIndex((f, i) => f !== b.frames[i])
  ok(a.frames.length === b.frames.length && diff < 0, `P4b 翻頁 then a pane frame then a band frame: band frames identical${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
})

/** a short band pages on its own clock (pageMs); the pane's frames must not change which page the band turns to */
await scenario('P4d', async () => {
  cfg.pageMs = 1000
  BAND_ROWS = 6
  try {
    const autoPage = async (dir, withPane) => {
      const { rig, run } = await boot(dir)
      const frames = []
      const frame = async () => { frames.push(JSON.stringify((await drawBand(run)).client ?? null)) }
      const pane = async () => { if (withPane) await drawPane(run) }
      await frame()
      await pane()
      for (let k = 0; k < 4; k++) {
        await pane()
        rig.now += 5000
        for (const fn of rig.timers) { await fn(); await sleep(300) }
        await frame()
      }
      return frames
    }
    const a = await autoPage(`${fixtureDir}/p4d-band`, false)
    const b = await autoPage(`${fixtureDir}/p4d-pane`, true)
    const diff = a.findIndex((f, i) => f !== b[i])
    ok(a.length === b.length && diff < 0, `P4d auto page on a short band: band frames identical with pane renders${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
    ok(a.some((f, i) => i > 0 && f !== a[i - 1]), 'P4d positive control: the band paged on its own clock')
  } finally {
    cfg.pageMs = 0
    BAND_ROWS = 20
  }
})

/** 損益 on a band that fits 3 holdings rows: the pane fits 5, so its scroll clamp differs and it writes a different lastPnlShown */
await scenario('P4e', async () => {
  cfg.holdings = { tw: CODES.slice(0, 6).map((c, i) => ({ code: c, name: `測${i + 1}`, qty: 1000, cost: 100 })), us: [], tf: [], crypto: [] }
  cfg.holdingsSource = 'config'
  BAND_ROWS = 7
  try {
    const pnlTurn = async (dir, withPane) => {
      const { rig, run } = await boot(dir)
      const frames = []
      const frame = async () => { const b = await drawBand(run); frames.push(JSON.stringify(b.client ?? null)); return b }
      const pane = async () => { if (withPane) await drawPane(run) }
      let b = await frame()
      await press(b, l => l === '台股庫存')
      b = await frame()
      await pane()
      await press(b, l => l.startsWith('翻頁'))
      b = await frame()
      await pane()
      rig.now += PAGE_TURN_WINDOW_MS + 1000
      b = await frame()
      await pane()
      await press(b, l => l.startsWith('翻頁'))
      await pane()
      await frame()
      return frames
    }
    const a = await pnlTurn(`${fixtureDir}/p4e-band`, false)
    const b = await pnlTurn(`${fixtureDir}/p4e-pane`, true)
    const diff = a.findIndex((f, i) => f !== b[i])
    ok(a.length === b.length && diff < 0, `P4e 損益 page turn after a pane frame: band frames identical${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
    ok(a.some(f => f.includes('"view":"pnl"')), 'P4e positive control: the band is on 損益 and turns its page')
  } finally {
    delete cfg.holdings
    delete cfg.holdingsSource
    BAND_ROWS = 20
  }
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
  // the band's width counts even on a frame it skips (hasSurvey), and a pane frame counts as well
  const { rig, run } = await boot(`${fixtureDir}/p7-band-skip`)
  await drawBand(run, { viewport: 200, props: { hasSurvey: true } })
  await press(await drawPane(run, { viewport: null }), l => l.startsWith('寬度'))
  ok(rig.calls.open.at(-1)?.columns === 120, `P7 band frame at 200 skipped by hasSurvey still sets the width: 寬 at 120 (${rig.calls.open.at(-1)?.columns})`)
  const pane = await boot(`${fixtureDir}/p7-pane-only`)
  await press(await drawPane(pane.run, { viewport: 200 }), l => l.startsWith('寬度'))
  ok(pane.rig.calls.open.at(-1)?.columns === 120, `P7 a pane frame at 200 sets the width: 寬 at 120 (${pane.rig.calls.open.at(-1)?.columns})`)
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
  // every bar with volume lights its bottom pixel, so the panel's last row is never blank
  ok(/[█▀▄]/.test(tall44[44 - 2] ?? ''), `P10 44 rows with tallVolume: the volume bars reach the panel's bottom row (${JSON.stringify((tall44[44 - 2] ?? '').trim().slice(0, 30))})`)
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

// P12 (gate off, the env unset): the band behaves as base - 趨勢圖 and a row pick enter the band chart,
// no pane is opened, and the band's frames equal base's (base = the same register.tsx from git, $OUT/base-register.js)
/** the band's Client props after 趨勢圖, and after a row pick, for one register */
async function enterChart(dir, reg) {
  const trend = await boot(`${dir}-trend`, undefined, false, reg)
  await press(await drawBand(trend.run), '趨勢圖')
  const chart = await drawBand(trend.run)
  const pk = await boot(`${dir}-pick`, undefined, false, reg)
  await drawBand(pk.run)
  await pick(pk.run, 2)
  const picked = await drawBand(pk.run)
  return { chart, picked, opens: trend.rig.calls.open.length + pk.rig.calls.open.length, closes: trend.rig.calls.close.length + pk.rig.calls.close.length }
}
await scenario('P12', async () => {
  const off = await enterChart(`${fixtureDir}/p12`, regPath)
  const base = await enterChart(`${fixtureDir}/p12-base`, baseRegPath)
  ok(off.chart.client?.view === 'chart' && focusCode(off.chart.client ?? {}) === '1101', `P12 gate off: 趨勢圖 enters the band chart on the first row (${off.chart.client?.view})`)
  ok(off.chart.client?.view === 'chart' && !off.chart.btns.some(b => b.label === '開 pane'), 'P12 gate off: the band chart row has no 開 pane button')
  ok(off.picked.client?.view === 'chart' && focusCode(off.picked.client ?? {}) === '1103', `P12 gate off: a row pick enters the band chart on that row (${off.picked.client?.view})`)
  ok(off.opens === 0 && off.closes === 0, `P12 gate off: no $.ui.open / $.ui.close (${off.opens} open, ${off.closes} close)`)
  const same = JSON.stringify([off.chart.client, off.picked.client]) === JSON.stringify([base.chart.client, base.picked.client])
  ok(same, 'P12 gate off: 趨勢圖 and the row pick draw the band exactly as base')
  const plainBase = await sequence(`${fixtureDir}/p12-base-seq`, false, false, baseRegPath)
  const plain = await sequence(`${fixtureDir}/p12-plain`, false, false)
  const drawn = await sequence(`${fixtureDir}/p12-drawn`, true, false)
  const baseDiff = plainBase.frames.findIndex((f, i) => f !== plain.frames[i])
  ok(plain.frames.length === plainBase.frames.length && baseDiff < 0, `P12 gate off: band frames over the P4 sequence equal base${baseDiff < 0 ? '' : ` (first diff at frame ${baseDiff})`}`)
  const diff = plain.frames.findIndex((f, i) => f !== drawn.frames[i])
  ok(plain.frames.length === drawn.frames.length && diff < 0 && drawn.calls.open.length === 0, `P12 gate off: band frames identical with pane renders in between${diff < 0 ? '' : ` (first diff at frame ${diff})`}`)
  ok(drawn.paneDraws > 0, `P12 positive control: the pane drew during the gate-off sequence (${drawn.paneDraws} draws)`)
})

done()
