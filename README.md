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

Trace saved to `traces/so-flow.zip`.

---

## View a trace

```bash
npx playwright show-trace traces/demo.zip
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

## Commands

| Command | What it does |
|---|---|
| `login <user> <pass>` | Log in — auto-skips when the saved session (`.sessions/`, per host+db) is still valid |
| `goto <url>` | Navigate |
| `mode human\|quick` | Navigation style for `navmenu` (default `human`) |
| `navmenu A > B > C [@id]` | Navigate by clicking menu labels (human) or jumping to `#action=id` (quick) |
| `click <sel>` | Click — waits for visibility |
| `fclick <sel>` | Force click — skips visibility check |
| `jclick <sel>` | JS click — for Odoo SPA list buttons |
| `clickbtn <text>` | Click a button by its visible label; prints the internal name it resolved |
| `buttons` | List all visible buttons: internal name + label (run before guessing selectors) |
| `fill <sel> <text>` | Fill input. Wrap multi-word selectors in `'single quotes'` |
| `type <text>` | Type into focused element (no selector — use after clicking a combobox) |
| `m2o <cell_sel> <text>` | Many2one: click cell → type → pick first dropdown (use instead of `fill` on OWL combobox cells) |
| `addline <field_name>` | Add a row to a One2many list (e.g. `addline order_line`), waits for row to appear |
| `press <key>` | Keyboard: `Enter` `Tab` `Escape` `ArrowDown` |
| `wait <ms>` | Pause (fixed — prefer `waitidle`) |
| `waitidle [maxMs]` | Wait until Odoo is idle (RPCs done + loading overlay gone). Much faster than fixed waits |
| `screenshot [name]` | Save PNG to `traces/` |
| `snapshot` | Print visible element tree (selector discovery) |
| `eval <js>` | Run JS, print result |
| `cookie <name> <value> [domain]` | Set a raw browser cookie (works for HttpOnly, e.g. a session_id obtained via `/web/session/authenticate`) |
| `highlight <sel>` | Draw Playwright's native pink box around an element — shows in screenshots, but NOT in the trace viewer's Snapshot tab |
| `mark <sel> [caption]` | Inject a real red box + caption around an element — visible in the trace viewer's Snapshot tab and every screenshot after it |
| `unmark` | Remove all marks added by `mark` |
| `bbox <sel>` | Print an element's `{x,y,width,height}` viewport box, for a custom annotation (e.g. drawing a circle/arrow with Pillow) |
| `evals <sel>` | Print outerHTML of matched elements (structure inspection) |
| `find <sel>` | Print up to 5 matching elements |
| `waitfor <sel>` | Wait up to 15s for selector to appear |
| `url` / `title` | Print current URL or page title |
| `done` | Stop recording, save zip |

Lines starting with `#` are ignored.

---

## Share a trace

Pull the zip to your local machine:
```bash
scp user@server:/path/to/odoo-trace-kit/traces/demo.zip .
npx playwright show-trace demo.zip
```

Or upload the `.zip` to a shared drive and teammates open it at https://trace.playwright.dev.
