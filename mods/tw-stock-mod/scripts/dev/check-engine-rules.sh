#!/usr/bin/env bash
# Static guard for the engine's own module rules - the ones esbuild, tsc and
# every harness in this directory accept, and only the real host refuses.
#
# 2026-09-19: `const next = {}` inside a helper cost a full release. The engine
# answered `/reload-plugins` with "hooks module did not load ... `next` (the
# continuation) is declared again (shadowed)", the band vanished, and nothing
# in this repo had complained: tsc exits 0, esbuild bundles it, and the dev
# harnesses import that bundle DIRECTLY instead of loading it through the
# engine, so the engine's validation pass never runs against it.
#
# Every rule below must be one the engine enforces at load time. Keep the
# grep narrow: a false positive here blocks a release just as hard.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
fail=0

# every rule below greps with rg, and a missing rg reads as "no hits" -
# which would print "clean" without having checked anything
if ! command -v rg >/dev/null 2>&1; then
  echo "check-engine-rules: rg (ripgrep) not found - install it, nothing was checked" >&2
  exit 1
fi

report() {
  echo "check-engine-rules: $1" >&2
  fail=1
}

# Rule 1: nothing can shadow `next`, the continuation every hook receives.
if hits=$(rg -n --glob '*.tsx' --glob '*.ts' \
    '\b(const|let|var|function)\s+next\b' "$MOD_DIR/hooks" 2>/dev/null); then
  report "a binding named \`next\` shadows the hook continuation - rename it:"
  echo "$hits" >&2
fi

# Rule 2: `$` nouns are called, never read. `$.mcp?.call` fails the whole
# module at load, the same class of engine-only refusal as rule 1.
if hits=$(rg -n --glob '*.tsx' --glob '*.ts' \
    '\$\.[a-z]+\?\.' "$MOD_DIR/hooks" 2>/dev/null); then
  report "a \`\$\` noun is read instead of called - use \$.noun.event(...):"
  echo "$hits" >&2
fi

if [[ "$fail" == 0 ]]; then
  echo "check-engine-rules: clean"
fi
exit "$fail"
