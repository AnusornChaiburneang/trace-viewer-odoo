// End-to-end tests for the Trace Kit API against a fake Odoo (tests/fixture_odoo.js).
// Runs real pw_trace.js processes; no real Odoo database is touched.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createFixtureOdoo } = require('./fixture_odoo');
const { readZip } = require('../api/zip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-api-'));
const TOKEN = 'test-token-0123456789abcdef', OTHER = 'other-token-0123456789abcdef';
const PASSWORD = 'test-pass';

(async () => {
  const odoo = createFixtureOdoo({ password: PASSWORD });
  await new Promise(r => odoo.server.listen(0, '127.0.0.1', r));
  const callbacks = [];
  const cbServer = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    callbacks.push({ body, sig: req.headers['x-tracekit-signature'] }); res.end('ok');
  });
  await new Promise(r => cbServer.listen(0, '127.0.0.1', r));

  Object.assign(process.env, { TRACE_CALLBACK_SECRET: 'cb-secret', CMD_TIMEOUT: '3000' });
  const { createApp } = require('../api/server');
  const env = { ...process.env, TRACE_API_TOKENS: `tester:${TOKEN},other:${OTHER}`, TRACE_DATA_DIR: tmp, MAX_CONCURRENT_RUNS: '1' };
  const app = createApp(env);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const odooUrl = `http://127.0.0.1:${odoo.server.address().port}/web/login`;

  const call = async (method, p, body, token = TOKEN) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, json: type.includes('json') ? await r.json() : null, buf: type.includes('json') ? null : Buffer.from(await r.arrayBuffer()), type };
  };
  const waitDone = async (id, ms = 240000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await call('GET', `/runs/${id}`);
      if (!['queued', 'running'].includes(r.json.status)) return r.json;
      await new Promise(res => setTimeout(res, 500));
    }
    throw new Error(`run ${id} did not finish`);
  };
  const target = (extra = {}) => ({ url: odooUrl, db: 'fixture', version: '17.0', login: 'alice', password: PASSWORD, ...extra });

  // ---- auth, validation, checks ---------------------------------------------
  assert.equal((await call('GET', '/health', null, null)).status, 200);
  assert.equal((await call('GET', '/runs', null, null)).status, 401);
  assert.equal((await call('GET', '/runs', null, 'wrong-token')).status, 401);
  let r = await call('POST', '/runs', {
    target: target({ password: undefined }), lang: ['en_US', 'th_TH'],
    transactions: [
      { id: 'T1', title: 'Only one language', steps: [{ title: { en_US: 'x' }, commands: ['eval 1', 'nosuchcmd', "fill 'unclosed 1"] }] },
      { id: 'T2', title: { en_US: 'a', th_TH: 'ก' }, depends_on: 'T9', steps: [{ title: { en_US: 'a', th_TH: 'ก' }, commands: ['login a b'] }] },
    ],
  });
  assert.equal(r.status, 422);
  const paths = r.json.details.map(d => d.path);
  for (const want of ['target.password', 'transactions[0].title', 'transactions[0].steps[0].title.th_TH',
    'transactions[0].steps[0].commands[0]', 'transactions[0].steps[0].commands[1]', 'transactions[0].steps[0].commands[2]',
    'transactions[1].depends_on', 'transactions[1].steps[0].commands[0]'])
    assert(paths.includes(want), `missing validation error for ${want}: ${JSON.stringify(r.json.details)}`);
  assert(r.json.details.find(d => d.path === 'transactions[0].steps[0].title.th_TH').message.includes('captions_complete'));
  const minimal = { target: target(), transactions: [{ id: 'T1', title: 'x', steps: [{ title: 'x', commands: ['url'] }] }] };
  r = await call('POST', '/checks', minimal);
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true);
  r = await call('POST', '/checks', { ...minimal, target: target({ version: '19.0' }) });
  assert.equal(r.status, 422); assert.equal(r.json.static_checks.find(c => c.name === 'version_match').status, 'failed');
  console.log('PASS auth, request validation (captions_complete, flow_syntax, reserved commands, depends_on) and /checks version_match');

  // ---- full batch: 3 transactions × 2 languages, manual, callback -----------
  const batch = {
    target: target(), lang: ['en_US', 'th_TH'], on_failure: 'stop',
    callback_url: `http://127.0.0.1:${cbServer.address().port}/hook`,
    output: { bundle: true, manual: { formats: ['md', 'html'], title: { en_US: 'Sales manual', th_TH: 'คู่มือการขาย' } } },
    transactions: [
      { id: 'T1', title: { en_US: 'Create the order', th_TH: 'สร้างใบสั่งขาย' },
        steps: [
          { title: { en_US: 'Enter the amount', th_TH: 'กรอกจำนวน' }, description: { en_US: 'Type 5', th_TH: 'พิมพ์ 5' },
            commands: ['fill #amount 5'], expect: ['value #amount 5'],
            highlight: { selector: '#amount', caption: { en_US: 'Amount', th_TH: 'จำนวน' } } },
          { title: { en_US: "Check the customer's greeting", th_TH: 'ตรวจคำทักทาย' }, commands: ['expect visible #hello'] },
        ],
        capture: { so_name: 'field name', greeting: 'text #hello' } },
      { id: 'T2', depends_on: 'T1', title: { en_US: 'Find {{T1.so_name}}', th_TH: 'ค้นหา {{T1.so_name}}' },
        steps: [{ title: { en_US: 'Search {{T1.so_name}}', th_TH: 'ค้นหา {{T1.so_name}}' },
          commands: ['fill #search {{T1.so_name}}'], expect: ['value #search S00042'] }] },
      { id: 'T3', title: { en_US: 'Status', th_TH: 'สถานะ' },
        steps: [{ title: { en_US: 'Confirmed order', th_TH: 'ยืนยันแล้ว' }, commands: ['expect state sale'] }] },
    ],
  };
  r = await call('POST', '/runs', batch);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const id = r.json.run_id;
  assert.equal((await call('GET', `/runs/${id}`, null, OTHER)).status, 404, 'another client must not see the run');
  const done = await waitDone(id);
  assert.equal(done.status, 'passed', JSON.stringify(done, null, 2));
  assert.deepEqual(done.static_checks.map(c => [c.name, c.status]), [['reachable', 'passed'], ['version_match', 'passed']]);
  assert.equal(done.results.en_US.transactions[0].captured.greeting, 'Hello');
  assert.equal(done.results.th_TH.transactions[0].captured.greeting, 'สวัสดี');
  assert.deepEqual(done.lang_restore, { lang: 'en_US', status: 'passed' });
  assert.equal(odoo.users.alice.lang, 'en_US', 'user language must be restored');

  const manifest = (await call('GET', `/runs/${id}/manifest`)).json;
  assert.equal(manifest.schema, 'trace-kit-manifest/1');
  const t1 = manifest.results.en_US.transactions[0], t2 = manifest.results.th_TH.transactions[1];
  assert.deepEqual(t1.steps.map(s => [s.no, s.title, s.status]), [[1, 'Enter the amount', 'passed'], [2, 'Check the customer’s greeting', 'passed']]);
  assert.equal(t1.steps[0].screenshot, 'en_US/T1/shots/01-enter-the-amount.png');
  assert.equal(t2.title, 'ค้นหา S00042'); assert.equal(t2.steps[0].title, 'ค้นหา S00042');
  const zipFile = path.join(tmp, 'bundle.zip');
  const zr = await call('GET', `/runs/${id}/bundle.zip`);
  assert.equal(zr.status, 200); fs.writeFileSync(zipFile, zr.buf);
  const entries = readZip(zipFile);
  for (const want of ['manifest.json', 'en_US/T1/shots/01-enter-the-amount.png', 'th_TH/T1/shots/01-step.png', 'en_US/T1/trace.zip',
    'th_TH/T3/result.json', 'en_US/T2/run.log', 'manual/en_US.md', 'manual/th_TH.md', 'manual/en_US.html', 'manual/th_TH.html'])
    assert(entries[want], `bundle is missing ${want}: ${Object.keys(entries).join(', ')}`);
  assert.equal(JSON.parse(entries['manifest.json']()).run_id, id);
  const png = entries['en_US/T1/shots/01-enter-the-amount.png']();
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1440, 900]);
  const md = entries['manual/th_TH.md']().toString();
  assert.match(md, /^# คู่มือการขาย/); assert.match(md, /### ขั้นตอนที่ 1\.1 กรอกจำนวน/);
  assert.match(md, /!\[กรอกจำนวน\]\(\.\.\/th_TH\/T1\/shots\/01-step\.png\)/);
  const html = (await call('GET', `/runs/${id}/manual.html?lang=en_US`)).buf.toString();
  assert.match(html, /<h3>Step 1\.1 Enter the amount<\/h3>/); assert.match(html, /data:image\/png;base64,/);
  // Test report: per-step checks in the manifest, last screen per transaction, report.html on request.
  assert.deepEqual(t1.steps[0].checks.map(c => [c.kind, c.label, c.status]),
    [['expect', 'value #amount 5', 'passed'], ['mark', 'Amount', 'passed']]);
  assert.deepEqual(t1.steps[1].checks.map(c => [c.kind, c.label, c.status]),
    [['expect', 'visible #hello', 'passed'], ['capture', 'so_name = S00042', 'passed'], ['capture', 'greeting = Hello', 'passed']]);
  assert.equal(t1.final_screenshot, 'en_US/T1/final.jpeg');
  assert(entries['en_US/T1/final.jpeg'], 'bundle is missing the last-screen frame');
  assert.equal(done.links.report_html, `${done.links.self}/report.html`);
  const rep = await call('GET', `/runs/${id}/report.html?lang=th_TH`);
  assert.equal(rep.status, 200); assert.match(rep.type, /text\/html/);
  const repHtml = rep.buf.toString();
  assert.match(repHtml, /รายงานผลทดสอบ/); assert.match(repHtml, /T1\.1 กรอกจำนวน/); assert.match(repHtml, /✓ value #amount 5/);
  assert.match(repHtml, /data:image\/png;base64,/); assert.match(repHtml, /data:image\/jpeg;base64,/);
  assert(!repHtml.includes(PASSWORD), 'report must not contain the password');
  assert.equal((await call('GET', `/runs/${id}/report.html?lang=de_DE`)).status, 404);
  assert.equal((await call('GET', `/runs/${id}/files/en_US/T1/shots/01-enter-the-amount.png`)).type, 'image/png');
  assert.equal((await call('GET', `/runs/${id}/files/..%2Frun.json`)).status, 400);
  assert.equal((await call('GET', `/runs/${id}/tx/T2/trace.zip?lang=th_TH`)).status, 200);
  for (let i = 0; i < 50 && !callbacks.length; i++) await new Promise(res => setTimeout(res, 100));
  assert.equal(callbacks.length, 1, 'callback must be delivered once');
  assert.equal(callbacks[0].sig, `sha256=${crypto.createHmac('sha256', 'cb-secret').update(callbacks[0].body).digest('hex')}`);
  assert.equal(JSON.parse(callbacks[0].body).run_id, id);
  const secretHits = [];
  const scan = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name);
    if (f.isDirectory()) scan(p); else if (!p.endsWith('.zip') && fs.readFileSync(p).includes(PASSWORD)) secretHits.push(p); } };
  scan(path.join(tmp, 'runs'));
  assert.deepEqual(secretHits, [], 'password written to disk');
  console.log('PASS 3 transactions × 2 languages: depends_on values, lang switch + restore, bundle, manual md/html, callback HMAC, no secrets on disk');

  // ---- failures: continue → partial with skipped dependent; stop → failed ----
  const failing = (onFailure) => ({ target: target(), on_failure: onFailure, output: { manual: { formats: ['md'] } },
    transactions: [
      { id: 'A', title: 'Broken', steps: [{ title: 'Missing element', commands: ['expect visible #nope'] }] },
      { id: 'B', depends_on: 'A', title: 'Needs A', steps: [{ title: 'x', commands: ['url'] }] },
      { id: 'C', title: 'Independent', steps: [{ title: 'y', commands: ['expect visible #hello'] }] },
    ] });
  r = await call('POST', '/runs', failing('continue'));
  let res = await waitDone(r.json.run_id);
  assert.equal(res.status, 'partial');
  assert.deepEqual(res.results.en_US.transactions.map(t => t.status), ['failed', 'skipped', 'passed']);
  assert.match(res.results.en_US.transactions[1].error, /depends on A/);
  assert.equal(res.results.en_US.transactions[0].failed_step, 1);
  const failMd = fs.readFileSync(path.join(tmp, 'runs', r.json.run_id, 'bundle', 'manual', 'en_US.md'), 'utf8');
  assert.match(failMd, /did not complete in the automated run/);
  assert(!/!\[Missing element\]/.test(failMd), 'failed step screenshot must not be in the manual');
  const failCheck = (await call('GET', `/runs/${r.json.run_id}/manifest`)).json.results.en_US.transactions[0].steps[0].checks[0];
  assert.deepEqual([failCheck.kind, failCheck.label, failCheck.status], ['expect', 'visible #nope', 'failed']);
  assert(failCheck.error, 'a failed check carries its error');
  const failRep = (await call('GET', `/runs/${r.json.run_id}/report.html`)).buf.toString();
  assert.match(failRep, /✗ visible #nope/); assert.match(failRep, /Depends on A|depends on A/);
  assert.match(failRep, /class="fail"/, 'the test report lists failures (unlike the manual)');
  r = await call('POST', '/runs', failing('stop'));
  res = await waitDone(r.json.run_id);
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.results.en_US.transactions.map(t => t.status), ['failed', 'skipped', 'skipped']);
  console.log('PASS on_failure continue (partial, dependent skipped, no failed shot in manual) and stop (rest skipped)');

  // ---- cancel a queued run ----------------------------------------------------
  const slow = { target: target(), transactions: [{ id: 'S', title: 's', steps: [{ title: 's', commands: ['wait 2500'] }] }] };
  const first = (await call('POST', '/runs', slow)).json.run_id;
  const second = (await call('POST', '/runs', slow)).json.run_id;
  r = await call('POST', `/runs/${second}/cancel`);
  assert.equal(r.status, 202); assert.equal(r.json.status, 'cancelled');
  assert.equal((await waitDone(first)).status, 'passed');
  assert.equal((await call('GET', `/runs/${second}`)).json.status, 'cancelled');
  assert.equal((await call('GET', `/runs/${second}/manifest`)).status, 404);
  console.log('PASS cancel a queued run without disturbing the running one');

  // ---- restart recovery and retention -----------------------------------------
  const ghost = crypto.randomUUID();
  fs.mkdirSync(path.join(tmp, 'runs', ghost));
  fs.writeFileSync(path.join(tmp, 'runs', ghost, 'run.json'), JSON.stringify({ id: ghost, client: 'tester', status: 'running', created_at: new Date().toISOString(), langs: ['en_US'], transactions: [] }));
  const app2 = createApp(env);
  assert.equal(app2.store.get(ghost).status, 'error');
  assert.match(app2.store.get(ghost).error, /restarted/);
  app2.retention(Date.now() + 15 * 86400000);
  assert.equal(app2.store.get(id).traces_expired, true);
  assert(!fs.existsSync(path.join(tmp, 'runs', id, 'bundle', 'en_US', 'T1', 'trace.zip')));
  assert(fs.existsSync(path.join(tmp, 'runs', id, 'bundle', 'en_US', 'T1', 'shots', '01-enter-the-amount.png')));
  assert(!Object.keys(readZip(path.join(tmp, 'runs', id, 'bundle.zip'))).some(n => n.endsWith('trace.zip')));
  app2.retention(Date.now() + 181 * 86400000);
  assert.equal(app2.store.get(id), null);
  console.log('PASS restart marks lost runs as error; retention drops traces at 14 days and runs at 180 days');

  app.server.close(); odoo.server.close(); cbServer.close();
})().catch(e => { console.error(e); process.exitCode = 1; process.exit(1); })
  .finally(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
