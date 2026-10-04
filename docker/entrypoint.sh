#!/usr/bin/env bash
# Container entrypoint: the API server (default in compose) plus the CLI.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'EOF'
odoo-trace-kit container

  api                                                           run the HTTP API (port 8080)
  trace <name> [url] [--db DB] [--flow flows/x.txt] [--task T]   record a trace
        (pipe a flow on stdin with `docker compose run -T`, or pass --flow)
  test  [odoo-base-url]                                         run the kit's test suite
  fonts                                                         list installed Thai fonts
  help                                                          this message

CLI artifacts go to /data/traces, login sessions to /data/sessions;
API runs live under /data/runs/<run_id>/.
EOF
}

cmd="${1:-help}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  api)   exec node api/server.js "$@" ;;
  trace) exec ./trace-local.sh "$@" ;;
  test)  exec ./run-tests.sh "$@" ;;
  fonts) exec fc-list :lang=th family ;;
  help|-h|--help) usage ;;
  *) exec "$cmd" "$@" ;;
esac
