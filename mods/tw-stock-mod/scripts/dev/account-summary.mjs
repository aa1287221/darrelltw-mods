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
//  11  距追繳: always the TWD cushion (equity - maintenance): long, short, hedged, equity <= maintenance
//  12  marginCall -> 追繳, and equity <= maintenance x 1.05 -> 風險: bold white on a
//      red fill; riskIndicator < 100 -> orange text
//  13  a null realized window -> —; wins/losses text
//  14  stale margin while open -> （資料 HH:MM）; closed -> no suffix
//  15  widths 40-120: no line wider than the band, fields dropped right to left
//  16  fills column only for >= 2 fills and enough width
//  17  the band's height is the same with and without the file
//  18  a file without margin.ref (or a null / malformed one) next to moved quotes
//      renders exactly as b206dfe did (noRef* in BASELINE)
//  19  live estimate from margin.ref x multiplier x (live - ref price): long,
//      short, mixed; 風險/權益/可用/距追繳 carry ≈
//  20  a quote not newer than margin.asOf (dataAt, else asOf) -> broker figures
//  21  a ref code without a live price or a holdings multiplier -> no estimate at all
//  22  closed market -> broker figures, even with the closing quotes held
//  23  danger/warning colours follow the live equity
//  24  delta 0 -> no ≈, broker figures
//  25  narrow widths with the estimate: no wrap, 風險 + 距追繳 kept
//  26  a quotes rewrite between account writes re-renders the estimate
//  27-34  fills column: adaptive decimals, one price when min == max, the 建倉明細 header
//         (present iff the column, aligned with it, not a sort target)
//  35-52  追繳價 / 強平價 per row: cushion over the row's underlying group only, the
//         live estimate when it applies, conservative rounding, adaptive decimals,
//         追繳中 / 強平 danger, orange within 2%, header iff column, drop order
//         建倉明細 -> 強平價 -> 追繳價, clicks unchanged; line 1's 距追繳 is always the 元
//         cushion, whatever the book; shioaji.liquidationRiskPct is user-level only
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
// cushion = equity 600,000 - maintenance 385,000 = 215,000 TWD
const holdings = (tmf = 5, mxf = 1) => ({
  asOf: OPEN - 30_000,
  market: 'tf',
  source: '永豐 期貨',
  holdings: [
    { code: 'TMFJ6', name: '微型臺指期貨 202610', qty: tmf, cost: 23400, price: 23450, prevClose: 23380, multiplier: 10, direction: tmf < 0 ? 'Sell' : 'Buy', underlying: 'IX0001' },
    { code: 'MXFJ6', name: '小型臺指期貨 202610', qty: mxf, cost: 23420, price: 23450, prevClose: 23380, multiplier: 50, direction: mxf < 0 ? 'Sell' : 'Buy', underlying: 'IX0001' },
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

// futures-quotes.json the fetcher would write: both held contracts, traded after the margin's asOf
const liveQuotes = (tmf = 23500, mxf = 23500, { asOf = OPEN - 5_000, dataAt = OPEN - 6_000, drop = [] } = {}) => ({
  asOf,
  ...(dataAt !== null ? { dataAt } : {}), // null: a file that leaves dataAt out
  market: 'tf',
  source: '永豐',
  quotes: Object.fromEntries(
    [
      ['TMFJ6', { price: tmf, prevClose: 23380, name: '微型臺指期貨 202610', multiplier: 10, decimals: 0 }],
      ['MXFJ6', { price: mxf, prevClose: 23380, name: '小型臺指期貨 202610', multiplier: 50, decimals: 0 }],
    ].filter(([code]) => !drop.includes(code)),
  ),
})

// --- stub host ---------------------------------------------------------------
let instance = 0
async function boot({ accountText, holdingsFile = holdings(), clock = OPEN, quotes, userConfig, projectExtra } = {}) {
  instance += 1
  const url = pathToFileURL(regPath)
  url.search = `?case=${instance}`
  const { register } = await import(url.href)
  const files = {
    '.claude/stock-band.json': JSON.stringify({ ...CONFIG, ...projectExtra }),
    ...(userConfig !== undefined ? { [`${HOME}/.claude/stock-band.json`]: JSON.stringify(userConfig) } : {}),
    [`${RUNTIME}futures-holdings.json`]: JSON.stringify(holdingsFile),
    ...(accountText !== undefined ? { [`${RUNTIME}futures-account.json`]: accountText } : {}),
    ...(quotes !== undefined ? { [`${RUNTIME}futures-quotes.json`]: JSON.stringify(quotes) } : {}),
  }
  const timers = []
  const logs = []
  const $ = {
    clock: { now: async () => clock, every: (_ms, fn) => timers.push(fn) },
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
    ui: { log: m => logs.push(String(m)), invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }) },
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
  /** rewrites runtime files (name -> object) and runs the poll timer, the way a refresh tick would */
  const repoll = async (changed = {}) => {
    for (const [name, data] of Object.entries(changed)) files[`${RUNTIME}${name}`] = JSON.stringify(data)
    for (const fn of timers) fn()
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
  }
  return { draw, landOn, repoll, logs }
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
  // an account file without margin.ref, next to quotes that moved since the margin was read
  for (const cols of [120, 60]) out[`noRef${cols}`] = (await frame({ accountText: JSON.stringify(account()), quotes: liveQuotes() }, cols)).id
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
  // captured with --capture against b206dfe's bundle: an account file without margin.ref next to moved quotes
  // noRef120 was 4d2e8d3099a28860 until the fills column got its 建倉明細 header (the sample carries fills): that is the only row that differs
  // then 581a5a67efc9232f until 追繳價/強平價 (rows 35-52): the sample carries a margin, so at 120 cols the two
  // columns take cols 98-111 and 建倉明細 drops out; every cell left of col 97 is unchanged (diffed against 887ae0b)
  // both noRef hashes re-captured when 距追繳 became the 元 cushion (the line-1 text is in the frame)
  noRef120: '77d77a97363b1196',
  noRef60: '576404aaa78261e9',
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
const LINE1 = '風險 120% │ 權益 600,000 │ 可用 100,000 │ 距追繳 215,000 元'
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
ok((await line1({ accountText: SAMPLE, holdingsFile: holdings(-5, -1) })).endsWith('距追繳 215,000 元'), '11: net short: the same 215,000 元 cushion')
ok((await line1({ accountText: SAMPLE, holdingsFile: holdings(5, -1) })).endsWith('距追繳 215,000 元'), '11: long 5x10 + short 1x50 = exposure 0: still 215,000 元')
ok((await line1({ accountText: JSON.stringify(account({ margin: { maintenanceMargin: 0 } })) })).endsWith('距追繳 —'), '11: no maintenance margin: 距追繳 —')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 380000 } })) })).endsWith('距追繳 0 元'), '11: equity below maintenance: 距追繳 0 元')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 385000 } })) })).endsWith('距追繳 0 元'), '11: equity == maintenance: 距追繳 0 元')
ok((await line1({ accountText: JSON.stringify(account({ margin: { equity: 385100 } })) })).endsWith('距追繳 100 元'), '11: 100 TWD over maintenance: 100 元')

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
const L1 = { risk: '風險 120%', eq: '權益 600,000', av: '可用 100,000', dist: '距追繳 215,000 元', distC: '距追繳 215,000' }
const L2 = { today: '已實現 今日 +50,000', month: '本月 +62,500', year: '今年 -12,300（3勝4敗）', fee: '費稅 -900' }
const WIDTHS = [
  [120, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [100, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [80, [L1.risk, L1.eq, L1.av, L1.dist], true, [L2.today, L2.month, L2.year, L2.fee]],
  [60, [L1.risk, L1.eq, L1.dist], false, [L2.today, L2.month]],
  [50, [L1.risk, L1.eq, L1.dist], false, [L2.today, L2.month]],
  [40, [L1.risk, L1.dist], false, [L2.today, L2.month]],
  [30, [L1.risk, L1.distC], false, [L2.today]],
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
// margin null: no 追繳價/強平價 (rows 35-52), so the fills column keeps its own geometry at 98
const NO_MARGIN = JSON.stringify(account({ margin: null }))
const plainFills = await frame({ accountText: NO_MARGIN })
{
  const row = (f, code) => textOf(f.rows.find(r => textOf(r).includes(code)) ?? [])
  ok(row(plainFills, 'TMFJ6').includes('4筆 23,410–23,520'), `16: 4 fills at 120 cols: "${row(plainFills, 'TMFJ6').trim()}"`)
  ok(!row(plainFills, 'MXFJ6').includes('筆'), '16: 1 fill: no column')
  // 損益% ends at column 96; the column starts at 98 and is 17 wide, so it needs 98 + 17 <= cols - 1
  const at116 = await frame({ accountText: NO_MARGIN }, 116)
  const at115 = await frame({ accountText: NO_MARGIN }, 115)
  ok(row(at116, 'TMFJ6').includes('4筆 23,410–23,520'), '16: 116 cols still fits it')
  ok(!row(at115, 'TMFJ6').includes('筆'), '16: 115 cols does not')
  ok(!row(await frame({ accountText: NO_MARGIN }, 80), 'TMFJ6').includes('筆'), '16: 80 cols: no column')
  const nullPrice = { ...FILLS, TMFJ6: [...FILLS.TMFJ6, { date: '2026-09-17', dseq: 'tA0x9', qty: 0, price: null, pnl: 0 }] }
  const n = await frame({ accountText: JSON.stringify(account({ margin: null, fills: nullPrice })) })
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

// --- live estimate (rows 18-26) ------------------------------------------------------
const REF_LONG = { TMFJ6: { qty: 5, price: 23450 }, MXFJ6: { qty: 1, price: 23450 } }
const withRef = (ref, margin = {}) => JSON.stringify(account({ margin: { ...margin, ref } }))
const priceCell = (f, code) => textOf(f.rows.find(r => textOf(r).includes(code)) ?? [])
// the quotes are applied to the table in every row below that says "positive control"
const quoted = (f, price) => priceCell(f, 'TMFJ6').includes(price)

// --- row 18: no ref -> b206dfe's frame ---------------------------------------------------
{
  const f120 = await frame({ accountText: SAMPLE, quotes: liveQuotes() }, 120)
  ok(f120.id === BASELINE.noRef120, `18: no ref, moved quotes, 120 cols: frame is b206dfe's (${f120.id})`)
  ok(quoted(f120, '23,500'), '18: positive control: the table prices TMFJ6 at the moved quote 23,500')
  const f60 = await frame({ accountText: SAMPLE, quotes: liveQuotes() }, 60)
  ok(f60.id === BASELINE.noRef60, `18: no ref, moved quotes, 60 cols: frame is b206dfe's (${f60.id})`)
  const MALFORMED = {
    'ref null': null,
    'ref is a number': 5,
    'ref is an array': [REF_LONG.TMFJ6],
    'ref qty is a string': { TMFJ6: { qty: '5', price: 23450 } },
    'ref without price': { TMFJ6: { qty: 5 } },
    'ref price NaN-ish null': { TMFJ6: { qty: 5, price: null } },
  }
  for (const [why, ref] of Object.entries(MALFORMED)) {
    const f = await frame({ accountText: withRef(ref), quotes: liveQuotes() })
    ok(f.id === BASELINE.noRef120 && lineOf(f.rows[1]) === LINE1, `18: ${why}: file still read, no estimate, b206dfe's frame (${f.id})`)
  }
}

// --- row 19: the math ------------------------------------------------------------------
const LIVE_LONG = '風險 ≈121% │ 權益 ≈605,000 │ 可用 ≈105,000 │ 距追繳 ≈220,000 元'
{
  // +50 points: 5 x 10 x 50 + 1 x 50 x 50 = +5,000
  const f = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes() })
  show('live estimate, long, 120 cols', f)
  ok(lineOf(f.rows[1]) === LIVE_LONG, `19: long +5,000: "${lineOf(f.rows[1])}"`)
  ok(lineOf(f.rows[2]) === LINE2, '19: line 2 is not estimated')
  // short -5 / -1 at the same move: -5,000, so the cushion is 210,000 元
  const s = await frame({ accountText: withRef({ TMFJ6: { qty: -5, price: 23450 }, MXFJ6: { qty: -1, price: 23450 } }), holdingsFile: holdings(-5, -1), quotes: liveQuotes() })
  const SHORT = '風險 ≈119% │ 權益 ≈595,000 │ 可用 ≈95,000 │ 距追繳 ≈210,000 元'
  ok(lineOf(s.rows[1]) === SHORT, `19: short -5,000: "${lineOf(s.rows[1])}"`)
  // mixed: +5 TMF at +50 (+2,500), -1 MXF at +30 (-1,500) = +1,000; exposure 0 no longer blanks 距追繳: 216,000 元
  const m = await frame({ accountText: withRef({ TMFJ6: { qty: 5, price: 23450 }, MXFJ6: { qty: -1, price: 23450 } }), holdingsFile: holdings(5, -1), quotes: liveQuotes(23500, 23480) })
  const MIXED = '風險 ≈120% │ 權益 ≈601,000 │ 可用 ≈101,000 │ 距追繳 ≈216,000 元'
  ok(lineOf(m.rows[1]) === MIXED, `19: mixed +1,000: "${lineOf(m.rows[1])}"`)
  ok(styleOf(f.rows[1], '≈121%')?.color === WHITE, '19: the estimated risk keeps the default colour above 100')
}

// --- row 20: stale quote ---------------------------------------------------------------
{
  const older = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23500, 23500, { dataAt: MARGIN.asOf - 1_000 }) })
  ok(lineOf(older.rows[1]) === LINE1, `20: quotes traded before the margin read: broker figures: "${lineOf(older.rows[1])}"`)
  ok(quoted(older, '23,500'), '20: positive control: those quotes still price the table')
  const same = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23500, 23500, { dataAt: MARGIN.asOf }) })
  ok(lineOf(same.rows[1]) === LINE1, `20: dataAt == margin.asOf is not newer: "${lineOf(same.rows[1])}"`)
  const noDataOld = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23500, 23500, { asOf: MARGIN.asOf - 5_000, dataAt: null }) })
  ok(lineOf(noDataOld.rows[1]) === LINE1, `20: no dataAt, asOf older than the margin: "${lineOf(noDataOld.rows[1])}"`)
  const noDataNew = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23500, 23500, { dataAt: null }) })
  ok(lineOf(noDataNew.rows[1]) === LIVE_LONG, `20: no dataAt, asOf newer: estimated: "${lineOf(noDataNew.rows[1])}"`)
}

// --- row 21: missing price / multiplier ------------------------------------------------------
{
  const noPrice = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23500, 23500, { drop: ['MXFJ6'] }) })
  ok(lineOf(noPrice.rows[1]) === LINE1, `21: MXFJ6 has no live quote: no estimate at all (not TMFJ6 alone): "${lineOf(noPrice.rows[1])}"`)
  ok(quoted(noPrice, '23,500'), '21: positive control: TMFJ6 itself is quoted')
  const h = holdings()
  delete h.holdings[1].multiplier
  const noMult = await frame({ accountText: withRef(REF_LONG), holdingsFile: h, quotes: liveQuotes() })
  ok(lineOf(noMult.rows[1]).startsWith('風險 120% │ 權益 600,000') && !lineOf(noMult.rows[1]).includes('≈'), `21: MXFJ6 holdings row has no multiplier: broker figures: "${lineOf(noMult.rows[1])}"`)
  const noIm = JSON.parse(withRef(REF_LONG))
  delete noIm.margin.initialMargin
  const noInitial = await frame({ accountText: JSON.stringify(noIm), quotes: liveQuotes() })
  ok(lineOf(noInitial.rows[1]) === LINE1, `21: margin without initialMargin: file read, broker figures: "${lineOf(noInitial.rows[1])}"`)
  const notHeld = await frame({ accountText: withRef({ ...REF_LONG, TXFJ6: { qty: 1, price: 17000 } }), quotes: liveQuotes() })
  ok(lineOf(notHeld.rows[1]) === LINE1, `21: a ref code with no holdings row and no quote: broker figures: "${lineOf(notHeld.rows[1])}"`)
}

// --- row 22: closed --------------------------------------------------------------------
{
  const CLOSE_AT = taipei(19, 5, 0) // 夜盤 closes Saturday 05:00
  const closed = await frame({
    accountText: withRef(REF_LONG, { asOf: CLOSE_AT - 60_000 }),
    quotes: liveQuotes(23500, 23500, { asOf: CLOSE_AT - 10_000, dataAt: CLOSE_AT - 20_000 }),
    clock: CLOSED,
  })
  ok(closed.props.phase !== 'open', `22: the market is closed (${closed.props.phase})`)
  ok(quoted(closed, '23,500'), '22: positive control: the closing quotes still price the table')
  ok(lineOf(closed.rows[1]) === LINE1, `22: closed: broker figures, no ≈: "${lineOf(closed.rows[1])}"`)
}

// --- row 23: colours on the live equity -----------------------------------------------------
{
  const ONE = { TMFJ6: { qty: 1, price: 23450 } }
  // broker 404,300 is above 404,250 (maintenance x 1.05); -10 points x 10 = -100 -> 404,200
  const broker = await frame({ accountText: JSON.stringify(account({ margin: { equity: 404300, riskIndicator: 100 } })), quotes: liveQuotes(23440) })
  ok(plain(styleOf(broker.rows[1], '100%'), WHITE), '23: without ref the broker equity 404,300 is not in danger')
  const live = await frame({ accountText: withRef(ONE, { equity: 404300, riskIndicator: 100 }), quotes: liveQuotes(23440) })
  ok(lineOf(live.rows[1]).startsWith('風險 ≈80% │ 權益 ≈404,200'), `23: estimate 404,200: "${lineOf(live.rows[1])}"`)
  ok(isDanger(styleOf(live.rows[1], '≈80%')), `23: live equity <= maintenance x 1.05: danger fill: ${JSON.stringify(styleOf(live.rows[1], '≈80%'))}`)
  // broker 500,100 / riskIndicator 100 is white; -20 x 10 -> 499,900 -> risk 99 -> orange
  const warn = await frame({ accountText: withRef(ONE, { equity: 500100, riskIndicator: 100 }), quotes: liveQuotes(23430) })
  ok(plain(styleOf(warn.rows[1], '≈99%'), ORANGE), `23: live risk 99 -> orange: "${lineOf(warn.rows[1])}"`)
}

// --- row 24: delta 0 ------------------------------------------------------------------
{
  const f = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes(23450, 23450) })
  ok(lineOf(f.rows[1]) === LINE1, `24: quotes at the ref prices: no ≈: "${lineOf(f.rows[1])}"`)
  ok(quoted(f, '23,450'), '24: positive control: quoted at 23,450')
}

// --- row 25: narrow widths -------------------------------------------------------------
for (const cols of [120, 100, 80, 60, 50, 40, 30]) {
  const f = await frame({ accountText: withRef(REF_LONG), quotes: liveQuotes() }, cols)
  const l1 = lineOf(f.rows[1])
  const widest = Math.max(dispWidth(textOf(f.rows[1])), dispWidth(textOf(f.rows[2])))
  ok(widest <= cols - 1, `25: ${cols} cols with the estimate: no wrap (widest ${widest}): "${l1}"`)
  ok(l1.startsWith('風險 ≈121%') && /距追繳 ≈220,000( 元)?$/.test(l1), `25: ${cols} cols keeps 風險 and 距追繳: "${l1}"`)
  const optional = l1.split(' │ ').slice(1, -1).map(x => x.split(' ')[0])
  ok(['權益', '可用'].slice(0, optional.length).join() === optional.join(), `25: ${cols} cols drops right to left: ${optional.join(',') || '(none)'}`)
}

// --- row 26: re-render between account writes -----------------------------------------------
{
  const band = await boot({ accountText: withRef(REF_LONG), quotes: liveQuotes() })
  await band.landOn('期貨庫存')
  const first = lineOf(render((await band.draw(120)).props, 120).rows[1])
  await band.repoll({ 'futures-quotes.json': liveQuotes(23520, 23500, { asOf: OPEN - 2_000, dataAt: OPEN - 3_000 }) })
  const second = lineOf(render((await band.draw(120)).props, 120).rows[1])
  ok(first.includes('權益 ≈605,000'), `26: first quotes: 權益 ≈605,000: "${first}"`)
  // TMFJ6 +70 (3,500) + MXFJ6 +50 (2,500) = +6,000, same account file
  ok(second.includes('權益 ≈606,000'), `26: rewritten quotes, same account file: 權益 ≈606,000: "${second}"`)
}

// --- rows 27-34: fills column format and header (synthetic prices) --------------------------
{
  const fx = prices => prices.map((price, i) => ({ date: '2026-09-17', dseq: `tB0x${i}`, qty: 1, price, pnl: 0 }))
  const fillsFrame = async (tmf, cols = 120) =>
    frame({ accountText: JSON.stringify(account({ margin: null, fills: { TMFJ6: fx(tmf), MXFJ6: FILLS.MXFJ6 } })) }, cols)
  const rowOf = (f, code) => textOf(f.rows.find(r => textOf(r).includes(code)) ?? [])
  const headOf = f => f.rows.find(r => textOf(r).includes('代號')) ?? []
  const hasHead = f => textOf(headOf(f)).includes('建倉明細')
  const CASES = [
    ['27 whole', [23883, 24140, 23900], '3筆 23,883–24,140'],
    ['27 whole, two fills', [23883, 24140], '2筆 23,883–24,140'],
    ['27 tenths', [107.5, 108], '2筆 107.5–108.0'],
    ['27 hundredths', [106.25, 107], '2筆 106.25–107.00'],
    ['27 hundredths in the middle only', [106, 107.25, 108], '3筆 106.00–108.00'],
    ['28 float noise is 2 decimals', [106.2500000001, 107], '2筆 106.25–107.00'],
    ['28 float noise that rounds to whole', [106.0000000001, 107], '2筆 106–107'],
    ['28 cap at 2: 3rd decimal rounds', [106.256, 107], '2筆 106.26–107.00'],
    ['28 rounds to whole', [106.004, 107], '2筆 106–107'],
    ['29 one distinct price', [23450, 23450, 23450, 23450], '4筆 23,450'],
    ['29 one distinct price, tenths', [23450.5, 23450.5], '2筆 23,450.5'],
    ['29 one distinct price after rounding', [106.25, 106.2500000001], '2筆 106.25'],
    ['30 a null price is skipped', [107.5, null, 108], '3筆 107.5–108.0'],
    ['30 all prices null', [null, null], '2筆'],
  ]
  for (const [why, prices, want] of CASES) {
    const line = rowOf(await fillsFrame(prices), 'TMFJ6').trimEnd()
    ok(line.endsWith(' ' + want), `${why}: "${line.slice(line.indexOf('TMFJ6') + 90).trim()}" ends with "${want}"`)
  }

  // header: present iff the column is
  ok(hasHead(plainFills), `31: header with the column: "${textOf(headOf(plainFills)).trim()}"`)
  for (const cols of [116, 120, 140]) ok(hasHead(await fillsFrame([23410, 23520], cols)), `31: ${cols} cols: header`)
  for (const cols of [115, 100, 80]) {
    const f = await fillsFrame([23410, 23520], cols)
    ok(!hasHead(f) && !rowOf(f, 'TMFJ6').includes('筆'), `31: ${cols} cols: no column, no header`)
  }
  ok(!hasHead(await fillsFrame([23410])), '31: no row with >= 2 fills: no header')
  ok(!hasHead(await frame({ accountText: JSON.stringify(account({ margin: null, fills: {} })) })), '31: empty fills: no header')
  ok(!hasHead(await frame({ accountText: JSON.stringify(account({ margin: null, fills: null })) })), '31: fills null: no header')
  ok(hasHead(await fillsFrame([null, null])), '31: an all-null-price column still has its header')

  // alignment: the cells' left edge, the other headers' style
  {
    const col = (row, needle) => dispWidth(textOf(row).slice(0, textOf(row).indexOf(needle)))
    const head = headOf(plainFills)
    const tmf = plainFills.rows.find(r => textOf(r).includes('TMFJ6'))
    ok(col(head, '建倉明細') === col(tmf, '4筆'), `32: header left edge ${col(head, '建倉明細')} = cell left edge ${col(tmf, '4筆')}`)
    ok(col(head, '建倉明細') === 98, '32: at column 98, right of 損益% (ends at 96)')
    ok(styleOf(head, '建倉明細')?.color === styleOf(head, '代號')?.color && styleOf(head, '建倉明細')?.bold === styleOf(head, '代號')?.bold, '32: styled like the other headers')
  }

  // width = max(header 8, widest cell): `2筆 1–2` is 7 wide
  {
    const at107 = await fillsFrame([1, 2], 107)
    const at106 = await fillsFrame([1, 2], 106)
    ok(rowOf(at107, 'TMFJ6').includes('2筆 1–2') && hasHead(at107), '33: 107 cols: 98 + 8 fits, cell and header')
    ok(!rowOf(at106, 'TMFJ6').includes('筆') && !hasHead(at106), '33: 106 cols: the header does not fit, so neither does the column')
    ok(hasHead(await fillsFrame([23410, 23520], 116)) && !hasHead(await fillsFrame([23410, 23520], 115)), '33: a wider cell (17) decides the edge')
  }

  // clicks: the header is not sortable, the others keep their targets
  {
    const at = (f, needle) => { const t = textOf(headOf(f)); return dispWidth(t.slice(0, t.indexOf(needle))) + 1 }
    const noFills = await frame({ accountText: JSON.stringify(account({ margin: null, fills: {} })) })
    const hy = plainFills.rows.findIndex(r => textOf(r).includes('代號'))
    const want = { 代號: 'code', '今日%': 'today', 今日損益: 'todayPnl', 總損益: 'totalPnl', '損益%': 'totalPnlPct' }
    for (const [label, key] of Object.entries(want)) {
      ok(plainFills.click(at(plainFills, label), hy)?.sortPnl === key, `34: with the column, a click on ${label} sorts ${key}`)
      ok(noFills.click(at(noFills, label), hy)?.sortPnl === key, `34: without the column, a click on ${label} sorts ${key}`)
      ok(at(plainFills, label) === at(noFills, label), `34: ${label} keeps its position (${at(plainFills, label)})`)
    }
    const x0 = at(plainFills, '建倉明細')
    for (let x = x0; x < x0 + 8; x++) ok(plainFills.click(x, hy) === undefined, `34: a click at x=${x} on 建倉明細 does nothing`)
  }
}

// --- rows 35-52: 追繳價 / 強平價 (synthetic book: equity 600,000, maintenance 385,000, initial 500,000) ------
const leg = (code, name, qty, price, multiplier, underlying) =>
  ({ code, name, qty, cost: price, price, prevClose: price, multiplier, direction: qty < 0 ? 'Sell' : 'Buy', ...(underlying !== null ? { underlying } : {}) })
const TMF = (qty, price = 23450, u = 'IX0001') => leg('TMFJ6', '微型臺指期貨 202610', qty, price, 10, u)
const MXF = (qty, price = 23450, u = 'IX0001') => leg('MXFJ6', '小型臺指期貨 202610', qty, price, 50, u)
const SRF = (qty, price = 106.25, u = '0050') => leg('SRFJ6', '小型元大台灣50ETF期貨 202610', qty, price, 1000, u)
const book = (...legs) => ({ asOf: OPEN - 30_000, market: 'tf', source: '永豐 期貨', holdings: legs })
const acct = margin => JSON.stringify(account({ margin }))
const CALL = '追繳價'
const LIQ = '強平價'
const headRow = f => f.rows.find(r => textOf(r).includes('代號')) ?? []
const headCol = (f, label) => { const t = textOf(headRow(f)); const i = t.indexOf(label); return i < 0 ? -1 : dispWidth(t.slice(0, i)) }
/** the token whose last display cell is right - 1, and its span style */
function cellEnding(row, right) {
  const cells = []
  let col = 0
  for (const ch of Array.from(textOf(row))) { cells.push({ ch, col }); col += charWidth(ch) }
  const end = cells.findIndex(c => c.col + charWidth(c.ch) === right)
  if (end < 0) return { text: '' }
  let i = end
  while (i >= 0 && !/[\s ]/.test(cells[i].ch)) i--
  const text = cells.slice(i + 1, end + 1).map(c => c.ch).join('')
  return { text, style: text ? row.find(s => s.text.includes(text)) : undefined }
}
/** the cell under a right-aligned header in `code`'s row; undefined when the header is absent */
const cell = (f, code, label) => {
  const c = headCol(f, label)
  if (c < 0) return undefined
  const row = f.rows.find(r => textOf(r).includes(code))
  return row ? cellEnding(row, c + dispWidth(label)) : undefined
}
const val = (f, code, label) => cell(f, code, label)?.text
const both = async (opts, cols = 120) => frame(opts, cols)

// --- row 35: long: ΔP = -(600,000 - 385,000) / (5 x 10 + 1 x 50) = -2,150; 強平 -(600,000 - 25% x 500,000) / 100 = -4,750
{
  const f = sample
  ok(val(f, 'TMFJ6', CALL) === '21,300' && val(f, 'MXFJ6', CALL) === '21,300', `35: long 追繳價 21,300 on both rows: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'MXFJ6', CALL)}`)
  ok(val(f, 'TMFJ6', LIQ) === '18,700' && val(f, 'MXFJ6', LIQ) === '18,700', `35: long 強平價 18,700 on both rows: ${val(f, 'TMFJ6', LIQ)} / ${val(f, 'MXFJ6', LIQ)}`)
  ok(plain(cell(f, 'TMFJ6', CALL)?.style, WHITE) && plain(cell(f, 'TMFJ6', LIQ)?.style, WHITE), '35: far from both: default colour')
}
// --- row 36: short: the adverse move is up
{
  const f = await both({ accountText: SAMPLE, holdingsFile: holdings(-5, -1) })
  ok(val(f, 'TMFJ6', CALL) === '25,600' && val(f, 'MXFJ6', CALL) === '25,600', `36: short 追繳價 25,600: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'MXFJ6', CALL)}`)
  ok(val(f, 'TMFJ6', LIQ) === '28,200' && val(f, 'MXFJ6', LIQ) === '28,200', `36: short 強平價 28,200: ${val(f, 'TMFJ6', LIQ)} / ${val(f, 'MXFJ6', LIQ)}`)
}
// --- row 37: one underlying, two prices: each row moves by the same ΔP off its own price
{
  const f = await both({ accountText: SAMPLE, holdingsFile: book(TMF(5, 23450), MXF(1, 23470)) })
  ok(val(f, 'TMFJ6', CALL) === '21,300' && val(f, 'MXFJ6', CALL) === '21,320', `37: TMF+MXF share ΔP -2,150: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'MXFJ6', CALL)}`)
  ok(val(f, 'TMFJ6', LIQ) === '18,700' && val(f, 'MXFJ6', LIQ) === '18,720', `37: and ΔP -4,750: ${val(f, 'TMFJ6', LIQ)} / ${val(f, 'MXFJ6', LIQ)}`)
}
// --- row 38: long 5 TMF + short 1 MXF on one underlying: exposure 0
{
  const f = await both({ accountText: SAMPLE, holdingsFile: book(TMF(5), MXF(-1)) })
  ok([CALL, LIQ].every(l => val(f, 'TMFJ6', l) === '—' && val(f, 'MXFJ6', l) === '—'), `38: hedged to 0: — in both columns: ${[CALL, LIQ].map(l => `${val(f, 'TMFJ6', l)}/${val(f, 'MXFJ6', l)}`).join(' ')}`)
  ok(lineOf(f.rows[1]).endsWith('距追繳 215,000 元'), `38: line 1 still 215,000 元: "${lineOf(f.rows[1])}"`)
}
// --- row 39: TMF + SRF: two underlyings, each row uses its own group only
const TWO = book(TMF(5), SRF(20))
const twoGroups = await both({ accountText: SAMPLE, holdingsFile: TWO })
{
  const f = twoGroups
  show('TMF 5 long + SRF 20 long, 120 cols', f)
  // TMF: 215,000 / 50 = 4,300; SRF: 215,000 / 20,000 = 10.75
  ok(val(f, 'TMFJ6', CALL) === '19,150' && val(f, 'SRFJ6', CALL) === '95.50', `39: 追繳價 per group: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'SRFJ6', CALL)}`)
  ok(val(f, 'TMFJ6', LIQ) === '13,950' && val(f, 'SRFJ6', LIQ) === '82.50', `39: 強平價 per group: ${val(f, 'TMFJ6', LIQ)} / ${val(f, 'SRFJ6', LIQ)}`)
  ok(lineOf(f.rows[1]) === '風險 120% │ 權益 600,000 │ 可用 100,000 │ 距追繳 215,000 元', `39: two underlyings: line 1 is the same 元 cushion: "${lineOf(f.rows[1])}"`)
}
// --- row 40: cushion <= 0
{
  const f = await both({ accountText: acct({ equity: 385000 }) })
  ok(val(f, 'TMFJ6', CALL) === '追繳中' && isDanger(cell(f, 'TMFJ6', CALL)?.style) && val(f, 'MXFJ6', CALL) === '追繳中', `40: equity == maintenance: 追繳中, danger: ${JSON.stringify(cell(f, 'TMFJ6', CALL))}`)
  // 強平: 385,000 - 125,000 = 260,000 over 100 -> 20,850, still a price
  ok(val(f, 'TMFJ6', LIQ) === '20,850' && !cell(f, 'TMFJ6', LIQ)?.style?.bg, `40: 強平價 still a price: ${val(f, 'TMFJ6', LIQ)}`)
  const g = await both({ accountText: acct({ equity: 125000 }) })
  ok(val(g, 'TMFJ6', LIQ) === '強平' && isDanger(cell(g, 'TMFJ6', LIQ)?.style), `40: equity == 25% x initial: 強平, danger: ${JSON.stringify(cell(g, 'TMFJ6', LIQ))}`)
  ok(val(g, 'TMFJ6', CALL) === '追繳中', '40: and 追繳中')
  const m = await both({ accountText: acct({ equity: 385000 }), holdingsFile: TWO })
  ok(lineOf(m.rows[1]).endsWith('距追繳 0 元'), `40: two underlyings at maintenance: "${lineOf(m.rows[1])}"`)
}
// --- row 41: orange within 2% of the current price (23,450 x 2% = 469)
{
  const at = async equity => both({ accountText: acct({ equity }) })
  const near = await at(431800) // ΔP -468 -> 22,982
  ok(val(near, 'TMFJ6', CALL) === '22,982' && plain(cell(near, 'TMFJ6', CALL)?.style, ORANGE), `41: 468 away (1.996%): orange: ${JSON.stringify(cell(near, 'TMFJ6', CALL))}`)
  const edge = await at(431900) // ΔP -469 -> 22,981, exactly 2%
  ok(val(edge, 'TMFJ6', CALL) === '22,981' && plain(cell(edge, 'TMFJ6', CALL)?.style, WHITE), `41: exactly 2%: default: ${JSON.stringify(cell(edge, 'TMFJ6', CALL))}`)
  const liqNear = await at(171800) // 強平 ΔP -468; 追繳 is already 追繳中
  ok(val(liqNear, 'TMFJ6', LIQ) === '22,982' && plain(cell(liqNear, 'TMFJ6', LIQ)?.style, ORANGE), `41: 強平價 468 away: orange: ${JSON.stringify(cell(liqNear, 'TMFJ6', LIQ))}`)
  const liqEdge = await at(171900)
  ok(val(liqEdge, 'TMFJ6', LIQ) === '22,981' && plain(cell(liqEdge, 'TMFJ6', LIQ)?.style, WHITE), `41: 強平價 exactly 2%: default: ${JSON.stringify(cell(liqEdge, 'TMFJ6', LIQ))}`)
  ok(isDanger(cell(liqNear, 'TMFJ6', CALL)?.style), '41: danger wins over orange')
}
// --- row 42: the live estimate: equity 605,000 at 23,500 -> 23,500 - 2,200 = 21,300 (broker equity would read 21,350)
{
  const f = await both({ accountText: withRef(REF_LONG), quotes: liveQuotes() })
  ok(val(f, 'TMFJ6', CALL) === '≈21,300' && val(f, 'MXFJ6', CALL) === '≈21,300', `42: estimated 追繳價 ≈21,300: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'MXFJ6', CALL)}`)
  ok(val(f, 'TMFJ6', LIQ) === '≈18,700', `42: estimated 強平價 ≈18,700: ${val(f, 'TMFJ6', LIQ)}`)
  const broker = await both({ accountText: SAMPLE, quotes: liveQuotes() })
  ok(val(broker, 'TMFJ6', CALL) === '21,350' && val(broker, 'TMFJ6', LIQ) === '18,750', `42: no ref: broker equity at the live price, no ≈: ${val(broker, 'TMFJ6', CALL)} / ${val(broker, 'TMFJ6', LIQ)}`)
}
// --- row 43: conservative rounding: 215,000 / 70 = 3,071.43; 475,000 / 70 = 6,785.71
{
  const l = await both({ accountText: SAMPLE, holdingsFile: book(TMF(7)) })
  ok(val(l, 'TMFJ6', CALL) === '20,379' && val(l, 'TMFJ6', LIQ) === '16,665', `43: long rounds up (20,378.57 -> 20,379; 16,664.29 -> 16,665): ${val(l, 'TMFJ6', CALL)} / ${val(l, 'TMFJ6', LIQ)}`)
  const s = await both({ accountText: SAMPLE, holdingsFile: book(TMF(-7)) })
  ok(val(s, 'TMFJ6', CALL) === '26,521' && val(s, 'TMFJ6', LIQ) === '30,235', `43: short rounds down (26,521.43 -> 26,521; 30,235.71 -> 30,235): ${val(s, 'TMFJ6', CALL)} / ${val(s, 'TMFJ6', LIQ)}`)
}
// --- row 44: decimals follow the row's price; SRF 1 x 1,000
{
  const one = async (equity, srf) => val(await both({ accountText: acct({ equity }), holdingsFile: book(srf) }), 'SRFJ6', CALL)
  const CASES = [
    ['2 decimals, 106.25 - 0.1 (no float creep to 106.16)', 385100, SRF(1, 106.25), '106.15'],
    ['1 decimal, 106.5 - 0.1', 385100, SRF(1, 106.5), '106.4'],
    ['0 decimals, 106 - 1.25 rounds up', 386250, SRF(1, 106), '105'],
    ['2 decimals, 106.25 - 0.333 rounds up', 385333, SRF(1, 106.25), '105.92'],
    ['2 decimals short, 106.25 + 0.333 rounds down', 385333, SRF(-1, 106.25), '106.58'],
    ['float-noise price reads as 2 decimals', 385100, SRF(1, 106.2500000001), '106.15'],
  ]
  for (const [why, equity, srf, want] of CASES) {
    const got = await one(equity, srf)
    ok(got === want, `44: ${why}: ${got} (want ${want})`)
  }
  // 強平 cushion 260,100 on 1,000 is past zero: unreachable, so —
  ok(val(await both({ accountText: acct({ equity: 385100 }), holdingsFile: book(SRF(1)) }), 'SRFJ6', LIQ) === '—', '44: a price at or below 0 reads —')
}
// --- row 45: a row without underlying (null: the fetcher could not read underlying_code)
{
  const f = await both({ accountText: SAMPLE, holdingsFile: book(TMF(5), MXF(1, 23450, null)) })
  ok(val(f, 'MXFJ6', CALL) === '—' && val(f, 'MXFJ6', LIQ) === '—', `45: no underlying: —: ${val(f, 'MXFJ6', CALL)} / ${val(f, 'MXFJ6', LIQ)}`)
  ok(val(f, 'TMFJ6', CALL) === '19,150' && val(f, 'TMFJ6', LIQ) === '13,950', `45: TMF's group is TMF alone: ${val(f, 'TMFJ6', CALL)} / ${val(f, 'TMFJ6', LIQ)}`)
  ok(lineOf(f.rows[1]).endsWith('距追繳 215,000 元'), `45: line 1 in 元: "${lineOf(f.rows[1])}"`)
}
// --- rows 46-47: header iff column; 建倉明細 drops first, then 強平價, then 追繳價
{
  // 追繳價 98-103, 強平價 106-111, 建倉明細 114 + 17; each needs its last cell <= cols - 2, as 建倉明細 always did
  const FH = '建倉明細'
  const WIDTHS = [[140, [CALL, LIQ, FH]], [132, [CALL, LIQ, FH]], [131, [CALL, LIQ]], [113, [CALL, LIQ]], [112, [CALL]], [105, [CALL]], [104, []], [80, []]]
    const cellText = { [CALL]: '21,300', [LIQ]: '18,700', [FH]: '4筆 23,410–23,520' }
  for (const [cols, want] of WIDTHS) {
    const f = await frame({ accountText: SAMPLE }, cols)
    const tmf = textOf(f.rows.find(r => textOf(r).includes('TMFJ6')) ?? [])
    for (const label of [CALL, LIQ, FH]) {
      const head = headCol(f, label) >= 0
      const body = tmf.includes(cellText[label])
      ok(head === want.includes(label) && body === head, `46: ${cols} cols: ${label} ${want.includes(label) ? 'shown' : 'dropped'} (header ${head}, cell ${body})`)
    }
    const all = Math.max(...f.rows.map(r => dispWidth(textOf(r).replace(/[\s ]+$/, ''))))
    ok(cols < 80 || all <= cols - 1, `47: ${cols} cols: no row past the band (${all})`)
  }
  const f = await frame({ accountText: SAMPLE }, 140)
  ok(headCol(f, CALL) + dispWidth(CALL) === 104 && headCol(f, LIQ) + dispWidth(LIQ) === 112 && headCol(f, '建倉明細') === 114, `47: positions: 追繳價 ends 104, 強平價 ends 112, 建倉明細 at 114 (${headCol(f, CALL)}, ${headCol(f, LIQ)}, ${headCol(f, '建倉明細')})`)
  // one column missing: the others close up
  const noMm = await frame({ accountText: acct({ maintenanceMargin: 0 }) }, 140)
  ok(headCol(noMm, CALL) < 0 && headCol(noMm, LIQ) + dispWidth(LIQ) === 104, `47: no maintenance: no 追繳價, 強平價 moves to 98 (${headCol(noMm, LIQ)})`)
  const noIm = JSON.parse(SAMPLE)
  delete noIm.margin.initialMargin
  const noInit = await frame({ accountText: JSON.stringify(noIm) }, 140)
  ok(headCol(noInit, LIQ) < 0 && headCol(noInit, CALL) >= 0 && headCol(noInit, '建倉明細') === 106, `47: no initialMargin: no 強平價, 建倉明細 at 106 (${headCol(noInit, '建倉明細')})`)
  const zeroIm = await frame({ accountText: acct({ initialMargin: 0 }) }, 140)
  ok(headCol(zeroIm, LIQ) < 0, '47: initialMargin 0: no 強平價')
  const noMargin = await frame({ accountText: NO_MARGIN }, 140)
  ok(headCol(noMargin, CALL) < 0 && headCol(noMargin, LIQ) < 0 && headCol(noMargin, '建倉明細') === 98, '47: margin null: neither, 建倉明細 back at 98')
}
// --- row 48: clicks
{
  const f = await frame({ accountText: SAMPLE }, 140)
  const g = await frame({ accountText: NO_MARGIN }, 140)
  const hy = f.rows.findIndex(r => textOf(r).includes('代號'))
  const want = { 代號: 'code', '今日%': 'today', 今日損益: 'todayPnl', 總損益: 'totalPnl', '損益%': 'totalPnlPct' }
  for (const [label, key] of Object.entries(want)) {
    ok(headCol(f, label) === headCol(g, label) && f.click(headCol(f, label) + 1, hy)?.sortPnl === key, `48: ${label} keeps its place and sorts ${key}`)
  }
  for (const label of [CALL, LIQ]) {
    const x0 = headCol(f, label)
    let none = true
    for (let x = x0; x < x0 + dispWidth(label) + 1; x++) if (f.click(x, hy) !== undefined) none = false
    ok(none, `48: a click on ${label} does nothing`)
  }
}
// --- row 49: shioaji.liquidationRiskPct, user-level only
{
  const liq = async opts => {
    const f = await frame({ accountText: SAMPLE, ...opts })
    return { v: val(f, 'TMFJ6', LIQ), logs: f.band.logs }
  }
  // 40%: 600,000 - 200,000 = 400,000 / 100 -> 19,450
  ok((await liq({ userConfig: { shioaji: { liquidationRiskPct: 40 } } })).v === '19,450', '49: user 40%: 19,450')
  ok((await liq({ userConfig: { shioaji: { liquidationRiskPct: 0 } } })).v === '17,450', '49: user 0%: equity itself, 17,450')
  const proj = await liq({ projectExtra: { shioaji: { liquidationRiskPct: 40 } } })
  ok(proj.v === '18,700', `49: project 40% alone: ignored, 25% default: ${proj.v}`)
  ok(proj.logs.some(l => l.includes('shioaji.liquidationRiskPct') && l.includes('已忽略')), `49: the project value is logged as ignored: ${proj.logs.filter(l => l.includes('忽略')).join(' / ')}`)
  ok((await liq({ userConfig: { shioaji: { liquidationRiskPct: 40 } }, projectExtra: { shioaji: { liquidationRiskPct: 10 } } })).v === '19,450', '49: user 40% + project 10%: the user wins')
  for (const bad of [150, -5, '40', null, true]) {
    const r = await liq({ userConfig: { shioaji: { liquidationRiskPct: bad } } })
    ok(r.v === '18,700', `49: user ${JSON.stringify(bad)}: falls back to 25%: ${r.v}`)
  }
}
// --- row 50: line 1 in 元 with the estimate; narrow widths still fit
{
  const opts = { accountText: withRef({ TMFJ6: { qty: 5, price: 23450 } }), holdingsFile: TWO, quotes: liveQuotes() }
  const f = await frame(opts)
  ok(lineOf(f.rows[1]).endsWith('距追繳 ≈217,500 元'), `50: estimated, two underlyings: "${lineOf(f.rows[1])}"`)
  ok(val(f, 'TMFJ6', CALL) === '≈19,150' && val(f, 'SRFJ6', CALL) === '≈95.38', `50: rows carry ≈ (23,500 - 4,350; 106.25 - 10.875 up): ${val(f, 'TMFJ6', CALL)} / ${val(f, 'SRFJ6', CALL)}`)
  for (const cols of [60, 40, 30]) {
    const g = await frame(opts, cols)
    const l1 = lineOf(g.rows[1])
    ok(dispWidth(textOf(g.rows[1])) <= cols - 1 && /距追繳 ≈217,500( 元)?$/.test(l1), `50: ${cols} cols: fits, keeps 距追繳: "${l1}"`)
  }
}
// --- row 51: a single-underlying book shows the same 元 cushion, the report's two frames
{
  const a = await frame({ accountText: SAMPLE, holdingsFile: book(TMF(5), MXF(1)) }, 120)
  show('(a) TMF 5 + MXF 1 long, 120 cols', a)
  ok(lineOf(a.rows[1]) === LINE1, `51: TMF+MXF: 元 like any book: "${lineOf(a.rows[1])}"`)
  show('(b) TMF 5 + SRF 20 long, 120 cols', twoGroups)
}

done()
