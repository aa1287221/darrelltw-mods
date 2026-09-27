#!/usr/bin/env bash
# Fails (exit 1) if any personal path, username, 永豐 account shape, TW 身分證
# shape, or the one real qty=67 fixture value leaked into the repo -
# your-venv (the old shioaji venv/env path), an absolute
# /Users/you path, the bare username, or the identifier shapes below. Run
# before every release; session-recap and the v0.10.0 doc pass both use this.
# Exit 2 means the search itself failed - never read that as clean.
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

# --self-test scans throwaway fixtures instead of the repo, to prove every
# pattern family actually fires rather than just "no hits found".
SEARCH_ROOT="$REPO_ROOT"
SELF_TEST=0
if [[ "${1:-}" == "--self-test" ]]; then
  SELF_TEST=1
  SEARCH_ROOT="$(mktemp -d)"
  trap 'rm -rf "$SEARCH_ROOT"' EXIT
fi

# A machine without rg used to fall through to "clean" on `command not found`
# (exit 127 inside `if`), so the gate passed without searching anything.
#
# Status: 0 = hits (printed), 1 = clean, 2 or more = the search itself failed.
# `if search` alone read an rg error (a bad pattern, an unreadable path) as
# "no hits" and passed. `--hidden`: rg skips dot-directories by default,
# which left .github/ and .claude-plugin/ unscanned; .git itself stays
# excluded, and gitignored files never ship, so they are not scanned.
search() {
  local root="$1" status hits
  if command -v rg >/dev/null 2>&1; then
    rg -n --hidden "$PATTERN" "$root" \
      --glob '!node_modules' \
      --glob '!.git' \
      --glob '!**/check-personal.sh' \
      --glob '!**/scripts/dev/README.md' && status=0 || status=$?
    return "$status"
  fi
  hits="$(grep -rnIE "$PATTERN" "$root" --exclude-dir=node_modules --exclude-dir=.git)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] || return "$status"
  hits="$(printf '%s\n' "$hits" | grep -vE '/check-personal\.sh:|/scripts/dev/README\.md:' || true)"
  [[ -n "$hits" ]] || return 1
  printf '%s\n' "$hits"
}

if [[ "$SELF_TEST" -eq 1 ]]; then
  # One fixture per family, each searched on its own: a regression in any
  # single pattern fails the self-test instead of being masked by the others
  # still matching. The personal-path fixture sits in a dot-directory, so
  # --hidden is under test too.
  mkdir -p "$SEARCH_ROOT/acct" "$SEARCH_ROOT/id" "$SEARCH_ROOT/qty" "$SEARCH_ROOT/path/.github"
  printf '%s\n' '{ "branch": "9A95", "account": "9A95-1234567" }' > "$SEARCH_ROOT/acct/acct.json"
  printf '%s\n' '{ "holder_id": "A123456789" }' > "$SEARCH_ROOT/id/id.json"
  printf '%s\n' 'row = dict(code="SRFJ6", qty=-67, price=110.35)' > "$SEARCH_ROOT/qty/qty.py"
  printf 'venv: /Users/%s/venv\n' "darrellwang" > "$SEARCH_ROOT/path/.github/ci.yml"
  echo "check-personal --self-test: scanning synthetic fixtures, expect a hit in each family"
  missed=()
  for family in acct id qty path; do
    search "$SEARCH_ROOT/$family" >/dev/null && status=0 || status=$?
    [[ "$status" -eq 0 ]] || missed+=("$family (status $status)")
  done
  # and a search that cannot run is an error, never "clean"
  search "$SEARCH_ROOT/does-not-exist" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -ge 2 ]] || missed+=("a missing root read as status $status, not an error")
  if [[ "${#missed[@]}" -gt 0 ]]; then
    echo "check-personal --self-test: FAILED - ${missed[*]}" >&2
    exit 2
  fi
  echo "check-personal --self-test: every family caught, and a failed search is an error"
  exit 0
fi

search "$SEARCH_ROOT" && status=0 || status=$?
if [[ "$status" -eq 0 ]]; then
  echo "check-personal: found personal paths above" >&2
  exit 1
fi
if [[ "$status" -ne 1 ]]; then
  echo "check-personal: the search itself failed (status $status) - not clean" >&2
  exit 2
fi

echo "check-personal: clean"
