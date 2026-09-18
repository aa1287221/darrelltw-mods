#!/usr/bin/env bash
# One entry point for the scripts/dev harnesses that can fail: builds
# register.tsx/board.tsx once, sets up disposable fixture projects under a
# tmpdir (never inside the repo), runs feed-idle / chart-nav / rank-cross /
# file-bars against them plus check-personal.sh, and prints a PASS/FAIL line
# per check. Exits non-zero if any of them did.
#
# rank-cross and chart-nav's "名次交叉" section once pinned the PR-a bug
# (focus/was.code tracked a table position, not a symbol); that is fixed, so
# every check here is expected to PASS.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

run_check "feed-idle"      node "$SCRIPT_DIR/feed-idle.mjs"   "$OUT/register.js" "$FIXTURES/feed-idle"
run_check "chart-nav"      node "$SCRIPT_DIR/chart-nav.mjs"   "$OUT/register.js" "$FIXTURES/chart-nav"
run_check "rank-cross"     node "$SCRIPT_DIR/rank-cross.mjs"  "$OUT/board.js" "$OUT/register.js" "$FIXTURES/rank-cross"
run_check "file-bars"      node "$SCRIPT_DIR/file-bars.mjs"   "$OUT/register.js" "$OUT/board.js" "$FIXTURES/file-bars"
run_check "check-personal" bash "$SCRIPT_DIR/check-personal.sh"

echo
echo "== summary =="
overall=0
for r in "${results[@]}"; do
  echo "$r"
  [[ "$r" == FAIL* ]] && overall=1
done
exit "$overall"
