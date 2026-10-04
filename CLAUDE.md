# odoo-trace-kit — AI Setup Guide

You are helping a developer use this tool to record and replay Odoo UI flows as Playwright traces.

## What this tool does

`pw_trace.js` runs a headless Chromium browser and lets the user (or you) type commands line-by-line to drive it:
- navigate pages, click buttons, fill fields, take screenshots
- save everything as a `.zip` trace viewable in the Playwright Trace Viewer

## Shared workflow

Read [TOOLS.md](/home/server/odoo-17.0/TOOLS.md) first. It defines environment
discovery, explicit context, run history, and flow storage for every assistant.
The [generated command reference](COMMANDS.md) is shared with runtime `help`.
The notes below cover browser discovery and version-specific troubleshooting.

## Environment probe — run BEFORE writing flows

Once you have the URL + DB + credentials, do a quick probe run to discover:

### 1. Verify login works
```bash
./trace-local.sh PROBE http://ODOO_URL/web/login <<'EOF'
login ADMIN_USER ADMIN_PASS
url
screenshot
done
EOF
```

The `login` command reports success/failure explicitly. Sessions are cached per host+db in
`.sessions/` — subsequent runs skip the login form automatically (it verifies the session
server-side via `get_session_info`, since Odoo renders the login form on `/web/login` even
when already authenticated).

**Switching databases:** always pin the target DB in the login URL (`/web/login?db=<name>`).
Sessions are cached per db, and `login` cross-checks the session's actual db against the
URL's `?db=` — a mismatched session is discarded and a fresh login performed, so you can
switch DBs freely between runs. Without `?db=` on a multi-DB server, a stale session could
land the trace in whichever db it was created on — the login output always prints `db=...`
so verify it matches what you expect.

### 2. Discover action IDs for the target module

For Sales (sale.order):
```sql
SELECT id, name->>'en_US' AS name FROM ir_act_window
WHERE res_model = 'sale.order' ORDER BY id;
```

For Purchase (purchase.order):
```sql
SELECT id, name->>'en_US' AS name FROM ir_act_window
WHERE res_model = 'purchase.order' ORDER BY id;
```

Replace `->>'en_US'` with `::text` on Odoo 14 where `name` is a plain varchar.

### 3. Press buttons by LABEL — never hunt for the name/id

To press any button, click by the label you see:
```
clickbtn Create Invoice
```
Do NOT write `button[name="action_confirm"]` / `button[name="319"]` or go looking for the
action id — that is the single biggest time-waster. Names/ids vary by module and version
(`action_confirm` vs `action_sale_ok` vs a numeric id); the visible label is stable.

`clickbtn` matches the visible label (exact → contains), falls back to title/aria-label for
icon buttons and to an internal name if you pass one, and prints the internal name it
resolved (so you learn it for free). **On a miss it prints the visible clickable labels
inline** — just retry with one of those; no name-hunting, no separate lookup. Labels differ
across DBs (e.g. the list "New" button is "Create" on some customized instances) — the miss
list shows you which. `buttons` still gives the full `name="<internal>" | "<label>"` table if
you want it up front.

### 4. Find the "Add a line" / "Add a product" button text

```
eval Array.from(document.querySelectorAll('[name="order_line"] a, [name="order_line"] button')).map(e => e.textContent.trim())
```

### 5. Check product field name in order lines

```
eval document.querySelector('td[name]')?.getAttribute('name')
```

---

## Key selector differences by Odoo version

| Thing | Odoo 14 | Odoo 16/17 | Odoo 18+ |
|---|---|---|---|
| Navigate to list | `/web#action=ID` | `/web#action=ID` | `/odoo/sales` or hash |
| New button | `button.o_list_button_add` | `button.o_list_button_add` | same |
| Add line text | "Add a line" | "Add a product" | "Add a product" |
| Product field | `td[name="product_id"]` | `td[name="product_template_id"]` | check with eval |
| Confirm SO | `button[name="action_confirm"]` | `button[name="action_confirm"]` or custom | check with eval |
| Confirm invoice | `button[name="action_post"]` | `button[name="action_post"]` | same |
| Login quirk | clean form | website module may overlay | same |
| One2many td cells | no `name` attr — use `td:nth-child(N)` | `td[name="field"]` | same as 17 |
| `data-id` on rows | client-side counter e.g. `product_3` — NOT the DB id | DB id integer | DB id integer |

---

## Odoo 14 — known gotchas

### One2many td cells have no `name` attribute
In Odoo 14 wizard/dialog list views, `<td>` cells are **not** annotated with `name`.
Use positional selectors instead:
```
evals tr.o_selected_row td          # see all cells in the new row
click tr.o_selected_row td:nth-child(2)   # click the 2nd cell
m2o 'tr.o_selected_row td:nth-child(2)' SearchText
```

### `data-id` is a client-side counter, not the DB id
`tr[data-id="product_3"]` — the `3` is a client-side sequence number, not the database record id.
Do not use `data-id` to look up records. Use `eval` to read field values from the OWL component instead.

### "Search More" dialog does not inherit autocomplete text
When you click "Search More..." from a dropdown, the dialog opens **empty** — it does NOT pre-fill with what you already typed.
You must re-type the search term inside the dialog:
```
click .o_m2o_dropdown_option_search_more   # or "Search More..." link
waitidle
fill .modal input.o_searchview_input SearchTerm
press Enter
waitidle
```

### Each run is a FRESH browser page — transient state does NOT carry over
Only the login session (cookies) persists between runs. Open dialogs, dropdown
state, and unsaved row-edits are **gone** in the next `trace.sh`/`trace-local.sh`
call, even against the same URL/record. If a `Validate` click opens an
"Immediate Transfer?" dialog, you MUST handle it (e.g. `clickbtn Apply`) in the
**same command block** — a follow-up invocation reloads the page fresh and
`clickbtn Apply` reports NOT FOUND. Rule: one logical action + all the dialogs it
spawns must live in a single flow, never split across invocations.

### Autocomplete: use `pick`, not `:has-text()` — and beware "Create and Edit…"
`:has-text("Create \"X\"")` selectors on dropdown items are unreliable (report
`matched -1 element(s)` / not actionable and silently do nothing). Instead:
```
fill '<input selector>' SearchText
waitidle
pick SearchText          # selects the matching option by text; skips Create/Create-and-Edit/Search More
```
`pick` works for OWL (`.o-autocomplete--dropdown-item`) and v14 jQuery-UI
(`.ui-menu-item`).

**You do NOT need a fixed wait before `pick`/`m2o`.** Odoo renders a
"Loading..." placeholder that matches the same item selector before the
`name_search` results replace it, so `waitfor .o-autocomplete--dropdown-item`
can resolve while only that placeholder exists. `pick` and `m2o` now recognise
the placeholder, never select it, and keep re-checking until the real options
land (up to the action timeout) — so the old `wait 1000` workaround is
unnecessary. If the results genuinely never arrive they say so explicitly
instead of matching the placeholder.

If you fall back to keyboard (`press ArrowDown` + `press
Enter`), note Enter can land on **"Create and Edit…"**, which opens a nested
"Create: <Field>" dialog — you must `clickbtn Save` (or the dialog's Save) on
that inner dialog before the outer wizard's Confirm sees the value, or the
record silently never gets created.

### v14 editable-list cells: use `celltype` (CSS click lies)
A readonly-styled `<td>` in a one2many list (e.g. the "Detailed Operations"
popup) reports "not actionable" to `click`/`fclick` even though it IS clickable,
and the first click only enters row-edit mode — it does NOT focus the inner
input, so `type` goes into whatever was focused before (e.g. a read-only product
description). Use:
```
celltype 'td[name="quantity"]' 5     # JS-clicks the cell, focuses its input, then types
```

### Column order is NOT stable across tables — discover with `cols`
The "Detailed Operations" popup's move-line table has a different column set than
the main Operations tab. Don't reuse a column index from another table — run
`cols` (optionally `cols <table selector>`) to print each header with its index
and field name for the table actually on screen.

---

## How to write a flow file

Once you know the selectors, write a `.txt` file in `flows/`. Comments start with `#`.

**Template for any login + form flow:**
```
# flows/my-flow.txt
# Env: Odoo X.X @ http://HOST:8069 / DB: my_db

# Login
strict on
login USER PASSWORD
waitidle

# Navigate
goto http://HOST:8069/web#action=ACTION_ID
waitidle

# ... your steps here ...

screenshot
done
```

Then run:
```bash
./trace-local.sh MY-FLOW http://HOST:8069/web/login --db DATABASE --flow flows/my-flow.txt
```

---

## Navigation: `navmenu` and human/quick modes

Two ways to reach a screen:

- **`goto http://HOST:8069/web#action=<ID>`** — the quick, deterministic jump. Hides the menu breadcrumb.
- **`navmenu App > Section > [Group >] Item [@<actionId>]`** — navigates by *clicking* menu labels, so the trace demonstrates the real click sequence a user follows.

`navmenu` matches on **rendered visible text** (exact-then-contains, case-insensitive), so translated labels work — write whatever appears on screen (this DB has Thai). It walks each `>`-separated label:
1. opens the apps menu and clicks the **app**,
2. clicks the **section** in the top menu bar (opens its dropdown),
3. for the rest, matches **group headers** (non-clickable separators like "Products" — used only to scope the next label) and **leaf items** (clicked to navigate),

inserting an implicit `waitidle` between navigating clicks. On any label it can't find, it prints `NOT FOUND: <label>` and lists the visible items at that level (group headers marked `[group]`) so failures are debuggable.

**Human mode always draws a red pointer.** Before each step it puts a red box + caption on the target (`App: Inventory`, `Menu: Configuration`, `Group: Products`, `Open: Purchase Product Group`) and holds it briefly so the trace explains *what* is being clicked and *where*. The pointer is cleared right after a navigating click, so the destination screen stays clean. (Uses the same drawing as the `mark` command, so it survives into the trace viewer's Snapshot tab.) Quick mode draws no pointer — it just jumps.

**Mode switch** — choose per flow with the `mode` directive near the top (default is `human`):

```
mode human    # click through the menu (shows the breadcrumb) — the default
mode quick    # short-circuit navmenu to goto #action=<id> when @<id> is given
```

In `quick` mode, `navmenu … @<id>` jumps straight to `#action=<id>`; the labels are kept for readability. If no `@<id>` is supplied, `navmenu` always clicks through regardless of mode. (`NAV_MODE=quick|human` env var is honored as a fallback if no directive is present.)

Example (Odoo 14, verified against `dv_kc`):
```
login admin <pass>
mode human
navmenu Inventory > Configuration > Products > Purchase Product Group @706
```
The same line under `mode quick` jumps via `#action=706`. See `flows/navmenu-human.txt` and `flows/navmenu-quick.txt`.

**Odoo 14 menu selectors** (verified, don't guess — re-probe with `eval`/`snapshot` on other versions): apps `.o_menu_apps a.o_app`; sections `.o_menu_sections > li > a` (`.dropdown-toggle` opens a dropdown, otherwise it's a leaf); inside a dropdown, `div.dropdown-header` = group label, `a.dropdown-item` = leaf action.

---

## Debugging tips

**Element not found / timeout:**
- Use `buttons` to list every visible button (internal name + label) — run this before guessing any button selector
- Use `clickbtn <label>` to click by visible text instead of internal name
- Use `evals <sel>` to print outerHTML of matched elements — reveals actual structure in one shot
- Use `snapshot` to print the visible element tree
- `click`/`fclick` timeouts now report whether the selector matched 0 elements vs existed but wasn't actionable

**Click fires but nothing happens:**
- Try `fclick` instead of `click` (bypasses visibility checks)
- For Odoo SPA list buttons, use `jclick` instead
- Make sure the previous autocomplete/edit is committed (`press Escape` or `press Tab` first)

**Autocomplete not selecting:** use `pick`, which matches by text and waits out
the "Loading..." placeholder. Do not click `.o-autocomplete--dropdown-item`
directly — that selector also matches the placeholder, so a raw click can select
"Loading...".
```
fill input.o-autocomplete--input SearchTerm
waitidle
pick SearchTerm
```

**After hash URL navigation, page looks empty:**
- OWL renders after `domcontentloaded` — add `waitidle` after hash navigation

**Flows are slow:**
- Replace fixed `wait <ms>` with `waitidle` — it returns as soon as Odoo finishes
  its RPCs and loading overlays disappear (typically <1s locally vs 5-8s fixed waits)
- Use `waitfor <sel>` when waiting for a specific element. Note `waitfor .o-autocomplete--dropdown-item` resolves on the "Loading..." placeholder too, so follow it with `pick` (which waits for real options) rather than a raw `click`
- Keep small fixed waits only for pure CSS animations that fire no network requests

**A run hung / was killed and I can't see where:**
- Every command is echoed as `> <command>` the moment it starts, and the console is
  teed to `<tracedir>/<label>.log` **synchronously** — so a run killed by SIGTERM/timeout
  still shows the last command it reached. Read that `.log` file.
- `trace-local.sh` runs node line-buffered (`stdbuf -oL`) so output streams live.

**A bad selector makes the flow look frozen:**
- Actions fail fast at **8s** by default (not Playwright's silent 30s). Bad selectors print
  `TIMEOUT on <cmd> <sel>` immediately with a "matched 0 elements" hint.
- `timeout <ms>` changes the per-action budget; `strict on` aborts the whole flow on the
  first error/timeout. Default mode continues but still exits 1 on any failed step.
  Failed login and hard timeouts always abort. Read `<label>.result.json` for
  per-step status, source line, duration, and reason. Env: `CMD_TIMEOUT`, `STRICT`.

**Date / datetime fields (Odoo 17) eat a 30s timeout on click:**
- Use `date <sel> <value>` — it fills WITHOUT clicking (the picker overlay isn't clickable),
  fires `change`, closes the picker (Escape), and commits (blur). Never `click` a date input first.
- Value format follows the user's lang. en_US: date `%d/%m/%Y`, datetime `%d/%m/%Y %H:%M:%S`
  (e.g. `date '.o_field_widget[name="commitment_date"] input' 01/06/2026 18:00:00`). Stored UTC.

**Selectors with spaces silently break `fill`/`date`/`mark`/`m2o`:**
- These commands take `<selector> <value>`, so an unquoted selector with a space gets split and
  the tail folds into the value. Wrap such selectors in `'single quotes'`. The tool now prints a
  `WARNING: selector "…" looks unquoted and may be truncated` when it detects this.
- Selector-only commands (`click`/`fclick`/`waitfor`/`bbox`/`find`/`evals`) take the whole rest of
  the line, so spaces are fine there without quoting.

**navmenu works on Odoo 14/16/17 unchanged** — the app/section/dropdown selectors are unions across
versions (v17 apps `.o_grid_apps_menu__button` opener + `a.o-app-menu-item`; sections
`.o_menu_sections > .o-dropdown > button.dropdown-toggle`; open menu `.o-dropdown--menu.d-block`).
`mode human` still draws the red pointer at each step. It waits for the app grid / dropdown to
actually render (not a fixed sleep), so it's not flaky across versions.

**Odoo 19 (verified on KST staging, 2026-10-02):** inside an app the navbar has only
`a.o_menu_toggle` (back to the app grid) — navmenu uses it as the last-resort opener.
Date fields are a `<button class="o_input">` ("Nov 1") until clicked; `date` opens the
field itself, and a v17-style `'… input'` selector is retried on the field. `record`
works (redirects to `/odoo/<model>/<id>`).

**Language-independent flows (EN/TH):** prefer `navmenu @module.xmlid` (labels are read
from Odoo in the user's language), `clickbtn <internal_name>`, `expect state <key>`
(e.g. `sale`) and ISO dates (`date <sel> 2026-12-31`). Mixed or transliterated labels
still work; these are recommendations, not rules.

**Manual steps:** wrap each manual section in `step '<title>' ['<description>']`; the
section's 1440x900 screenshot is taken automatically when the next step starts.
Put secrets in `TRACE_VAR_<NAME>` env vars and write `{{NAME}}` in the flow. Use
`capture` to pass a record id / document number to later lines. See README
"User-manual steps, variables and capture" and "API mode".

**HTTP API (P3):** other systems submit batches to `api/server.js` (Docker: `docker compose up -d`,
127.0.0.1:8080). A request is JSON — transactions → steps → `commands` (normal flow lines) —
compiled to flows and run per language; results come back as `bundle.zip` + `manifest.json` +
draft manual. See README "HTTP API" and `api/examples/sales-manual.json`. Captions must be given
for every requested language; `login`/`lang`/`step`/`done`/`eval`/`cookie` are reserved there.

---

## Deliverable

After setup, produce:
1. A working `flows/<name>.txt` file for the developer's target flow
2. A short summary of what selectors/IDs you discovered for their DB
3. The command to run it and pull the trace zip

## Explicit run context and assertions

Use `trace-local.sh <name> [url] --task T26-12345 --session-id <current-session> --db <db>`.
Both launchers also accept `ODOO_TASK`, `ODOO_SESSION_ID`, and `ODOO_DB`; flags win.
Never infer the task/session from the newest Claude log or dashboard session. If
only a session is provided, task lookup is restricted to that exact ID. Missing
context stays unassigned. A `--db` conflicting with URL `?db=` is an error.

Use `expect visible|hidden|text|value <selector> [expected]`, `expect state <label>`,
and `expect dialog <title>` to verify outcomes. Quote selectors containing spaces.
These retry within the action timeout and fail the run if the expected UI state
is absent. Trace creation alone is not proof of success: inspect the exit code
and `<label>.result.json`. See README for the result schema and context metadata.

## Field names and editable rows (Odoo 17)

Prefer `field amount 10` for scalar form/wizard fields and
`rowset invoice_line_ids 'name=Service A' quantity 2` for existing rows. A row may
also be selected by `#1` (first visible data row). Field names are resolved in the
active form/topmost dialog. Exact row matching must be unique. The helper waits
for the row editor, commits widget changes, and verifies the displayed result.
It does not press Save. Read README for supported widget types and limitations.

`eval` takes a JavaScript expression and awaits its returned promise. Do not use
bare top-level `await`; return the promise or wrap code in an async IIFE.
