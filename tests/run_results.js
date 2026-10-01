// Isolated browser integration: synthetic UI/session server, no real Odoo data.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { parseOptions, resolveContext } = require('../run-context');
const { loadConfig } = require('../config');
const kit = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-results-'));
const html = `<html><head><title>Fixture</title></head><body>
<div class="o_action_manager"><input id="amount" value="10"><div id="status">Ready</div>
<div class="o_form_view"><div class="o_statusbar_status"><button class="o_arrow_button_current">Confirmed</button></div></div>
<div class="modal"><h2 class="modal-title">Transfer</h2></div>
<table><tr><td id="check"><input type="checkbox"></td><td id="empty"></td></tr></table>
<input id="search"><div class="o-autocomplete--dropdown-item">Product A</div>
<form method="POST"><input id="login" name="login"><input id="password" name="password"><button>Log in</button></form>
</div></body></html>`;
let contextLookups = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/sessions/')) {
    const sid = decodeURIComponent(url.pathname.split('/')[3]); contextLookups.push(sid);
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify({ session_id: sid, task_number: 'T26-12345' }));
  }
  if (url.pathname === '/web/session/get_session_info') {
    const cookie = Object.fromEntries((req.headers.cookie || '').split('; ').filter(Boolean).map(s => s.split('=')));
    res.setHeader('Content-Type','application/json');
    return res.end(JSON.stringify({ result: cookie.user ? { uid: 7, username: cookie.user, db: cookie.db, server_version: '17.0-fixture' } : {} }));
  }
  if (url.pathname.startsWith('/web/dataset/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), method = body.params.method;
    if (method === 'disconnect') return req.socket.destroy();
    if (method === 'html_error') { res.writeHead(502); return res.end('proxy error'); }
    if (method === 'late') await new Promise(resolve => setTimeout(resolve, 300));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(method === 'explode' ? {jsonrpc:'2.0', id:body.id,
      error:{code:200, message:'Odoo Server Error', data:{name:'odoo.exceptions.ValidationError',
        message:'Missing account', debug:'Traceback (most recent call last):\n  File "custom/invoice.py", line 42, in create_invoices\nValidationError: Missing account'}}}
      : {jsonrpc:'2.0', id:body.id, result:{private_business_data:'must not be captured'}}));
  }
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    if (form.get('password') !== 'test-pass') return res.end(html);
    res.writeHead(302, { Location: '/web', 'Set-Cookie': [`user=${form.get('login')}; Path=/`, `db=${url.searchParams.get('db') === 'wrongdb' ? 'unexpected' : (url.searchParams.get('db') || 'fixture')}; Path=/`] });
    return res.end();
  }
  res.setHeader('Content-Type','text/html'); res.end(url.pathname === '/web' ? html.replace(/<form.*?<\/form>/s, '') : html);
});
async function run(name, flow, args = [], extraEnv = {}, launcher = null) {
  const previous = new Set(fs.readdirSync(tmp));
  const target = `http://127.0.0.1:${server.address().port}/web/login`;
  const child = spawn(launcher ? 'bash' : process.execPath,
    [launcher ? path.join(kit, launcher) : path.join(kit,'pw_trace.js'), name, target, ...args],
    { env: { ...process.env, ODOO_TASK: '', ODOO_SESSION_ID: '', ODOO_DB: '', TRACE_LOCAL: '',
      TRACE_OUT_DIR: tmp, TRACE_SESSION_DIR: path.join(tmp,'sessions'), CMD_TIMEOUT: '400', ...extraEnv }, stdio: ['pipe','pipe','pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  child.stdin.end(flow);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const files = fs.readdirSync(tmp).filter(f => f.endsWith('.result.json') && !previous.has(f));
  const file = files.map(f => path.join(tmp, f)).find(f => JSON.parse(fs.readFileSync(f)).flow_name === name);
  if (!file || !fs.existsSync(file)) throw new Error(`${name}: no result, exit=${code}\n${output}`);
  const result = JSON.parse(fs.readFileSync(file));
  assert(fs.existsSync(result.trace_file), `${name}: trace missing\n${output}`);
  assert.equal(code, result.status === 'passed' ? 0 : 1, output);
  return { code, result, output };
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { ODOO_TASK: 'T26-99999', ODOO_SESSION_ID: 'env-session', ODOO_DB: 'env_db' };
  assert.equal(parseOptions(['demo','--task','T26-12345','--db','explicit'],env).db, 'explicit');
  assert.throws(() => parseOptions(['demo','http://localhost/?db=a','--db','b'],{}), /conflicts/);
  assert.throws(() => parseOptions(['demo','--task'],{}), /needs a value/);
  assert.throws(() => parseOptions(['demo','--oops','x'],{}), /Unknown option/);
  // The default task pattern is deliberately permissive (any ticket scheme);
  // a stricter one comes from trace.config.json / TRACE_TASK_PATTERN.
  assert.equal(parseOptions(['demo','--task','bad'],{}).task, 'bad');
  const strictCfg = loadConfig({ TRACE_TASK_PATTERN: '^T\\d{2}-\\d{5}$' });
  assert.throws(() => parseOptions(['demo','--task','bad'],{},strictCfg), /format/);
  assert.equal(parseOptions(['demo','--task','T26-12345'],{},strictCfg).task, 'T26-12345');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await resolveContext(parseOptions(['demo'],{}),base)).task,'');
  assert.equal(contextLookups.length,0);
  assert.equal((await resolveContext(parseOptions(['demo','--session-id','chosen'],{}),base)).task,'T26-12345');
  assert.deepEqual(contextLookups,['chosen']);
  await resolveContext(parseOptions(['demo','--session-id','chosen','--task','T26-54321'],{}),base);
  assert.deepEqual(contextLookups,['chosen']);
  console.log('PASS context parsing, precedence, exact lookup, no implicit lookup');

  let r = await run('assertions', '# comment\nexpect value #amount 10\nexpect text #status Ready\nexpect visible #amount\nexpect hidden #missing\nexpect state Confirmed\nexpect dialog Transfer\nboolcell \'#check\' on\nexpect visible #check\ndone\n', ['--task','T26-12345','--session-id','test-session','--db','fixture']);
  assert.equal(r.code,0,r.output); assert.equal(r.result.context.task,'T26-12345'); assert.equal(r.result.steps[0].line,2);
  assert.equal(r.result.context.session_id,'test-session'); assert.equal(r.result.context.requested_db,'fixture');
  console.log('PASS assertions, success exit, context and source metadata');

  r = await run('failures', 'clickbtn Missing\njclick #missing\nboolcell \'#missing\' on\nboolcell \'#empty\' on\ncelltype \'#empty\' bad\npick Wrong product\nscroll #missing\nbreadcrumb\nunknowncommand\nexpect value #amount 99\nnavmenu Missing\ndone\n');
  assert.equal(r.code,1,r.output); assert.equal(r.result.failed_steps,11,r.output);
  assert.equal(r.result.steps.at(-1).command,'done');
  console.log('PASS semantic failures, failed assertions, continuation, nonzero exit, preserved zip');

  r = await run('strict', 'strict on\nclickbtn Missing\nfill #amount 99\ndone\n');
  assert.equal(r.result.steps.length,2,r.output); assert.equal(r.code,1);
  console.log('PASS strict mode stops before subsequent mutation');

  r = await run('idle', 'eval window.__odooPending = 1\nwaitidle 450\ndone\n');
  assert.equal(r.result.failed_steps,1,r.output); assert.match(r.result.steps[1].error,/waitidle timed out/);
  console.log('PASS idle deadline fails instead of reporting idle');

  r = await run('loginbad', 'login alice wrong-password\nfill #amount 99\ndone\n',['--db','fixture']);
  assert.equal(r.result.steps.length,1,r.output); assert.equal(r.code,1); assert(!r.output.includes('wrong-password'));
  console.log('PASS failed login always stops and credentials are absent from command logs');

  r = await run('loginok', 'login alice test-pass\ndone\n',['--db','fixture']);
  assert.equal(r.code,0,r.output); assert.equal(r.result.context.verified_session.username,'alice');
  assert.equal(r.result.context.verified_session.server_version,'17.0-fixture');
  r = await run('switchuser', 'login bob test-pass\ndone\n',['--db','fixture']);
  assert.equal(r.code,0,r.output); assert.equal(r.result.context.verified_session.username,'bob');
  r = await run('switchdb', 'login bob test-pass\ndone\n',['--db','second']);
  assert.equal(r.code,0,r.output); assert.equal(r.result.context.verified_session.db,'second');
  console.log('PASS verified login metadata, cached-user switching and DB isolation');

  r = await run('wrapper', 'done\n',['--task','T26-12345','--session-id','wrap','--db','fixture'],{},'trace-local.sh');
  assert.equal(r.code,0,r.output); assert.equal(r.result.context.session_id,'wrap');
  console.log('PASS local launcher forwards flags and labels explicit task');

  r = await run('wrongdb', 'login bob test-pass\nfill #amount 99\ndone\n',['--db','wrongdb']);
  assert.equal(r.code,1,r.output); assert.equal(r.result.steps.length,1);
  assert.equal(r.result.context.verified_session,null);
  console.log('PASS server-side database mismatch aborts after fresh login');

  r = await run('edgecases', `eval document.body.insertAdjacentHTML("beforeend", "<i class=hidden style=display:none></i><i class=hidden style=display:none></i>")
expect hidden .hidden
eval setTimeout(() => document.querySelector("#status").textContent = "Later", 150)
expect text #status Later
eval "apostrophe's are valid JS"
done
`);
  assert.equal(r.code,0,r.output);
  r = await run('empty', '# no commands\n');
  assert.equal(r.code,1,r.output); assert.match(r.result.error,/No commands/);
  console.log('PASS assertion retry, multiple hidden elements, raw JS quotes, and empty flow rejection');

  r = await run('field-dispatch', `strict on
eval document.body.innerHTML = '<div class="o_form_view"><div class="o_field_widget" name="reference"><input value="old"></div><div class="o_field_widget" name="invoice_line_ids"><table class="o_list_table"><tbody><tr class="o_data_row" data-id="one"><td name="name">Service A</td><td name="quantity"><input value="1"></td></tr></tbody></table></div></div>'
field reference Working value
expect value '[name="reference"] input' Working value
field reference ''
expect value '[name="reference"] input' ''
rowset invoice_line_ids 'name=Service A' quantity 2
expect value '[name="quantity"] input' 2
done
`);
  assert.equal(r.code,0,r.output);
  assert.equal(r.result.steps.filter(s => /^(field|rowset) /.test(s.command)).length,3);
  console.log('PASS field/rowset command dispatch, quoted row matching, and clearing values');
  const rpc = method => `fetch('/web/dataset/call_kw', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:17,method:'call',params:{model:'sale.order',method:'${method}',args:[[7]],kwargs:{password:'hidden-secret',context:{token:'hidden-token'}}}})}).then(r=>r.text()).catch(()=>null)`;
  r = await run('runtime-evidence', [
    'eval void ' + rpc('late'),
    'wait 400',
    'eval ' + rpc('explode'),
    'eval ' + rpc('html_error'),
    'eval ' + rpc('disconnect'),
    'done',
  ].join('\n')+'\n');
  const requests = r.result.runtime.requests;
  const late = requests.find(x=>x.method==='late'), failure=requests.find(x=>x.method==='explode');
  assert.equal(late.step_id,r.result.steps[0].step_id);
  assert.equal(late.status,'ok'); assert(late.duration_ms>=250);
  assert.equal(failure.http_status,200); assert.equal(failure.status,'rpc_error');
  assert.match(failure.error.traceback,/custom\/invoice.py/);
  assert.equal(failure.line,3);
  assert.equal(failure.params.kwargs.password,'[redacted]');
  assert.equal(failure.params.kwargs.context.token,'[redacted]');
  assert(!JSON.stringify(requests).includes('hidden-secret'));
  assert(!JSON.stringify(requests).includes('private_business_data'));
  assert.equal(requests.find(x=>x.method==='html_error').status,'http_error');
  assert(requests.some(x=>x.method==='disconnect' && x.status==='network_error'));
  assert.equal(new Set(requests.map(x=>x.request_id)).size,requests.length);
  console.log('PASS RPC correlation, late responses, HTTP-200 traceback, network/HTTP failures, redaction and result omission');

  const original = '# immutable file snapshot\nexpect value #amount 10\ndone\n';
  const flowFile = path.join(tmp, 'captured.txt'); fs.writeFileSync(flowFile, original);
  const first = await run('history-file', '', ['--flow', flowFile]);
  assert.equal(first.result.flow.content, original);
  assert.equal(first.result.flow.capture, 'file');
  assert.equal(first.result.flow.complete, true);
  const { createHash } = require('crypto');
  assert.equal(first.result.flow.sha256, createHash('sha256').update(original).digest('hex'));
  fs.writeFileSync(flowFile, 'done\n');
  // Launch the same name again; old artifacts and source snapshot must survive.
  const beforeFiles = fs.readdirSync(tmp).filter(f => f.endsWith('.result.json'));
  await run('history-file', '', ['--flow', flowFile]);
  const newFiles = fs.readdirSync(tmp).filter(f => f.endsWith('.result.json') && !beforeFiles.includes(f));
  assert.equal(newFiles.length, 1);
  const second = JSON.parse(fs.readFileSync(path.join(tmp,newFiles[0])));
  assert.notEqual(first.result.run_id,second.run_id);
  assert.notEqual(first.result.flow.sha256,second.flow.sha256);
  assert(fs.existsSync(first.result.trace_file));
  assert.equal(first.result.flow.content,original);
  const redacted = await run('history-secret','login alice test-pass\ndone\n',['--db','fixture']);
  assert(!redacted.result.flow.content.includes('test-pass'));
  assert.equal(redacted.result.flow.content,'login [redacted]\ndone\n');
  console.log('PASS unique run artifacts, immutable file snapshots, source hashing, and credential redaction');


})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { server.close(); console.log(`Test artifacts: ${tmp}`); });
