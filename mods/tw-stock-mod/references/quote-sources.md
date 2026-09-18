# Quote sources

This page answers one question: where do the band's prices come from, and how
do you point it at a different source. The measurement log behind every claim
here — exact requests, exact bytes back, exact failures — lives in
[`docs/stock-api-notes.md`](../../../docs/stock-api-notes.md). Read this page
to choose a source; read that one to see the evidence.

Every route below writes into one of the same places the band already reads:
`hooks/register.tsx`'s built-in Yahoo feed, the runtime-dir override
file at `~/.claude/stock-band/<project-slug>/stock-quotes.json` (what
`fetch-quotes-shioaji.py` writes), or the project's own
`<project>/.claude/stock-quotes.json` as a manual override (read order:
runtime dir while fresh, then the project file, then the built-in feed).
Nothing you configure changes `hooks/board.tsx` — the band does not know or
care which route filled in a number.

## Compare the routes

| Route | Key / account | Process to keep running | Freshness | Intraday series (`spark` column) | K bars | 昨收 (previous close) | 上市/上櫃 resolution | Footer tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Yahoo** (default) | none | none | US: real-time. Taiwan: ~20 min behind | Yes, native | Yes, native | Yes | Config's own `"ex": "otc"` | `Yahoo 即時` (US) / `Yahoo 延遲` (Taiwan) |
| **Quotes-file override** | depends on what writes it | depends on what writes it | Whatever the writer promises | Only if the writer fills `series` | Only if the writer fills `bars` | Only if the writer fills `prevClose` | Handled by the writer, before the file is written | `source` string in the file, or `報價檔` if it leaves that blank |
| **永豐 Shioaji**, `twSources: ["shioaji"]` | 永豐金 brokerage account + API access | No — the band spawns and re-spawns it itself | Real intraday tick | No — the script does not fill it (unverified whether Shioaji itself carries one) | No — same | Yes (`contract.reference`) | Automatic — the SDK resolves it | `永豐 即時` |
| **Fugle 富果** (not wired) | Free Fugle membership | Whatever you write | Real intraday | Not from the one REST endpoint checked | Not from the one REST endpoint checked | Yes (`previousClose`) | Automatic — the symbol alone is enough | Whatever `source` your fetcher writes |

## Preference order and the user-level file

Taiwan's two built-in routes (Yahoo, Shioaji) are not a single choice
any more - `twSources` is an ARRAY, in preference order: `["shioaji",
"yahoo"]` tries Shioaji first, and for any tick Shioaji has nothing
fresh for (the script has not logged in yet, or died) falls through to Yahoo,
without waiting out the full 120s staleness window. The footer's
source tag always names whichever route actually answered that tick, never
the one that was merely preferred. The shipped default is `["yahoo"]` alone;
a legacy `"twSource": "x"` (singular, a string) is still read as an alias for
`["x"]`.

**Where a source order belongs: `~/.claude/stock-band.json`, not the
project's.** Which broker you have an account with, and which route you'd
rather try first, is a fact about the PERSON running the band, not about the
project - so it lives in a user-level config file that is never inside a
project and therefore never lands in version control:

```jsonc
// ~/.claude/stock-band.json
{
  "twSources": ["shioaji", "yahoo"],
  "shioaji": { "python": "python3", "env": "~/.sinobon.env", "interval": 10 }
}
```

The band reads it via `$.env.get("HOME")` and merges it UNDER whatever the
project's own `<project>/.claude/stock-band.json` says: built-in defaults <
`~/.claude/stock-band.json` < the project file, key for key (a key only the
user file states still applies; a key the project file also states wins).
Any key is legal in either file - `twSources`/`shioaji` are simply the ones
that most belong in the user-level one, so a shared project's config stays
neutral and every contributor keeps their own order without editing a
tracked file.

## 1. Yahoo (default)

No key, no account, nothing to run. This is what the band uses out of the box
for both markets.

**What it does and does not carry.** One `spark` request answers the whole
watchlist plus the market's indices — current price, previous close, the
day's 5-minute closes (`indicators.quote[0].close[]`, what feeds the `spark`
trend column), and `regularMarketTime` (the exchange's own clock, printed as
更新). A separate `chart` request per symbol answers OHLC bars for the `kbar`
column and the trend view.

**Freshness.** US quotes are real-time. Taiwan quotes through Yahoo run about
20 minutes behind the exchange's own tape. Real intraday Taiwan prices are
available through a 永豐 brokerage account instead (§3).

**Turn it on.** Nothing to do — it is the default for both markets. To be
explicit about it in `<project>/.claude/stock-band.json`:

```jsonc
{ "twSources": ["yahoo"] }
```

**How to tell it took.** The footer reads `Yahoo 即時` on the US board and
`Yahoo 延遲` on the Taiwan board — the label itself says which market and
whether the number is live or 20 minutes old.

**Limits worth knowing before you touch `feedMs`.** A `spark` request caps at
20 symbols — a 21st gets `Number of symbols needs to be less than or equal to
20` back, so a full watchlist plus indices costs two requests, not one. No
official rate limit is published; the community number is roughly 360
requests/hour, and the band's own budget of 300/hour (see §5) sits under it on
purpose.

## 2. The quotes-file override

**Two files, one seam.** `fetch-quotes-shioaji.py` (and the band, when it
spawns it) writes `~/.claude/stock-band/<project-slug>/stock-quotes.json`,
which wins while fresh; `<project>/.claude/stock-quotes.json` is the
hand-editable seam below, and wins over the built-in feed whenever the
runtime-dir file is not fresh. Write `<project>/.claude/stock-quotes.json` in
the shape of [`stock-quotes.example.json`](../stock-quotes.example.json), and
the band uses it instead of Yahoo — **this is the seam for any source
the module does not speak natively**, including Shioaji (§3) and Fugle (§4).

**The contract.** A file with these keys:

```jsonc
{
  "asOf": 1757900000000,        // when this file was written, ms epoch
  "dataAt": 1757900000000,      // when the prices traded — printed as 更新
  "market": "tw",               // informational; the band still picks the market off the clock
  "source": "永豐 即時",         // names itself in the footer instead of 報價檔
  "barLabel": "5 分 K",
  "quotes": {
    "2330": {
      "price": 1188.0,
      "prevClose": 1165.0,
      "name": "台積電",
      "series": [1166.0, 1170.5, /* … */ 1188.0],   // recent closes, oldest first — feeds `spark`
      "bars": [[1165.0, 1172.0, 1164.0, 1170.5], /* … */]  // [open, high, low, close], oldest first
    }
  },
  "index": { "value": 24340.24, "change": 288.54, "pct": 1.2 },
  "indices": [{ "name": "TAIEX", "value": 24340.24, "change": 288.54, "pct": 1.2 }]
}
```

Only `code` → `price` is required per quote; everything else is optional and
each field is independent — you can hand over prices with no series and no
bars, and the band just draws a plainer row. `indices` (plural) is what the
footer's split-flap index board flips through; `index` (singular) is the
older single-index shape and still works.

**Freshness rule.** Older than 120 seconds, malformed, or missing, and the
band ignores the file and falls back to whatever the built-in feed has (or to
demo prices if neither is fresh). There is no partial trust — a stale file is
treated exactly like no file.

**How to tell it took.** The footer shows whatever string you put in
`source`; leave it out and it falls back to `報價檔`.

## 3. 永豐 Shioaji, through `scripts/fetch-quotes-shioaji.py`

**What you need:**

- A 永豐金 brokerage account with the API enabled and 簽署中心's "Python API
  測試" passed.
- A Python 3.12 or 3.13 venv with `shioaji` installed (the SDK caps at Python
  3.13; one working combination measured here was Python 3.12.6, shioaji
  1.7.2).
- `SINOBON_API_KEY` / `SINOBON_SECRET_KEY` in `~/.sinobon.env` (`--env`'s
  default) or another env file outside the repo.
- macOS or Linux — the band spawns the script with `nohup`, which Windows
  does not have.
- **Run `<python> scripts/fetch-quotes-shioaji.py --check` first.** It
  diagnoses the Python version, the `shioaji` install, the env file, a real
  login, and the platform, then exits without writing anything. An HTTP 406
  on login means 簽署中心's own test was never passed.
- **A long-lived process.** `api.login()` takes seconds and holds a session —
  measured: `api.usage()` after login reports `connections=1,
  limit_bytes=524288000`. Calling it every 30 seconds the way the built-in
  feed calls Yahoo means logging in and out every 30 seconds, which is
  not what a broker session is for.

**Why this cannot live inside the hooks module.** Yahoo is one
HTTP GET — `$.http.fetch` calls it directly. Shioaji is a Python SDK; the
hooks module runs in a JS sandbox and can only reach it through `$.process`.
And there is no 永豐 CLI to spawn per-tick anyway: `pip install shioaji`
installs a `shioaji` command, but running it only prints `Hello from
shioaji!` — it is a placeholder entry point (`shioaji/__init__.py:18`), not an
interface. The SDK's Python API is the whole interface, so a script that logs
in once and stays running is the shape that fits, writing the override file
from §2 on a loop.

**Turn it on, managed by the band.** Put `"twSources": ["shioaji", ...]` and
the `shioaji` block in `~/.claude/stock-band.json` (not the project's - see
[Preference order and the user-level file](#preference-order-and-the-user-level-file) above):

```jsonc
// ~/.claude/stock-band.json
{
  "twSources": ["shioaji", "yahoo"],
  "shioaji": { "python": "python3", "env": "~/.sinobon.env", "interval": 10 }
}
```

Once Taiwan needs a feed, `hooks/register.tsx`'s `feedTwShioaji` runs this
same script itself, detached (`$.process.run(['/bin/sh', '-c', 'nohup ... &'],
...)` — the `nohup`/`&` wrapper is what lets a one-shot `run()` call return
while the script keeps going past it; see the function's own comment for why).
The band and the script then talk over two files instead of a socket:

- **The heartbeat** (`stock-band.heartbeat`, in the runtime dir
  `~/.claude/stock-band/<project-slug>/` — never the project's `.claude/`) —
  the band rewrites it every feed tick it wants Taiwan prices; the script
  exits by itself once that file is missing or more than 90 seconds old, so
  a closed band or a switch to the US board does not leave a login running
  forever.
- **The pidfile** (`stock-shioaji.pid`, same runtime dir) — a second Claude
  Code session on the same project sees a live pid there and exits at once
  instead of logging in twice for the same watchlist.

Respawn is rate-limited on the band's side too: once at session start, then
only when the quotes file has gone stale (>120s) AND the last spawn attempt
was more than 60 seconds ago — never more than once a minute. Whether or not
a respawn was attempted, a stale tick makes `feedTwShioaji` report "nothing
fresh" for that tick, and `feedTw`'s dispatcher falls through to the NEXT
entry in `twSources` (e.g. `yahoo`) rather than waiting out the staleness
window - this covers a missing `python`, a missing env file, or a dead login
the same way, since all three look identical from here (the quotes file just
never gets fresher). With only `["shioaji"]` configured, a stale tick falls
all the way back to demo prices instead, the same as any other feed running
dry. Script output goes to `stock-shioaji.log`, same runtime dir, not to the
band's own debug log.

**Turn it on by hand**, the same script, started yourself:

```sh
python3 \
  mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
  --project . --interval 10
```

(use whichever python has `shioaji` installed — a venv's `bin/python3` if
that is where you `pip install shioaji`, not necessarily the bare `python3`
above; `--env` defaults to `~/.sinobon.env`)

It reads the same `tw` watchlist out of `<project>/.claude/stock-band.json`,
so there is nothing else to configure. Stop it with Ctrl-C; the band falls
back to its own feed 120 seconds after the file goes stale. `--heartbeat` and
`--pidfile` are optional here — they only matter when the band itself is the
one spawning the process.

**What it carries.** `api.snapshots()` gives current price, and
`contract.reference` gives 昨收 in the broker's own terms — this stays correct
through an ex-dividend date, unlike a plain "yesterday's close".
`snapshot.close` is always the last trade and never reads
`-`, so there is no between-trades gap to patch. 上市/上櫃 resolves itself —
the script does not need an `"ex": "otc"` hint the way Yahoo does.

**The timestamp trap.** `snapshot.ts` is nanoseconds, but Shioaji stamps it
with **Taipei wall-clock time counted as if it were UTC** — a snapshot taken
at 10:55 comes back reading 18:55, exactly 8 hours ahead. The script
subtracts a constant 8-hour offset before writing `dataAt`; anything else
reading `snapshot.ts` directly has to do the same subtraction, or the band
prints `更新 18:55` for a 10:55 snapshot.

**How to tell it took.** The footer reads `永豐 即時` (the script sets
`"source": "永豐 即時"` in the file it writes).

**Holdings.** The script also calls `api.list_positions()` every tick and
writes `<project>/.claude/stock-holdings.json` — see §5. Its quotes fetch
covers the watchlist UNION every held code, so a holding that never made the
watchlist still gets a live price there too, which the 損益 view prefers over
the holdings file's own `price`/`prevClose`.

**Futures.** The same script also prices a `futures` watchlist (`tf` market)
off `api.Contracts.Futures[code]` — month codes or `R1`/`R2` aliases both
resolve — and writes `futures-quotes.json`/`futures-holdings.json` the same
way, with `multiplier`/`decimal_locator`/`reference` always read from the
contract rather than a lookup table. This route is `tf`'s only source: there
is no Yahoo or MIS fallback, so a stale file shows `無報價`, not a demo walk.
See the README's [Taiwan futures (tf)](../README.md#taiwan-futures-tf).

## 4. Fugle 富果 and other keyed vendors (not wired)

Fugle is not built into the module. Route 2 (the quotes-file override) is how
it — or any other vendor with a key — reaches the band; nobody has written
that fetcher yet. What it has to do:

- **Get its own API key.** Fugle's free tier needs only a Fugle membership,
  not a brokerage account — that requirement is for the *trading* API, not
  the market-data one.
- **Call Fugle's intraday quote endpoint per symbol.** The free REST tier has
  no batch/snapshot endpoint, so a 20-symbol watchlist costs 20 requests per
  refresh, and the endpoint caps at 60 requests/minute. A full watchlist
  refresh under that cap lands far slower than a single batched Yahoo request
  for the same 20 symbols — do not expect sub-minute updates from this route
  without a paid tier.
- **Map Fugle's fields onto the quotes-file contract from §2**: its quote
  response's last price, previous close and quote timestamp become that
  symbol's `price`, `prevClose` and the file's `dataAt`.
- **Respect Fugle's terms**, which matter more here than for Yahoo
  because Fugle actually publishes them: no forwarding market data to a third
  party, and one Fugle account per user — a plugin cannot embed a shared key
  and proxy requests for everyone who installs it. Each user who wants this
  route has to get their own key and run their own fetcher.
- Set `"source"` to something that says so, e.g. `"富果 即時"`, so the footer
  does not claim `報價檔` with no indication of where the numbers came from.

Fugle resolves 上市/上櫃 by symbol alone — its data source already spans both
the exchange and 櫃買中心, so a fetcher does not need an `"ex"` hint the way
Yahoo does.

## 5. The holdings file and the 損益 view

`stock-holdings.json` is what the 損益 button reads — positions, not
watchlist prices. `scripts/fetch-quotes-shioaji.py` writes it every tick
after `list_positions` (§3) into the runtime dir
(`~/.claude/stock-band/<project-slug>/`), which wins whenever it parses;
`<project>/.claude/stock-holdings.json` is the manual override, and anything
else can write either one by hand or from its own fetcher, in the shape of
[`../../stock-holdings.example.json`](../../stock-holdings.example.json):

```jsonc
{ "asOf": 1757900000000, "market": "tw", "source": "手動庫存",
  "holdings": [ { "code": "2330", "name": "台積電", "qty": 1000, "cost": 980.5, "price": 1188.0, "prevClose": 1165.0 } ] }
```

`qty` is shares (股), not 張. `cost` is the average cost per share.
`price`/`prevClose` are optional — the band prefers a live quote for that
code first (see the UNION note in §3) and only falls back to these when
nothing priced that code. `source` is free text for the footer/title, but a
project-path file written by hand must never carry `"source": "永豐 庫存"`
— that label is reserved for `fetch-quotes-shioaji.py`'s own output (§3), and
the band treats a project-path file with that exact source as a stale copy
of the fetcher's pre-runtime-dir output and ignores it.

**No staleness rule.** Unlike the quotes file, this one is never expired by
age: a position does not go wrong just because nobody wrote a fresh copy in
the last two minutes. `asOf` still shows on the pnl board's title row.

**Manual alternative**, no file at all: a `holdings` block in
`stock-band.json` —

```jsonc
{ "holdings": { "tw": [ { "code": "2330", "qty": 1000, "cost": 980.5 } ], "us": [] } }
```

The holdings file wins over this block for whichever market it names (its
own `market` field, or every market if it leaves that out); a market the
file does not cover falls back to the config block.

## Write your own fetcher

Any source not listed above — another vendor, a spreadsheet, a paper-trading
simulator — reaches the band the same way Shioaji does: write
`<project>/.claude/stock-quotes.json` in the §2 shape, on whatever schedule
your source supports.

**The file contract**, restated: `asOf` and `dataAt` in epoch milliseconds,
`quotes` keyed by the same codes as the watchlist, `price` required and
everything else optional, `source` to name yourself in the footer.

**The failure rule.** A failed fetch must leave the file alone rather than
write a stale price back into it. The band already treats a file older than
120 seconds as gone and falls back to a live feed or demo prices — writing a
fresh `asOf` with old numbers defeats that safety net and makes a stale price
look live.

**Rate-limit facts that bit the built-in feed, and will bite a custom one the
same way:**

- **A request with no browser `User-Agent` gets `429`** on the very first
  try against Yahoo, and the ban lasts on the order of minutes once it hits.
  Send a real browser UA string on every request.
- **A repeated URL comes back cached, byte-identical, with a frozen price** —
  measured six ticks over 80 seconds returning the same body. Carry a
  `_=<timestamp>` query parameter and `Cache-Control: no-cache` /
  `Pragma: no-cache` headers on every request so each one is a distinct URL.
- **The feed enforces a 300 requests/hour budget, not just an interval.**
  `feedMs` alone cannot bound the request rate once one tick costs more than
  one request (a wide watchlist split across two `spark` calls, or the K-bar
  column adding a per-symbol request) — a fetcher polling on a fixed interval
  has to account for its own per-tick request count against whatever budget
  its source actually allows, the same way the built-in feed works out its
  interval from `REQUESTS_PER_HOUR` rather than trusting `feedMs` alone.
