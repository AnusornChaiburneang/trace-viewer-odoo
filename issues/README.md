# odoo-trace-kit — issues / improvement log

Drop a short `.txt` here **whenever a trace run hits a problem** — a selector that
didn't work, a menu/dialog the tool couldn't handle, a version quirk, a flaky step,
anything worth fixing later. These notes drive the kit's development.

## When to write one
After running any flow, if you hit an issue (or a workaround you had to invent),
create a note here before moving on. Don't fix it silently in your head — write it
down so it can be turned into a real command/fix.

## Naming
`<yyyy-mm-dd>-<short-slug>.txt`  — e.g. `2026-08-03-mo-detailed-ops-cell-focus.txt`

## What to put in it
- **Context:** Odoo version + db, the flow/screen (e.g. "MO Detailed Operations popup, dv_kc, v17").
- **What failed:** the exact command + what happened (paste the tool's log line).
- **Workaround (if any):** what you did instead that worked.
- **Suggested fix:** a new command, a selector, a doc note — whatever would stop
  the next session from rediscovering it.

Keep each note to a few lines. One issue per file.
