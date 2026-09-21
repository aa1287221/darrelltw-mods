// Proves feedCrypto()'s Pionex handling against the REAL register.tsx
// (bundled), with a stub host the same shape as sources-order.mjs's but with
// a fully controllable `$.http.fetch` - crypto-feed needs canned success/
// error/429 responses on demand, not the live endpoint, so it can assert
// exact behavior instead of whatever Pionex happens to answer this second.
//
// Usage: node crypto-feed.mjs <register.js>
import { pathToFileURL } from 'node:url'
import { ok, done } from './assert.mjs'

const [, , modPath] = process.argv
globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() })
globalThis.Fragment = 'Fragment'

// Must match the literals in hooks/register.tsx - neither constant is
// exported, so this harness names them again to tell a Pionex ticker
// request apart from a CoinGecko market-cap-supply request in the shared
// $.http.fetch stub below (fetchCryptoSupply now rides the same tick as
// feedCrypto - see register.tsx's feedOnce).
const PIONEX_TICKERS_URL = 'https://api.pionex.com/api/v1/market/tickers'
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets'

// A default happy CoinGecko answer for the ten default CRYPTO_LIST codes -
// this file is not the one proving the market-cap sort (see crypto-sort.mjs
// for that), so every case here just wants fetchCryptoSupply to succeed
// quietly and never log a warning that would confuse crypto-feed's own
// assertions on `logs`.
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

// The default crypto watchlist (defaultConfig's CRYPTO_LIST) - ten codes,
// closes/opens read off Pionex on 2026-09-18/19. Every code here trades on
// Pionex for real: an earlier revision carried TON, which has no Pionex
// market at all (checked against the full ~330-symbol response), and this
// fixture invented a TON_USDT row for it - so the harness passed against a
// market that does not exist. BCH replaced it in both places. Keep this
// rule: a fixture row must correspond to a real market, or the test proves
// nothing about the real feed.
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
  // market noise: a symbol NOT on the watchlist, proving feedCrypto filters
  // the whole-exchange answer down to the configured list rather than
  // publishing everything it happens to see
  { symbol: 'SHIB_USDT', time: 1789746167017, open: '0.0000090', close: '0.0000095', high: '0.0000098', low: '0.0000088', volume: '1e12', amount: '9000000', count: 200000 },
]

const HAPPY_BODY = JSON.stringify({ result: true, data: { tickers: HAPPY_TICKERS }, timestamp: 1789746167461 })
// the exact error shape from the brief - HTTP 200, result:false
const ERROR_BODY = JSON.stringify({ result: false, code: 'MARKET_INVALID_SYMBOL', message: 'symbol error', timestamp: 1789746227 })

/**
 * Boots a fresh module instance (register.tsx keeps module-level mutable
 * state - cryptoSkipUntil, liveBy, ... - that must not leak between cases
 * sharing one process, same reason sources-order.mjs re-imports per case)
 * with a manually-driven clock and a queue of canned `$.http.fetch`
 * responses. Returns handles to probe props and advance time by hand.
 */
let moduleTick = 0
async function boot(responses) {
  moduleTick += 1
  const url = pathToFileURL(modPath)
  url.search = `?case=${moduleTick}`
  const { register } = await import(url.href)

  const home = '/fake-home'
  const files = {
    '.claude/stock-band.json': JSON.stringify({
      market: 'crypto',
      feed: 'auto',
      feedMs: 30000,
      refreshMs: 3000,
    }),
  }
  const calls = []
  const cgCalls = []
  const timers = []
  const logs = []
  let clock = 1789746167017 // matches the fixtures' own `time`, arbitrary otherwise

  const $ = {
    clock: {
      now: async () => clock,
      every: (ms, fn) => timers.push({ ms, fn }),
    },
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
      fetch: async (u, init) => {
        // fetchCryptoSupply now rides the same tick as feedCrypto (see
        // feedOnce in register.tsx) - routed to its OWN canned response and
        // its OWN call list, so it never eats an entry off `responses`/
        // `calls`, which every assertion below still reads as "the Pionex
        // ticker request" alone, same as before this sort feature existed.
        if (typeof u === 'string' && u.startsWith(COINGECKO_MARKETS_URL)) {
          cgCalls.push({ url: u, at: clock })
          return { status: 200, ok: true, text: COINGECKO_HAPPY_BODY, headers: {} }
        }
        calls.push({ url: u, init, at: clock })
        const idx = Math.min(calls.length - 1, responses.length - 1)
        const r = responses[idx]
        return { status: r.status, ok: r.status >= 200 && r.status < 300, text: r.text, headers: r.headers ?? {} }
      },
    },
  }

  const handlers = new Map()
  register((event, a, b) => handlers.set(event, typeof a === 'function' ? a : b))
  const next = async () => ({ type: 'next', props: {}, kids: [] })
  await handlers.get('session.start')($, {}, next)
  // session.start already awaits its own boot feed() before returning - a
  // small buffer against anything unawaited, not load-bearing (same
  // convention as sources-order.mjs).
  await new Promise(r => setTimeout(r, 200))

  const probe = async () => {
    const tree = await handlers.get('ui.render')($, { props: {}, surface: 'terminal', viewport: { columns: 100 } }, next)
    return findClient(tree)?.props?.props
  }

  // Advances the fake clock by `ms` and fires every registered
  // `$.clock.every` callback once, the same "the clock is yours to drive"
  // technique feed-idle.mjs uses to ask "what happens N ms later" without
  // waiting for it. Each firing is awaited, plus a short real delay for
  // anything the callback itself left unawaited (feed()'s own async chain).
  const advance = async ms => {
    clock += ms
    for (const t of timers) {
      await t.fn()
      await new Promise(r => setTimeout(r, 200))
    }
  }

  return { probe, advance, calls, cgCalls, logs, get clock() { return clock } }
}

// --- (1) & (4): happy path, ten codes, one request -------------------------
{
  const { probe, calls } = await boot([{ status: 200, text: HAPPY_BODY }])
  const props = await probe()

  ok(calls.length === 1, `(1)/(4) ten coins cost exactly one HTTP request (got ${calls.length})`)
  ok(props?.market === 'crypto', '(1) board is showing the crypto market')

  const byCode = Object.fromEntries((props?.quotes ?? []).map(q => [q.code, q]))
  const codes = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'BCH']
  const allPriced = codes.every(c => byCode[c] && byCode[c].noData !== true)
  ok(allPriced, `(1) all 10 configured coins got published (missing: ${codes.filter(c => !byCode[c] || byCode[c].noData).join(', ') || 'none'})`)

  const allNumbers = codes.every(c => typeof byCode[c]?.price === 'number' && Number.isFinite(byCode[c].price))
  ok(allNumbers, '(1) every published price is a number, not a string')

  // 漲跌 = (close - open) / open, i.e. pct/100 - a 24-HOUR change (see
  // feedCrypto's comment on prevClose), not a change-since-yesterday-close
  // the way tw/us read theirs.
  const pctOk = HAPPY_TICKERS.filter(t => t.symbol !== 'SHIB_USDT').every(t => {
    const code = t.symbol.replace('_USDT', '')
    const q = byCode[code]
    if (!q) return false
    const expected = (parseFloat(t.close) - parseFloat(t.open)) / parseFloat(t.open)
    return Math.abs(q.pct / 100 - expected) < 0.0005 // round2() on `change` leaves a little float noise
  })
  ok(pctOk, '(1) each published pct matches (close - open) / open')

  const shibLeaked = props?.quotes?.some(q => q.code === 'SHIB' || q.name === 'SHIB')
  ok(!shibLeaked, '(1) a ticker not on the watchlist (SHIB) is not published')
}

// --- (2): result:false must be treated as a failure -------------------------
{
  const { probe, calls, logs } = await boot([{ status: 200, text: ERROR_BODY }])
  const props = await probe()

  ok(calls.length === 1, '(2) the failing request still only fires once')
  ok(props?.source === 'demo', `(2) result:false published nothing live - board stayed on demo prices (source=${props?.source})`)
  ok(
    logs.some(l => l.includes('result:false')),
    '(2) the failure is logged rather than silently swallowed',
  )
}

// --- (3): a 429 sets at least a 90s cooldown, no retry inside it ------------
{
  const { probe, advance, calls } = await boot([{ status: 429, text: '' }, { status: 200, text: HAPPY_BODY }])
  ok(calls.length === 1, '(3) boot fetch fired once and got the 429')

  await advance(30_000) // +30s (< 90s cooldown)
  ok(calls.length === 1, `(3) +30s inside the cooldown: still no retry (calls=${calls.length})`)

  await advance(30_000) // +60s total (< 90s cooldown)
  ok(calls.length === 1, `(3) +60s inside the cooldown: still no retry (calls=${calls.length})`)

  await advance(29_000) // +89s total (< 90s cooldown, right at the edge)
  ok(calls.length === 1, `(3) +89s, one second short of the cooldown: still no retry (calls=${calls.length})`)

  await advance(2_000) // +91s total (past the 90s cooldown)
  ok(calls.length === 2, `(3) past 90s: the next tick retries (calls=${calls.length})`)

  const props = await probe()
  ok(props?.source === 'live' && props?.market === 'crypto', '(3) the retry after cooldown succeeds and publishes live quotes')
}

done()
