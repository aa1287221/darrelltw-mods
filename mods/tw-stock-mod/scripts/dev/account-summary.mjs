// 期貨庫存's account summary (#27, band half, paths 9-17): the 永豐 fetcher's
// `futures-account.json` adds two lines above the tf pnl table - margin/risk
// and realized P&L - plus a fills column, against the REAL register.tsx and
// board.tsx (bundled), an in-memory fs and a fixed clock (no fixture dir, no
// network, no spawn). Every amount here is synthetic.
//
//   9  absent / malformed / wrong-shape file -> the frame is byte-identical to
//      origin/main's (BASELINE below, captured with --capture from 58b982b,
//      whose hooks/ equal origin/main); other markets never change
//  10  the issue's sample renders line 1 and line 2 exactly
//  11  距追繳: long, short, mixed-to-zero exposure, equity <= maintenance
//  12  marginCall -> 追繳, and equity <= maintenance x 1.05 -> 風險: bold white on a
//      red fill; riskIndicator < 100 -> orange text
//  13  a null realized window -> —; wins/losses text
//  14  stale margin while open -> （資料 HH:MM）; closed -> no suffix
//  15  widths 40-120: no line wider than the band, fields dropped right to left
//  16  fills column only for >= 2 fills and enough width
//  17  the band's height is the same with and without the file
//
// Usage: node account-summary.mjs $OUT/register.js $OUT/board.js [--capture]
process.env.TZ = 'Asia/Taipei' // row 0 prints 更新 HH:MM; the baseline must not depend on the runner's zone
const { pathToFileURL } = await import('node:url')
const { createHash } = await import('node:crypto')
const { ok, done } = await import('./assert.mjs')

const [, , regPath, boardPath, mode] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

const taipei = (day, hh, mm, ss = 0) => Date.UTC(2026, 8, day, hh - 8, mm, ss)
const OPEN = taipei(17, 21, 0) // Thursday 21:00: 夜盤 open
const CLOSED = taipei(19, 12, 0) // Saturday noon: tf closed
const HOME = '/fake-home'
const RUNTIME = `${HOME}/.claude/stock-band/fake-project/`
const RED = '#e5534b' // board.tsx DOWN_RED: gains on the Taiwan boards
const GREEN = '#3fb950' // board.tsx UP_GREEN: losses on the Taiwan boards
const ORANGE = '#d97757' // board.tsx ORANGE: the band's one attention colour
const WHITE = '#f0f3f6'
const DIM = '#6e7681'
/** the danger state: bold white on a red fill, readable the same under either colour convention */
const isDanger = s => s?.color === WHITE && s?.bg === RED && s?.bold === true

const CONFIG = {
  market: 'us',
  feed: 'off',
  pageMs: 0,
  animation: 'off',
  refreshMs: 3000,
  tw: [{ code: '2330', name: '台積電', prevClose: 1000 }],
  us: [{ code: 'AAPL', name: 'Apple', prevClose: 300 }],
  futures: [],
}
// exposure = 5 x 10 + 1 x 50 = 100 index-point TWD: (600,000 - 385,000) / 100 = 2,150 points
const holdings = (tmf = 5, mxf = 1) => ({
  asOf: OPEN - 30_000,
  market: 'tf',
  source: '永豐 期貨',
  holdings: [
    { code: 'TMFJ6', name: '微型臺指期貨 202610', qty: tmf, cost: 23400, price: 23450, prevClose: 23380, multiplier: 10, direction: tmf < 0 ? 'Sell' : 'Buy' },
    { code: 'MXFJ6', name: '小型臺指期貨 202610', qty: mxf, cost: 23420, price: 23450, prevClose: 23380, multiplier: 50, direction: mxf < 0 ? 'Sell' : 'Buy' },
  ],
})
const MARGIN = {
  asOf: OPEN - 30_000, riskIndicator: 120, equity: 600000, availableMargin: 100000, initialMargin: 500000,
  maintenanceMargin: 385000, marginCall: 0, todayBalance: 590000, yesterdayBalance: 541000, depositWithdrawal: 0,
  openPnl: 10000, todayOpenPnl: 4000, settledPnl: 50000, fee: 800, tax: 100, plusMargin: 0, plusMarginIndicator: 0,
}
const win = (pnl, wins, losses, fee = 0, tax = 0) => ({ asOf: OPEN - 30_000, pnl, fee, tax, trades: wins + losses, wins, losses })
// a split fill repeats its dseq; one price the broker sent as 0 arrives as null
const FILLS = {
  TMFJ6: [
    { date: '2026-09-17', dseq: 'tA0x1', qty: 2, price: 23410, pnl: 800 },
    { date: '2026-09-17', dseq: 'tA0x1', qty: 1, price: 23520, pnl: -700 },
    { date: '2026-09-16', dseq: 'tA0x2', qty: 1, price: 23450, pnl: 0 },
    { date: '2026-09-16', dseq: 'tA0x3', qty: 1, price: 23480, pnl: -300 },
  ],
  MXFJ6: [{ date: '2026-09-16', dseq: 'tA0x4', qty: 1, price: 23420, pnl: 1500 }],
}
const account = (patch = {}) => ({
  asOf: OPEN - 30_000,
  source: '永豐',
  margin: patch.margin === null ? null : { ...MARGIN, ...patch.margin },
  fills: FILLS,
  realized: { today: win(50000, 3, 1, 800, 100), month: win(62500, 4, 2), year: win(-12300, 3, 4) },
  ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'margin')),
})

// --- stub host ---------------------------------------------------------------
let instance = 0
async function boot({ accountText, holdingsFile = holdings(), clock = OPEN } = {}) {
  instance += 1
  const url = pathToFileURL(regPath)
  url.search = `?case=${instance}`
  const { register } = await import(url.href)
  const files = {
    '.claude/stock-band.json': JSON.stringify(CONFIG),
    [`${RUNTIME}futures-holdings.json`]: JSON.stringify(holdingsFile),
    ...(accountText !== undefined ? { [`${RUNTIME}futures-account.json`]: accountText } : {}),
  }
  const $ = {
    clock: { now: async () => clock, every: () => {} },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => { files[path] = text },
    },
    env: { get: async name => (name === 'HOME' ? HOME : undefined) },
    session: { cwd: async () => '/fake-project' },
    process: { run: async () => { throw new Error('account-summary: no spawn expected') } },
    plugin: { root: '/fake-plugin-root' },
    ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
    http: { fetch: async () => { throw new Error('account-summary: no network expected') } },
  }
  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)
  /** one ui.render at `cols`; `maxRows` 0 is a stub host with none */
  const draw = async (cols = 120, maxRows = 0) => {
    const hostProps = maxRows > 0 ? { maxRows, bodyColumns: cols } : {}
    const tree = await handlers.get('ui.render')($, { props: hostProps, surface: 'terminal', viewport: { columns: cols } }, next)
    let props, client
    const btns = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (n.type === 'Client') { props = n.props.props; client = n.props }
      if (n.type === 'Button') btns.push({ key: n.props.key, label: n.props.label, press: n.props.onPress })
      for (const k of [...(n.kids ?? []), n.props?.children]) walk(k)
    }
    walk(tree)
    return { props, client, btns }
  }
  const landOn = async label => {
    const { btns } = await draw()
    btns.find(b => b.key?.startsWith('stock-band:tab:') && b.label.replace(/^\[|\]$/g, '') === label)?.press()
  }
  return { draw, landOn }
}

// --- the board, as colored spans ----------------------------------------------
const board = (await import(pathToFileURL(boardPath).href)).default
function render(props, cols) {
  let state
  let pointer
  const posts = []
  const surface = {
    columns: cols, rows: props.boardRows,
    elements: { Box: 'Box', Text: 'Text' },
    get state() { return state }, setState: s => { state = s },
    every: () => () => {}, onPointer: fn => { pointer = fn }, post: m => posts.push(m),
  }
  board(props, surface)
  const out = board(props, surface)
  const spans = (node, style, acc) => {
    if (node == null || node === false) return acc
    if (typeof node === 'string' || typeof node === 'number') { acc.push({ text: String(node), ...style }); return acc }
    if (Array.isArray(node)) { for (const n of node) spans(n, style, acc); return acc }
    const own = { color: node.props?.color ?? style.color, bg: node.props?.backgroundColor ?? style.bg, bold: node.props?.bold ?? style.bold }
    for (const k of [...(node.kids ?? []), ...(node.props?.children != null ? [node.props.children] : [])]) spans(k, own, acc)
    return acc
  }
  const rows = (out.kids ?? []).map(row => spans(row, {}, []))
  const click = (x, y) => { posts.length = 0; pointer?.({ type: 'down', button: 'left', x, y }); return posts[0] }
  return { out, rows, click }
}
const textOf = row => row.map(s => s.text).join('')
const lineOf = row => textOf(row).replace(/[\s ]+$/, '').replace(/^[\s ]/, '')
const styleOf = (row, needle) => row.find(s => s.text.includes(needle))
const charWidth = ch => {
  const cp = ch.codePointAt(0) ?? 0
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
  return wide ? 2 : 1
}
const dispWidth = s => Array.from(s).reduce((w, ch) => w + charWidth(ch), 0)
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16)

/** boots, lands on 期貨庫存, draws at cols/maxRows and renders the board */
async function frame(opts = {}, cols = 120, maxRows = 0) {
  const band = await boot(opts)
  await band.landOn('期貨庫存')
  const { props, client, btns } = await band.draw(cols, maxRows)
  const r = render(props, cols)
  return { props, client, btns, ...r, id: sha({ tree: r.out, height: client?.height }), band }
}
const show = (tag, f) => { console.log(`--- ${tag}`); for (const row of f.rows) console.log('|' + textOf(row) + '|') }

const SIZES = [[120, 0], [80, 0], [120, 10], [80, 7], [100, 20]]

// --- capture mode: print the baseline from a build of origin/main ------------
if (mode === '--capture') {
  const out = {}
  for (const [cols, maxRows] of SIZES) out[`${cols}x${maxRows}`] = (await frame({}, cols, maxRows)).id
  const tw = await boot({})
  await tw.landOn('台股')
  out.tw = sha(render((await tw.draw(120)).props, 120).out)
  await tw.landOn('台股庫存')
  out.twPnl = sha(render((await tw.draw(120)).props, 120).out)
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}

// captured with --capture against 58b982b's bundle (hooks/ == origin/main), TZ Asia/Taipei
const BASELINE = {
  '120x0': 'a57ae70b8ce8c6bd',
  '80x0': '92c321e397526a88',
  '120x10': 'a57ae70b8ce8c6bd',
  '80x7': 'e0e72eff9d53880d',
  '100x20': 'a57ae70b8ce8c6bd',
  tw: 'fc37c2a3d220223c',
  twPnl: 'b1a3d05125f82c60',
}

// --- row 9: no file, malformed, wrong shape -> main's frame -------------------
const SAMPLE = JSON.stringify(account())
const BAD = {
  'not JSON': '{"margin": ',
  'holdings-shaped': JSON.stringify(holdings()),
  'margin is a number': JSON.stringify({ ...account(), margin: 5 }),
  'equity is a string': JSON.stringify(account({ margin: { equity: '600000' } })),
  'realized missing': JSON.stringify({ ...account(), realized: undefined }),
  'a realized window is an array': JSON.stringify({ ...account(), realized: { today: [], month: null, year: null } }),
  'fills row without qty': JSON.stringify({ ...account(), fills: { TMFJ6: [{ price: 23400 }] } }),
  'root is an array': JSON.stringify([account()]),
  'realized without year': JSON.stringify({ ...account(), realized: { today: win(1, 1, 0), month: null } }),
  'no margin key': JSON.stringify({ ...account(), margin: undefined }),
}
for (const [cols, maxRows] of SIZES) {
  const f = await frame({}, cols, maxRows)
  ok(f.id === BASELINE[`${cols}x${maxRows}`], `9: no file, ${cols} cols / maxRows ${maxRows}: frame is main's (${f.id})`)
  ok(!('account' in f.props), `9: no file, ${cols}x${maxRows}: props carry no account key`)
}
for (const [why, text] of Object.entries(BAD)) {
  const f = await frame({ accountText: text })
  ok(f.id === BASELINE['120x0'], `9: ${why}: read as no file, frame is main's (${f.id})`)
}
const nulls = await frame({ accountText: JSON.stringify({ asOf: OPEN, source: '永豐', margin: null, fills: null, realized: { today: null, month: null, year: null } }) })
ok(nulls.id === BASELINE['120x0'], `9: every section null: nothing to show, frame is main's (${nulls.id})`)
{
  const tw = await boot({ accountText: SAMPLE })
  await tw.landOn('台股')
  const id = sha(render((await tw.draw(120)).props, 120).out)
  ok(id === BASELINE.tw, `9: another market (台股) with the file present is unchanged (${id})`)
  await tw.landOn('台股庫存')
  const pnl = sha(render((await tw.draw(120)).props, 120).out)
  ok(pnl === BASELINE.twPnl, `9: 台股庫存 (another market's pnl view) with the file present is unchanged (${pnl})`)
}

// --- row 10: the issue's sample ---------------------------------------------
const sample = await frame({ accountText: SAMPLE })
show('sample, 120 cols, stub host', sample)
const LINE1 = '風險 120% │ 權益 600,000 │ 可用 100,000 │ 距追繳 -2,150 點'
const LINE2 = '已實現 今日 +50,000 │ 本月 +62,500 │ 今年 -12,300（3勝4敗）│ 費稅 -900'
ok(lineOf(sample.rows[1]) === LINE1, `10: line 1 is "${LINE1}": "${lineOf(sample.rows[1])}"`)
ok(lineOf(sample.rows[2]) === LINE2, `10: line 2 is "${LINE2}": "${lineOf(sample.rows[2])}"`)
ok(textOf(sample.rows[0]).includes('期貨庫存損益') && textOf(sample.rows[3]).includes('口數'), '10: title stays row 0, the table header moves to row 3')
ok(styleOf(sample.rows[1], '120%')?.color === WHITE, `10: 風險 120% is the default colour: ${styleOf(sample.rows[1], '120%')?.color}`)
ok(styleOf(sample.rows[2], '+50,000')?.color === RED && styleOf(sample.rows[2], '+62,500')?.color === RED, '10: realized gains draw red (紅漲綠跌)')
ok(styleOf(sample.rows[2], '-12,300')?.color === GREEN && styleOf(sample.rows[2], '-900')?.color === GREEN, '10: the year loss and 費稅 draw green')
ok(sample.props.quoteRows === 3 && sample.props.boardRows === 8, `10: stub host: 3 holding rows + 2 summary lines + 3 chrome = 8: ${sample.props.quoteRows}/${sample.props.boardRows}`)

// --- row 11: 距追繳 --------------------------------------------------------------
const line1 = async (opts, cols = 120) => lineOf((await frame(opts, cols)).rows[1])
ok((await line1({ accountText: SAMPLE, holdingsFile: holdings(-5, -1) })).endsWith('距追繳 +2,150 點'), '11: net short: +2,150 點 (the adverse move is up)')
ok((await line1({ accountText: SAMPLE, holdingsFile: holdings(5, -1) })).endsWith('距追繳 —'), '11: long 5x10 + short 1x50 = exposure 0: 距追繳 —')
ok((await line1({ accountText: JSON.stringify(account({ margin: { maintenanceMargin: 0 } })) })).endsWith('距追繳 —'), '11: no maintenance margin: 距追繳 —')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 380000 } })) })).endsWith('距追繳 0'), '11: equity below maintenance: 距追繳 0')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 385000 } })) })).endsWith('距追繳 0'), '11: equity == maintenance: 距追繳 0')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 385100 } })) })).endsWith('距追繳 -1 點'), '11: 100 TWD over maintenance on exposure 100: -1 點')

// --- row 12: colours ------------------------------------------------------------
{
  const f = await frame({ accountText: JSON.stringify(account({ margin: { marginCall: 8000 } })), holdingsFile: holdings(5, -1) })
  const l = f.rows[1]
  ok(lineOf(l).endsWith('追繳 8,000') && !lineOf(l).includes('距追繳'), `12: marginCall 8,000 replaces 距追繳 (even at exposure 0): "${lineOf(l)}"`)
  const call = styleOf(l, '追繳 8,000')
  ok(isDanger(call), `12: 追繳 8,000 is bold white on a red background: ${JSON.stringify(call)}`)
  ok(isDanger(styleOf(l, '120%')), `12: 風險 is bold white on red under a margin call: ${JSON.stringify(styleOf(l, '120%'))}`)
  ok(!styleOf(l, '權益')?.bg && !styleOf(l, '600,000')?.bg, '12: only the danger cells are filled')
}
const riskStyle = async (margin, needle) => styleOf((await frame({ accountText: JSON.stringify(account({ margin })) })).rows[1], needle)
const plain = (s, colour) => s?.color === colour && !s?.bg && !s?.bold
ok(plain(await riskStyle({ riskIndicator: 99 }, '99%'), ORANGE), '12: riskIndicator 99 -> orange text, no fill')
ok(plain(await riskStyle({ riskIndicator: 100 }, '100%'), WHITE), '12: riskIndicator 100 -> default (the threshold is < 100)')
ok(isDanger(await riskStyle({ riskIndicator: 100, equity: 404250 }, '100%')), '12: equity == maintenance x 1.05 (404,250) -> danger fill')
ok(plain(await riskStyle({ riskIndicator: 100, equity: 404251 }, '100%'), WHITE), '12: equity 1 TWD above maintenance x 1.05 -> default')
ok(isDanger(await riskStyle({ riskIndicator: 99, equity: 404250 }, '99%')), '12: danger wins over the warning')

// --- row 13: null window, wins/losses ------------------------------------------------
{
  const f = await frame({ accountText: JSON.stringify(account({ realized: { today: win(50000, 3, 1, 800, 100), month: null, year: win(-12300, 3, 4) } })) })
  ok(lineOf(f.rows[2]) === '已實現 今日 +50,000 │ 本月 — │ 今年 -12,300（3勝4敗）│ 費稅 -900', `13: a null month shows —: "${lineOf(f.rows[2])}"`)
  const g = await frame({ accountText: JSON.stringify(account({ realized: { today: null, month: null, year: null } })) })
  ok(lineOf(g.rows[2]) === '已實現 今日 — │ 本月 — │ 今年 — │ 費稅 —', `13: every window null (margin present): "${lineOf(g.rows[2])}"`)
  const m = await frame({ accountText: JSON.stringify(account({ margin: null })) })
  ok(lineOf(m.rows[1]) === '風險 —' && lineOf(m.rows[2]) === LINE2, `13: margin null, realized present: "${lineOf(m.rows[1])}" / line 2 as usual`)
}

// --- row 14: age ------------------------------------------------------------------
{
  const stale = await frame({ accountText: JSON.stringify(account({ margin: { asOf: OPEN - 181_000 } })) })
  const l = stale.rows[1]
  ok(lineOf(l) === `${LINE1}（資料 20:56）`, `14: margin 181 s old while tf is open: dim suffix: "${lineOf(l)}"`)
  ok(styleOf(l, '（資料')?.color === DIM, '14: the suffix is dim')
  ok(!lineOf((await frame({ accountText: JSON.stringify(account({ margin: { asOf: OPEN - 180_000 } })) })).rows[1]).includes('資料'), '14: exactly 3 x 60 s old: no suffix')
  const closed = await frame({ accountText: JSON.stringify(account({ margin: { asOf: CLOSED - 8 * 3600_000 } })), clock: CLOSED })
  ok(closed.props.phase !== 'open' && lineOf(closed.rows[1]) === LINE1, `14: closed market (${closed.props.phase}): no suffix: "${lineOf(closed.rows[1])}"`)
}

// --- row 15: narrow widths ------------------------------------------------------------
const STALE = JSON.stringify(account({ margin: { asOf: OPEN - 600_000 } }))
const L1 = { risk: '風險 120%', eq: '權益 600,000', av: '可用 100,000', dist: '距追繳 -2,150 點' }
const L2 = { today: '已實現 今日 +50,000', month: '本月 +62,500', year: '今年 -12,300（3勝4敗）', fee: '費稅 -900' }
const WIDTHS = [
  [120, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [100, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [80, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [60, [L1.risk, L1.eq, L1.av, L1.dist], false, [L2.today, L2.month]],
  [50, [L1.risk, L1.eq, L1.dist], false, [L2.today, L2.month]],
  [40, [L1.risk, L1.dist], false, [L2.today, L2.month]],
  [30, [L1.risk, L1.dist], false, [L2.today]],
]
for (const [cols, want1, suffix, want2] of WIDTHS) {
  const f = await frame({ accountText: STALE }, cols)
  if (cols === 80) show('stale margin, 80 cols', f)
  const got1 = lineOf(f.rows[1])
  const exp1 = want1.join(' │ ') + (suffix ? '（資料 20:50）' : '')
  const exp2 = want2.join(' │ ').replace('） │', '）│')
  ok(got1 === exp1, `15: ${cols} cols line 1 "${exp1}": "${got1}"`)
  ok(lineOf(f.rows[2]) === exp2, `15: ${cols} cols line 2 "${exp2}": "${lineOf(f.rows[2])}"`)
  const widest = Math.max(dispWidth(textOf(f.rows[1])), dispWidth(textOf(f.rows[2])))
  ok(widest <= cols - 1, `15: ${cols} cols: the summary lines never wrap (widest ${widest})`)
  // at 60 the table itself already overflows on main (pnlLayout's own 60-column floor), so only 80 up
  if (cols >= 80) {
    const all = Math.max(...f.rows.map(r => dispWidth(textOf(r).replace(/ +$/, ''))))
    ok(all <= cols, `15: ${cols} cols: no row of the frame is wider than the band (${all})`)
  }
}
ok(lineOf((await frame({ accountText: JSON.stringify(account({ margin: { marginCall: 8000 } })) }, 30)).rows[1]) === '風險 120% │ 追繳 8,000', '15: the minimum under a margin call is 風險 + 追繳')

// --- row 16: fills column -------------------------------------------------------------
{
  const row = (f, code) => textOf(f.rows.find(r => textOf(r).includes(code)) ?? [])
  ok(row(sample, 'TMFJ6').includes('4筆 23,410–23,520'), `16: 4 fills at 120 cols: "${row(sample, 'TMFJ6').trim()}"`)
  ok(!row(sample, 'MXFJ6').includes('筆'), '16: 1 fill: no column')
  // 損益% ends at column 96; the column starts at 98 and is 17 wide, so it needs 98 + 17 <= cols - 1
  const at116 = await frame({ accountText: SAMPLE }, 116)
  const at115 = await frame({ accountText: SAMPLE }, 115)
  ok(row(at116, 'TMFJ6').includes('4筆 23,410–23,520'), '16: 116 cols still fits it')
  ok(!row(at115, 'TMFJ6').includes('筆'), '16: 115 cols does not')
  ok(!row(await frame({ accountText: SAMPLE }, 80), 'TMFJ6').includes('筆'), '16: 80 cols: no column')
  const nullPrice = { ...FILLS, TMFJ6: [...FILLS.TMFJ6, { date: '2026-09-17', dseq: 'tA0x9', qty: 0, price: null, pnl: 0 }] }
  const n = await frame({ accountText: JSON.stringify(account({ fills: nullPrice })) })
  ok(row(n, 'TMFJ6').includes('5筆 23,410–23,520'), `16: a null price counts as a fill but not in the range: "${row(n, 'TMFJ6').trim()}"`)
  const both = await frame({ accountText: JSON.stringify({ ...account(), margin: null, realized: { today: null, month: null, year: null } }) })
  ok(row(both, 'TMFJ6').includes('4筆') && both.props.quoteRows === 5, '16: fills alone draw the column but no summary lines')
}

// --- row 17: the band's height --------------------------------------------------------
for (const maxRows of [0, 5, 6, 7, 8, 10, 20]) {
  const without = await frame({}, 120, maxRows)
  const withFile = await frame({ accountText: SAMPLE }, 120, maxRows)
  const h0 = without.client?.height, h1 = withFile.client?.height
  ok(h0 === h1 && without.rows.length === withFile.rows.length, `17: maxRows ${maxRows}: height ${h1} with the file == ${h0} without (drawn ${withFile.rows.length}/${without.rows.length})`)
}
{
  const f = await frame({ accountText: SAMPLE }, 120, 7)
  ok(f.props.quoteRows === 1 && lineOf(f.rows[1]).startsWith('風險'), `17: maxRows 7: 1 holding row under the two lines (${f.props.quoteRows})`)
  ok(f.btns.some(b => b.label === '翻頁 1/2'), `17: paging counts the rows left: ${f.btns.map(b => b.label).join('  ')}`)
  const g = await frame({ accountText: SAMPLE }, 120, 6)
  ok(g.props.quoteRows === 2 && !lineOf(g.rows[1]).startsWith('風險'), '17: maxRows 6: no room for the lines, the table keeps its 2 rows')
  // the header row moved down: a click on it still sorts
  const head = textOf(sample.rows[3])
  const x = dispWidth(head.slice(0, head.indexOf('今日%'))) + 1
  ok(sample.click(x, 3)?.sortPnl === 'today', `17: a click on the header (row 3) sorts: ${JSON.stringify(sample.click(x, 3))}`)
  ok(sample.click(x, 1) === undefined, '17: a click on the summary line does not')
}

done()
