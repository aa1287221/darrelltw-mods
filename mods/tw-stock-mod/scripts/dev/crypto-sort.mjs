// Proves the two new sort keys (`'volume'`/`'marketcap'`) against the REAL
// register.tsx (bundled), same "stub host, canned $.http.fetch" shape as
// crypto-feed.mjs/market-select.mjs. This is the one harness that actually
// exercises fetchCryptoSupply's CoinGecko call and buildProps' sort branch -
// crypto-feed.mjs and market-select.mjs only need CoinGecko to answer
// quietly, never assert on it.
//
// Usage: node crypto-sort.mjs <register.js>
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'

const [, , modPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

const PIONEX_TICKERS_URL = 'https://api.pionex.com/api/v1/market/tickers'
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets'

// The same ten-code fixture crypto-feed.mjs/market-select.mjs use (read off
// Pionex 2026-09-18/19) - deliberately kept as-is rather than hand-tuned for
// this file, because the mismatch between `volume` (coin count) and
// `amount` (USDT turnover) it already has is exactly what (1) needs: sorted
// by `amount`, BTC/ETH/BNB lead; sorted by the wrong field (`volume`),
// DOGE/ADA/XRP would lead instead (DOGE alone has ~800M coins vs BTC's
// ~40K) - see the amount-vs-volume comment on QuoteRow.amount in
// register.tsx for why that swap would be meaningless.
const HAPPY_TICKERS = [
  { symbol: 'BTC_USDT', time: 1789746167017, open: '76633.32', close: '80744.04', high: '81153.69', low: '76259.98', volume: '38480.088467', amount: '3017756588.53451109', count: 499384 },
  { symbol: 'ETH_USDT', time: 1789746167017, open: '2467.86', close: '2579.91', high: '2610.00', low: '2440.11', volume: '900000', amount: '2000000000', count: 100000 },
  { symbol: 'SOL_USDT', time: 1789746167017, open: '100.99', close: '110.92', high: '112.50', low: '99.80', volume: '500000', amount: '50000000', count: 80000 },
  { symbol: 'BNB_USDT', time: 1789746167017, open: '727.45', close: '756.24', high: '760.00', low: '720.10', volume: '90000', amount: '65000000', count: 40000 },
  { symbol: 'XRP_USDT', time: 1789746167017, open: '1.3058', close: '1.3785', high: '1.4000', low: '1.2900', volume: '4000000', amount: '5300000', count: 90000 },
  { symbol: 'DOGE_USDT', time: 1789746167017, open: '0.08177', close: '0.08735', high: '0.08900', low: '0.08100', volume: '80000000', amount: '6900000', count: 120000 },
  { symbol: 'ADA_USDT', time: 1789746167017, open: '0.2023', close: '0.2191', high: '0.2250', low: '0.1990', volume: '9000000', amount: '1900000', count: 60000 },
  { symbol: 'AVAX_USDT', time: 1789746167017, open: '7.59', close: '8.10', high: '8.25', low: '7.50', volume: '600000', amount: '4800000', count: 30000 },
  { symbol: 'LINK_USDT', time: 1789746167017, open: '11.37', close: '12.16', high: '12.30', low: '11.20', volume: '700000', amount: '8300000', count: 35000 },
  { symbol: 'BCH_USDT', time: 1789746167017, open: '232.8', close: '252.5', high: '256.4', low: '231.2', volume: '47345.0619', amount: '11599993.01419999', count: 30500 },
]
const HAPPY_BODY = JSON.stringify({ result: true, data: { tickers: HAPPY_TICKERS }, timestamp: 1789746167461 })

// Circulating supply for the ten codes - rough real-world figures (2026-09),
// picked so the marketcap order is NOT just a relabeling of the amount
// order: SOL's `amount` (50,000,000) beats XRP's (5,300,000), but XRP's
// market cap (58.5B supply x $1.3785) beats SOL's (480M supply x $110.92) -
// (1)/(2) both check that rank flip specifically, to prove the marketcap
// branch is really pricing supply x price, not quietly falling back to
// amount.
const COINGECKO_HAPPY_BODY = JSON.stringify([
  { id: 'bitcoin', symbol: 'btc', circulating_supply: 19_800_000 },
  { id: 'ethereum', symbol: 'eth', circulating_supply: 120_500_000 },
  { id: 'solana', symbol: 'sol', circulating_supply: 480_000_000 },
  { id: 'binancecoin', symbol: 'bnb', circulating_supply: 145_800_000 },
  { id: 'ripple', symbol: 'xrp', circulating_supply: 58_500_000_000 },
  { id: 'dogecoin', symbol: 'doge', circulating_supply: 148_000_000_000 },
  { id: 'cardano', symbol: 'ada', circulating_supply: 35_400_000_000 },
  { id: 'avalanche-2', symbol: 'avax', circulating_supply: 410_000_000 },
  { id: 'chainlink', symbol: 'link', circulating_supply: 678_000_000 },
  { id: 'bitcoin-cash', symbol: 'bch', circulating_supply: 19_800_000 },
])

function findClient(node) {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'Client') return node
  for (const k of node.kids ?? []) {
    const hit = findClient(k)
    if (hit) return hit
  }
  return undefined
}

/**
 * Boots a fresh module instance (register.tsx keeps module-level mutable
 * state - cryptoSupply, liveBy, ... - that must not leak between cases
 * sharing one process, same reason crypto-feed.mjs/market-select.mjs
 * re-import per case) with a manually-driven clock and separate canned-
 * response queues for Pionex and CoinGecko.
 *
 * `bandConfig` is merged straight into `.claude/stock-band.json` - callers
 * pass `sort`/`market`/a `tw`/`us` quotes file override as needed.
 * `quotesFile` optionally seeds `.claude/stock-quotes.json` for the tw/us
 * cases (feed:"off", no network at all - same fixture shape run-checks.sh's
 * rank-cross fixture uses).
 */
let moduleTick = 0
async function boot({ bandConfig, quotesFile, cryptoResponses = [{ status: 200, text: HAPPY_BODY }], cgResponses = [{ status: 200, text: COINGECKO_HAPPY_BODY }] }) {
  moduleTick += 1
  const url = pathToFileURL(modPath)
  url.search = `?case=${moduleTick}`
  const { register } = await import(url.href)

  const home = '/fake-home'
  const files = {
    '.claude/stock-band.json': JSON.stringify({ feed: 'auto', feedMs: 30000, refreshMs: 3000, ...bandConfig }),
  }
  if (quotesFile) files['.claude/stock-quotes.json'] = JSON.stringify(quotesFile)

  const cryptoCalls = []
  const cgCalls = []
  const timers = []
  const logs = []
  let clock = 1789746167017 // matches the fixtures' own `time`, arbitrary otherwise

  const $ = {
    clock: { now: async () => clock, every: (ms, fn) => timers.push({ ms, fn }) },
    fs: {
      read: async path => {
        if (path in files) return files[path]
        throw new Error('ENOENT ' + path)
      },
      write: async (path, text) => {
        files[path] = text
      },
    },
    env: { get: async name => (name === 'HOME' ? home : undefined) },
    session: { cwd: async () => '/fake-project' },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    plugin: { root: '/fake-plugin-root' },
    ui: {
      log: m => logs.push(m),
      invalidate: () => {},
      resolve: async () => ({ Box: 'Box', Button: 'Button', Client: 'Client', Text: 'Text' }),
    },
    http: {
      fetch: async u => {
        if (typeof u === 'string' && u.startsWith(COINGECKO_MARKETS_URL)) {
          const idx = Math.min(cgCalls.length, cgResponses.length - 1)
          cgCalls.push({ url: u, at: clock })
          const r = cgResponses[idx]
          return { status: r.status, ok: r.status >= 200 && r.status < 300, text: r.text ?? '', headers: r.headers ?? {} }
        }
        const idx = Math.min(cryptoCalls.length, cryptoResponses.length - 1)
        cryptoCalls.push({ url: u, at: clock })
        const r = cryptoResponses[idx]
        return { status: r.status, ok: r.status >= 200 && r.status < 300, text: r.text ?? '', headers: r.headers ?? {} }
      },
    },
  }

  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)
  // session.start already awaits its own boot feed() before returning - a
  // small buffer against anything unawaited, not load-bearing (same
  // convention as crypto-feed.mjs).
  await new Promise(r => setTimeout(r, 200))

  const probe = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
    return findClient(tree)?.props?.props
  }

  return { probe, cryptoCalls, cgCalls, logs }
}

// --- (1): sort:'volume' ranks by Pionex `amount` (USDT turnover), not the
// coin-count `volume` field ---------------------------------------------
{
  const { probe } = await boot({ bandConfig: { market: 'crypto', sort: 'volume' } })
  const props = await probe()
  const codes = (props?.quotes ?? []).map(q => q.code)
  ok(
    codes[0] === 'BTC' && codes[1] === 'ETH',
    `(1) sort:'volume' leads with BTC/ETH (by amount), not DOGE/ADA (by the coin-count 'volume' field) - got ${JSON.stringify(codes)}`,
  )
  const amounts = (props?.quotes ?? []).map(q => q.amount ?? 0)
  const sortedDesc = [...amounts].every((v, i) => i === 0 || amounts[i - 1] >= v)
  ok(sortedDesc, `(1) every row's amount is >= the next row's (descending) - got ${JSON.stringify(amounts)}`)
}

// --- (2): sort:'marketcap' ranks by supply(CoinGecko) x price(live), a
// genuinely different order from amount/volume --------------------------
{
  const { probe } = await boot({ bandConfig: { market: 'crypto', sort: 'marketcap' } })
  const props = await probe()
  const codes = (props?.quotes ?? []).map(q => q.code)
  ok(
    codes[0] === 'BTC' && codes[1] === 'ETH' && codes[2] === 'BNB',
    `(2) sort:'marketcap' top three are BTC/ETH/BNB - got ${JSON.stringify(codes.slice(0, 3))}`,
  )
  // the rank flip that proves this is really supply x price, not amount:
  // SOL's amount (50M) beats XRP's (5.3M), but XRP's market cap (58.5B
  // supply) beats SOL's (480M supply) - see COINGECKO_HAPPY_BODY's comment.
  ok(
    codes.indexOf('XRP') < codes.indexOf('SOL'),
    `(2) XRP outranks SOL under marketcap (higher supply x price), though SOL has the higher 'amount' - got ${JSON.stringify(codes)}`,
  )
}

// --- (3): CoinGecko failing never touches the published quotes; the sort
// falls back to volume (amount); the fallback is logged exactly once -----
{
  const { probe, logs } = await boot({
    bandConfig: { market: 'crypto', sort: 'marketcap' },
    cgResponses: [{ status: 500, text: '' }],
  })
  const props1 = await probe()
  ok(props1?.source === 'live', `(3) quotes still publish live despite CoinGecko failing (source=${props1?.source})`)
  const codes1 = (props1?.quotes ?? []).map(q => q.code)
  ok(
    codes1[0] === 'BTC' && codes1[1] === 'ETH',
    `(3) with no supply cache, marketcap falls back to volume(amount) - BTC/ETH lead, same as (1) - got ${JSON.stringify(codes1)}`,
  )

  // a second render (same tick, no clock advance - feedOnce is not
  // re-triggered) must not add a second warning; the "once per session"
  // guard is cryptoSupplyWarned, not a per-render check.
  await probe()
  const warnLogs = logs.filter(l => l.includes('CoinGecko'))
  ok(warnLogs.length === 1, `(3) the CoinGecko-unavailable fallback is logged exactly once, not once per render (got ${warnLogs.length})`)
}

// --- (4): crypto defaults to marketcap with no explicit `sort` in config -
{
  const { probe } = await boot({ bandConfig: { market: 'crypto' } })
  const props = await probe()
  const codes = (props?.quotes ?? []).map(q => q.code)
  ok(
    codes.indexOf('XRP') < codes.indexOf('SOL'),
    `(4) with no "sort" key at all, crypto still ranks XRP above SOL - the same marketcap-only signal (2) checks, proving the default really is 'marketcap' and not 'volume'/'change' (got ${JSON.stringify(codes)})`,
  )
}

// tw/us fixture watchlist for (5)/(6) - matches run-checks.sh's own
// rank-cross fixture (three codes, equal prevClose, three distinct pct) so
// the default/fallback 'change' order is unambiguous: 甲(+5%) > 乙(+2%) >
// 丙(0%). Passed as the config's own `tw` override, same as
// run-checks.sh's fixture, or the default 20-symbol TW_LIST would swamp it
// (every one of those codes reads pct=0 under this quotes file - noData).
const TW_FIXTURE_LIST = [
  { code: '1111', name: '甲', prevClose: 100 },
  { code: '2222', name: '乙', prevClose: 100 },
  { code: '3333', name: '丙', prevClose: 100 },
]

// --- (5): tw/us still default to 'change' with no explicit `sort` --------
{
  const { probe } = await boot({
    bandConfig: { market: 'tw', feed: 'off', tw: TW_FIXTURE_LIST, us: [] },
    quotesFile: {
      asOf: 1789596000000,
      market: 'tw',
      quotes: {
        1111: { price: 105, prevClose: 100, name: '甲' },
        2222: { price: 102, prevClose: 100, name: '乙' },
        3333: { price: 100, prevClose: 100, name: '丙' },
      },
    },
  })
  const props = await probe()
  const codes = (props?.quotes ?? []).map(q => q.code)
  ok(
    JSON.stringify(codes) === JSON.stringify(['1111', '2222', '3333']),
    `(5) tw with no "sort" key still ranks by 漲跌% descending (unchanged default) - got ${JSON.stringify(codes)}`,
  )
}

// --- (6): 'marketcap'/'volume' picked while on tw falls back to 'change',
// not a crash and not an unsorted/stuck list -----------------------------
{
  const { probe } = await boot({
    bandConfig: { market: 'tw', feed: 'off', sort: 'marketcap', tw: TW_FIXTURE_LIST, us: [] },
    quotesFile: {
      asOf: 1789596000000,
      market: 'tw',
      quotes: {
        1111: { price: 105, prevClose: 100, name: '甲' },
        2222: { price: 102, prevClose: 100, name: '乙' },
        3333: { price: 100, prevClose: 100, name: '丙' },
      },
    },
  })
  const props = await probe()
  const codes = (props?.quotes ?? []).map(q => q.code)
  ok(
    JSON.stringify(codes) === JSON.stringify(['1111', '2222', '3333']),
    `(6) sort:'marketcap' on tw (no amount/supply data at all) falls back to 'change' rather than an unsorted list - got ${JSON.stringify(codes)}`,
  )
  ok(props?.sorted === true, "(6) props.sorted reflects the FALLBACK ('change'), not the requested 'marketcap'")
}

// --- (7): a user-added crypto code with no CRYPTO_COINGECKO_ID entry (e.g.
// PEPE) is left out of the CoinGecko request rather than silently reading
// market cap 0, and the omission is logged exactly once ---------------------
{
  const { probe, cgCalls, logs } = await boot({
    bandConfig: { market: 'crypto', crypto: [{ code: 'BTC' }, { code: 'PEPE' }] },
  })
  await probe()
  ok(cgCalls.length === 1, `(7) fetchCryptoSupply still fires once (got ${cgCalls.length})`)
  ok(!cgCalls[0].url.includes('PEPE'), `(7) the CoinGecko request URL does not contain the unmapped code PEPE - got ${cgCalls[0].url}`)
  const pepeLogs = logs.filter(l => l.includes('PEPE'))
  ok(pepeLogs.length === 1, `(7) exactly one log line mentions the unmapped code PEPE (got ${pepeLogs.length})`)
}

done()
