# odoo-trace-kit — AI Setup Guide

You are helping a developer use this tool to record and replay Odoo UI flows as Playwright traces.

## What this tool does

`pw_trace.js` runs a headless Chromium browser and lets the user (or you) type commands line-by-line to drive it:
- navigate pages, click buttons, fill fields, take screenshots
- save everything as a `.zip` trace viewable in the Playwright Trace Viewer

## Your job: discover their environment first

Before writing any flow or running any command, ask the developer:

1. **Odoo URL** — `http://localhost:8069` or a remote IP/hostname?
2. **Database name** — which DB to test against?
3. **Login credentials** — username + password for the test session
4. **Odoo version** — 14, 16, 17, 18? (affects selectors and URL patterns)
5. **What flow do they want to record?** — e.g. SO→Invoice, Purchase, Inventory, etc.

If they don't know some answers, help them find out:

```bash
# Check running Odoo process
ps aux | grep odoo-bin | grep -v grep

# List available databases
psql -U odoo -h localhost -c "\l" 2>/dev/null | grep -v template

# Check Odoo version from source
grep -r "^version" /path/to/odoo/odoo/release.py 2>/dev/null | head -3
```

---

## Environment probe — run BEFORE writing flows

Once you have the URL + DB + credentials, do a quick probe run to discover:

### 1. Verify login works
```bash
./trace.sh PROBE http://ODOO_URL/web/login <<'EOF'
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

### 3. Discover button names on a form

After opening a form (e.g. new SO), run:
```
buttons
```
This lists every visible button as `name="<internal>" | "<label>"` — the ground truth for
which selector to click. Button names vary by module (`action_confirm` vs `action_sale_ok`
vs numeric action IDs), so never guess: run `buttons` first.

**Or skip internal names entirely** — click by the visible label:
```
clickbtn Create Invoice
```
`clickbtn` matches visible text (exact first, then contains, case-insensitive) and prints
the internal name it resolved to, so you learn the selector for free. If it reports
NOT FOUND, run `buttons` to see what's actually on screen.

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
wait 2000
fill .modal input.o_searchview_input SearchTerm
press Enter
wait 2000
```

---

## How to write a flow file

Once you know the selectors, write a `.txt` file in `flows/`. Comments start with `#`.

**Template for any login + form flow:**
```
# flows/my-flow.txt
# Env: Odoo X.X @ http://HOST:8069 / DB: my_db

# Login
fill input#login admin
fill input#password admin
press Enter
wait 6000

# Navigate
goto http://HOST:8069/web#action=ACTION_ID
wait 8000

# ... your steps here ...

screenshot
done
```

Then run:
```bash
./trace.sh MY-FLOW http://HOST:8069/web/login < flows/my-flow.txt
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

**Autocomplete not selecting:**
```
fill input.o-autocomplete--input SearchTerm
wait 2000
click .o-autocomplete--dropdown-item
wait 1500
```

**After hash URL navigation, page looks empty:**
- OWL renders after `domcontentloaded` — add `waitidle` after hash navigation

**Flows are slow:**
- Replace fixed `wait <ms>` with `waitidle` — it returns as soon as Odoo finishes
  its RPCs and loading overlays disappear (typically <1s locally vs 5-8s fixed waits)
- Use `waitfor <sel>` when waiting for a specific element (e.g. `waitfor .o-autocomplete--dropdown-item` after typing in an autocomplete)
- Keep small fixed waits only for pure CSS animations that fire no network requests

---

## Deliverable

After setup, produce:
1. A working `flows/<name>.txt` file for the developer's target flow
2. A short summary of what selectors/IDs you discovered for their DB
3. The command to run it and pull the trace zip
