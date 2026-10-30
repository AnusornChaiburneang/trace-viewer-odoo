# Trace Kit API: Header, Request body และ Response

คู่มืออ้างอิงสำหรับทีมที่เรียกใช้ Trace Kit API ตัวอย่าง response ทั้งหมดในไฟล์นี้**ได้จากการเรียก API จริง**
ส่วน `run_id` และเวลาจะเปลี่ยนไปในแต่ละครั้งที่รัน

- **Base URL:** `https://trace.odoo19e.com/api/v1`
- **รูปแบบข้อมูล:** JSON (UTF-8) ทั้งขาส่งและขารับ ยกเว้นไฟล์ที่ดาวน์โหลด
- **ตัวอย่าง body แบบเต็ม:** [api/examples/sales-manual.json](../api/examples/sales-manual.json) และคำอธิบายทีละฟิลด์ใน [sales-manual.md](../api/examples/sales-manual.md)
- English version: [API-REFERENCE.en.md](API-REFERENCE.en.md)

## สารบัญ
1. [Endpoint ทั้งหมด](#1-endpoint-ทั้งหมด)
2. [Header (`-H`)](#2-header--h)
3. [Request body](#3-request-body)
4. [Response แยกตาม endpoint](#4-response-แยกตาม-endpoint)
5. [ค่าสถานะ (status)](#5-ค่าสถานะ-status)
6. [Callback และการตรวจลายเซ็น](#6-callback-และการตรวจลายเซ็น)
7. [ตัวอย่างการเรียกครบทั้งรอบด้วย curl](#7-ตัวอย่างการเรียกครบทั้งรอบด้วย-curl)

---

## 1. Endpoint ทั้งหมด

| Method | Path | ต้องมี token | Body | Response สำเร็จ |
|---|---|---|---|---|
| GET | `/health` | ไม่ต้อง | – | `200` สถานะของระบบ |
| POST | `/checks` | ✅ | JSON (แบบเดียวกับ `/runs`) | `200` ผ่าน · `422` ไม่ผ่าน |
| POST | `/runs` | ✅ | JSON | `202` รับงานแล้ว |
| GET | `/runs` | ✅ | – | `200` รายการงานของ token นี้ |
| GET | `/runs/{run_id}` | ✅ | – | `200` สถานะและผล |
| POST | `/runs/{run_id}/cancel` | ✅ | – | `202` |
| GET | `/runs/{run_id}/manifest` | ✅ | – | `200` JSON (หลังงานจบ) |
| GET | `/runs/{run_id}/bundle.zip` | ✅ | – | `200` ไฟล์ zip (หลังงานจบ) |
| GET | `/runs/{run_id}/manual.md?lang=th_TH` | ✅ | – | `200` Markdown (หลังงานจบ) |
| GET | `/runs/{run_id}/manual.html?lang=th_TH` | ✅ | – | `200` HTML (หลังงานจบ) |
| GET | `/runs/{run_id}/report.html?lang=th_TH` | ✅ | – | `200` HTML รายงานผลทดสอบ (หลังงานจบ) |
| GET | `/runs/{run_id}/tx/{tx_id}/trace.zip?lang=th_TH` | ✅ | – | `200` ไฟล์ zip (หลังงานจบ) |
| GET | `/runs/{run_id}/files/{path}` | ✅ | – | `200` ไฟล์เดียวจาก bundle เช่น ภาพ |

- path ทั้งหมดต่อท้าย Base URL เช่น `https://trace.odoo19e.com/api/v1/runs`
- ถ้าไม่ใส่ `?lang=` ระบบจะใช้ภาษาแรกใน `lang` ของ request

### งานเดียว ได้ทั้ง Test case และคู่มือ

body เดียวกันให้ผล 2 แบบ เลือกใช้ตามผู้อ่าน:

| | `manual.html` / `manual.md` | `report.html` |
|---|---|---|
| ผู้อ่าน | ผู้ใช้งาน (คู่มือ user / manager) | dev, tester, ผู้ตรวจรับงาน |
| ต้องขอ | ใส่ `output.manual` ใน request | ได้เสมอ ไม่ต้องขอ |
| เนื้อหา | ชื่อบท ขั้นตอน คำอธิบาย ภาพ | ผลรวม, จุดที่ไม่ผ่าน, ภาพทุกขั้น + ภาพสุดท้ายของแต่ละบท, ตาราง Step / Result พร้อมรายการตรวจ ✓/✗ |
| ขั้นที่ไม่ผ่าน | **ซ่อนภาพ** แสดงคำเตือนแทน (กันภาพที่ผิดหลุดเข้าคู่มือ) | **แสดงทั้งหมด** พร้อมข้อความ error |
| อยู่ใน `bundle.zip` | ✅ `manual/<lang>.md` และ `.html` | ❌ สร้างตอนขอ (ข้อมูลที่ใช้คือ `manifest.json` + ภาพใน bundle) |

รายการตรวจใน `report.html` มาจาก `steps[].checks` ใน manifest ([4.6](#46-get-runsrun_idmanifest--200-หลังงานจบ)):
`expect` ทุกตัว (ทั้งใน `expect` และใน `commands`), `highlight` (กรอบแดง), และ `capture` ของบท

---

## 2. Header (`-H`)

### 2.1 Header ที่ต้องส่งไป

| Header | ต้องส่งเมื่อ | ค่า | ถ้าไม่ส่ง |
|---|---|---|---|
| `Authorization` | ทุก endpoint ยกเว้น `/health` | `Bearer <token ของทีม>` | `401` |
| `Content-Type` | `POST /runs` และ `POST /checks` | `application/json` | แนะนำให้ส่งทุกครั้ง |

```bash
curl -s -X POST https://trace.odoo19e.com/api/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @body.json
```

- **token:** ได้จากผู้ดูแลระบบ หนึ่ง token ต่อหนึ่งทีมหรือหนึ่งระบบ แต่ละ token เห็นเฉพาะงานที่ตัวเองส่ง
  ถ้าใช้ token อื่นเรียก `run_id` ของคนอื่นจะได้ `404`
- **ขนาด body:** ไม่เกิน 1 MB ถ้าเกินจะได้ `413`
- **ใช้ `--data-binary @file`:** ไม่ใช้ `-d` เพื่อให้ข้อความภาษาไทยและการขึ้นบรรทัดถูกส่งไปตามเดิม
- **อย่าใส่ token ลงในโค้ดหรือแชต:** เก็บไว้ใน environment variable หรือ secret manager

### 2.2 Header ที่ได้กลับมา

| Header | ได้เมื่อ | ค่า / ความหมาย |
|---|---|---|
| `Content-Type` | ทุก response | `application/json; charset=utf-8` หรือชนิดของไฟล์ที่ดาวน์โหลด (`application/zip`, `image/png`, `text/markdown`, `text/html`) |
| `Cache-Control` | ทุก response | `no-store` (ผลเปลี่ยนตามสถานะงาน ห้าม cache) |
| `Location` | `202` จาก `POST /runs` | URL ของงานที่เพิ่งสร้าง ตรงกับ `links.self` |
| `WWW-Authenticate` | `401` | `Bearer` |
| `Content-Disposition` | ดาวน์โหลด `bundle.zip` และ `trace.zip` | `attachment; filename="trace-bundle-<run_id>.zip"` |
| `Content-Length` | ไฟล์ที่ดาวน์โหลด | ขนาดไฟล์ (byte) |
| `Strict-Transport-Security` | ทุก response ผ่าน HTTPS | บังคับใช้ HTTPS |

ตัวอย่าง header จริงของ `202` และของการดาวน์โหลด bundle:

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

### 2.3 Header ของ callback (ระบบของคุณเป็นฝั่งรับ)
ดู[หัวข้อ 6](#6-callback-และการตรวจลายเซ็น)

---

## 3. Request body

`POST /runs` และ `POST /checks` ใช้ body รูปแบบเดียวกัน (`/checks` ตรวจอย่างเดียว ไม่รันจริง)

### 3.1 โครงสร้าง

```text
{
  target          object   ✅  Odoo ปลายทาง
  lang            string | string[]    ภาษา (ค่าเริ่มต้น "en_US")
  on_failure      "stop" | "continue"  (ค่าเริ่มต้น "stop")
  callback_url    string               URL รับผลเมื่องานจบ
  output          object               ร่างคู่มือ
  options         object               ความเร็วและ timeout
  transactions    object[] ✅           บทของคู่มือ
}
```

### 3.2 รายละเอียดทุกฟิลด์

**`target`**

| ฟิลด์ | ชนิด | บังคับ | ค่าเริ่มต้น / ข้อจำกัด | ความหมาย |
|---|---|---|---|---|
| `url` | string | ✅ | `http://` หรือ `https://` | หน้า login ของ Odoo เช่น `https://erp.example.com/web/login` |
| `db` | string | ✅ | | ชื่อฐานข้อมูล |
| `version` | string | | เช่น `"17.0"`, `"19.0"` | ระบบตรวจกับเวอร์ชันจริงของ server ถ้าไม่ตรง งานจะไม่รัน |
| `login` | string | ✅ | | user ที่ browser ใช้ login (แนะนำ user สำหรับทำคู่มือโดยเฉพาะ) |
| `password` | string | ✅ | | รหัสผ่านของ user นั้น เก็บไว้ในหน่วยความจำระหว่างรันเท่านั้น ไม่บันทึกลงดิสก์ |
| `api_key` | string | | | รับไว้แล้ว ใช้จริงใน P4 |

**ระดับบนสุด**

| ฟิลด์ | ชนิด | ค่าเริ่มต้น / ข้อจำกัด | ความหมาย |
|---|---|---|---|
| `lang` | string หรือ array | `"en_US"` · สูงสุด 4 ภาษา | รันทั้ง batch หนึ่งรอบต่อภาษา ระบบสลับภาษาของ user ระหว่างรันแล้วคืนค่าเดิมเมื่อจบ |
| `on_failure` | `"stop"` \| `"continue"` | `"stop"` | `stop`: บทที่เหลือทั้งหมดถูกข้าม · `continue`: ข้ามเฉพาะบทที่ `depends_on` บทที่พัง |
| `callback_url` | string | | URL ที่ระบบจะ POST ผลไปให้เมื่องานจบ |
| `output.manual.formats` | array | `["md","html"]` | รูปแบบร่างคู่มือ ใส่ `output.manual` เมื่อต้องการร่างคู่มือเท่านั้น |
| `output.manual.title` | text | | ชื่อคู่มือ |
| `options.mode` | `"human"` \| `"quick"` | `"human"` | `human` คลิกผ่านเมนูพร้อมกรอบแดง (เหมาะกับคู่มือ) · `quick` กระโดดไปหน้าปลายทางเลย |
| `options.timeout_ms` | integer | `8000` (1000–60000) | เวลารอสูงสุดต่อคำสั่ง |
| `options.transaction_timeout_s` | integer | `600` (30–3600) | เวลาสูงสุดต่อบท |

**`transactions[]`** (สูงสุด 20 บท)

| ฟิลด์ | ชนิด | บังคับ | ความหมาย |
|---|---|---|---|
| `id` | string | ✅ | ขึ้นต้นด้วยตัวอักษร ใช้ได้เฉพาะ `A-Z a-z 0-9 _` ยาวไม่เกิน 32 ตัว และห้ามซ้ำ เช่น `T1` |
| `title` | text | ✅ | ชื่อบท ใช้ `{{T1.x}}` ได้ |
| `depends_on` | string หรือ array | | `id` ของบท**ก่อนหน้า** ถ้าบทนั้นไม่ผ่าน บทนี้จะถูกข้าม |
| `steps` | array | ✅ | 1–60 ขั้น |
| `capture` | object | | `{ "<ชื่อ>": "url id" \| "field <ชื่อฟิลด์>" \| "text <selector>" }` เก็บค่าเมื่อจบขั้นสุดท้าย บทถัดไปเรียกใช้ได้ด้วย `{{T1.<ชื่อ>}}` |
| `unit` | array | | รับไว้แล้ว ใช้จริงใน P4 |

**`steps[]`** (1 ขั้น = 1 ภาพ 1440×900)

| ฟิลด์ | ชนิด | บังคับ | ความหมาย |
|---|---|---|---|
| `title` | text | ✅ | หัวข้อของขั้นในคู่มือ |
| `description` | text | | คำอธิบายใต้หัวข้อ |
| `commands` | string[] | ✅ | คำสั่งของ browser หนึ่ง string ต่อหนึ่งคำสั่ง (1–60 คำสั่ง) ดูชื่อคำสั่งใน [COMMANDS.md](../COMMANDS.md) |
| `expect` | string[] | | สิ่งที่ต้องเป็นจริงเมื่อจบขั้น เขียนโดยไม่ต้องมีคำว่า `expect` นำหน้า เช่น `"state draft"`, `"visible .o_list_view"` |
| `highlight.selector` | string | | element ที่จะวาดกรอบแดงก่อนถ่ายภาพ |
| `highlight.caption` | text | | ข้อความบนกรอบแดง |

### 3.3 กฎของข้อความ (`text`)
- **ขอภาษาเดียว:** ใส่เป็น string ได้ เช่น `"title": "เปิดใบเสนอราคา"`
- **ขอหลายภาษา:** ต้องเป็น object ที่มี**ครบทุกภาษา** เช่น `"title": { "en_US": "Open a quotation", "th_TH": "เปิดใบเสนอราคา" }`
  ถ้าขาดภาษาใดจะได้ `422` (`captions_complete`) ระบบไม่สร้างข้อความแทนให้
- ข้อความต้องอยู่บรรทัดเดียว
- เครื่องหมาย `'` ในข้อความจะถูกเปลี่ยนเป็น `’` อัตโนมัติ

### 3.4 กฎของ `commands`
- ห้ามใช้ `login`, `lang`, `step`, `done`, `strict`, `eval`, `cookie` เพราะ API จัดการเอง
- quote `'` ต้องเปิดและปิดให้ครบ
- `"` ภายใน selector ต้องเขียนเป็น `\"` ใน JSON เช่น `"date '.o_field_widget[name=\"validity_date\"]' 2026-12-31"`
- `highlight.selector` ห้ามมี `'`
- browser เปิดได้เฉพาะ host ของ `target.url` เท่านั้น ถ้าพยายามเปิดเว็บอื่นจะถูกบล็อก

### 3.5 ตัวอย่าง body (2 ภาษา, 2 บทที่ส่งค่าต่อกัน, callback, ร่างคู่มือ)

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

## 4. Response แยกตาม endpoint

ทุก error มีรูปแบบเดียวกัน: `{ "error": "<ข้อความ>" }` บางกรณีมีฟิลด์เพิ่ม เช่น `details` และ `status`

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
| ฟิลด์ | ความหมาย |
|---|---|
| `running` | จำนวนงานที่กำลังรัน |
| `queued` | จำนวนงานที่รอคิว |
| `max_concurrent_runs` | จำนวนงานสูงสุดที่รันพร้อมกันได้ |

### 4.2 `POST /checks` → `200` (ผ่าน) หรือ `422` (ไม่ผ่าน)
ตรวจ body และเรียก Odoo เพื่อดูเวอร์ชัน โดยยังไม่เปิด browser
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
ถ้า body ผิดรูปแบบ จะได้ `422` แบบเดียวกับ [4.4](#44-error-ที่เกิดจาก-request)

### 4.3 `POST /runs` → `202 Accepted`
งานเข้าคิวแล้ว ยังไม่ได้รัน
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
| ฟิลด์ | ความหมาย |
|---|---|
| `run_id` | รหัสงาน **ต้องเก็บไว้** เพื่อใช้ถามสถานะและดาวน์โหลดผล |
| `position` | จำนวนงานที่รออยู่ก่อนหน้า (`0` = เริ่มรันทันที) |
| `links` | URL สำเร็จรูปของ endpoint ที่เกี่ยวข้อง ใช้ได้เมื่องานจบแล้ว (ยกเว้น `self` ใช้ได้ตลอด) ส่วน `manual_*` และ `report_html` ให้เติม `?lang=` เอง |

### 4.4 Error ที่เกิดจาก request

**`422` body ไม่ผ่านการตรวจ:** `details` บอกตำแหน่ง (`path`) ของทุกจุดที่ผิดพร้อมกัน
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

| Status | `error` | สาเหตุ |
|---|---|---|
| `400` | `body is not valid JSON` | JSON ผิดรูปแบบ |
| `401` | `missing or invalid bearer token` | ไม่ได้ส่ง token หรือ token ผิด (มี header `WWW-Authenticate: Bearer`) |
| `413` | `body larger than 1 MB` | body ใหญ่เกิน 1 MB |
| `422` | `validation failed` | ดู `details` |

### 4.5 `GET /runs/{run_id}` → `200`
ใช้ถามสถานะเป็นระยะ (แนะนำทุก 10–30 วินาที) หรือรอ callback ก็ได้

**ระหว่างรัน**
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

**เมื่อจบ** (แสดงเฉพาะฟิลด์ที่เปลี่ยน)
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

| ฟิลด์ | ความหมาย |
|---|---|
| `status` | สถานะรวมของงาน ([หัวข้อ 5](#5-ค่าสถานะ-status)) |
| `progress` | บทล่าสุดที่**รันเสร็จ** (`null` = ยังไม่จบบทแรก) |
| `static_checks` | ผลตรวจก่อนรัน ถ้ามีข้อ `failed` ทุกบทจะถูกข้าม |
| `results.<lang>.status` | ผลรวมของภาษานั้น: `passed` / `partial` / `failed` |
| `results.<lang>.transactions[].status` | `passed` / `failed` / `skipped` |
| `…transactions[].error` | สาเหตุเมื่อไม่ผ่านหรือถูกข้าม รูปแบบ `<คำสั่งที่พัง>: <รายละเอียด>` หรือ `depends on T1, which did not pass` |
| `…transactions[].failed_step` | เลขขั้นแรกที่ไม่ผ่าน (`null` = ผ่านทุกขั้น) |
| `…transactions[].captured` | ค่าที่ `capture` ได้ในภาษานั้น |
| `lang_restore` | ภาษาเดิมของ user และผลการคืนค่า (`passed` / `failed` / `not needed`) |
| `callback` | ผลการส่ง callback `{url, status: "delivered" \| "failed", attempts, last_error}` ค่านี้เติมหลังจาก `status` เปลี่ยนเป็นค่าจบแล้วครู่หนึ่ง |
| `traces_expired` | `true` เมื่อไฟล์ trace.zip ถูกลบตามอายุ (14 วัน) |
| `error` | ข้อความเมื่อ `status` เป็น `error` |

### 4.6 `GET /runs/{run_id}/manifest` → `200` (หลังงานจบ)
ข้อมูลหลักที่ระบบคู่มือควรใช้ **มีชื่อบท ชื่อขั้น คำอธิบาย และ path ของภาพครบ**
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
- `title` ใน manifest **แทนค่าตัวแปรแล้ว** เช่น `ค้นหา {{T1.so_name}}` กลายเป็น `ค้นหา S00042`
- path ของ `screenshot`, `trace` และ `log` อ้างอิงจาก root ของ `bundle.zip` และใช้ดาวน์โหลดทีละไฟล์ได้ด้วย
  `GET /runs/{run_id}/files/<path>` เช่น `/files/th_TH/T1/shots/01-step.png`
- ขั้นที่ `status` ไม่ใช่ `passed` ยังมีภาพเก็บไว้เพื่อตรวจสอบ **แต่ไม่ควรนำไปใส่คู่มือ**
- `final_screenshot` ภาพหน้าจอสุดท้ายของบท (จาก trace) มีแม้บทจะพังก่อนถึงขั้นแรก เช่น login ไม่ผ่าน · เป็น `null` เมื่อไม่มี trace
- `checks` รายการที่ตรวจในขั้นนั้น เรียงตามลำดับที่รัน:

| ฟิลด์ | ความหมาย |
|---|---|
| `kind` | `expect` (เงื่อนไขที่ต้องเป็นจริง) · `mark` (กรอบแดงจาก `highlight` หรือคำสั่ง `mark`) · `capture` (ค่าที่เก็บได้) · `command` (คำสั่งอื่นที่พัง เป็นสาเหตุที่ขั้นไม่ผ่าน) |
| `label` | ข้อความที่อ่านได้ เช่น `state sale`, `จำนวน`, `so_name = S00042` (ยาวไม่เกิน 120 ตัว) |
| `line` | บรรทัดใน flow ที่ระบบสร้างจาก request (ใช้คู่กับ `run.log`) |
| `status` / `error` | ผลของคำสั่งนั้น และข้อความเมื่อไม่ผ่าน |

### 4.7 ไฟล์ที่ดาวน์โหลด (หลังงานจบ)

| Endpoint | Content-Type | เนื้อหา |
|---|---|---|
| `/bundle.zip` | `application/zip` | `manifest.json`, `<lang>/<tx>/shots/*.png`, `<lang>/<tx>/final.jpeg`, `<lang>/<tx>/trace.zip`, `result.json`, `run.log`, `manual/<lang>.md` และ `.html` |
| `/manual.md?lang=` | `text/markdown; charset=utf-8` | ร่างคู่มือ ภาพอ้างอิงเป็นไฟล์แยกใน bundle |
| `/manual.html?lang=` | `text/html; charset=utf-8` | ร่างคู่มือไฟล์เดียวที่ฝังภาพไว้แล้ว เปิดในเบราว์เซอร์ได้ทันที |
| `/report.html?lang=` | `text/html; charset=utf-8` | รายงานผลทดสอบไฟล์เดียว ฝังภาพแล้ว: ผลรวม, จุดที่ไม่ผ่าน, ภาพทุกขั้น + ภาพสุดท้าย, ตาราง Step / Result ✓/✗ (ได้ทุกงาน ไม่ต้องขอ `output`) |
| `/tx/{tx_id}/trace.zip?lang=` | `application/zip` | Playwright trace ของบทเดียว เปิดดูที่ https://trace.playwright.dev |
| `/files/{path}` | ตามชนิดไฟล์ | ไฟล์เดียวจาก bundle |

### 4.8 `GET /runs` → `200`
รายการงานของ token นี้ เรียงจากใหม่ไปเก่า query: `?status=passed&limit=50` (`limit` สูงสุด 200)
```json
{ "runs": [ { "run_id": "a6d21254-…", "status": "passed", "client": "manual-system", "created_at": "…", "…": "…" } ] }
```
แต่ละรายการมีฟิลด์เดียวกับ [4.5](#45-get-runsrun_id--200)

### 4.9 `POST /runs/{run_id}/cancel`
| Status | Body | ความหมาย |
|---|---|---|
| `202` | `{"run_id": "…", "status": "cancelled"}` | งานยังรอคิวอยู่ ยกเลิกทันที |
| `202` | `{"run_id": "…", "status": "cancelling"}` | งานกำลังรัน ระบบจะหยุดบทที่รันอยู่ ให้ถามสถานะต่อจนได้ `cancelled` |
| `409` | `{"error": "run already passed"}` | งานจบไปแล้ว ยกเลิกไม่ได้ |

### 4.10 Error อื่นๆ ของ `/runs/{run_id}/…`

| Status | `error` | สาเหตุ |
|---|---|---|
| `404` | `run not found` | ไม่มีงานนี้ หรือเป็นงานของ token อื่น |
| `404` | `run has no language th_TH` | `?lang=` ไม่อยู่ในภาษาที่ขอไว้ |
| `404` | `not found` | ไม่มีไฟล์นั้น เช่น ไม่ได้ขอร่างคู่มือ หรือ trace ถูกลบตามอายุแล้ว |
| `409` | `run is running; results are available when it finishes` | ขอผลก่อนงานจบ (มีฟิลด์ `status` บอกสถานะปัจจุบัน) |
| `400` | `bad path` | path ใน `/files/…` ออกนอก bundle |
| `405` | `method not allowed` | ใช้ method ผิด |

---

## 5. ค่าสถานะ (status)

**สถานะของงาน (`status`)**

| ค่า | จบแล้วหรือยัง | ความหมาย |
|---|---|---|
| `queued` | ยัง | รอคิว |
| `running` | ยัง | กำลังรัน |
| `passed` | จบ | ทุกบทผ่านทุกภาษา |
| `partial` | จบ | `on_failure: "continue"` และผ่านบางส่วน |
| `failed` | จบ | มีบทที่ไม่ผ่าน หรือ static check ไม่ผ่าน |
| `cancelled` | จบ | ถูกยกเลิก |
| `error` | จบ | ระบบมีปัญหา เช่น server restart ระหว่างรัน **ต้องส่งงานใหม่** |

**สถานะของบทและขั้น:** `passed`, `failed`, `skipped` (เฉพาะบท: ถูกข้ามเพราะ `on_failure: stop` หรือ `depends_on` ไม่ผ่าน)

**ชื่อ static check:** `request` (เฉพาะ `/checks`), `reachable`, `version_match`

---

## 6. Callback และการตรวจลายเซ็น

เมื่องานจบ ถ้า request มี `callback_url` ระบบจะ `POST` ไปที่ URL นั้น

**Header ที่ระบบของคุณจะได้รับ**

| Header | ค่า |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `trace-kit/1.0.0` |
| `X-TraceKit-Signature` | `sha256=<HMAC-SHA256 ของ body ทั้งก้อน เป็น hex>` (มีเมื่อผู้ดูแลตั้ง `TRACE_CALLBACK_SECRET`) |

**Body:** `{"event": "run.finished", …}` ตามด้วยฟิลด์ชุดเดียวกับ [4.5](#45-get-runsrun_id--200) ทุกตัว
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

**สิ่งที่ฝั่งรับต้องทำ**
- ตอบ `2xx` ภายใน 10 วินาที ถ้าไม่ได้ ระบบจะส่งซ้ำ รวมแล้วสูงสุด 4 ครั้ง (ห่างกัน 1, 5 และ 15 วินาที)
- **ตรวจลายเซ็นทุกครั้ง** โดยคำนวณ HMAC จาก body ดิบ (byte ตามที่ได้รับ ห้าม parse แล้ว stringify ใหม่)
- callback อาจมาซ้ำได้ ให้ใช้ `run_id` กันการประมวลผลซ้ำ

**ตัวอย่างการตรวจลายเซ็น (Node.js)**
```js
const crypto = require('crypto');
function verify(rawBody, header, secret) {           // rawBody: Buffer ของ body ที่ได้รับ
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return header && header.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

**ตัวอย่างการตรวจลายเซ็น (Python)**
```python
import hmac, hashlib
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header or "", expected)
```

---

## 7. ตัวอย่างการเรียกครบทั้งรอบด้วย curl

```bash
API=https://trace.odoo19e.com/api/v1
TOKEN=<token ของทีม>
H_AUTH="Authorization: Bearer $TOKEN"

# 1) ระบบพร้อมไหม
curl -s $API/health

# 2) ตรวจ body ก่อน (ไม่รันจริง)
curl -s -X POST $API/checks -H "$H_AUTH" -H "Content-Type: application/json" --data-binary @body.json

# 3) ส่งงาน → เก็บ run_id
RUN=$(curl -s -X POST $API/runs -H "$H_AUTH" -H "Content-Type: application/json" --data-binary @body.json \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['run_id'])")
echo "run_id: $RUN"

# 4) ถามสถานะจนจบ (หรือรอ callback)
while :; do
  ST=$(curl -s -H "$H_AUTH" $API/runs/$RUN | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  echo "status: $ST"; case $ST in queued|running) sleep 15;; *) break;; esac
done

# 5) ดาวน์โหลดผล
curl -s -H "$H_AUTH" -o bundle.zip      $API/runs/$RUN/bundle.zip
curl -s -H "$H_AUTH" -o manifest.json   $API/runs/$RUN/manifest
curl -s -H "$H_AUTH" -o manual-th.html "$API/runs/$RUN/manual.html?lang=th_TH"   # คู่มือผู้ใช้
curl -s -H "$H_AUTH" -o report-th.html "$API/runs/$RUN/report.html?lang=th_TH"   # รายงานผลทดสอบ
```

**เวลาที่ใช้โดยประมาณ:** ประมาณ 10 วินาทีต่อหนึ่งขั้นต่อหนึ่งภาษา เช่น 3 บท × 5 ขั้น × 2 ภาษา ≈ 5 นาที
ระบบรันทีละงาน งานที่ส่งเข้ามาพร้อมกันจะรอคิว (ดู `position` และ `/health`)

**อายุของไฟล์:** trace.zip เก็บ 14 วัน · ภาพ manifest และคู่มือเก็บ 180 วัน
