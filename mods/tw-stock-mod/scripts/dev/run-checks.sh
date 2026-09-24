#!/usr/bin/env bash
# One entry point for the scripts/dev harnesses that can fail: builds
# register.tsx/board.tsx once, sets up disposable fixture projects under a
# tmpdir (never inside the repo), runs feed-idle / chart-nav / rank-cross /
# file-bars / tf-market / tf-quotes / tf-feed / tf-pnl / tabs / chart-view /
# fit-rows / pytest / feed-errors / feed-budget / crypto-feed / crypto-sort / market-select
# against them (feed-errors, crypto-feed, crypto-sort and market-select build their own stub config
# in-process instead, so they need no fixture directory) plus
# tsc (typecheck), check-engine-rules.sh, `claude plugin validate` (when the CLI is on PATH)
# and check-personal.sh, and prints a PASS/FAIL line
# per check. Exits non-zero if any of them did.
#
# rank-cross and chart-nav's "名次交叉" section once pinned the PR-a bug
# (focus/was.code tracked a table position, not a symbol); that is fixed, so
# every check here is expected to PASS.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The fetcher's pure-function suite (scripts/tests, path matrix rows 12-15) -
# this repo's own venv if it exists, else whatever python3 is on PATH.
if [[ -x "$HOME/.claude/stock-band-venv/bin/python" ]]; then
  PYTHON="$HOME/.claude/stock-band-venv/bin/python"
else
  PYTHON=python3
fi

OUT="${OUT:-${TMPDIR:-/tmp}/tw-stock-mod-dev}"
mkdir -p "$OUT"
FIXTURES="$(mktemp -d)"
cleanup() { rm -rf "$FIXTURES"; }
trap cleanup EXIT

# bun is not on every machine; `npx -y esbuild` takes the same flags
if command -v bunx >/dev/null 2>&1; then ESBUILD=(bunx esbuild); else ESBUILD=(npx -y esbuild); fi

echo "== build =="
if ! (cd "$MOD_DIR" && "${ESBUILD[@]}" hooks/register.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile="$OUT/register.js"); then
  echo "esbuild register.tsx FAILED" >&2
  exit 1
fi
if ! (cd "$MOD_DIR" && "${ESBUILD[@]}" hooks/board.tsx --bundle --format=esm --jsx-factory=h \
  --jsx-fragment=Fragment --external:claude-code --outfile="$OUT/board.js"); then
  echo "esbuild board.tsx FAILED" >&2
  exit 1
fi

# --- fixtures ----------------------------------------------------------
# feed-idle: real network, real live feed - one TW code keeps the request
# budget small. The harness itself drives a fixed, already-closed clock, so
# it does not matter when this actually runs.
mkdir -p "$FIXTURES/feed-idle/.claude"
cat > "$FIXTURES/feed-idle/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "auto",
  "twSources": ["yahoo"],
  "feedMs": 30000,
  "refreshMs": 3000,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": []
}
JSON

# chart-nav / rank-cross: three demo codes, a quotes-file override, feed off
# - no network at all, so the rank cross is driven purely by the fixture
# file, not by whatever Yahoo happens to answer this second. Two separate
# copies: both scripts rewrite the quotes file mid-run, and they run as
# separate processes but would otherwise read each other's leftover state.
write_cross_fixture() {
  local dir="$1"
  mkdir -p "$dir/.claude"
  cat > "$dir/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "sort": "change",
  "feed": "off",
  "refreshMs": 1000,
  "pageMs": 0,
  "columns": 1,
  "tw": [
    { "code": "1111", "name": "甲", "prevClose": 100 },
    { "code": "2222", "name": "乙", "prevClose": 100 },
    { "code": "3333", "name": "丙", "prevClose": 100 }
  ],
  "us": []
}
JSON
  cat > "$dir/.claude/stock-quotes.json" <<'JSON'
{
  "asOf": 1789596000000,
  "market": "tw",
  "quotes": {
    "1111": { "price": 105, "prevClose": 100, "name": "甲" },
    "2222": { "price": 102, "prevClose": 100, "name": "乙" },
    "3333": { "price": 100, "prevClose": 100, "name": "丙" }
  }
}
JSON
}
write_cross_fixture "$FIXTURES/chart-nav"
write_cross_fixture "$FIXTURES/rank-cross"

# file-bars: a quotes-file price with no bars of its own, so it has to ask
# Yahoo for K bars - real network, feed left "auto" since feedBars() itself
# is a no-op while config.feed === "off".
mkdir -p "$FIXTURES/file-bars/.claude"
cat > "$FIXTURES/file-bars/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "auto",
  "twSources": ["yahoo"],
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": []
}
JSON
cat > "$FIXTURES/file-bars/.claude/stock-quotes.json" <<'JSON'
{
  "asOf": 0,
  "market": "tw",
  "quotes": {
    "2330": { "price": 1188.0, "prevClose": 1165.0, "name": "台積電" }
  }
}
JSON

# tf-market: a project with a `futures` list (SRFJ6 beside an index alias,
# plus two invalid entries the parser must drop) and one without. Feed off,
# no quotes file: no network, and the futures rows must draw as no-data.
mkdir -p "$FIXTURES/tf-market/.claude" "$FIXTURES/tf-plain/.claude"
cat > "$FIXTURES/tf-market/.claude/stock-band.json" <<'JSON'
{
  "market": "tf",
  "feed": "off",
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [{ "code": "AAPL", "name": "Apple", "prevClose": 300 }],
  "futures": [{ "code": "TXFR1" }, {}, { "code": 5 }, { "code": "SRFJ6", "name": "小台50" }]
}
JSON
cat > "$FIXTURES/tf-plain/.claude/stock-band.json" <<'JSON'
{
  "market": "auto",
  "feed": "off",
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [{ "code": "AAPL", "name": "Apple", "prevClose": 300 }]
}
JSON

# tf-quotes: a tf-pinned project with feed "auto" (feedBars must be live so
# only the tf short-circuit keeps Yahoo out; feedMarkets is then ['tf'], which
# costs no request), and a tw project with an override quotes file that also
# names a futures code - which must never price the tf table. The harness
# writes the runtime-dir futures-quotes.json itself, stamped off its clock.
mkdir -p "$FIXTURES/tf-quotes/.claude" "$FIXTURES/tf-override/.claude"
cat > "$FIXTURES/tf-quotes/.claude/stock-band.json" <<'JSON'
{
  "market": "tf",
  "feed": "auto",
  "twSources": ["yahoo"],
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [],
  "futures": [{ "code": "TXFR1", "name": "台指近" }, { "code": "SRFJ6" }]
}
JSON
cat > "$FIXTURES/tf-override/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "off",
  "pageMs": 0,
  "tw": [
    { "code": "1111", "name": "甲", "prevClose": 100 },
    { "code": "2222", "name": "乙", "prevClose": 100 }
  ],
  "us": [],
  "futures": [{ "code": "SRFJ6" }]
}
JSON
cat > "$FIXTURES/tf-override/.claude/stock-quotes.json" <<'JSON'
{
  "asOf": 0,
  "quotes": {
    "1111": { "price": 105, "prevClose": 100, "name": "甲" },
    "2222": { "price": 102, "prevClose": 100, "name": "乙" },
    "SRFJ6": { "price": 999, "prevClose": 100 }
  }
}
JSON

# tf-feed: 美股 pinned, twSources shioaji, a `futures` list - the harness fakes
# the clock at 夜盤 and stubs fs.write / process.run, so no network and no
# real spawn; it rewrites this config per scenario (market / futures).
mkdir -p "$FIXTURES/tf-feed/.claude"
cat > "$FIXTURES/tf-feed/.claude/stock-band.json" <<'JSON'
{
  "market": "us",
  "feed": "auto",
  "twSources": ["shioaji"],
  "feedMs": 30000,
  "refreshMs": 3000,
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [{ "code": "AAPL", "name": "Apple", "prevClose": 300 }],
  "futures": [{ "code": "TXFR1", "name": "台指近" }, { "code": "SRFJ6" }]
}
JSON

# tf-pnl: the holdings-only user - a project with an EMPTY `futures` list
# (so the 期貨庫存 stop has to come from the file alone); feed off, pinned to
# 美股 so the cycle walk starts from a known stop. The harness writes the
# runtime-dir futures-holdings.json / futures-quotes.json itself and reuses
# tf-plain as the project with neither.
mkdir -p "$FIXTURES/tf-pnl/.claude"
cat > "$FIXTURES/tf-pnl/.claude/stock-band.json" <<'JSON'
{
  "market": "us",
  "feed": "off",
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [{ "code": "AAPL", "name": "Apple", "prevClose": 300 }],
  "futures": []
}
JSON

# chart-view: a tf project like tf-quotes and a tw project with feed off - the
# harness writes both quotes files itself (six-element bars + barsBy into the
# runtime dir; the old [o, h, l, c] shape into the tw project's .claude/).
mkdir -p "$FIXTURES/chart-view/.claude" "$FIXTURES/chart-view-tw/.claude"
cat > "$FIXTURES/chart-view/.claude/stock-band.json" <<'JSON'
{
  "market": "tf",
  "feed": "auto",
  "twSources": ["yahoo"],
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": [],
  "futures": [{ "code": "TXFR1", "name": "台指近" }, { "code": "MXFR1", "name": "小台近" }, { "code": "SRFJ6" }]
}
JSON
cat > "$FIXTURES/chart-view-tw/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "off",
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": []
}
JSON

# fit-rows: NO `tw` list (the built-in 20 symbols, demo prices off the
# harness's fixed clock), feed off, pageMs 0 (the harness sets it for the
# ticker section), seven tw holdings for the 損益 view.
mkdir -p "$FIXTURES/fit-rows/.claude"
cat > "$FIXTURES/fit-rows/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "off",
  "pageMs": 0,
  "us": [],
  "holdings": {
    "tw": [
      { "code": "2330", "qty": 1000, "cost": 900 },
      { "code": "2317", "qty": 2000, "cost": 150 },
      { "code": "2454", "qty": 1000, "cost": 1200 },
      { "code": "0050", "qty": 3000, "cost": 100 },
      { "code": "2412", "qty": 1000, "cost": 120 },
      { "code": "2881", "qty": 2000, "cost": 80 },
      { "code": "2603", "qty": 1000, "cost": 200 }
    ]
  }
}
JSON

# --- run -----------------------------------------------------------------
declare -a results
run_check() {
  local name="$1"; shift
  echo
  echo "== $name =="
  if "$@"; then
    results+=("PASS  $name")
  else
    results+=("FAIL  $name")
  fi
}

# cd first: scripts/tests loads fetch-quotes-shioaji.py by path (no
# pytest.ini/conftest), but the documented invocation is run from here.
run_pytest() { (cd "$MOD_DIR" && "$PYTHON" -m pytest scripts/tests -q); }

# SKIP_NETWORK=1 (CI) leaves out the two checks that hit the real Yahoo
# endpoint: a runner's IP gets 429'd or blocked often enough that a red
# there says nothing about this repo.
skip_check() { echo; echo "== $1 =="; echo "skipped (SKIP_NETWORK=1)"; results+=("SKIP  $1"); }
net_check() { if [[ "${SKIP_NETWORK:-0}" == 1 ]]; then skip_check "$1"; else run_check "$@"; fi; }

net_check "feed-idle"      node "$SCRIPT_DIR/feed-idle.mjs"   "$OUT/register.js" "$FIXTURES/feed-idle"
run_check "chart-nav"      node "$SCRIPT_DIR/chart-nav.mjs"   "$OUT/register.js" "$FIXTURES/chart-nav"
run_check "rank-cross"     node "$SCRIPT_DIR/rank-cross.mjs"  "$OUT/board.js" "$OUT/register.js" "$FIXTURES/rank-cross"
net_check "file-bars"      node "$SCRIPT_DIR/file-bars.mjs"   "$OUT/register.js" "$OUT/board.js" "$FIXTURES/file-bars"
run_check "tf-market"      node "$SCRIPT_DIR/tf-market.mjs"   "$OUT/register.js" "$FIXTURES/tf-market" "$FIXTURES/tf-plain"
run_check "tf-quotes"      node "$SCRIPT_DIR/tf-quotes.mjs"   "$OUT/register.js" "$OUT/board.js" "$FIXTURES/tf-quotes" "$FIXTURES/tf-override"
run_check "tf-feed"        node "$SCRIPT_DIR/tf-feed.mjs"     "$OUT/register.js" "$FIXTURES/tf-feed"
run_check "tf-pnl"         node "$SCRIPT_DIR/tf-pnl.mjs"      "$OUT/register.js" "$OUT/board.js" "$FIXTURES/tf-pnl" "$FIXTURES/tf-plain"
run_check "tabs"           node "$SCRIPT_DIR/tabs.mjs"        "$OUT/register.js" "$FIXTURES/tf-pnl" "$FIXTURES/tf-plain"
run_check "chart-view"     node "$SCRIPT_DIR/chart-view.mjs"  "$OUT/register.js" "$OUT/board.js" "$FIXTURES/chart-view" "$FIXTURES/chart-view-tw"
run_check "fit-rows"       node "$SCRIPT_DIR/fit-rows.mjs"    "$OUT/register.js" "$OUT/board.js" "$FIXTURES/fit-rows"
run_check "pytest"         run_pytest
run_check "feed-errors"    node "$SCRIPT_DIR/feed-errors.mjs" "$OUT/register.js"
run_check "feed-budget"    node "$SCRIPT_DIR/feed-budget.mjs" "$OUT/register.js"
run_check "crypto-feed"    node "$SCRIPT_DIR/crypto-feed.mjs" "$OUT/register.js"
run_check "crypto-sort"    node "$SCRIPT_DIR/crypto-sort.mjs" "$OUT/register.js"
run_check "market-select"  node "$SCRIPT_DIR/market-select.mjs" "$OUT/register.js"
# tsc across hooks/: the real engine types when /plugin-types has written
# them, else scripts/dev/types-stub (loose `$`, everything the mod declares
# checked for real - cross-file imports, and board.tsx's BoardProps against
# what buildProps sends).
run_typecheck() {
  local cfg="$SCRIPT_DIR/tsconfig.stub.json"
  if [[ -d "$MOD_DIR/.claude/types" || -d "$MOD_DIR/../../.claude/types" ]]; then cfg="$MOD_DIR/tsconfig.json"; fi
  echo "tsc -p ${cfg#"$MOD_DIR"/}"
  if command -v bunx >/dev/null 2>&1; then bunx -p typescript@5 tsc -p "$cfg"; else npx -y -p typescript@5 tsc -p "$cfg"; fi
}
run_check "typecheck"      run_typecheck
run_check "engine-rules"   bash "$SCRIPT_DIR/check-engine-rules.sh"
# The engine's own load-time scan of the hooks module (what it hooks, which $
# calls, and the rules esbuild and tsc accept but the host refuses - e.g. $
# passed into a function imported from another file). Needs the claude CLI;
# no login.
if command -v claude >/dev/null 2>&1; then
  run_check "plugin-validate" claude plugin validate "$MOD_DIR"
else
  echo; echo "== plugin-validate =="; echo "skipped (no claude CLI on PATH)"; results+=("SKIP  plugin-validate")
fi
run_check "check-personal" bash "$SCRIPT_DIR/check-personal.sh"

echo
echo "== summary =="
overall=0
for r in "${results[@]}"; do
  echo "$r"
  [[ "$r" == FAIL* ]] && overall=1
done
exit "$overall"
