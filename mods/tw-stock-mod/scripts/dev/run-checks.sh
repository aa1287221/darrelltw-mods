#!/usr/bin/env bash
# One entry point for the scripts/dev harnesses that can fail: builds
# register.tsx/board.tsx once, sets up disposable fixture projects under a
# tmpdir (never inside the repo), runs feed-idle / chart-nav / rank-cross /
# file-bars / tf-market / tf-quotes / tf-feed / tf-pnl / tabs / chart-view / pytest
# against them
# plus check-personal.sh, and prints a PASS/FAIL line per check. Exits
# non-zero if any of them did.
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

# chart-view: a tf project like tf-quotes (the harness writes its own
# six-element bars + barsBy into the runtime dir) and a tw project whose
# project-level quotes file carries the old [o, h, l, c] bars, feed off.
mkdir -p "$FIXTURES/chart-view/.claude" "$FIXTURES/chart-view-tw/.claude"
cat > "$FIXTURES/chart-view/.claude/stock-band.json" <<'JSON'
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
cat > "$FIXTURES/chart-view-tw/.claude/stock-band.json" <<'JSON'
{
  "market": "tw",
  "feed": "off",
  "pageMs": 0,
  "tw": [{ "code": "2330", "name": "台積電", "prevClose": 1000 }],
  "us": []
}
JSON
cat > "$FIXTURES/chart-view-tw/.claude/stock-quotes.json" <<'JSON'
{
  "asOf": 0,
  "market": "tw",
  "quotes": {
    "2330": {
      "price": 1188.0, "prevClose": 1165.0, "name": "台積電",
      "bars": [
        [1165.0, 1172.0, 1164.0, 1170.5], [1170.5, 1176.0, 1168.0, 1174.0],
        [1174.0, 1183.0, 1173.5, 1181.5], [1181.5, 1190.0, 1180.0, 1188.0],
        [1188.0, 1191.0, 1184.0, 1185.0], [1185.0, 1189.5, 1183.0, 1189.0],
        [1189.0, 1192.0, 1186.5, 1187.5], [1187.5, 1190.0, 1185.0, 1188.0]
      ]
    }
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

run_check "feed-idle"      node "$SCRIPT_DIR/feed-idle.mjs"   "$OUT/register.js" "$FIXTURES/feed-idle"
run_check "chart-nav"      node "$SCRIPT_DIR/chart-nav.mjs"   "$OUT/register.js" "$FIXTURES/chart-nav"
run_check "rank-cross"     node "$SCRIPT_DIR/rank-cross.mjs"  "$OUT/board.js" "$OUT/register.js" "$FIXTURES/rank-cross"
run_check "file-bars"      node "$SCRIPT_DIR/file-bars.mjs"   "$OUT/register.js" "$OUT/board.js" "$FIXTURES/file-bars"
run_check "tf-market"      node "$SCRIPT_DIR/tf-market.mjs"   "$OUT/register.js" "$FIXTURES/tf-market" "$FIXTURES/tf-plain"
run_check "tf-quotes"      node "$SCRIPT_DIR/tf-quotes.mjs"   "$OUT/register.js" "$OUT/board.js" "$FIXTURES/tf-quotes" "$FIXTURES/tf-override"
run_check "tf-feed"        node "$SCRIPT_DIR/tf-feed.mjs"     "$OUT/register.js" "$FIXTURES/tf-feed"
run_check "tf-pnl"         node "$SCRIPT_DIR/tf-pnl.mjs"      "$OUT/register.js" "$OUT/board.js" "$FIXTURES/tf-pnl" "$FIXTURES/tf-plain"
run_check "tabs"           node "$SCRIPT_DIR/tabs.mjs"        "$OUT/register.js" "$FIXTURES/tf-pnl" "$FIXTURES/tf-plain"
run_check "chart-view"     node "$SCRIPT_DIR/chart-view.mjs"  "$OUT/register.js" "$OUT/board.js" "$FIXTURES/chart-view" "$FIXTURES/chart-view-tw"
run_check "pytest"         run_pytest
run_check "check-personal" bash "$SCRIPT_DIR/check-personal.sh"

echo
echo "== summary =="
overall=0
for r in "${results[@]}"; do
  echo "$r"
  [[ "$r" == FAIL* ]] && overall=1
done
exit "$overall"
