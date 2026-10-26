# อธิบายตัวอย่าง request: `sales-manual.json`

ไฟล์ [sales-manual.json](sales-manual.json) คือตัวอย่าง body ของ `POST /api/v1/runs`
ที่ระบบจัดทำคู่มือส่งเข้ามา เพื่อให้ Trace Kit เปิด Odoo ทำตามขั้นตอน ถ่ายภาพทีละขั้น
แล้วส่งภาพ, manifest, trace และร่างคู่มือกลับไป

- **โมดูลที่ใช้:** Sales (ใบเสนอราคา) ใช้ได้กับ Odoo ทุกเวอร์ชันที่ติดตั้ง Sales
- **อ่านอย่างเดียว:** เปิดดูรายการและเอกสารที่มีอยู่ และเปิดฟอร์มใหม่โดย**ไม่กดบันทึก** จึงไม่สร้างข้อมูลใน Odoo
- **ทดสอบแล้ว:** Odoo 19e (KST staging) ภาษา en_US และ th_TH ผ่านทั้งหมดในเวลาประมาณ 200 วินาที

---

## 1. ส่ง request อย่างไร

```bash
TOKEN=<token ของระบบคู่มือ>          # จาก secrets/api_tokens.txt บน server
API=http://127.0.0.1:8080/api/v1

# (ไม่บังคับ) ตรวจ request และ server ก่อน โดยยังไม่เปิด browser
curl -s -X POST $API/checks -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' --data-binary @sales-manual.json

# ส่งงานจริง → ได้ run_id กลับมา
curl -s -X POST $API/runs -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' --data-binary @sales-manual.json
```

ก่อนส่ง ต้องแก้ค่าใน `target` ให้เป็นของ Odoo จริง (ดูหัวข้อ 3) และลบ `callback_url`
ออกถ้าระบบคู่มือยังไม่มี endpoint สำหรับรับผล

---

## 2. ภาพรวมของ request

```text
request
├── target            ต่อ Odoo ตัวไหน ด้วย user อะไร
├── lang              รันภาษาอะไรบ้าง
├── on_failure        ถ้ามี transaction พัง จะหยุดหรือไปต่อ
├── callback_url      แจ้งผลกลับเมื่องานจบ
├── output            ต้องการร่างคู่มือไหม
├── options           ความเร็วและ timeout
└── transactions[]    บทของคู่มือ (1 transaction = 1 บท)
    └── steps[]       หัวข้อย่อยในบท (1 step = 1 ภาพ)
        └── commands[]  คำสั่งที่ browser ทำในขั้นนั้น
```

---

## 3. อธิบายทีละฟิลด์

### `target`: Odoo ปลายทาง

```json
"target": {
  "url": "https://YOUR-ODOO.example.com/web/login",
  "db": "YOUR_DB",
  "version": "17.0",
  "login": "manual_bot",
  "password": "SET-ME",
  "api_key": "optional, used from P4"
}
```

| ฟิลด์ | บังคับ | ความหมาย |
|---|---|---|
| `url` | ✅ | หน้า login ของ Odoo (`http` หรือ `https`) |
| `db` | ✅ | ชื่อฐานข้อมูล ระบบจะ login เข้า DB นี้เท่านั้น |
| `version` | | เวอร์ชันที่คาดไว้ เช่น `"17.0"` หรือ `"19.0"` ระบบตรวจกับ server ก่อนรัน (`version_match`) ถ้าไม่ตรงจะไม่รัน |
| `login`, `password` | ✅ | user ที่ browser ใช้ login **ควรใช้ user สำหรับทำคู่มือโดยเฉพาะ** เพราะระหว่างรันระบบจะเปลี่ยนภาษาของ user นี้ชั่วคราว |
| `api_key` | | รับไว้แล้ว แต่จะเริ่มใช้ใน P4 (ตรวจข้อมูลผ่าน RPC) Odoo ไม่ให้ใช้ API Key login หน้าเว็บ จึงยังต้องมี `password` |

**ความปลอดภัย:** `password` และ `api_key` อยู่ในหน่วยความจำระหว่างรันเท่านั้น ไม่ถูกบันทึกลงดิสก์ log
หรือ bundle ผลที่ตามมาคือถ้า server restart ระหว่างงาน งานนั้นจะเป็น `error` และต้องส่งใหม่

### `lang`: ภาษาที่ต้องการ

```json
"lang": ["en_US", "th_TH"]
```

- ใส่ภาษาเดียว (`"th_TH"`) หรือหลายภาษา (สูงสุด 4) ถ้าไม่ใส่ จะใช้ `en_US`
- **ทั้ง batch รันหนึ่งรอบต่อภาษา** ตัวอย่างนี้จึงรัน 3 transaction × 2 ภาษา = 6 ครั้ง
- ก่อนรันแต่ละภาษา ระบบเปลี่ยนภาษาของ user เป็นภาษานั้น และ**คืนภาษาเดิมเมื่อจบ**
- ภาษาต้องเปิดใช้ใน Odoo แล้ว (Settings → Languages) ถ้ายังไม่เปิด transaction แรกจะ fail พร้อมข้อความบอก

### `on_failure`: เมื่อมี transaction พัง

```json
"on_failure": "continue"
```

| ค่า | ผล |
|---|---|
| `"stop"` (ค่าเริ่มต้น) | transaction ที่เหลือทั้งหมด (ทุกภาษา) ได้สถานะ `skipped` และงานรวมเป็น `failed` |
| `"continue"` | รันต่อ ข้ามเฉพาะ transaction ที่ `depends_on` ตัวที่พัง ถ้ามีบางตัวผ่าน งานรวมเป็น `partial` |

ในตัวอย่างนี้ ถ้า T1 พัง: T2 ถูกข้ามเพราะพึ่งพา T1 แต่ T3 ยังรันต่อ

### `callback_url`: แจ้งผลกลับ

```json
"callback_url": "https://manual-system.example.com/hooks/trace"
```

ไม่บังคับ เมื่องานจบ API จะ POST ผลสรุป (`{"event": "run.finished", "run_id": …, "status": …, "links": …}`)
ไปที่ URL นี้
- ถ้าตั้ง `TRACE_CALLBACK_SECRET` ไว้ จะมี header `X-TraceKit-Signature: sha256=<HMAC ของ body>`
  ให้ตรวจว่ามาจาก Trace Kit จริง
- ถ้าส่งไม่สำเร็จ จะลองใหม่ รวมแล้วพยายามส่งสูงสุด 4 ครั้ง (ห่างกัน 1, 5 และ 15 วินาที)
- ถ้าไม่ใช้ callback ให้ถามสถานะเองด้วย `GET /runs/{id}`

### `output`: ร่างคู่มือ

```json
"output": {
  "bundle": true,
  "manual": {
    "formats": ["md", "html"],
    "title": { "en_US": "Sales manual", "th_TH": "คู่มือการขาย" }
  }
}
```

- ระบบสร้าง **bundle** (ภาพ, manifest, trace) ทุกครั้ง
- ใส่ `manual` เมื่อต้องการ**ร่างคู่มือ**ด้วย
  - `formats`: `md` (Markdown ภาพเป็นไฟล์แยก) และหรือ `html` (ไฟล์เดียวที่ฝังภาพไว้แล้ว)
  - `title`: ชื่อคู่มือของแต่ละภาษา
- ถ้าไม่ต้องการร่างคู่มือ ให้ลบ `manual` ออก จะได้แค่ภาพกับ manifest

### `options`: การรัน

```json
"options": { "mode": "human", "timeout_ms": 8000, "transaction_timeout_s": 600 }
```

| ฟิลด์ | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `mode` | `human` | `human`: `navmenu` คลิกผ่านเมนูทีละชั้นพร้อมกรอบแดงชี้ (เหมาะกับคู่มือ) · `quick`: กระโดดไปหน้าปลายทางเลย (เร็วกว่า) |
| `timeout_ms` | 8000 | เวลารอสูงสุดของแต่ละคำสั่ง (1000–60000) |
| `transaction_timeout_s` | 600 | เวลาสูงสุดของหนึ่ง transaction (30–3600) ถ้าเกินจะถูกหยุดและนับเป็น failed |

### `transactions[]`: บทของคู่มือ

| ฟิลด์ | บังคับ | ความหมาย |
|---|---|---|
| `id` | ✅ | ชื่อสั้นที่ไม่ซ้ำกัน ขึ้นต้นด้วยตัวอักษร เช่น `T1` ใช้อ้างถึงค่าที่ capture มา (`{{T1.so_id}}`) และใช้เป็นชื่อโฟลเดอร์ใน bundle |
| `title` | ✅ | ชื่อบท |
| `depends_on` | | `id` ของ transaction ก่อนหน้า (หรือหลายตัวเป็น array) ถ้าตัวนั้นไม่ผ่าน ตัวนี้จะถูกข้าม |
| `steps` | ✅ | หัวข้อย่อยในบท (สูงสุด 60) |
| `capture` | | เก็บค่าเมื่อจบบท เพื่อส่งให้บทถัดไป (ดูด้านล่าง) |
| `unit` | | รับไว้แล้ว เริ่มตรวจข้อมูลผ่าน RPC ใน P4 |

**`capture`**: เก็บค่าบนหน้าจอเมื่อจบขั้นสุดท้ายของบท

```json
"capture": { "so_id": "url id", "so_name": "field name" }
```

| รูปแบบ | อ่านค่าจาก | ตัวอย่างผล |
|---|---|---|
| `"url id"` | เลข record ใน URL | `157` |
| `"field <ชื่อฟิลด์>"` | ค่าของฟิลด์ในฟอร์มหรือ dialog ที่เปิดอยู่ | `"S00169"` |
| `"text <selector>"` | ข้อความที่มองเห็นของ element | `"Quotation"` |

บทถัดไปเรียกใช้ค่าเหล่านี้ด้วย `{{T1.so_id}}` และ `{{T1.so_name}}` ได้ทั้งใน `commands`, `expect`,
`title`, `description` และ caption ค่าจะถูกเก็บแยกต่อภาษา (รอบภาษาไทยใช้ค่าที่ได้จากรอบภาษาไทย)

### `steps[]`: หัวข้อย่อย (1 ขั้น = 1 ภาพ)

| ฟิลด์ | บังคับ | ความหมาย |
|---|---|---|
| `title` | ✅ | หัวข้อของขั้น ใช้เป็นหัวข้อในคู่มือและชื่อไฟล์ภาพ |
| `description` | | คำอธิบายใต้หัวข้อในคู่มือ |
| `commands` | ✅ | คำสั่งที่ browser ทำ หนึ่งบรรทัดต่อหนึ่ง string (สูงสุด 60) |
| `expect` | | สิ่งที่ต้องเป็นจริงเมื่อจบขั้น ถ้าไม่จริง ขั้นนี้ fail และไม่มีภาพในคู่มือ |
| `highlight` | | วาดกรอบแดงพร้อม caption รอบ element ก่อนถ่ายภาพ |

เมื่อจบขั้น ระบบจะถ่ายภาพขนาด **1440×900** โดยอัตโนมัติ ทั้งกรอบแดงและ caption จะติดอยู่ในภาพ
จากนั้นจะลบกรอบแดงออกก่อนเริ่มขั้นถัดไป

---

## 4. กฎของข้อความ (สำคัญ)

1. **ต้องมีครบทุกภาษาที่ขอ (`captions_complete`)** ถ้า `lang` มีสองภาษา ทุก `title`, `description`
   และ `caption` ต้องเป็น object ที่มีครบทั้งสองภาษา
   ```json
   "title": { "en_US": "Open the quotation list", "th_TH": "เปิดรายการใบเสนอราคา" }
   ```
   ถ้าขาดภาษาใด API จะตอบ `422` พร้อมบอกตำแหน่ง เช่น `transactions[0].steps[1].title.th_TH`
   ระบบ**ไม่สร้างคำบรรยายแทนให้**
2. **ถ้าขอภาษาเดียว** ใส่เป็น string ธรรมดาได้: `"title": "เปิดรายการใบเสนอราคา"`
3. **ข้อความต้องอยู่บรรทัดเดียว** ห้ามมีการขึ้นบรรทัดใหม่
4. **เครื่องหมาย `'` ในข้อความ** จะถูกเปลี่ยนเป็น `’` อัตโนมัติ เช่น `Customer's` → `Customer’s`

---

## 5. กฎของ `commands`

- ใช้คำสั่งเดียวกับไฟล์ flow ของ Trace Kit (ดู [COMMANDS.md](../../COMMANDS.md)) หนึ่งคำสั่งต่อหนึ่ง string
- **คำสั่งที่ API จัดการเองและห้ามใส่:** `login`, `lang`, `step`, `done`, `strict`, `eval`, `cookie`
- quote `'` ต้องเปิดและปิดให้ครบ
- **ใน JSON ต้องเขียน `"` ภายใน selector เป็น `\"`:**
  ```json
  "date '.o_field_widget[name=\"validity_date\"]' 2026-12-31"
  ```
- **ใน `highlight.selector` ห้ามใช้ `'`** ให้ใช้ `\"` แทน
- **ในโหมด API ระบบจะบล็อก** การเปิดเว็บอื่นนอกจาก Odoo ปลายทาง

**คำสั่งที่ใช้ในตัวอย่างนี้**

| คำสั่ง | ทำอะไร |
|---|---|
| `navmenu @sale.menu_sale_quotations` | เปิดเมนูด้วย xmlid ระบบอ่านชื่อเมนูตามภาษาของ user แล้วคลิกทีละชั้น จึงใช้ได้ทั้งภาษาไทยและอังกฤษ |
| `jclick <selector>` | คลิก element |
| `waitidle` | รอจน Odoo โหลดเสร็จ |
| `record sale.order {{T1.so_id}}` | เปิด record ตามเลข id โดยตรง |
| `date '<field>' 2026-12-31` | กรอกวันที่แบบ ISO ระบบแปลงเป็นรูปแบบวันที่ตามภาษาของ user ให้ |

**`expect` ที่ใช้ในตัวอย่างนี้** (ใส่โดยไม่ต้องมีคำว่า `expect` นำหน้า)

| expect | ตรวจอะไร |
|---|---|
| `visible .o_list_view` | หน้ารายการแสดงอยู่ |
| `text '.o_field_widget[name="name"]' {{T1.so_name}}` | เลขที่เอกสารตรงกับที่ capture มา |
| `state draft` | สถานะเอกสารเป็น `draft` ตรวจด้วยค่าภายใน จึงใช้ได้ทุกภาษา |

---

## 6. ตัวอย่างนี้ทำอะไรบ้าง

### T1: เปิดใบเสนอราคา (Open a quotation)
| ขั้น | ทำอะไร | ภาพที่ได้ |
|---|---|---|
| 1.1 เปิดรายการใบเสนอราคา | คลิกผ่านเมนู ขาย › คำสั่งซื้อ › ใบเสนอราคา และตรวจว่าเห็นหน้ารายการ | รายการใบเสนอราคา มีกรอบแดง "ใบเสนอราคาแรก" ที่แถวแรก |
| 1.2 เปิดใบเสนอราคาแรก | คลิกแถวแรก แล้ว**เก็บค่า** `so_id` (เลข record) และ `so_name` (เลขที่เอกสาร) | ฟอร์มของใบเสนอราคานั้น |

### T2: เปิด `{{T1.so_name}}` อีกครั้ง (`depends_on: T1`)
| ขั้น | ทำอะไร | ภาพที่ได้ |
|---|---|---|
| 2.1 เปิด `{{T1.so_name}}` ด้วยเลขที่ | เปิด record ตรงด้วย `{{T1.so_id}}` และตรวจว่าเลขที่ตรงกับ `{{T1.so_name}}` | ฟอร์มเอกสารเดียวกับ 1.2 |

ชื่อบทและชื่อขั้นจะแสดงเลขจริงแทนตัวแปร เช่น "เปิด S00169 อีกครั้ง" ถ้า T1 ไม่ผ่าน T2 จะถูกข้าม

### T3: สร้างใบเสนอราคาใหม่ (อิสระ ไม่พึ่งพาบทอื่น)
| ขั้น | ทำอะไร | ภาพที่ได้ |
|---|---|---|
| 3.1 ใบเสนอราคาใหม่ | เปิดเมนูอีกครั้ง กดปุ่ม New แล้วตรวจว่าสถานะเป็น `draft` | ฟอร์มใบเสนอราคาว่าง |
| 3.2 กำหนดวันหมดอายุ | กรอกวันหมดอายุ 31/12/2026 แบบ ISO (**ไม่กดบันทึก**) | ฟอร์มที่มีกรอบแดง "วันหมดอายุ" |

### flow ที่ API สร้างจริง (ตัวอย่าง T1 ภาษาไทย)

API แปลงแต่ละ transaction เป็นไฟล์ flow ให้อัตโนมัติ ไม่ต้องเขียนเอง แสดงไว้เพื่อให้เห็นว่าเกิดอะไรขึ้น:

```text
strict on
timeout 8000
mode human
login {{LOGIN}} {{PASSWORD}}         ← ใส่ค่าจริงตอนรัน ไม่เขียนลงไฟล์
lang th_TH                           ← เปลี่ยนภาษาของ user

step 'เปิดรายการใบเสนอราคา' 'ขาย > คำสั่งซื้อ > ใบเสนอราคา'
navmenu @sale.menu_sale_quotations
expect visible .o_list_view
mark '.o_data_row:first-child' ใบเสนอราคาแรก      ← จาก highlight

step 'เปิดใบเสนอราคาแรก'                          ← ภาพของขั้นก่อนหน้าถูกถ่ายตรงนี้
jclick .o_data_row:first-child td.o_data_cell
waitidle
capture so_id url id                              ← จาก capture ของ T1
capture so_name field name
done                                              ← ภาพของขั้นสุดท้ายถูกถ่ายตรงนี้
```

---

## 7. ผลที่ได้กลับมา

**ตอบทันทีเมื่อส่ง (`202`)**
```json
{
  "run_id": "5c89708f-9fd1-4598-9b75-3d487df04844",
  "status": "queued",
  "position": 0,
  "links": {
    "self": "/api/v1/runs/5c89…",
    "manifest": "/api/v1/runs/5c89…/manifest",
    "bundle": "/api/v1/runs/5c89…/bundle.zip",
    "manual_md": "/api/v1/runs/5c89…/manual.md",
    "manual_html": "/api/v1/runs/5c89…/manual.html"
  }
}
```

**ถามสถานะ** ด้วย `GET /runs/{id}` (หรือรอ callback) สถานะจะเปลี่ยนตามลำดับ
`queued` → `running` → ปิดท้ายด้วยค่าใดค่าหนึ่ง

| สถานะ | ความหมาย |
|---|---|
| `passed` | ทุก transaction ผ่านทุกภาษา |
| `partial` | `on_failure: continue` และผ่านบางส่วน |
| `failed` | มี transaction ที่ไม่ผ่าน (หรือ static check ไม่ผ่าน) |
| `cancelled` | ถูกยกเลิกด้วย `POST /runs/{id}/cancel` |
| `error` | ระบบมีปัญหา เช่น server restart ระหว่างรัน ต้องส่งใหม่ |

ระหว่างที่งานยังไม่จบ endpoint ผลลัพธ์จะตอบ `409`

**ดาวน์โหลด** (หลังจบ)
```bash
curl -s -H "Authorization: Bearer $TOKEN" -o bundle.zip      $API/runs/<run_id>/bundle.zip
curl -s -H "Authorization: Bearer $TOKEN" -o manual-th.html  "$API/runs/<run_id>/manual.html?lang=th_TH"
```

**โครงสร้าง bundle.zip ของตัวอย่างนี้** (ได้จากการรันจริงบน KST)
```text
manifest.json                                   ← ข้อมูลทั้งหมดของงาน: ลำดับบท/ขั้น, ชื่อ, สถานะ, ไฟล์ภาพ, ค่าที่ capture
en_US/T1/shots/01-open-the-quotation-list.png
en_US/T1/shots/02-open-the-first-quotation.png
en_US/T1/trace.zip  result.json  run.log        ← trace สำหรับเปิดใน trace.playwright.dev
en_US/T2/shots/01-open-s00169-by-id.png
en_US/T3/shots/01-new-quotation.png
en_US/T3/shots/02-set-the-expiration-date.png
th_TH/T1/shots/01-step.png  02-step.png         ← ชื่อไฟล์ใช้ได้เฉพาะอักษรอังกฤษ ชื่อขั้นจริงอยู่ใน manifest
th_TH/T2/…  th_TH/T3/…
manual/en_US.md  manual/en_US.html
manual/th_TH.md  manual/th_TH.html
```

- **ระบบคู่มือควรอ่าน `manifest.json` เป็นหลัก** ใน `results.<lang>.transactions[].steps[]` มีชื่อขั้น
  คำอธิบาย สถานะ และ path ของภาพครบ ไม่ต้องเดาจากชื่อไฟล์
- **ขั้นที่ไม่ผ่าน** ยังมีภาพเก็บไว้ใน `shots/` สำหรับตรวจสอบ แต่**ร่างคู่มือจะแสดงคำเตือนแทนภาพ**
  เพื่อไม่ให้ภาพของขั้นที่ทำไม่สำเร็จหลุดเข้าไปในคู่มือ
- **อายุของไฟล์:** `trace.zip` ถูกลบหลัง 14 วัน ส่วนภาพ manifest และคู่มือเก็บไว้ 180 วัน

---

## 8. Error ที่พบบ่อย

| สิ่งที่เห็น | สาเหตุ | วิธีแก้ |
|---|---|---|
| `422` `…title.th_TH: missing th_TH text (captions_complete)` | ข้อความขาดบางภาษา | เพิ่มข้อความของภาษานั้น |
| `422` `…title: give one text per language` | ขอหลายภาษาแต่ใส่เป็น string | เปลี่ยนเป็น `{ "en_US": …, "th_TH": … }` |
| `422` `unknown command "…" (flow_syntax)` | สะกดคำสั่งผิด | ดูชื่อคำสั่งที่ถูกต้องใน [COMMANDS.md](../../COMMANDS.md) |
| `422` `"login" is managed by the API` | ใส่คำสั่งที่ API จัดการเอง | ลบออก (login, lang, step, done, strict, eval, cookie) |
| `422` `depends_on … must be an earlier transaction id` | อ้างถึงบทที่อยู่หลังกว่าหรือไม่มีอยู่ | เรียงบทใหม่ หรือแก้ id |
| `422` `version_match failed` (จาก `/checks`) | `target.version` ไม่ตรงกับ server | แก้ `version` ให้ตรงกับเวอร์ชันจริง |
| `401` | token ผิดหรือไม่ได้ส่ง | ส่ง header `Authorization: Bearer <token>` |
| transaction `failed` และมีข้อความ `lang: th_TH is not installed` | Odoo ยังไม่เปิดภาษานั้น | เปิดภาษาใน Odoo (Settings → Languages) |
| transaction `failed` และมีข้อความ `TIMEOUT on …` | selector ไม่ตรงกับหน้าจอ หรือหน้าโหลดช้า | ดู `run.log` และภาพของขั้นนั้นใน bundle แล้วแก้ selector หรือเพิ่ม `timeout_ms` |
