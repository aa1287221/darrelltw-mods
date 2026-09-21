# dev harnesses

Run the real `hooks/register.tsx` and `hooks/board.tsx` against a stub host and
the real endpoints, outside Claude Code. Every bug fixed on 2026-09-16 was
found with these rather than by reading the diff — the band draws into a
terminal surface that a screenshot only samples once, so "it looks wrong" is
never enough to act on.

`check-personal.sh` is separate from the harnesses above - it `rg`s the whole
repo for personal paths (`your-venv`, `/Users/you`,
the bare username) and exits 1 on any hit; run it before every release.

`assert.mjs` is a two-function helper (`ok(cond, msg)`, `done()`) that turns a
harness's printed output into a real pass/fail: `ok` prints `ok `/`FAIL ` and
sets `process.exitCode = 1` on a miss, `done()` prints the final tally.
`feed-idle.mjs`, `chart-nav.mjs`, `rank-cross.mjs`, the four `tf-*.mjs`
harnesses (`tf-market`, `tf-quotes`, `tf-feed`, `tf-pnl`), `tabs.mjs`,
`chart-view.mjs`, `fit-rows.mjs`, `crypto-feed.mjs`, `crypto-sort.mjs` and
`market-select.mjs` use it - they are the harnesses this exits non-zero on a
real regression, alongside `pytest` for the fetcher's own pure functions.
`board-harness.mjs`, `frames.mjs`, `file-bars.mjs` and the rest still just
print for a human to read; `run-checks.sh` below runs `file-bars.mjs` too but
only as a smoke test (it always exits 0), not as an assertion.

`run-checks.sh` is the one entry point that runs the asserting harnesses
end-to-end against disposable fixtures (never against your real project) and
exits non-zero if anything failed - see its own section below.

## Build first

```sh
OUT=/tmp/tw-stock-mod-dev
bunx esbuild hooks/register.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile=$OUT/register.js
bunx esbuild hooks/board.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile=$OUT/board.js
```

`<proj>` below is a directory holding `.claude/stock-band.json` (and optionally
`.claude/stock-quotes.json`) — the real project works, and so does a throwaway
one with just a config in it.

Whatever `$` stub a harness builds, `session.start` now reads `$.env.get`
and `$.session.cwd` unconditionally (no optional chaining) to resolve
`~/.claude/stock-band.json` and the runtime dir - a stub missing either one
throws before it draws a single frame. `chart-nav.mjs` and `feed-idle.mjs`
were both missing them (stale since before that read was added) until this
pass; `board-harness.mjs` and `file-bars.mjs` already had the right shape -
copy theirs if you add a new harness.

## What each one answers

| script | question | usage |
| --- | --- | --- |
| `harness.mjs` | what props does the feed actually build? prices, indices, source tag, K bars | `node harness.mjs $OUT/register.js <config.json> [ticks]` |
| `board-harness.mjs` | what do the rows look like, as text | `node board-harness.mjs $OUT/board.js $OUT/register.js <proj>` |
| `frames.mjs` | does the animation play, and what does each frame look like | `node frames.mjs $OUT/board.js $OUT/register.js <proj> <seconds>` |
| `remount.mjs` | does a remounted board install its own frame clock | `node remount.mjs $OUT/board.js <props.json>` |
| `snooze.mjs` | does 收起 30分 then 展開 leave the band without a frame clock | `node snooze.mjs $OUT/board.js $OUT/register.js <proj>` |
| `switch.mjs` | does pressing the other market's tab fetch the market it lands on (stale: its stub lacks `env`/`session`, see above) | `node switch.mjs $OUT/register.js <config.json>` |
| `page-reset.mjs` | does pressing 翻頁 push the auto-page deadline out | `node page-reset.mjs $OUT/register.js <proj> <press-at-ms>` |
| `chart-nav.mjs` | do 上一檔／下一檔／回清單 move the focus and wrap **(asserts)**; also pins the PR-a 名次交叉 bug (see below) | `node chart-nav.mjs $OUT/register.js <proj>` |
| `click-to-chart.mjs` | does clicking a table row open that symbol's chart | `node click-to-chart.mjs $OUT/board.js $OUT/register.js <proj> [columns]` |
| `real-click.py` | does a REAL click in a REAL Claude Code open the chart | `python3 real-click.py <proj> [x] [row] [--plugin-dir <path>]` |
| `feed-idle.mjs` | does a closed market stop being polled, and does its snapshot still hold **(asserts)** | `node feed-idle.mjs $OUT/register.js <proj>` |
| `feed-open-snooze.mjs` | does an open market still get polled, and does 收起 stop it | `node feed-open-snooze.mjs $OUT/register.js <proj>` |
| `rank-cross.mjs` | when two symbols' 漲跌幅 cross in rank, does the table mark the row that changed occupant with `was.code` **(asserts; pins the PR-a fix, see below)** | `node rank-cross.mjs $OUT/board.js $OUT/register.js <proj>` |
| `tf-market.mjs` | 台指期 sessions (日盤/夜盤 across midnight and the weekend), the auto pick, the 台指期 cycle stop, no-data rows with no quotes source, and a project without `futures` unchanged **(asserts)** | `node tf-market.mjs $OUT/register.js <proj-with-futures> <proj-without>` |
| `tf-quotes.mjs` | does a runtime-dir `futures-quotes.json` price the 台指期 table (永豐 footer, 5 分 K（永豐）, per-row decimals, alias → resolved month), feed the chart without a Yahoo request, and go no-data once stale; does the stock override stay as it was **(asserts)** | `node tf-quotes.mjs $OUT/register.js $OUT/board.js <tf-proj> <tw-proj>` |
| `tf-feed.mjs` | with 美股 on screen during 夜盤, is the heartbeat still written every feed tick naming `tf`; is the fetcher spawned once with both `--codes` and `--futures` (also during 台股 hours, also as `--futures ""` without a list); does a Yahoo back-off leave the heartbeat alone; does a project without `futures` write no heartbeat at night **(asserts)** | `node tf-feed.mjs $OUT/register.js <proj>` |
| `tf-pnl.mjs` | does a runtime-dir `futures-holdings.json` add the 期貨庫存 stop (with an empty `futures` list too), price each position × its multiplier in 口 at the contract's decimals with 紅漲綠跌, prefer a fresh `futures-quotes.json` over the file's own prices, sort by every key and page like 台股庫存; does the stop go with the file, and a project with neither stay as it was **(asserts)** | `node tf-pnl.mjs $OUT/register.js $OUT/board.js <holdings-proj> <plain-proj>` |
| `chart-view.mjs` | the chart view (#12): 16 rows by default, `chartRows` config and the `maxRows − 2` clamp (the harness passes `maxRows` as the AbovePrompt props, which the stubs other than `fit-rows.mjs` leave `{}`), y labels unique and strictly decreasing with the 昨結 dotted line + label and the filled last-price tag (a 2-point range at 0 decimals pins the rounded-duplicate case), x labels from bar timestamps (no 15:00/05:00 for 19:40–23:00 bars; first/last/round ticks; 60 分 bars across two sessions draw the boundary rules), stride 2 → 1 at 120 bars, volume rows at 16 and none at 8, `1分 5分 15分 60分` switching bars + label, `曲線` braille + shade remembered per market, the title readout, a row without `barsBy` and a stock row with old `[o, h, l, c]` bars (session axis, no timeframe buttons), and the control row unchanged with no bars **(asserts)**. Writes both quotes files itself (six-element bars + `barsBy` into the tf runtime dir, four-element into the tw project) | `node chart-view.mjs $OUT/register.js $OUT/board.js <tf-proj> <tw-proj>` |
| `fit-rows.mjs` | the band fitting itself to the host (#13): with `maxRows` 20/9/7/5/4/3 the tree (button row + Client) fits in every view - the table's quote rows shrink 5 → 3, the 5/4-row compact layout puts the titles on the rule and the clock + source tag in the button row, 3 rows is the one-line ticker (`趨勢圖` gone, `翻頁` kept) that rotates on `pageMs` with `was.code` on every cell; 損益 pages by its reduced rows and falls to the ticker under 4, the chart keeps its 8-row floor and falls to the ticker under it; `columns: "auto"` picks 4/3/2/1 columns at `bodyColumns` 190/130/100/74 (76 → 1, 77 → 2) with 20 symbols, an explicit `columns: 2` still forces 2, a 3-symbol list stays single-column at 190; and a stub host with no `maxRows` keeps today's 8-row two-column board **(asserts)**. Passes `maxRows`/`bodyColumns` as the AbovePrompt props and no viewport, so `bodyColumns` has to be what sizes the band | `node fit-rows.mjs $OUT/register.js $OUT/board.js <proj>` |
| `tabs.mjs` | the market tab row (#9): three tabs without futures/US holdings, five with a futures list + tf positions, six with US holdings too (keys `stock-band:tab:<market>[:pnl]`, plain, the selected one `[label]` and the rest dim); does each tab land on its own market + view in one press, does the mark move with it, does the tab row stay in chart view and a tab leave the chart; a 130→60 column sweep showing sessionNote → taipeiNote → badge give way before any tab **(asserts)** | `node tabs.mjs $OUT/register.js <holdings-proj> <plain-proj>` |
| `crypto-feed.mjs` | does Pionex's ticker endpoint get parsed right: `result:false` treated as failure (never a price), a 429 holding off for the cooldown with no retry inside it, and a ten-coin watchlist costing one request a tick **(asserts, no fixture directory needed - builds its own stub config in-process)** | `node crypto-feed.mjs $OUT/register.js` |
| `crypto-sort.mjs` | the `'volume'`/`'marketcap'` sort keys: `'volume'` ranks by Pionex's `amount` (USDT turnover), never the coin-count `volume` field; `'marketcap'` ranks by CoinGecko's cached circulating supply x live price, with a rank flip that proves it is not just amount in disguise; a CoinGecko failure still publishes quotes live and falls back to volume, logged once; crypto defaults to `'marketcap'`, tw/us still default to `'change'`, and `'marketcap'`/`'volume'` picked on tw falls back to `'change'` rather than drawing unsorted **(asserts, no fixture directory needed - builds its own stub config in-process)** | `node crypto-sort.mjs $OUT/register.js` |
| `market-select.mjs` | the market control itself: terminal draws a `Select` (five options now - 台股/台股庫存/美股/美股庫存/加密貨幣, the holdings/pnl stop folds into the same dropdown instead of a separate Button, value packs market+view together) rather than the old cycle `Button`; picking crypto switches the board AND fires its fetch immediately, not on the next tick; a resolved table with no `Select` falls back to the cycle `Button` and it still cycles; no independent holdings Button exists anywhere, on any market **(asserts, no fixture directory needed - builds its own stub config in-process)** | `node market-select.mjs $OUT/register.js` |

## The clock is yours to drive

`feed-idle.mjs` and `feed-open-snooze.mjs` replace `$.clock.now` with a variable
they push forward by whole minutes and call every registered `$.clock.every`
callback by hand. That is the only way to ask "what happens two hours after the
close" or "what happens at 10:30 on a trading Wednesday" without waiting for it,
and it is how the market-hours behaviour was measured rather than argued about.
`feed-open-snooze.mjs` hard-codes 2026-09-16T10:30+08:00 — move that date to a
weekday inside Taiwan hours if you re-run it much later.

Both count `$.http.fetch` calls, so the number they print is requests actually
made against the real endpoint, not an estimate.

## Two things the stubs get wrong on purpose

- `$.clock.every` callbacks are fire-and-forget in the host too, so a test that
  calls one has to `await` a real timeout afterwards or it reads the state from
  before the fetch landed.
- `frames.mjs` redraws on its own 50 ms loop rather than waiting for the board's
  `setState`, so it shows every frame the board *could* draw. That is what makes
  it the right tool for "is the animation correct" and the wrong one for "does
  the host paint it" — `remount.mjs` and `snooze.mjs` cover the second.

## PR-a: focus and was.code tracked a table position, not a symbol (fixed)

`chart-nav.mjs`'s 名次交叉 section and `rank-cross.mjs` both pin down the same
bug, from two angles - now fixed in `hooks/register.tsx`, so both assert
green; this stays here as the regression guard and the reason they assert
what they do:

- `buildProps` re-sorts `quotes` by `pct` on every render when `cfg.sort ===
  'change'` (the default), and `focus` (chart view) used to be a plain index
  into that array - `props.quotes[props.focus]`. When two symbols' 漲跌幅
  crossed in rank, the sort reordered them and the SAME `focus` index then
  pointed at a different symbol, so the chart view silently jumped to
  whichever symbol had just moved into that slot. `focusCode` is now tracked
  by the symbol's own code (module state in `hooks/register.tsx`) and
  re-resolved to a page/index every render, so a rank cross can no longer
  move the chart out from under it.
- The table view's flip animation is supposed to mark a row that just
  changed occupant with `was.code`/`was.name`, the same way a page turn does
  (`pageFrom` in `buildProps`). That assignment used to fire only inside
  `setPage`, so a rank cross with no accompanying page turn (the only case a
  short, single-page watchlist can ever hit) set no `was` at all - the code
  column changed with no flip and no flag. `buildProps` now also compares
  each rendered row against `lastShown`'s row at the same position and
  attaches `was` on a bare occupant change, independent of `setPage`.

## run-checks.sh

```sh
bash scripts/dev/run-checks.sh
```

Builds `register.js`/`board.js` into `$OUT` (default
`${TMPDIR:-/tmp}/tw-stock-mod-dev`) with `bunx esbuild`, falling back to
`npx -y esbuild` (same flags) on a machine without bun; writes disposable
fixture projects under a `mktemp -d` (never inside the repo, never touching
your real project or `~/.claude`); runs `feed-idle.mjs` → `chart-nav.mjs` →
`rank-cross.mjs` → `file-bars.mjs` → `tf-market.mjs` → `tf-quotes.mjs` →
`tf-feed.mjs` → `tf-pnl.mjs` → `tabs.mjs` → `chart-view.mjs` → `fit-rows.mjs`
→ `pytest` (`scripts/tests`, via `~/.claude/stock-band-venv/bin/python` when
present, else `python3`) → `crypto-feed.mjs` → `crypto-sort.mjs` →
`market-select.mjs` → `check-engine-rules.sh` → `check-personal.sh` in that
order, and prints a `PASS`/`FAIL` line per check. Exits non-zero if any of
them did.

Every check here is expected to `PASS` - PR-a above was the one standing
exception and is now fixed. `feed-idle` and `file-bars` hit the real Yahoo
endpoint (see "The clock is yours to drive" above), so a `FAIL` on either one
there is worth checking against the network before assuming it's a real
regression. `crypto-feed`, `crypto-sort` and `market-select` hit no network
at all (their own `$.http.fetch` stub answers canned responses), so a `FAIL`
in any one of them is never a network fluke.

## The stub host cannot answer everything

`real-click.py` opens a real Claude Code in a pty, waits for the band, sends a
real SGR mouse click and reads the screen back with `pyte` (`pip install --user
pyte`). It exists because on 2026-09-16 every stub-host harness passed while the
feature did nothing in the real app: the `ui.message` event reports `e.module` as
`hooks/board.tsx`, and the hook was comparing it against the `./board.tsx`
literal the `Client` prop carries. The stub host never had an opinion about that
string, so it could not catch it.

Rule of thumb: the `.mjs` harnesses prove the module's own logic; this one proves
the engine and the module agree on what they hand each other.
