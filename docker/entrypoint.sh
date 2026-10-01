#!/usr/bin/env bash
# Container entrypoint. P1 exposes the existing CLI; the API server arrives in P3.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
odoo-trace-kit container

  trace <name> [url] [--db DB] [--flow flows/x.txt] [--task T]   record a trace
        (pipe a flow on stdin with `docker compose run -T`, or pass --flow)
  test  [odoo-base-url]                                         run the kit's test suite
  fonts                                                         list installed Thai fonts
  help                                                          this message

Artifacts are written to /data/traces, login sessions to /data/sessions.
EOF
}

cmd="${1:-help}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  trace) exec ./trace-local.sh "$@" ;;
  test)  exec ./run-tests.sh "$@" ;;
  fonts) exec fc-list :lang=th family ;;
  help|-h|--help) usage ;;
  *) exec "$cmd" "$@" ;;
esac
