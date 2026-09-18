// 進圖表 → 按下一檔／上一檔 → 回清單，每一步把真的按鈕列與焦點印出來，並斷言
// 導覽本身的行為（上一檔／下一檔／回清單，含繞頭尾）。
//
// 「名次交叉」那段額外驗證 PR-a 的 bug：hooks/register.tsx 每次 render 都依
// cfg.sort==='change' 重排 quotes（依 pct 由大到小），但 focus 只是頁內位置
// (props.quotes[props.focus])，不是代碼。兩檔漲跌幅名次交叉時，同一個 focus
// 位置換了別檔坐在上面 - 聚焦會靜靜跳到別檔頭上。這段現在預期是紅的（PR-a
// target），本任務不修 register.tsx，只記錄它。
import { readFile, writeFile } from 'node:fs/promises'
import { ok, done } from './assert.mjs'
globalThis.h = (t, p, ...k) => ({ type: t, props: p ?? {}, kids: k.flat() })
globalThis.Fragment = 'Fragment'
const [, , regPath, projDir] = process.argv
// 假時鐘：固定在 2026-09-17T10:00:00+08:00（週四台股盤中），一路沿用到名次
// 交叉那段才手動推進 - 導覽段落全程同一個 now，demo 價格/排序不會中途漂移。
let clock = 1789596000000
const timers = []
const $ = {
  clock: { now: async () => clock, every: (ms, fn) => timers.push(fn) },
  fs: { read: async p => (await readFile(projDir + '/' + p)).toString() },
  ui: { log: () => {}, invalidate: () => {}, resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client' }) },
  http: { fetch: async (u, i) => { const r = await fetch(u, { headers: i?.headers }); return { ok: r.ok, status: r.status, text: await r.text() } } },
  env: { get: async name => (name === 'HOME' ? process.env.HOME : undefined) },
  session: { cwd: async () => projDir },
}
const handlers = new Map()
const { register } = await import(regPath)
register((e, a, b) => handlers.set(e, typeof a === 'function' ? a : b))
await handlers.get('session.start')($, {}, async () => ({ kids: [] }))
await new Promise(r => setTimeout(r, 2500))

const draw = async () => {
  const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 120 } }, async () => ({ kids: [] }))
  const btns = [], texts = []; let props, side = 'left'
  const walk = (n, depth = 0) => { if (!n || typeof n !== 'object') return
    if (n.type === 'Client') props = n.props.props
    if (n.type === 'Button') btns.push({ label: n.props.label, press: n.props.onPress, key: n.props.key })
    if (n.type === 'Text' && typeof n.props.children === 'string') texts.push(n.props.children)
    for (const k of [...(n.kids ?? []), n.props?.children]) walk(k, depth + 1) }
  walk(tree)
  return { btns, texts, props }
}
const show = async label => {
  const { btns, props } = await draw()
  const sym = props.view === 'chart' ? props.quotes[props.focus]?.code : '—'
  console.log(`${label.padEnd(14)} view=${String(props.view).padEnd(5)} 焦點=${sym}   按鈕列： ${btns.map(b => `[${b.label}]`).join(' ')}`)
  return { btns, props }
}

// --- 既有：上一檔／下一檔／回清單 -------------------------------------------
let { btns: b0, props: p0 } = await show('起始')
ok(p0.view === 'table', '起始是清單畫面')
ok(!!b0.find(x => x.label === '趨勢圖'), '清單畫面有「趨勢圖」按鈕')

b0.find(x => x.label === '趨勢圖').press()
let { btns: b1, props: p1 } = await show('按 趨勢圖')
ok(p1.view === 'chart', '按趨勢圖後進入圖表畫面')
const order = p1.quotes.map(q => q.code)
ok(order.length >= 2, '圖表畫面看得到至少兩檔，導覽才有得測')
ok(p1.quotes[p1.focus]?.code === order[0], '起始焦點停在名次第一那檔')

b1.find(x => x.label.startsWith('下一檔')).press()
let { btns: b2, props: p2 } = await show('按 下一檔')
ok(p2.quotes[p2.focus]?.code === order[1], '下一檔移到名次第二')

b2.find(x => x.label.startsWith('下一檔')).press()
let { btns: b3, props: p3 } = await show('按 下一檔')
ok(p3.quotes[p3.focus]?.code === order[2 % order.length], '下一檔再往後移一檔')

b3.find(x => x.label === '◀ 上一檔').press()
let { btns: b4, props: p4 } = await show('按 上一檔')
ok(p4.quotes[p4.focus]?.code === order[1], '上一檔退回名次第二')

b4.find(x => x.label === '◀ 上一檔').press()
let { btns: b5, props: p5 } = await show('按 上一檔')
ok(p5.quotes[p5.focus]?.code === order[0], '上一檔退回名次第一')

b5.find(x => x.label === '◀ 上一檔').press()
let { btns: b6, props: p6 } = await show('上一檔(繞回尾)')
ok(p6.quotes[p6.focus]?.code === order[order.length - 1], '上一檔從第一檔繞回最後一檔')

b6.find(x => x.label === '回清單').press()
let { btns: b7, props: p7 } = await show('按 回清單')
ok(p7.view === 'table', '回清單後畫面切回清單')

// --- 新增：名次交叉（PR-a target）------------------------------------------
// 重新進圖表：onTrend 每次都把 focus 重設回 0，所以這裡穩穩停在名次第一。
b7.find(x => x.label === '趨勢圖').press()
let { btns: b8, props: p8 } = await show('交叉前：進圖表')
ok(p8.quotes[p8.focus]?.code === order[0], '重新進圖表，焦點回到名次第一')

b8.find(x => x.label.startsWith('下一檔')).press()
let { props: p9 } = await show('交叉前：下一檔')
const trackedCode = p9.quotes[p9.focus]?.code
ok(trackedCode === order[1], '進入交叉測試前，焦點停在名次第二那檔')

// 讓名次第一、第二對調（.claude/stock-quotes.json 覆蓋報價）：把兩檔的報價
// 物件互換，代碼欄不動、名次互換 - 這是 register.tsx 重排 quotes 的唯一觸發
// 條件，不需要真的等一個 refreshMs 循環，直接改檔＋手動觸發 poll() 的 timer
// 一樣算數。用排序後的 order[0]/order[1]（不是 JSON 檔案裡的 key 順序）來挑
// 要對調的兩檔，這樣不管報價檔本身怎麼排都抓得到真正的名次第一、第二。
const quotesPath = `${projDir}/.claude/stock-quotes.json`
const before = JSON.parse(await readFile(quotesPath, 'utf8'))
const [topCode, secondCode] = order
const swapped = {
  ...before,
  asOf: (clock += 1000),
  quotes: { ...before.quotes, [topCode]: before.quotes[secondCode], [secondCode]: before.quotes[topCode] },
}
await writeFile(quotesPath, JSON.stringify(swapped, null, 2))
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { props: p10 } = await show('交叉後（同一個 focus）')
ok(
  p10.quotes[p10.focus]?.code === trackedCode,
  `名次交叉後 focus 應該還跟著 ${trackedCode} 走，而不是跟著「名次第二這個位置」(PR-a target)`,
)

// --- 新增：分頁換頁跟隨 ------------------------------------------------------
// 兩位審查者都抓到的第二個漏洞：buildProps 先切頁（quotes.slice）再用
// focusCode 在「這一頁」裡 findIndex，圖表視圖時 autoPage 又凍結 page 不動
// (view !== 'table')。清單超過一頁、cfg.sort==='change' 時，聚焦那檔名次一
// 掉出目前頁，findIndex 在 shown 裡就是找不到 -> 退回 0 -> 圖悄悄換成本頁
// 第一檔。這段把清單換成 6 檔（PAGE_SIZE_1COL=5，第 6 名落在第 2 頁），先
// 回清單重進圖表，聚焦名次第 5（還在第 1 頁），再把報價改成讓它掉到第 6 名
// （該翻到第 2 頁），驗證 K 線標題與 page/focus 都跟著那檔走，而不是停在原
// 頁面被換成新占位者；接著再讓它升回第 1 名，驗證跟得回去。
// 名次交叉段結束時停在 chart 視圖（`b7` 是更早、上一次回清單前的按鈕列，
// 這裡要重新 draw 一次拿現在真正畫出來的按鈕列）。
const { btns: bCross } = await show('分頁跟隨：交叉段結束時的畫面')
bCross.find(x => x.label === '回清單').press()
await show('分頁跟隨：先回清單')

const bandPath = `${projDir}/.claude/stock-band.json`
const sixCodes = ['4444', '5555', '6666', '7777', '8888', '9999']
const sixBand = {
  market: 'tw',
  sort: 'change',
  feed: 'off',
  refreshMs: 1000,
  pageMs: 0,
  columns: 1,
  tw: sixCodes.map((code, i) => ({ code, name: `第${i}檔`, prevClose: 100 })),
  us: [],
}
await writeFile(bandPath, JSON.stringify(sixBand, null, 2))
// 依 price 降冪 = 依 pct 降冪 = 名次 1~6（4444 最高、9999 最低）
const writeSixQuotes = prices =>
  writeFile(
    quotesPath,
    JSON.stringify(
      {
        asOf: (clock += 1000),
        market: 'tw',
        quotes: Object.fromEntries(sixCodes.map((code, i) => [code, { price: prices[i], prevClose: 100, name: `第${i}檔` }])),
      },
      null,
      2,
    ),
  )
await writeSixQuotes([106, 105, 104, 103, 102, 101]) // 4444..9999 依序名次 1~6
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { btns: b11, props: p11 } = await show('分頁跟隨：清單已換成 6 檔')
ok(p11.view === 'table', '換清單後畫面還是清單')

b11.find(x => x.label === '趨勢圖').press()
let { props: p12 } = await show('分頁跟隨：進圖表')
ok(p12.page === 0, '進圖表時停在第 1 頁')
ok(p12.quotes[p12.focus]?.code === '4444', '進圖表焦點停在名次第一 4444')

for (let i = 0; i < 4; i++) {
  const { btns } = await show(`分頁跟隨：下一檔 x${i}`)
  btns.find(x => x.label.startsWith('下一檔')).press()
}
let { props: p13, btns: b13 } = await show('分頁跟隨：下一檔到名次第五')
const rank5Code = p13.quotes[p13.focus]?.code
ok(rank5Code === '8888', '連按 4 次下一檔，焦點停在名次第五 8888（仍在第 1 頁）')
ok(p13.page === 0, '名次第五還在第 1 頁')

// 讓 8888（目前名次第五）與 9999（名次第六）對調 -> 8888 掉到第 6 名，該
// 翻到第 2 頁；page/autoPage 在 chart 視圖凍結，唯一該動 page 的是本次要
// 修的 page-follow 邏輯。
await writeSixQuotes([106, 105, 104, 103, 101, 102]) // 8888 變最低、9999 變第五
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { props: p14, btns: b14 } = await show('分頁跟隨：掉到第六名（該翻頁）')
ok(p14.view === 'chart', '掉名次後仍在圖表畫面')
ok(p14.page === 1, '8888 掉到第六名後，page 跟著翻到第 2 頁')
ok(p14.quotes.length === 1, '第 2 頁只有 1 檔（6 檔 / 每頁 5 檔）')
ok(p14.quotes[p14.focus]?.code === rank5Code, `K 線標題仍是 ${rank5Code}，不是被換成第 2 頁的新占位者`)
const nextBtn14 = b14.find(x => x.label.startsWith('下一檔'))
ok(nextBtn14.label === '下一檔 ▶ 1/1', `按鈕列位置顯示 1/1，反映新頁位置：實際 "${nextBtn14.label}"`)

// 再讓 8888 升回名次第一，驗證跟得回去（page 退回第 1 頁）。
await writeSixQuotes([105, 104, 103, 102, 110, 101]) // 8888 變最高
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { props: p15 } = await show('分頁跟隨：升回第一名')
ok(p15.page === 0, '8888 升回第一名後，page 跟著退回第 1 頁')
ok(p15.quotes[p15.focus]?.code === rank5Code, `K 線標題仍是 ${rank5Code}，跟著升回第一名`)
ok(p15.focus === 0, '第一名落在第 1 頁的第一個位置')

// --- 新增：pageAt 被 autoPage 冒充成「剛翻頁」，回清單誤觸發整頁翻牌 --------
// 這次審查抓到的漏洞：autoPage() 在 view !== 'table' 時每次 poll 都把
// pageAt = now（凍結的是 page 本身，不是 pageAt - 見 autoPage 內 view!=='table'
// 那個早退分支），但真正的翻頁快照 pageFrom/pageFromMarket 只有 setPage 會
// 更新。buildProps 的翻牌 guard 舊版拿 pageAt 當「這份快照多新」的量尺，於是
// 使用者只要在圖表停留超過一輪 poll，pageAt 就被 autoPage 持續刷新成「剛
// 剛」，即使距離上一次真正的 setPage 已經遠遠超過 PAGE_TURN_WINDOW_MS - 回
// 清單那一刻明明沒有真的翻頁，也會被判定成「剛翻頁」，把舊頁的 was 套到現在
// 這頁，整頁閃出不相干的舊股票。修法另開 pageFromAt，只在 setPage 裡動，不
// 受 autoPage 影響（見 register.tsx pageFromAt 的宣告與註解）。
{
  const { btns } = await show('翻牌回歸：清掉前一段留下的圖表畫面')
  btns.find(x => x.label === '回清單').press()
  await show('翻牌回歸：先回清單')
}

const flapCodes = ['F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'F007']
const flapBand = {
  market: 'tw',
  sort: 'list', // 固定名次：這段只測翻頁/回清單的翻牌 guard，不要被排序漂移干擾
  feed: 'off',
  refreshMs: 1000,
  pageMs: 999999, // 大到不會自己觸發第二次真的翻頁，只留 autoPage 早退分支刷新 pageAt 的副作用
  columns: 1,
  tw: flapCodes.map((code, i) => ({ code, name: `翻牌${i}`, prevClose: 100 })),
  us: [],
}
await writeFile(bandPath, JSON.stringify(flapBand, null, 2))
await writeFile(
  quotesPath,
  JSON.stringify(
    {
      asOf: (clock += 1000),
      market: 'tw',
      quotes: Object.fromEntries(flapCodes.map((code, i) => [code, { price: 100 + i, prevClose: 100, name: `翻牌${i}` }])),
    },
    null,
    2,
  ),
)
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { props: pFlap0 } = await show('翻牌回歸：清單已換成 7 檔')
ok(pFlap0.view === 'table' && pFlap0.page === 0, '換清單後回到清單第 1 頁')

// 真的翻一次頁：page 0 -> 1，這才是唯一合法的 pageFrom/pageFromMarket/pageFromAt 來源
const { btns: bFlap0 } = await show('翻牌回歸：翻頁前')
bFlap0.find(x => x.label.startsWith('翻頁')).press()
let { props: pFlap1 } = await show('翻牌回歸：真的翻頁到第 2 頁')
ok(pFlap1.page === 1, '真的按了翻頁，落在第 2 頁')

// 進圖表：之後 page 不再被 setPage 動到 - autoPage 在 view!=='table' 時只早退寫 pageAt
const { btns: bFlap1 } = await show('翻牌回歸：進圖表前')
bFlap1.find(x => x.label === '趨勢圖').press()
let { props: pFlapChart } = await show('翻牌回歸：進圖表')
ok(pFlapChart.view === 'chart' && pFlapChart.page === 1, '進圖表當下還是第 2 頁，page 沒被翻頁邏輯動過')

// 在圖表停留超過一輪 poll：每次 poll 都呼叫 autoPage()，view!=='table' 的
// 早退分支把 pageAt 刷新成「剛剛」，但不動 pageFrom/pageFromMarket/
// pageFromAt。累計下來遠遠超過 PAGE_TURN_WINDOW_MS(2500ms)，但每次 poll 之
// 間只推進 1500ms - 舊版 bug 下 pageAt 永遠讀得到「1500ms 內」，判定成剛翻頁。
for (let i = 0; i < 3; i++) {
  clock += 1500
  // `fn()` fires poll() without awaiting its own promise (register.tsx's
  // `$.clock.every` callback is fire-and-forget, matching the real engine) -
  // the 400ms real sleep is what lets each poll actually land before the
  // next `clock` bump, same as every other fixture reload in this file.
  for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }
}

// 回清單：view 變回 table，page 維持 1（onList 不碰 page），這整段期間沒有
// 任何一次真的翻頁。
const { btns: bFlapChart } = await show('翻牌回歸：圖表停留後')
bFlapChart.find(x => x.label === '回清單').press()
let { props: pFlapBack } = await show('翻牌回歸：回清單')
ok(pFlapBack.view === 'table' && pFlapBack.page === 1, '回清單後仍在第 2 頁（沒有真的翻頁）')
ok(
  pFlapBack.quotes[0]?.was === undefined,
  '沒有真的翻頁卻被判定成剛翻頁，第 2 頁不該套上第 1 頁的舊股票當翻牌 (bug #1)',
)

// --- 新增：切市場沒重設 page，落在跟直覺不符的頁碼 -----------------------
// 第二個漏洞：換市場（當年的 onCycle，現在的 onSelectStop）只呼叫 resetPnlScroll()，從沒把 page 歸零。
// buildProps 用 ((page % pages) + pages) % pages 把舊 page 繞進新市場的合法
// 範圍，不會當機，但落點完全看兩個市場頁數的餘數關係，不是使用者切市場時
// 直覺期待的「從頭看」。這段把美股停在最後一頁、台股只有 2 頁，讓餘數落在
// 非 0 的位置，驗證切過去該是台股第 1 頁而不是繞算出來的第 2 頁 - 修法是
// 市場真的換了就把 page 寫回 0（見 onSelectStop 裡
// `if (stop.market !== props.market)`）。20 檔頂到 MAX_SYMBOLS（見
// register.tsx），5 檔一頁剛好 4 頁；7 台股 5 檔一頁是 2 頁，4 頁対 2 頁的餘
// 數在最後一頁（index 3）時是 3 % 2 = 1 - 非 0，足以跟真正該歸零的 0 區分。
const usCycleCodes = Array.from({ length: 20 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`)
const twCycleCodes = Array.from({ length: 7 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)
const cycleBand = {
  market: 'us',
  sort: 'list',
  feed: 'off',
  refreshMs: 1000,
  pageMs: 999999,
  columns: 1,
  us: usCycleCodes.map((code, i) => ({ code, name: `美股${i}`, prevClose: 100 })),
  tw: twCycleCodes.map((code, i) => ({ code, name: `台股${i}`, prevClose: 100 })),
}
await writeFile(bandPath, JSON.stringify(cycleBand, null, 2))
await writeFile(
  quotesPath,
  JSON.stringify(
    {
      asOf: (clock += 1000),
      market: 'us',
      quotes: Object.fromEntries(usCycleCodes.map((code, i) => [code, { price: 100 + i, prevClose: 100, name: `美股${i}` }])),
    },
    null,
    2,
  ),
)
for (const fn of timers) { await fn(); await new Promise(r => setTimeout(r, 400)) }

let { props: pCyc0 } = await show('市場切換：美股起始')
ok(pCyc0.market === 'us' && pCyc0.pageCount === 4, '美股 20 檔、每頁 5 檔，共 4 頁')

// 不假設進來時剛好在第 1 頁 - 前一段測試留在台股某一頁，換市場/換清單都不會
// 重置 page（這正是本段要測的行為的另一半），所以用「按到頁碼停在最後一頁」
// 當終止條件，跟殘留狀態脫鉤，而不是硬編「按幾次」。
for (let guard = 0; guard < pCyc0.pageCount && pCyc0.page !== pCyc0.pageCount - 1; guard++) {
  const { btns } = await show(`市場切換：美股找最後一頁 x${guard}`)
  btns.find(x => x.label.startsWith('翻頁')).press()
  ;({ props: pCyc0 } = await show(`市場切換：美股找最後一頁後 x${guard}`))
}
ok(pCyc0.page === pCyc0.pageCount - 1, `美股停在最後一頁（page=${pCyc0.pageCount - 1}），用來製造切市場後的餘數落點`)

const { btns: bCyc1 } = await show('市場切換：切市場前')
bCyc1.find(x => x.key === 'stock-band:tab:tw')?.press()
let { props: pCyc2 } = await show('市場切換：切到台股')
ok(pCyc2.market === 'tw', '按台股分頁後市場真的換成台股')
ok(pCyc2.pageCount === 2, '台股 7 檔、每頁 5 檔，共 2 頁')
ok(
  pCyc2.page === 0,
  `market 真的換了，page 該歸零從頭看，不是繞算 3 % 2 = 1 落在第 2 頁：實際 page=${pCyc2.page} (bug #2)`,
)

done()
