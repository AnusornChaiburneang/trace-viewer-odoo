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

## Docker (Ubuntu 24.04 server)

The image is built on `mcr.microsoft.com/playwright:v1.61.1-noble`, adds Thai
fonts (so Thai labels in screenshots don't render as boxes), and refuses to build
if the kit's own tests fail or if `package-lock.json` pins a different Playwright
than the image ships.

```bash
docker compose build
docker compose run --rm tracekit test          # kit test suite (smoke test skips without Odoo)
docker compose run --rm tracekit fonts         # list installed Thai fonts

# Record a trace. -T is required when piping a flow on stdin.
docker compose run --rm -T tracekit trace SMOKE \
  http://host.docker.internal:8069/web/login --db mydb < flows/login-only.txt

# ...or point at a flow inside the mounted ./flows directory
docker compose run --rm tracekit trace SO-FLOW \
  http://host.docker.internal:8069/web/login --db mydb --flow flows/so-invoice-payment.txt
```

- Traces, logs and `result.json` are written to `/data/traces`; saved login
  sessions to `/data/sessions`. Both live in the `tracekit-data` volume — bind-mount
  a host directory over `/data` if you want the files on the host directly.
- `./flows` is mounted read-only, so your own (gitignored) flows are never baked
  into the image.
- `host.docker.internal` reaches an Odoo running on the Docker host.
- If you bump Playwright in `package.json`, bump `PLAYWRIGHT_VERSION` in
  `docker-compose.yml` to match; the build fails until they agree.

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
Start from a shipped template — `flows/so-invoice-payment.txt` (a full
SO -> invoice -> payment flow) or `flows/login-only.txt` — and replace the
`<PLACEHOLDER>` values. Then see the commands reference below.

Your own recordings go in `flows/` too, which is gitignored apart from those
two templates, so real hostnames, databases and passwords stay local.

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
./trace.sh so-flow http://localhost:8069/web/login \
  --task TICKET-123 --db my_test_db < flows/so-invoice-payment.txt
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
`expect state <label|key>` checks the current Odoo statusbar label, or its internal
selection key (`expect state sale`), which is the same in every UI language;
`expect dialog <title>` checks the visible modal title. These are UI assertions;
use an explicit selector assertion when a customized widget has different markup.

`tests/run_results.js` exercises pass/fail exits, strict stopping, assertions,
login verification, session isolation, and launcher context against a synthetic
local HTTP server. It never accesses an Odoo database.

## User-manual steps, variables and capture

These commands turn a flow into material for a user manual: ordered sections, each
with a title, a description and a fixed-size screenshot.

```text
strict on
login admin {{PASSWORD}}

step 'Open the quotation list' 'Sales > Orders > Quotations'
navmenu @sale.menu_sale_quotations
mark '.o_data_row:first-child' 'First quotation'

step 'Open the quotation {{SO}}'
record sale.order {{SO_ID}}
capture so_name field name
capture so_id url id
expect state sale

step 'Set the expiration date'
date '.o_field_widget[name="validity_date"]' 2026-12-31
done
```

- `step '<title>' ['<description>']` opens a section. When the next `step` starts,
  or the flow ends (with `done`, at end of input, or on a strict abort), the section
  is closed: the mouse is parked in a corner, systray counters are hidden, a
  **1440×900 viewport screenshot** is written to `<label>.shots/NN-<slug>.png`, and
  any `mark` boxes are cleared so they never bleed into the next section. A section
  is `failed` if any of its commands failed; it is still photographed.
  `result.json` lists the sections under `manual.steps` (number, title, description,
  first/last source line, status, error, screenshot path). Commands before the first
  `step` (typically `login`) belong to no section. Step screenshots are always kept.
- `{{NAME}}` placeholders are replaced before a line runs. Values come from
  `--var NAME=VALUE` (repeatable), from `TRACE_VAR_NAME` environment variables, and
  from earlier `capture`s. Use the environment for secrets: command-line arguments
  are visible in `ps`. The log and `result.json` keep the line **as written**
  (`fill #password {{PASSWORD}}`), and the values of variables whose name contains
  pass/secret/token/key/pwd are masked in every log line and error. An unknown
  variable fails that line.
- `capture <name> field <field_name>` reads the value shown in the topmost dialog or
  main form; `capture <name> url id` reads the record id from the URL (Odoo ≤17
  `#id=42`, Odoo 18+ `/odoo/…/42`); `capture <name> text <selector>` reads visible
  text. Captured values are stored in `result.json` → `captured` and are available
  as `{{name}}` to later lines (and, in the API, to later transactions).
- `navmenu @module.xmlid` reads the menu path from Odoo in the user's language and
  then clicks through it as usual, so one flow works for English and Thai screens.
  In `mode quick` it jumps straight to the menu's action. Labels written before the
  `@xmlid` are only for readability.
- `date <selector> 2026-12-31` (or `2026-12-31 18:00`) converts an ISO date to the
  user's `res.lang` format. `date` accepts the input or the field selector, and on
  Odoo 19 (where a date field is a button until clicked) it opens the field first.
- `screenshot [name] viewport` takes a viewport-only shot; the default stays full page.
- `goto` accepts a path relative to the current page (`goto /odoo`).

### API mode

`TRACE_API_MODE=1` is set by the API server for flows submitted by other systems:

- `goto` and any page or frame load may only reach the target's host, plus hosts in
  `TRACE_ALLOWED_HOSTS` (comma-separated). Other document loads are aborted and
  logged as `BLOCKED navigation`.
- `eval` is refused; `cookie` may only set cookies for an allowed host.
- every screenshot is kept (`KEEP_SHOTS` is implied).

## HTTP API (batches for user manuals)

`api/server.js` lets another system submit test cases and get back screenshots,
a manifest, traces and an optional draft manual. It runs `pw_trace.js` in API mode
for every transaction, in every requested language.

```bash
mkdir -p secrets && echo "manual-system:$(openssl rand -hex 24)" > secrets/api_tokens.txt
docker compose build && docker compose up -d          # listens on 127.0.0.1:8080 only
curl -s http://127.0.0.1:8080/api/v1/health
```

Without Docker: `TRACE_API_TOKENS=manual-system:<token> TRACE_DATA_DIR=./data node api/server.js`.
The API is published on `127.0.0.1` because Odoo passwords travel in the request
body: put a reverse proxy with TLS (Caddy/nginx) in front before exposing it.

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/runs` | submit a batch → `202 {run_id, links}`; `422 {details:[{path,message}]}` if invalid |
| `GET` | `/api/v1/runs/{id}` | status (`queued` `running` `passed` `partial` `failed` `cancelled` `error`), static checks, per-language results |
| `GET` | `/api/v1/runs/{id}/manifest` | `manifest.json` |
| `GET` | `/api/v1/runs/{id}/bundle.zip` | everything below in one zip |
| `GET` | `/api/v1/runs/{id}/manual.md` / `manual.html` `?lang=th_TH` | draft manual (when requested) |
| `GET` | `/api/v1/runs/{id}/tx/{tx}/trace.zip?lang=` | one transaction's Playwright trace |
| `GET` | `/api/v1/runs/{id}/files/<path>` | one file from the bundle, e.g. a screenshot |
| `GET` | `/api/v1/runs?status=&limit=` | your runs, newest first |
| `POST` | `/api/v1/runs/{id}/cancel` | cancel a queued or running batch |
| `POST` | `/api/v1/checks` | validate a request and check the server/version, no browser |
| `GET` | `/api/v1/health` | no auth |

Every call except `health` needs `Authorization: Bearer <token>`; each token's runs
are visible only to that token. Results endpoints answer `409` until the run finishes.

**Request** — see [api/examples/sales-manual.json](api/examples/sales-manual.json):

- `target`: `url`, `db`, `version` (checked against the server), `login` and
  `password` for the browser. They are held in memory only — never written to disk —
  so a run interrupted by a server restart ends as `error` and must be resubmitted.
  `api_key` is accepted and used from P4 (RPC data checks).
- `lang`: one code or a list (`["en_US","th_TH"]`). The whole batch runs once per
  language: the user's language is switched before (`lang` command) and restored after.
- `transactions[]`: `id`, `title`, optional `depends_on`, `steps[]`, optional `capture`
  (`{"so_id": "url id", "so_name": "field name"}`). Later transactions use captured
  values as `{{T1.so_id}}` in commands and titles.
- `steps[]`: `title`, optional `description`, `commands` (flow lines — `login`, `lang`,
  `step`, `done`, `strict`, `eval` and `cookie` are reserved), optional `expect`
  (`["state sale"]`) and `highlight` (`{selector, caption}` → red box in the shot).
- Every title/description/caption is a string when one language is requested, or
  `{lang: text}` with **every** requested language present (`captions_complete`);
  captions are never generated.
- `on_failure`: `stop` (default; everything after a failure is `skipped`) or
  `continue` (only transactions that `depends_on` a failed one are skipped → `partial`).
- `output.manual`: `{formats: ["md","html"], title}` for a draft manual;
  `callback_url`: POSTed `{event:"run.finished", …status}` when the batch ends
  (signed `X-TraceKit-Signature: sha256=<HMAC>` when `TRACE_CALLBACK_SECRET` is set,
  retried 4 times). Polling `GET /runs/{id}` works too.

**Bundle**

```text
manifest.json                         run, static checks, per-language results, steps, captured values
<lang>/<tx>/shots/NN-<slug>.png       1440×900, one per step (failed steps keep their shot here)
<lang>/<tx>/trace.zip | result.json | run.log
manual/<lang>.md | manual/<lang>.html  draft manual; failed/skipped steps show a warning, not a picture
```

**Configuration** (environment): `TRACE_API_TOKENS` / `TRACE_API_TOKENS_FILE`
(`name:token` per line, token ≥ 16 chars), `TRACE_DATA_DIR` (`/data`),
`MAX_CONCURRENT_RUNS` (1), `MAX_TRANSACTIONS_PER_RUN` (20), `TRACE_RETENTION_DAYS`
(14 — trace.zip files), `TRACE_KEEP_DAYS` (180 — whole runs), `TRACE_PUBLIC_URL`
(absolute links), `TRACE_CALLBACK_SECRET`, `TRACE_TARGET_ALLOWLIST` (allowed Odoo hosts),
`TRACE_ALLOWED_HOSTS` (extra hosts a flow may navigate to), `TRACE_API_PORT` (8080).

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
