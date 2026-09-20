#!/usr/bin/env bash
# run-tests.sh — regression check for pw_trace.js. Run this before committing
# a change to the dispatcher.
#
#   ./run-tests.sh                              # against http://localhost:8069
#   ./run-tests.sh http://localhost:8069        # explicit
#
# Phase 1 (static) runs anywhere. Phase 2 drives a real browser against the
# LOGIN PAGE ONLY — no credentials, no database reads, no writes — so it is safe
# to run against whatever Odoo happens to be on the port.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BASE="${1:-http://localhost:8069}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
skip(){ printf '  SKIP  %s\n        reason: %s\n' "$1" "$2"; }

echo "=== 1. static checks (no browser needed) ==="
if node --check pw_trace.js 2>"$TMP/syntax" && node --check field-tools.js 2>>"$TMP/syntax"; then
  ok "pw_trace.js parses"
else
  bad "pw_trace.js syntax error: $(head -1 "$TMP/syntax")"
fi
if python3 tests/static_checks.py; then
  ok "static checks"
else
  bad "static checks (see above)"
fi

echo
if node generate-command-docs.js --check; then
  ok "generated command reference"
else
  bad "generated command reference is stale"
fi

if node tests/runtime_evidence.js; then
  ok "runtime capture boundaries"
else
  bad "runtime capture boundaries"
fi

echo "=== 1b. unit: autocomplete matcher (synthetic DOM, no Odoo) ==="
if node tests/unit_dropdown.js; then
  ok "pickFromDropdown unit tests"
else
  bad "pickFromDropdown unit tests (see above)"
fi

echo
echo "=== 1c. Odoo field and editable-row helpers ==="
if node tests/field_helpers.js; then
  ok "field and row helpers"
else
  bad "field and row helper tests"
fi

echo "=== Python runtime observer ==="
if python3 tests/test_observer.py && node tests/python_trace.js; then
  ok "Python observer and browser correlation"
else
  bad "Python observer and browser correlation"
fi

echo "=== 1d. isolated browser results and context ==="
if node tests/run_results.js; then
  ok "results, assertions, and explicit context"
else
  bad "results/context integration tests"
fi

echo
echo "=== 2. browser smoke test (login page only) ==="
if ! curl -sf -o /dev/null --max-time 5 "$BASE/web/login"; then
  echo "  SKIPPED — nothing serving $BASE/web/login"
  echo "  (start Odoo, or pass a URL: ./run-tests.sh http://host:port)"
else
  # Odoo may be serving a database SELECTOR rather than a login form (multi-db,
  # or db_name unset). Pin the first database so the flow reaches a real login
  # page — otherwise the page-shape assertions below test nothing.
  DB="$(curl -s --max-time 5 "$BASE/web/database/list" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"call","params":{}}' 2>/dev/null \
      | python3 -c 'import sys,json
try:
    r=(json.load(sys.stdin) or {}).get("result") or []
    print(r[0] if r else "")
except Exception:
    print("")' 2>/dev/null)"
  if [ -n "$DB" ]; then DBQ="?db=${DB}"; echo "  database: $DB"; else DBQ=""; echo "  database: (none advertised)"; fi
  sed -e "s#__BASE__#${BASE}#g" -e "s#__DBQ__#${DBQ}#g" tests/smoke.txt > "$TMP/smoke.txt"
  LOG="$TMP/smoke.log"
  TRACE_OUT_DIR="$TMP" CMD_TIMEOUT=4000 \
    timeout 180 node pw_trace.js smoke "$BASE/web/login${DBQ}" < "$TMP/smoke.txt" > "$LOG" 2>&1
  SMOKE_EXIT=$?
  if [ "$SMOKE_EXIT" -eq 1 ]; then
    ok "intentional failure paths return exit 1"
  else
    bad "failure smoke returned $SMOKE_EXIT (expected 1)"
  fi
  # Each command must print a distinctive, stable line. These assert the
  # FAILURE paths report clearly instead of silently doing nothing.
  assert() {  # assert <description> <fixed-string>
    if command grep -qF -- "$2" "$LOG"; then ok "$1"; else
      bad "$1  (expected to find: $2)"
    fi
  }
  # --- always assertable: these do not depend on what the page contains ------
  assert "wrapped-quote selector is warned about" "takes the whole rest of the line unquoted"
  assert "scroll hits an element"                 'scroll: input[name="login"]'
  assert "scroll reports a miss"                  "scroll: .no_such_element_at_all"
  assert "breadcrumb with no crumbs is graceful"  "breadcrumb: no clickable crumbs found"
  assert "boolcell with no cell is graceful"      "boolcell NOT FOUND cell:"
  assert "record builds the O17 hash URL"         "record: res.partner #1"
  assert "clickrpc lists labels on a miss"        "clickrpc NOT FOUND:"
  assert "flow ran to completion"                 "Stopping trace..."

  # --- need a real login FORM: skip rather than fail if the server is only
  #     offering the database selector, which no change to pw_trace.js can fix.
  #     (A red test that is really an environment problem trains people to
  #     ignore red tests.)
  if command grep -qF "/web/database/selector" "$LOG"; then
    R="server is showing the database selector, not a login form — start Odoo with a single db (db_name=...) or pass a reachable instance"
    skip "blank Odoo-18 style URL is warned about"        "$R"
    skip "clickrpc catches a button that does nothing"    "$R"
  else
    assert "blank Odoo-18 style URL is warned about" "the page rendered no action content"
    assert "clickrpc catches a button that does nothing" "its method never reached the server"
  fi
  if [ "$FAIL" -ne 0 ]; then
    echo
    echo "  --- smoke log (last 25 lines) ---"
    tail -25 "$LOG" | sed 's/^/  /'
  fi
fi

echo
echo "=============================="
printf ' %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
