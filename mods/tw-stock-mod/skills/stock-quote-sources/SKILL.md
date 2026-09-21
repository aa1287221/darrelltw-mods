---
name: stock-quote-sources
description: Use when the user wants to change, choose, or wire where tw-stock-mod's stock prices come from — switching the feed, connecting a broker or vendor API, or asking why a price looks stale. Trigger words include 換報價來源, 接永豐, 接群益, 接 API, 即時報價, 股價來源, 換成 Yahoo, quote source, switch feed, wire shioaji, wire capital, SKCOM, real-time quotes.
---

# Wiring tw-stock-mod's quote sources

Full detail, exact JSON, exact commands, and what each route does and does
not carry: [`../../references/quote-sources.md`](../../references/quote-sources.md).
Read it before editing config — this file only routes you to the right
section.

This covers the stock (`tw`/`us`) routes only — a `futures` watchlist (`tf`
market) always routes through 永豐 with no alternative source, see the
README's [Taiwan futures (tf)](../../README.md#taiwan-futures-tf) section.

## Decision table

| What the user wants | Route |
| --- | --- |
| Just works, no setup | Yahoo — already the default for both markets |
| Real-time Taiwan prices, has a 永豐/Sinopac account (macOS/Linux) | Shioaji, `twSources: ["shioaji"]` — the band runs the fetcher itself |
| Real-time Taiwan prices, has a 群益/Capital account (Windows) | Capital, `twSources: ["capital"]` — the band runs the fetcher itself |
| Prices from their own broker or a paid vendor | The quotes-file override, fed by a script |
| Specifically 富果/Fugle | Not built in — write a small fetcher into the override (§5 of the reference) |
| Something else entirely (custom data, a simulator) | Write a fetcher into the override ("Write your own fetcher" in the reference) |

## Steps per route

**Yahoo (default).** Nothing to do. To be explicit, set
`"twSources": ["yahoo"]` in `<project>/.claude/stock-band.json`. Footer tag:
`Yahoo 即時` (US) / `Yahoo 延遲` (Taiwan, ~20 min behind).

**永豐 Shioaji, managed by the band.** Put `SINOBON_API_KEY`/`SINOBON_SECRET_KEY`
in an env file outside the repo, and set `~/.claude/stock-band.json` (NOT the
project's - see the note above) to:

```json
"twSources": ["shioaji", "yahoo"],
"shioaji": { "python": "python3", "env": "~/.sinobon.env", "interval": 10 }
```

The band spawns `scripts/fetch-quotes-shioaji.py` itself once Taiwan needs a
feed, and keeps it fed with a heartbeat file (all in the runtime dir,
`~/.claude/stock-band/<project-slug>/`, never the project's `.claude/`) —
nothing to run by hand, nothing to leave a terminal open for. `python` can
point at a venv's own interpreter (e.g. `~/some/venv/.venv/bin/python3`) if
the system `python3` does not have `shioaji` installed. Footer tag: `永豐
即時`. The same script also writes `stock-holdings.json` (runtime dir) every
tick (from `list_positions`), which is what feeds the 損益 view. First run
`<python> scripts/fetch-quotes-shioaji.py --check` to confirm the account,
env file and login all work before wiring it in.

**永豐 Shioaji, run by hand.** Same script, started yourself instead of by the
band — useful outside a Claude Code session, or to debug the feed:

```sh
python3 \
  mods/tw-stock-mod/scripts/fetch-quotes-shioaji.py \
  --project . --interval 10
```

(use whichever `python` has `shioaji` installed; `--env` defaults to
`~/.sinobon.env`). Leave it running — it holds a login session and writes
`stock-quotes.json` (and `stock-holdings.json`) into the same runtime dir on
a loop, unless `--out-dir` points somewhere else.

**群益 Capital, managed by the band.** Windows only — SKCOM is a COM DLL. Put
`CAPITAL_USER_ID`/`CAPITAL_PASSWORD` in an env file outside the repo, unzip the
SDK somewhere stable, register its 元件 once as Administrator
(`regsvr32 SKCOM.dll` in `元件d`), `pip install comtypes`, and set
`~/.claude/stock-band.json` (NOT the project's) to:

```json
"twSources": ["capital", "yahoo"],
"capital": {
  "python": "python",
  "env": "~/.capital.env",
  "dll": "~/CapitalAPI/元件/x64/SKCOM.dll",
  "interval": 10
}
```

`dll` has no default — 群益 ships a zip with no install location, so the script
refuses rather than guesses. `python` must have `comtypes` AND match the
registered 元件's bitness. The band spawns
`scripts/fetch-quotes-capital.py` itself, on the same heartbeat/pidfile
contract as Shioaji (runtime dir, nothing to run by hand); the script detaches
itself rather than via `nohup`, which Windows does not have. Footer tag:
`群益 即時`. The same script writes `stock-holdings.json` every tick from
未實現損益彙總, which is what feeds the 損益 view. First run
`<python> scripts/fetch-quotes-capital.py --check` — it walks the platform,
bitness, comtypes, the DLL path, the registration, the env file, a real login,
the quote host, every watchlist and index code, and the 證券 account, one ✅/❌
line each.

**富果 Fugle, or any other vendor.** Not wired into the module. Write a small
script that calls the vendor's API and writes
`<project>/.claude/stock-quotes.json` in the shape of
[`../../stock-quotes.example.json`](../../stock-quotes.example.json) — see
"Write your own fetcher" in the reference for the file contract, the failure
rule (a failed fetch leaves the file alone), and the rate-limit traps that hit
the built-in feed (missing `User-Agent`, cached URLs, budget vs. interval).

## Checking it took

The band's footer names its source: `Yahoo 即時` / `Yahoo 延遲` / a
fetcher's own `source` string, falling back to `報價檔` / `示範資料
（未接 API）` when nothing is fresh. If the footer still says 示範資料 after
wiring a route, the feed or the override file is not landing — check the file
is younger than 120 seconds and re-read the matching section of
`../../references/quote-sources.md`.
