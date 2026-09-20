#!/usr/bin/env bash
# Local trace launcher. Flags/ODOO_* environment variables identify this run;
# task lookup is restricted to an explicit session, never the newest session.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Output directory and ticket conventions now live in trace.config.json (which
# is gitignored), so this launcher carries no machine-specific paths. Set
# TRACE_OUT_DIR to override for a single run.
export TRACE_LOCAL=1
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  export NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null || true)}"
fi
: "${PLAYWRIGHT_BROWSERS_PATH:=${HOME}/.cache/ms-playwright}"
export PLAYWRIGHT_BROWSERS_PATH
exec stdbuf -oL -eL node "$SCRIPT_DIR/pw_trace.js" "$@"
