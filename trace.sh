#!/usr/bin/env bash
# trace.sh — run an interactive or piped trace session
#
# Usage:
#   ./trace.sh <name> [target_url]           # interactive REPL
#   ./trace.sh <name> [target_url] < flow.txt  # pipe commands
#
# Examples:
#   ./trace.sh demo http://localhost:8069/web/login
#   ./trace.sh so-flow http://192.168.1.10:8069/web/login < flows/so-invoice-payment.txt
#
# Output: traces/<name>.zip
# View:   npx playwright show-trace traces/<name>.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Use local node_modules if present (preferred), else fall back to global
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  export NODE_PATH="${NODE_PATH:-$(npm root -g 2>/dev/null || true)}"
fi
# Playwright looks for browsers in ~/.cache/ms-playwright by default;
# override only if a custom path is set in the environment
: "${PLAYWRIGHT_BROWSERS_PATH:=${HOME}/.cache/ms-playwright}"
export PLAYWRIGHT_BROWSERS_PATH

exec node "$SCRIPT_DIR/pw_trace.js" "$@"
