# Trace Kit API: Headers, Request Body and Responses

Reference for teams that call the Trace Kit API. Every response example in this file
**was captured from a real API call**; `run_id` values and timestamps differ on each run.

- **Base URL:** `https://trace.odoo19e.com/api/v1`
- **Format:** JSON (UTF-8) in both directions, except downloaded files
- **Full request example:** [api/examples/sales-manual.json](../api/examples/sales-manual.json), explained field by field in [sales-manual.md](../api/examples/sales-manual.md) (Thai)
- Thai version of this document: [API-REFERENCE.md](API-REFERENCE.md)

## Contents
1. [Endpoints](#1-endpoints)
2. [Headers (`-H`)](#2-headers--h)
3. [Request body](#3-request-body)
4. [Responses by endpoint](#4-responses-by-endpoint)
5. [Status values](#5-status-values)
6. [Callback and signature verification](#6-callback-and-signature-verification)
7. [A complete round trip with curl](#7-a-complete-round-trip-with-curl)

---

## 1. Endpoints

| Method | Path | Token | Body | Success response |
|---|---|---|---|---|
| GET | `/health` | no | – | `200` service status |
| POST | `/checks` | ✅ | JSON (same as `/runs`) | `200` passed · `422` failed |
| POST | `/runs` | ✅ | JSON | `202` accepted |
| GET | `/runs` | ✅ | – | `200` this token's runs |
| GET | `/runs/{run_id}` | ✅ | – | `200` status and results |
| POST | `/runs/{run_id}/cancel` | ✅ | – | `202` |
| GET | `/runs/{run_id}/manifest` | ✅ | – | `200` JSON (after the run finishes) |
| GET | `/runs/{run_id}/bundle.zip` | ✅ | – | `200` zip file (after the run finishes) |
| GET | `/runs/{run_id}/manual.md?lang=th_TH` | ✅ | – | `200` Markdown (after the run finishes) |
| GET | `/runs/{run_id}/manual.html?lang=th_TH` | ✅ | – | `200` HTML (after the run finishes) |
| GET | `/runs/{run_id}/report.html?lang=th_TH` | ✅ | – | `200` HTML test report (after the run finishes) |
| GET | `/runs/{run_id}/tx/{tx_id}/trace.zip?lang=th_TH` | ✅ | – | `200` zip file (after the run finishes) |
| GET | `/runs/{run_id}/files/{path}` | ✅ | – | `200` a single file from the bundle, e.g. a screenshot |

- Paths are relative to the Base URL, e.g. `https://trace.odoo19e.com/api/v1/runs`.
- Without `?lang=`, the first language of the request's `lang` is used.

### One run, both a test case and a manual

The same body produces two documents; pick by reader:

| | `manual.html` / `manual.md` | `report.html` |
|---|---|---|
| Reader | end users (user / manager manual) | developers, testers, acceptance reviewers |
| Requested by | `output.manual` in the request | always available, nothing to request |
| Content | chapters, steps, descriptions, screenshots | overall result, failures, every step's screenshot + each transaction's last screen, a Step / Result table with ✓/✗ checks |
| Failed steps | **screenshot hidden**, a warning instead (keeps wrong pictures out of a manual) | **all shown**, with the error |
| In `bundle.zip` | ✅ `manual/<lang>.md` and `.html` | ❌ rendered on request from `manifest.json` + the bundle's images |

The checks in `report.html` come from `steps[].checks` in the manifest ([4.6](#46-get-runsrun_idmanifest--200-after-the-run-finishes)):
every `expect` (from `expect` and from `commands`), `highlight` (red box) and the transaction's `capture`.

---

## 2. Headers (`-H`)

### 2.1 Request headers

| Header | Required for | Value | If missing |
|---|---|---|---|
| `Authorization` | every endpoint except `/health` | `Bearer <your team's token>` | `401` |
| `Content-Type` | `POST /runs` and `POST /checks` | `application/json` | recommended on every request |

```bash
curl -s -X POST https://trace.odoo19e.com/api/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @body.json
```

- **Tokens:** issued by the administrator, one per team or calling system. A token only sees
  the runs it submitted; requesting another token's `run_id` returns `404`.
- **Body size:** at most 1 MB, otherwise `413`.
- **Use `--data-binary @file`**, not `-d`, so Thai text and line breaks are sent unchanged.
- **Never put a token in source code or chat.** Keep it in an environment variable or a secret manager.

### 2.2 Response headers

| Header | When | Value / meaning |
|---|---|---|
| `Content-Type` | every response | `application/json; charset=utf-8`, or the type of a downloaded file (`application/zip`, `image/png`, `text/markdown`, `text/html`) |
| `Cache-Control` | every response | `no-store` (results change as the run progresses; do not cache) |
| `Location` | `202` from `POST /runs` | URL of the new run, same as `links.self` |
| `WWW-Authenticate` | `401` | `Bearer` |
| `Content-Disposition` | `bundle.zip` and `trace.zip` downloads | `attachment; filename="trace-bundle-<run_id>.zip"` |
| `Content-Length` | downloads | file size in bytes |
| `Strict-Transport-Security` | every HTTPS response | HTTPS is enforced |

Real headers of a `202` and of a bundle download:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Location: https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224
```
```http
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Length: 223421
Content-Disposition: attachment; filename="trace-bundle-a6d21254-d1f4-479e-8de3-f1a875f11224.zip"
Cache-Control: no-store
```

### 2.3 Callback headers (your system receives them)
See [section 6](#6-callback-and-signature-verification).

---

## 3. Request body

`POST /runs` and `POST /checks` take the same body (`/checks` only validates; it does not run anything).

### 3.1 Structure

```text
{
  target          object   ✅  the Odoo to run against
  lang            string | string[]    language(s) (default "en_US")
  on_failure      "stop" | "continue"  (default "stop")
  callback_url    string               where to POST the result when the run finishes
  output          object               draft manual
  options         object               speed and timeouts
  transactions    object[] ✅           the chapters of the manual
}
```

### 3.2 All fields

**`target`**

| Field | Type | Required | Default / limits | Meaning |
|---|---|---|---|---|
| `url` | string | ✅ | `http://` or `https://` | Odoo login page, e.g. `https://erp.example.com/web/login` |
| `db` | string | ✅ | | database name |
| `version` | string | | e.g. `"17.0"`, `"19.0"` | checked against the server's real version; on mismatch the run does not start |
| `login` | string | ✅ | | user the browser logs in with (a dedicated manual user is recommended) |
| `password` | string | ✅ | | that user's password; held in memory during the run only, never written to disk |
| `api_key` | string | | | accepted now, used from P4 |

**Top level**

| Field | Type | Default / limits | Meaning |
|---|---|---|---|
| `lang` | string or array | `"en_US"` · up to 4 | the whole batch runs once per language; the user's language is switched during the run and restored afterwards |
| `on_failure` | `"stop"` \| `"continue"` | `"stop"` | `stop`: every remaining transaction is skipped · `continue`: only transactions that `depends_on` a failed one are skipped |
| `callback_url` | string | | URL the service POSTs to when the run finishes |
| `output.manual.formats` | array | `["md","html"]` | draft manual formats; include `output.manual` only when you want a draft manual |
| `output.manual.title` | text | | manual title |
| `options.mode` | `"human"` \| `"quick"` | `"human"` | `human` clicks through the menus with a red pointer (best for manuals) · `quick` jumps straight to the target screen |
| `options.timeout_ms` | integer | `8000` (1000–60000) | maximum wait per command |
| `options.transaction_timeout_s` | integer | `600` (30–3600) | maximum time per transaction |

**`transactions[]`** (up to 20)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | ✅ | starts with a letter; only `A-Z a-z 0-9 _`; at most 32 characters; unique, e.g. `T1` |
| `title` | text | ✅ | chapter title; may use `{{T1.x}}` |
| `depends_on` | string or array | | `id` of an **earlier** transaction; if that one does not pass, this one is skipped |
| `steps` | array | ✅ | 1–60 steps |
| `capture` | object | | `{ "<name>": "url id" \| "field <field_name>" \| "text <selector>" }`, read at the end of the last step; later transactions use it as `{{T1.<name>}}` |
| `unit` | array | | accepted now, used from P4 |

**`steps[]`** (1 step = 1 screenshot, 1440×900)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `title` | text | ✅ | section heading in the manual |
| `description` | text | | text under the heading |
| `commands` | string[] | ✅ | browser commands, one per string (1–60); command names are in [COMMANDS.md](../COMMANDS.md) |
| `expect` | string[] | | what must be true at the end of the step, written without the leading `expect`, e.g. `"state draft"`, `"visible .o_list_view"` |
| `highlight.selector` | string | | element to draw a red box around before the screenshot |
| `highlight.caption` | text | | label on the red box |

### 3.3 Text rules (`text`)
- **One language requested:** a plain string is fine, e.g. `"title": "Open a quotation"`.
- **Several languages:** an object with **every** requested language, e.g.
  `"title": { "en_US": "Open a quotation", "th_TH": "เปิดใบเสนอราคา" }`.
  A missing language returns `422` (`captions_complete`); text is never generated for you.
- One line only.
- A `'` in text is converted to `’` automatically.

### 3.4 `commands` rules
- `login`, `lang`, `step`, `done`, `strict`, `eval` and `cookie` are reserved for the API.
- Single quotes `'` must be balanced.
- A `"` inside a selector must be written as `\"` in JSON, e.g.
  `"date '.o_field_widget[name=\"validity_date\"]' 2026-12-31"`.
- `highlight.selector` must not contain `'`.
- The browser may only open the host of `target.url`; any other site is blocked.

### 3.5 Example body (2 languages, 2 transactions passing a value, callback, draft manual)

```json
{
  "target": {
    "url": "https://your-odoo.example.com/web/login",
    "db": "your_db",
    "version": "17.0",
    "login": "manual_bot",
    "password": "********"
  },
  "lang": ["en_US", "th_TH"],
  "on_failure": "continue",
  "callback_url": "https://manual-system.example.com/hooks/trace",
  "output": {
    "manual": { "formats": ["md", "html"], "title": { "en_US": "Sales manual", "th_TH": "คู่มือการขาย" } }
  },
  "transactions": [
    {
      "id": "T1",
      "title": { "en_US": "Open a quotation", "th_TH": "เปิดใบเสนอราคา" },
      "steps": [
        {
          "title": { "en_US": "Open the quotation list", "th_TH": "เปิดรายการใบเสนอราคา" },
          "description": { "en_US": "Sales > Orders > Quotations", "th_TH": "ขาย > คำสั่งซื้อ > ใบเสนอราคา" },
          "commands": ["navmenu @sale.menu_sale_quotations"],
          "expect": ["visible .o_list_view"],
          "highlight": { "selector": ".o_data_row:first-child", "caption": { "en_US": "Latest quotation", "th_TH": "ใบเสนอราคาล่าสุด" } }
        },
        {
          "title": { "en_US": "Open the latest quotation", "th_TH": "เปิดใบเสนอราคาล่าสุด" },
          "commands": ["jclick .o_data_row:first-child td.o_data_cell", "waitidle"]
        }
      ],
      "capture": { "so_id": "url id", "so_name": "field name" }
    },
    {
      "id": "T2",
      "depends_on": "T1",
      "title": { "en_US": "Reopen {{T1.so_name}}", "th_TH": "เปิด {{T1.so_name}} อีกครั้ง" },
      "steps": [
        {
          "title": { "en_US": "Open {{T1.so_name}} by id", "th_TH": "เปิด {{T1.so_name}} ด้วยเลขที่" },
          "commands": ["record sale.order {{T1.so_id}}"],
          "expect": ["text '.o_field_widget[name=\"name\"]' {{T1.so_name}}"]
        }
      ]
    }
  ]
}
```

---

## 4. Responses by endpoint

Every error has the same shape: `{ "error": "<message>" }`, sometimes with extra fields such as `details` or `status`.

### 4.1 `GET /health` → `200`
```json
{
  "ok": true,
  "version": "1.0.0",
  "running": 0,
  "queued": 0,
  "max_concurrent_runs": 1
}
```
| Field | Meaning |
|---|---|
| `running` | runs in progress |
| `queued` | runs waiting in the queue |
| `max_concurrent_runs` | how many runs may execute at once |

### 4.2 `POST /checks` → `200` (passed) or `422` (failed)
Validates the body and asks Odoo for its version, without opening a browser.
```json
{
  "ok": true,
  "static_checks": [
    { "name": "request",       "status": "passed", "detail": "schema, flow_syntax, captions_complete" },
    { "name": "reachable",     "status": "passed", "detail": "17.0" },
    { "name": "version_match", "status": "passed", "detail": "requested 17.0, server reports 17.0" }
  ]
}
```
An invalid body returns the same `422` as in [4.4](#44-request-errors).

### 4.3 `POST /runs` → `202 Accepted`
The run is queued; it has not started yet.
```json
{
  "run_id": "a6d21254-d1f4-479e-8de3-f1a875f11224",
  "status": "queued",
  "position": 0,
  "links": {
    "self":        "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224",
    "manifest":    "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224/manifest",
    "bundle":      "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224/bundle.zip",
    "manual_md":   "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224/manual.md",
    "manual_html": "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224/manual.html",
    "report_html": "https://trace.odoo19e.com/api/v1/runs/a6d21254-d1f4-479e-8de3-f1a875f11224/report.html"
  }
}
```
| Field | Meaning |
|---|---|
| `run_id` | run identifier; **store it** to poll status and download results |
| `position` | runs queued ahead of this one (`0` = starts immediately) |
| `links` | ready-made URLs; usable once the run has finished (`self` works at any time); add `?lang=` to the `manual_*` and `report_html` links yourself |

### 4.4 Request errors

**`422` validation failed:** `details` lists every problem at once, each with its JSON `path`.
```json
{
  "error": "validation failed",
  "details": [
    { "path": "target.password", "message": "required" },
    { "path": "transactions[0].title", "message": "give one text per language: {\"en_US\": \"…\", \"th_TH\": \"…\"}" },
    { "path": "transactions[0].steps[0].title.th_TH", "message": "missing th_TH text (captions_complete)" },
    { "path": "transactions[0].steps[0].commands[0]", "message": "\"eval\" is managed by the API and cannot be used in a step" }
  ]
}
```

| Status | `error` | Cause |
|---|---|---|
| `400` | `body is not valid JSON` | malformed JSON |
| `401` | `missing or invalid bearer token` | token missing or wrong (with `WWW-Authenticate: Bearer`) |
| `413` | `body larger than 1 MB` | body over 1 MB |
| `422` | `validation failed` | see `details` |

### 4.5 `GET /runs/{run_id}` → `200`
Poll this (every 10–30 seconds is plenty) or wait for the callback.

**While running**
```json
{
  "run_id": "a6d21254-d1f4-479e-8de3-f1a875f11224",
  "status": "running",
  "client": "manual-system",
  "created_at": "2026-10-29T19:17:17.418Z",
  "started_at": "2026-10-29T19:17:17.425Z",
  "finished_at": null,
  "target": { "url": "https://your-odoo.example.com/web/login", "db": "your_db", "version": "17.0" },
  "langs": ["en_US", "th_TH"],
  "on_failure": "continue",
  "progress": null,
  "static_checks": [
    { "name": "reachable",     "status": "passed", "detail": "17.0" },
    { "name": "version_match", "status": "passed", "detail": "requested 17.0, server reports 17.0" }
  ],
  "results": null,
  "lang_restore": null,
  "callback": null,
  "traces_expired": false,
  "error": null,
  "links": { "self": "…", "manifest": "…", "bundle": "…", "manual_md": "…", "manual_html": "…", "report_html": "…" }
}
```

**When finished** (only the fields that change)
```json
{
  "status": "passed",
  "finished_at": "2026-10-29T19:17:30.313Z",
  "progress": { "lang": "th_TH", "transaction": "T2" },
  "results": {
    "en_US": {
      "status": "passed",
      "transactions": [
        { "id": "T1", "status": "passed", "error": null, "failed_step": null, "captured": { "so_name": "S00042" } },
        { "id": "T2", "status": "passed", "error": null, "failed_step": null, "captured": {} }
      ]
    },
    "th_TH": {
      "status": "passed",
      "transactions": [
        { "id": "T1", "status": "passed", "error": null, "failed_step": null, "captured": { "so_name": "S00042" } },
        { "id": "T2", "status": "passed", "error": null, "failed_step": null, "captured": {} }
      ]
    }
  },
  "lang_restore": { "lang": "en_US", "status": "passed" }
}
```

| Field | Meaning |
|---|---|
| `status` | overall run status ([section 5](#5-status-values)) |
| `progress` | the last transaction that **finished** (`null` = the first one is still running) |
| `static_checks` | pre-run checks; if any is `failed`, every transaction is skipped |
| `results.<lang>.status` | result for that language: `passed` / `partial` / `failed` |
| `results.<lang>.transactions[].status` | `passed` / `failed` / `skipped` |
| `…transactions[].error` | why it failed or was skipped: `<failing command>: <details>`, or `depends on T1, which did not pass` |
| `…transactions[].failed_step` | number of the first step that did not pass (`null` = all passed) |
| `…transactions[].captured` | values captured in that language |
| `lang_restore` | the user's original language and whether it was restored (`passed` / `failed` / `not needed`) |
| `callback` | callback delivery `{url, status: "delivered" \| "failed", attempts, last_error}`; filled in shortly after `status` becomes final |
| `traces_expired` | `true` once trace.zip files have been removed by retention (14 days) |
| `error` | message when `status` is `error` |

### 4.6 `GET /runs/{run_id}/manifest` → `200` (after the run finishes)
The main data source for a manual system: **chapter and step titles, descriptions and screenshot paths**.
```json
{
  "schema": "trace-kit-manifest/1",
  "run_id": "a6d21254-d1f4-479e-8de3-f1a875f11224",
  "status": "passed",
  "created_at": "2026-10-29T19:17:17.418Z",
  "finished_at": "2026-10-29T19:17:30.313Z",
  "target": { "url": "https://your-odoo.example.com/web/login", "db": "your_db", "version": "17.0" },
  "langs": ["en_US", "th_TH"],
  "viewport": { "width": 1440, "height": 900 },
  "static_checks": [ "…" ],
  "lang_restore": { "lang": "en_US", "status": "passed" },
  "results": {
    "th_TH": {
      "status": "passed",
      "transactions": [
        {
          "id": "T1",
          "title": "เปิดใบเสนอราคา",
          "status": "passed",
          "error": null,
          "failed_step": null,
          "captured": { "so_name": "S00042" },
          "trace": "th_TH/T1/trace.zip",
          "log": "th_TH/T1/run.log",
          "final_screenshot": "th_TH/T1/final.jpeg",
          "steps": [
            {
              "no": 1,
              "title": "กรอกจำนวน",
              "description": "พิมพ์ 5",
              "status": "passed",
              "error": null,
              "screenshot": "th_TH/T1/shots/01-step.png",
              "checks": [
                { "kind": "expect", "label": "value #amount 5", "line": 9, "status": "passed", "error": null },
                { "kind": "mark",   "label": "จำนวน",           "line": 10, "status": "passed", "error": null }
              ]
            }
          ]
        },
        {
          "id": "T2",
          "title": "ค้นหา S00042",
          "status": "passed",
          "steps": [ { "no": 1, "title": "ค้นหา S00042", "screenshot": "th_TH/T2/shots/01-s00042.png", "…": "…" } ]
        }
      ]
    },
    "en_US": { "…": "…" }
  }
}
```
- Titles in the manifest **have variables filled in**: `ค้นหา {{T1.so_name}}` becomes `ค้นหา S00042`.
- `screenshot`, `trace` and `log` paths are relative to the root of `bundle.zip`; each file can also be
  downloaded on its own with `GET /runs/{run_id}/files/<path>`, e.g. `/files/th_TH/T1/shots/01-step.png`.
- Screenshot file names keep ASCII characters only (a Thai title becomes `01-step.png`); use the `title` in the manifest, not the file name.
- Steps whose `status` is not `passed` still keep their screenshot for investigation, **but it should not go into a manual**.
- `final_screenshot` is the transaction's last screen (from its trace), present even when it broke before its first step, e.g. a failed login · `null` when there is no trace.
- `checks` lists what the step verified, in run order:

| Field | Meaning |
|---|---|
| `kind` | `expect` (a condition that must hold) · `mark` (red box from `highlight` or a `mark` command) · `capture` (a captured value) · `command` (another command that broke: why the step failed) |
| `label` | readable text, e.g. `state sale`, `จำนวน`, `so_name = S00042` (at most 120 characters) |
| `line` | line in the flow the API generated from the request (matches `run.log`) |
| `status` / `error` | that command's result, and its message when it failed |

### 4.7 Downloads (after the run finishes)

| Endpoint | Content-Type | Content |
|---|---|---|
| `/bundle.zip` | `application/zip` | `manifest.json`, `<lang>/<tx>/shots/*.png`, `<lang>/<tx>/final.jpeg`, `<lang>/<tx>/trace.zip`, `result.json`, `run.log`, `manual/<lang>.md` and `.html` |
| `/manual.md?lang=` | `text/markdown; charset=utf-8` | draft manual; images are separate files in the bundle |
| `/manual.html?lang=` | `text/html; charset=utf-8` | single-file draft manual with embedded images; opens directly in a browser |
| `/report.html?lang=` | `text/html; charset=utf-8` | single-file test report with embedded images: overall result, failures, every step's screenshot + last screens, Step / Result table with ✓/✗ (every run, no `output` needed) |
| `/tx/{tx_id}/trace.zip?lang=` | `application/zip` | Playwright trace of one transaction; open it at https://trace.playwright.dev |
| `/files/{path}` | depends on the file | one file from the bundle |

### 4.8 `GET /runs` → `200`
This token's runs, newest first. Query: `?status=passed&limit=50` (`limit` at most 200).
```json
{ "runs": [ { "run_id": "a6d21254-…", "status": "passed", "client": "manual-system", "created_at": "…", "…": "…" } ] }
```
Each item has the same fields as [4.5](#45-get-runsrun_id--200).

### 4.9 `POST /runs/{run_id}/cancel`
| Status | Body | Meaning |
|---|---|---|
| `202` | `{"run_id": "…", "status": "cancelled"}` | the run was still queued and is cancelled immediately |
| `202` | `{"run_id": "…", "status": "cancelling"}` | the run is executing; the current transaction is stopped — keep polling until `cancelled` |
| `409` | `{"error": "run already passed"}` | the run has already finished |

### 4.10 Other errors on `/runs/{run_id}/…`

| Status | `error` | Cause |
|---|---|---|
| `404` | `run not found` | no such run, or it belongs to another token |
| `404` | `run has no language th_TH` | `?lang=` is not one of the requested languages |
| `404` | `not found` | the file does not exist, e.g. no draft manual was requested, or the trace has expired |
| `409` | `run is running; results are available when it finishes` | results requested before the run finished (a `status` field shows the current status) |
| `400` | `bad path` | a `/files/…` path points outside the bundle |
| `405` | `method not allowed` | wrong HTTP method |

---

## 5. Status values

**Run status (`status`)**

| Value | Finished? | Meaning |
|---|---|---|
| `queued` | no | waiting in the queue |
| `running` | no | executing |
| `passed` | yes | every transaction passed in every language |
| `partial` | yes | `on_failure: "continue"` and some transactions passed |
| `failed` | yes | a transaction failed, or a static check failed |
| `cancelled` | yes | cancelled |
| `error` | yes | service problem, e.g. a server restart during the run — **submit it again** |

**Transaction and step status:** `passed`, `failed`, `skipped` (transactions only: skipped because of `on_failure: stop` or a failed `depends_on`).

**Static check names:** `request` (only in `/checks`), `reachable`, `version_match`.

---

## 6. Callback and signature verification

When a run finishes and the request had a `callback_url`, the service sends a `POST` to it.

**Headers your system receives**

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `trace-kit/1.0.0` |
| `X-TraceKit-Signature` | `sha256=<hex HMAC-SHA256 of the whole body>` (present when the administrator set `TRACE_CALLBACK_SECRET`) |

**Body:** `{"event": "run.finished", …}` followed by every field from [4.5](#45-get-runsrun_id--200).
```json
{
  "event": "run.finished",
  "run_id": "a6d21254-d1f4-479e-8de3-f1a875f11224",
  "status": "passed",
  "client": "manual-system",
  "finished_at": "2026-10-29T19:17:30.313Z",
  "results": { "…": "…" },
  "links": { "self": "…", "manifest": "…", "bundle": "…", "manual_md": "…", "manual_html": "…", "report_html": "…" }
}
```

**What the receiver must do**
- Answer `2xx` within 10 seconds. Otherwise the service retries, for at most 4 attempts in total (1, 5 and 15 seconds apart).
- **Verify the signature every time**, computing the HMAC over the raw body bytes as received (do not parse and re-serialize).
- A callback may arrive more than once; use `run_id` to avoid processing it twice.

**Verifying the signature (Node.js)**
```js
const crypto = require('crypto');
function verify(rawBody, header, secret) {           // rawBody: Buffer of the received body
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return header && header.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

**Verifying the signature (Python)**
```python
import hmac, hashlib
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header or "", expected)
```

---

## 7. A complete round trip with curl

```bash
API=https://trace.odoo19e.com/api/v1
TOKEN=<your team's token>
H_AUTH="Authorization: Bearer $TOKEN"

# 1) Is the service up?
curl -s $API/health

# 2) Validate the body first (does not run anything)
curl -s -X POST $API/checks -H "$H_AUTH" -H "Content-Type: application/json" --data-binary @body.json

# 3) Submit the run → keep the run_id
RUN=$(curl -s -X POST $API/runs -H "$H_AUTH" -H "Content-Type: application/json" --data-binary @body.json \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['run_id'])")
echo "run_id: $RUN"

# 4) Poll until it finishes (or wait for the callback)
while :; do
  ST=$(curl -s -H "$H_AUTH" $API/runs/$RUN | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  echo "status: $ST"; case $ST in queued|running) sleep 15;; *) break;; esac
done

# 5) Download the results
curl -s -H "$H_AUTH" -o bundle.zip      $API/runs/$RUN/bundle.zip
curl -s -H "$H_AUTH" -o manifest.json   $API/runs/$RUN/manifest
curl -s -H "$H_AUTH" -o manual-th.html "$API/runs/$RUN/manual.html?lang=th_TH"   # user manual
curl -s -H "$H_AUTH" -o report-th.html "$API/runs/$RUN/report.html?lang=th_TH"   # test report
```

**Typical duration:** about 10 seconds per step per language, e.g. 3 transactions × 5 steps × 2 languages ≈ 5 minutes.
Runs execute one at a time; runs submitted at the same time wait in the queue (see `position` and `/health`).

**Retention:** trace.zip files are kept 14 days; screenshots, manifest and manuals 180 days.
