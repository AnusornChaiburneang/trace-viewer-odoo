# odoo-trace-kit

Record Odoo UI flows as Playwright traces — for visual manual testing and review.

Traces are self-contained `.zip` files. Open them in the Playwright Trace Viewer to step through every action with screenshots, DOM snapshots, and network logs — no Odoo access needed.

---

## Install

```bash
git clone <this-repo>
cd odoo-trace-kit
npm install
npx playwright install chromium
```

Requires Node.js 18+. Works on Linux, macOS, Windows (WSL).

---

## Usage

```bash
# Interactive — type commands manually
./trace.sh so-flow http://your-odoo:8069/web/login

# Automated — pipe a flow script
./trace.sh so-flow http://your-odoo:8069/web/login < flows/so-invoice-payment.txt
```

Traces use unique timestamp + UUID filenames in `traces/`. Use the path printed by the runner.

**No setup is required.** There is no task tracker, dashboard, or fixed directory
layout to configure — `./trace.sh` works on a fresh clone.

---

## Configuration (optional)

Defaults work standalone. To point the kit at your own paths or conventions,
copy the example and edit it:

```bash
cp trace.config.example.json trace.config.json
```

`trace.config.json` is **gitignored**, so machine-specific settings never end up
in the repo.

| Key | Env override | Default | What it does |
|---|---|---|---|
| `outputDir` | `TRACE_OUT_DIR` | `traces` | Where `.zip`/`.log` are written. Relative = inside the kit. |
| `defaultUrl` | `TRACE_DEFAULT_URL` | `http://localhost:8069/web/login` | Used when no URL is passed. |
| `taskPattern` | `TRACE_TASK_PATTERN` | any `A-Z0-9._-` token | Accepted `--task` values — use any ticket scheme, or none. |
| `taskInFilename` | — | `false` | Prefix artifacts with the task number. |
| `dashboardUrl` | `ODOO_DASHBOARD_URL` | `null` | Only used to resolve `--session-id` into a task. `null` = never contacted. |

A `--task` is **always optional**. Pass one if your team tracks tickets; omit it
and runs are simply unassigned.

---

## View a trace

```bash
npx playwright show-trace "traces/<printed-label>.zip"
```

Or drag-drop `demo.zip` to **https://trace.playwright.dev** — zero install.

---

## Set up for your environment

Every Odoo instance is different — different version, database, action IDs, button names.

**If you have an AI assistant (Claude Code, Cursor, Copilot):**  
Open this repo and ask it to help you set up. It will read `CLAUDE.md` and guide you through discovering your environment and generating a flow file.

**Manually:**  
See the commands reference below, then write a `flows/my-flow.txt`.

---


## Tests

```bash
./run-tests.sh                        # against http://localhost:8069
./run-tests.sh http://host:8069       # explicit target
```

Run this before committing a change to `pw_trace.js`.

**Phase 1 — static** (no browser, runs anywhere): syntax, stray control
characters in the source, duplicate dispatcher branches, and help-text ↔
implementation parity. This exists because `node --check` happily accepts things
that are badly wrong — a NUL byte inside a string literal, or the same `cmd ===`
branch implemented twice with the second silently dead. Both have actually
happened.

**Phase 2 — browser smoke** (`tests/smoke.txt`): drives the **login page only**
— no credentials, no database reads, no writes — so it is safe against whatever
instance is on the port. It exercises the *failure* paths (wrapped-quote
warning, `scroll` miss, `breadcrumb` with no crumbs, `boolcell` with no cell,
`record` URL building, `clickrpc` both ways), because those are what rot
silently when the dispatcher is edited.

Assertions that need a real login *form* are **skipped with a reason** — not
failed — when the server is only offering the database selector, since no change
to `pw_trace.js` could fix that. Phase 2 as a whole is skipped if nothing is
serving the URL.

## Commands

See [COMMANDS.md](COMMANDS.md), generated from the same registry as the runner's
help output. Regenerate it with `node generate-command-docs.js` after changing
`commands.json`; the regression suite checks that the reference is current.

## Share a trace

Pull the zip to your local machine:
```bash
scp 'user@server:/path/to/odoo-trace-kit/traces/<printed-label>.zip' ./trace.zip
npx playwright show-trace ./trace.zip
```

Or upload the `.zip` to a shared drive and teammates open it at https://trace.playwright.dev.

## Reliable results and explicit run context

Both launchers accept the same options, before or after the positional arguments:

```bash
./trace.sh so-confirm http://localhost:8069/web/login \
  --task TICKET-123 --db my_test_db < flows/so-confirm.txt
```

`--task`, `--session-id`, and `--db` override `ODOO_TASK`, `ODOO_SESSION_ID`, and
`ODOO_DB`. A URL's `?db=` must agree with the selected database; conflicting values
fail before opening the browser. Database selection is pinned into the login URL.
The session cache is separated by protocol, host, port, and database. `login`
checks the authenticated username as well as the database before reusing a session.

Without a task, the launcher looks up only the explicitly supplied session through
`/api/sessions/<session-id>/context` on the dashboard. It never picks the newest
session. Without explicit context, or when the lookup is unavailable, the run
remains unassigned. `ODOO_DASHBOARD_URL` overrides the dashboard address.

Every started run writes `<label>.result.json` alongside its trace and log. The
JSON includes each command's source line, status, duration, and failure reason;
requested task/session/database; verified login UID, username, database, and Odoo
version; and Git revision/dirty state for the working directory and trace kit.
Unverified metadata is null. A dirty revision identifies the base commit, not an
exact snapshot of uncommitted code. Login and cookie commands are redacted in the
command log and result file; the Playwright trace still records browser activity.

Exit codes: **0** all executed steps passed, **1** a step or run failed, **2** invalid
startup arguments. `strict on` stops on the first failure. Default non-strict mode
continues for diagnosis but still returns 1 if any step failed. Failed login and
hard timeouts always abort. The trace is finalized on handled failures, including
strict aborts. The result JSON is refreshed as steps execute, so an externally
killed process leaves a `running` step rather than a false success.

### Assertions

```text
strict on
login admin <password>
expect visible '.o_form_view'
expect value '[name="amount"] input' 10
expect text '#message' Saved
expect hidden '.o_error_dialog'
expect state Sales Order
expect dialog Create invoices
done
```

`expect visible|hidden|text|value <selector> [expected]` checks the selected element.
Quote selectors containing spaces. Text comparisons normalize whitespace; input
values match exactly. Assertions retry until the action timeout. Visible/text/value
checks require exactly one visible match, so ambiguous selectors fail.
`expect state <label>` checks the current Odoo statusbar label;
`expect dialog <title>` checks the visible modal title. These are UI assertions;
use an explicit selector assertion when a customized widget has different markup.

`tests/run_results.js` exercises pass/fail exits, strict stopping, assertions,
login verification, session isolation, and launcher context against a synthetic
local HTTP server. It never accesses an Odoo database.

## Edit Odoo fields and existing rows by name

```text
# Active form or topmost visible dialog; no CSS selector required.
field amount 10
field advance_payment_method percentage
field reference ''

# Match an existing row by exact text in a named column, or by visible position.
rowset invoice_line_ids 'name=Service A' quantity 2
rowset invoice_line_ids #1 price_unit 100
```

`field <name> <value>` resolves the visible `.o_field_widget` for an Odoo field
name in the active form or topmost dialog. Hidden duplicates and fields inside
list rows are excluded. Use `rowset` for list fields.

`rowset <table-field> <row> <column> <value>` edits an existing one2many/list row.
`#1` means the first visible data row on the current page; section/note rows count
if they are data rows. `<field>=<text>` matches the exact displayed text or input
value of a column, with whitespace normalized. Quote the entire row selector when
it contains spaces. Matching multiple rows fails before clicking; use a position
to disambiguate. The helper binds to the row's UI `data-id`, clicks the requested
cell, waits for the editor to render, then edits that same row across rerenders.
The UI ID is not assumed to be a database record ID. Hidden/missing columns and
rows without a stable UI identity fail explicitly.

Supported controls: text, numeric inputs, textarea, checkbox (`on`/`off`), native
selection (exact label or option value), radio (exact label or `data-value`), and
Odoo many2one autocomplete (exact existing option label). Autocomplete selection
is scoped to the target widget, waits for results, and never chooses Create or
Search More. Use `''` to clear a text field. Composite widgets, dates/date ranges,
file uploads, and many2many tags require their dedicated commands.

Both commands respect readonly/disabled controls, commit through widget events,
blur without Tab/Escape, wait for Odoo to become idle, and verify the displayed
value. Numeric comparisons use Odoo's loaded locale parser when available; the
fallback accepts only plain decimal numbers. Invalid or reverted values fail the
step and the run. These commands do not press Save or prove database persistence;
use a subsequent save/reload/assertion when persistence is part of your flow.

`tests/field_helpers.js` covers stacked dialogs, ambiguity, readonly controls,
onchange rejection, localization, autocomplete, and asynchronous row replacement.
The new commands also run through the trace dispatcher in `tests/run_results.js`.

For asynchronous browser expressions, `eval` awaits a returned promise:
`eval odoo.__WOWL_DEBUG__.root.env.services.action.doAction(...)`.
Top-level `await` is not supported; use an async IIFE when needed.

## Run history and source capture

Pass `--flow /path/to/flow.txt` to capture the exact source read at startup.
Each execution has a unique UUID and timestamped ZIP/log/result filenames, so
reruns never overwrite previous artifacts. Schema 2 reports include `run_id`,
`flow_name`, `started_at`, `updated_at`, and `flow` (captured content, original
SHA-256, source path, capture type and completeness). Login/cookie arguments in
the captured text are redacted. Other command content is retained.

The dashboard Flows tab automatically indexes result files and legacy ZIPs.
Saved definitions are independent of historical snapshots. Keep failed runs for
diagnosis. See the shared guide for artifact roots and status meanings.

## Browser and runtime evidence

New runs automatically capture same-origin browser JSON-RPC POST requests.
Each request has a run-scoped request ID and the ID/source line of the step active
when it started. Late responses stay linked to that step. Background traffic can
overlap: this association is timing evidence, not proof that a click caused it.

In Flows, expand an RPC below its step to see endpoint, model/method, sanitized
parameters, HTTP/RPC status, duration, and the error/actual Python traceback
returned by Odoo. HTTP 200 with a JSON-RPC error is labeled `rpc_error`. Network
failures and incomplete response capture are explicit. Older runs have no runtime
evidence. RPC errors are diagnostic evidence; existing assertion verdicts remain
unchanged, since some flows intentionally trigger errors.

Without `--python-trace`, this uses Odoo's existing response data and needs no
server restart. This default capture does not trace successful Python overrides, SQL, commits, or record changes, and does not
observe the runner's separate API login/session probes. Correlation IDs are local
to the report, not injected into Odoo logs. Match trace network entries using
endpoint, start time, JSON-RPC ID, and parameters. Successful result bodies are
omitted. Authentication parameters/details and sensitive parameter keys are
redacted; arbitrary positional values and traceback text can still contain data.
Capture is capped at 500 requests, 1 MiB per response, and bounded parameter and
traceback lengths. The runner drains responses for up to two seconds at shutdown.

## Failure summaries and opt-in Python tracing

Run details start with a deterministic failure summary: failed assertion (or
first failed step), startup error, correlated RPC errors, and earlier errors
that may be related. Timing correlation is explicitly labeled as uncertain.
A recorded RPC error does not override assertion verdicts, because some tests
intentionally exercise error paths. Summary links jump to the underlying evidence.

For deeper tracing, enable the server-wide observer for the Odoo configuration
you intend to run (no database module installation or schema change):

```bash
python3 ./server-trace.py enable --config /path/to/odoo.conf
# restart Odoo however you normally do it
./trace.sh example http://localhost:8069/web/login --db DATABASE --flow /path/to/flow.txt --python-trace
```

`enable` preserves existing addon/module entries and backs up the configuration;
it adds the kit's `server_addons` path and `tracekit_runtime` server-wide module.
Use `disable` with the same config and restart to unload it. `status` reports
configuration only, not whether the current process loaded the observer. Explicit
`--load`/`--addons-path` server arguments override config; include the observer
there too if used. Re-enable after switching to an addon profile that removes
the observer path. Apply separately for each Odoo installation you want to trace.

Only signed, same-origin `/web/dataset/` POSTs during recorded steps are profiled.
The report embeds the matching server trace using run/request/step IDs; the
server keeps originals under `.runtime/traces/<run-id>/`. Both processes need
access to the same kit/state directory. `TRACEKIT_STATE_DIR` can specify a shared
alternative (including its 32-byte `key`). No key or raw credentials are included
in Python call evidence. Requests without valid signatures remain unprofiled.

Expand an RPC to see actual executed addon/ORM functions, source file and line,
parent calls, model name, and inclusive duration. This proves executed Python
paths, not successful database commits. Return events also occur when exceptions
unwind; `complete` means a return event was observed, not business success.
No arguments, locals, record contents, SQL text, or record-change audit are captured.

Limits: 2,000 calls and 10 seconds per request; partial captures are labeled.
Timings include profiling overhead and nested calls. Existing profilers and
gevent workers are skipped. WSGI dispatch is covered; streaming response bodies,
cron/background workers, and C/native calls are not. Observer hooks target the
installed Odoo 14 `Root` and Odoo 17/19 `Application` WSGI entrypoints.

---

## Optional: integrating with a task tracker or dashboard

Nothing below is required to use the kit — it describes how to wire it into an
existing workflow.

`trace-local.sh` is a thin wrapper around `trace.sh` that sets `TRACE_LOCAL=1`,
which turns on `taskInFilename`. Combined with a `trace.config.json` such as:

```json
{
  "outputDir": "/path/to/your/recordings",
  "taskPattern": "^T\\d{2}-\\d{5}$",
  "taskInFilename": true,
  "dashboardUrl": "http://127.0.0.1:7878"
}
```

...artifacts land in your own directory, named `<task> <name> <timestamp> <id>.zip`,
and `--task` is restricted to your ticket format.

`dashboardUrl` is contacted **only** when you pass `--session-id` without
`--task`, to look the task up. If it is `null` (the default) or unreachable, the
run proceeds with the task unassigned — it is never a hard dependency.

If your environment has its own tool guide, link it from `CLAUDE.md` rather than
here, so this README stays portable.
