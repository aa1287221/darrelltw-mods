#!/usr/bin/env bash
# Fails (exit 1) if any personal path, username, 永豐 account shape, TW 身分證
# shape, or the one real qty=67 fixture value leaked into the repo -
# your-venv (the old shioaji venv/env path), an absolute
# /Users/you path, the bare username, or the identifier shapes below. Run
# before every release; session-recap and the v0.10.0 doc pass both use this.
set -euo pipefail

# Repo root from this script's own location, not a hardcoded reviewer path -
# mods/tw-stock-mod/scripts/dev/check-personal.sh is four levels under it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# prototype/ is NOT excluded: it is real repo content and has carried a
# leaked personal path before (render-styles.py's hardcoded jobs-tmp file).
PERSONAL='Darrell/investment|/Users/darrellwang|darrellwang'
# 永豐 branch+account shapes (e.g. 9A95-1234567): a branch code beside
# 7-8 digits - generic on purpose, a real account number alone is just a number.
ACCOUNT='\b([0-9][A-Z][0-9]{2}|[A-Z][0-9]{6})[-_ ]?[0-9]{7,8}\b'
# Taiwan 身分證: one letter, 1 (male) or 2 (female), eight digits.
TW_ID='\b[A-Z][12][0-9]{8}\b'
# Position sizes aren't greppable in general, so this watches for the one
# real value (67 口 SRFJ6) keyed to "qty" so a coincidental 67 never matches.
QTY_67='qty["'"'"']?[[:space:]]*[:=][[:space:]]*-?67\b'
PATTERN="${PERSONAL}|${ACCOUNT}|${TW_ID}|${QTY_67}"

# --self-test scans a throwaway fixture instead of the repo, to prove the
# three patterns above actually fire rather than just "no hits found".
SEARCH_ROOT="$REPO_ROOT"
SELF_TEST=0
if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=1
  SEARCH_ROOT="$(mktemp -d)"
  trap 'rm -rf "$SEARCH_ROOT"' EXIT
fi

# A machine without rg used to fall through to "clean" on `command not found`
# (exit 127 inside `if`), so the gate passed without searching anything.
search() {
  local root="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -n "$PATTERN" "$root" \
      --glob '!node_modules' \
      --glob '!.git' \
      --glob '!**/check-personal.sh' \
      --glob '!**/scripts/dev/README.md'
  else
    grep -rnIE "$PATTERN" "$root" --exclude-dir=node_modules --exclude-dir=.git \
      | grep -vE '/check-personal\.sh:|/scripts/dev/README\.md:'
  fi
}

if [[ "$SELF_TEST" -eq 1 ]]; then
  # One file per family: a regression in any single pattern shows up on its
  # own instead of being masked by the other two still matching.
  cat > "$SEARCH_ROOT/acct.json" <<'EOF'
{ "branch": "9A95", "account": "9A95-1234567" }
EOF
  cat > "$SEARCH_ROOT/id.json" <<'EOF'
{ "holder_id": "A123456789" }
EOF
  cat > "$SEARCH_ROOT/qty.py" <<'EOF'
row = dict(code="SRFJ6", qty=-67, price=110.35)
EOF
  echo "check-personal --self-test: scanning a synthetic fixture, expect a hit per family"
  if search "$SEARCH_ROOT"; then
    echo "check-personal --self-test: caught all 3 synthetic families (exit 1, as real detection would)" >&2
    exit 1
  fi
  echo "check-personal --self-test: FAILED - missed a synthetic identifier, a pattern regressed" >&2
  exit 2
fi

if search "$SEARCH_ROOT"; then
  echo "check-personal: found personal paths above" >&2
  exit 1
fi

echo "check-personal: clean"
