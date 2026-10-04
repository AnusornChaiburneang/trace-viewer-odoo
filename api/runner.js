// Execute one batch: static checks → every transaction in every language (one
// pw_trace.js process per transaction, sharing a per-batch login session) →
// restore the user's language → manifest, draft manual and bundle.zip.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { compileFlow, restoreFlow } = require('./compile');
const { textFor } = require('./validate');
const { renderMarkdown, renderHtml } = require('./manual');
const { writeZip } = require('./zip');

const KIT = path.resolve(__dirname, '..');

// version_info is public JSON-RPC on every Odoo since 8: no login, no API key.
async function serverVersion(targetUrl) {
  const origin = new URL(targetUrl).origin;
  const r = await fetch(`${origin}/web/webclient/version_info`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!j.result || !j.result.server_version) throw new Error(`no Odoo version info at ${origin} (HTTP ${r.status})`);
  return j.result.server_version;
}

async function staticChecks(run) {
  const checks = [];
  let version = null;
  try {
    version = await serverVersion(run.target.url);
    checks.push({ name: 'reachable', status: 'passed', detail: version });
  } catch (e) {
    checks.push({ name: 'reachable', status: 'failed', detail: e.message });
    return checks;
  }
  if (run.target.version) {
    const want = run.target.version.split('.')[0], got = String(version).match(/(\d+)/)[1];
    checks.push({ name: 'version_match', status: want === got ? 'passed' : 'failed',
      detail: `requested ${run.target.version}, server reports ${version}` });
  }
  return checks;
}

function spawnKit(args, env, timeoutS, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(KIT, 'pw_trace.js'), ...args],
      { env, stdio: ['ignore', 'ignore', 'pipe'] });
    onChild(child);
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutS * 1000);
    child.on('close', (code, signal) => { clearTimeout(timer); onChild(null); resolve({ code, signal, stderr }); });
  });
}

const newestResult = (dir) => {
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.result.json')).sort().pop() : null;
  return f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
};

function copyIfExists(src, dst) {
  if (src && fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return true; }
  return false;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

async function executeRun({ store, run, secrets, control, log = () => {} }) {
  const runDir = store.dir(run.id);
  const work = path.join(runDir, 'work');
  const bundleDir = path.join(runDir, 'bundle');
  const sessions = path.join(runDir, 'sessions');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  run.status = 'running';
  run.started_at = new Date().toISOString();
  run.static_checks = await staticChecks(run);
  store.save(run);

  const baseEnv = {
    ...process.env,
    TRACE_API_MODE: '1',
    TRACE_ALLOWED_HOSTS: process.env.TRACE_ALLOWED_HOSTS || '',
    TRACE_SESSION_DIR: sessions,
    TRACE_VAR_LOGIN: secrets.login,
    TRACE_VAR_PASSWORD: secrets.password,
    TRACE_LOCAL: '', ODOO_TASK: '', ODOO_SESSION_ID: '', ODOO_DB: '',
  };
  const kitArgs = (name, flowFile, vars) => [name, run.target.url, '--db', run.target.db, '--flow', flowFile,
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}=${v}`])];

  const results = {};
  let originalLang = null;
  let stopAll = run.static_checks.some(c => c.status === 'failed');
  const stopReason = stopAll ? 'static checks failed' : null;

  for (const lang of run.langs) {
    const txResults = [];
    const exported = {};   // {"T1.so_id": 42} — values for later transactions
    for (const tx of run.transactions) {
      // Transaction titles may use values captured by earlier transactions.
      const title = textFor(tx.title, lang).replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (m, k) => (k in exported ? String(exported[k]) : m));
      const base = { id: tx.id, title, status: 'skipped', error: null, failed_step: null,
        captured: {}, trace: null, log: null, steps: [] };
      const failedDep = tx.depends_on.find(d => (txResults.find(r => r.id === d) || {}).status !== 'passed');
      if (control.cancelled) { base.error = 'cancelled'; txResults.push(base); continue; }
      if (stopAll) { base.error = stopReason || 'skipped after an earlier failure (on_failure: stop)'; txResults.push(base); continue; }
      if (failedDep) { base.error = `depends on ${failedDep}, which did not pass`; txResults.push(base); continue; }

      const flowFile = path.join(work, 'flows', `${lang}-${tx.id}.txt`);
      fs.mkdirSync(path.dirname(flowFile), { recursive: true });
      fs.writeFileSync(flowFile, compileFlow(run, tx, lang));
      const outDir = path.join(work, lang, tx.id);
      log(`run ${run.id}: ${lang}/${tx.id} starting`);
      const res = await spawnKit(kitArgs(tx.id, flowFile, exported),
        { ...baseEnv, TRACE_OUT_DIR: outDir, CMD_TIMEOUT: String(run.options.timeout_ms) },
        run.options.transaction_timeout_s, (c) => { control.child = c; });
      const r = newestResult(outDir);
      const dest = path.join(bundleDir, lang, tx.id);
      if (!r) {
        base.status = 'failed';
        base.error = res.signal ? `transaction timed out or was stopped (${res.signal})` : `runner produced no result: ${res.stderr.trim().split('\n').pop() || `exit ${res.code}`}`;
      } else {
        if (!originalLang && r.lang_switch && r.lang_switch.from) originalLang = r.lang_switch.from;
        base.status = r.status === 'passed' && !res.signal ? 'passed' : 'failed';
        const failed = (r.steps || []).find(s => s.status !== 'passed');
        base.error = res.signal ? `transaction timed out (${run.options.transaction_timeout_s}s)` : (failed ? `${failed.command}: ${failed.error}` : r.error || null);
        base.captured = r.captured || {};
        if (copyIfExists(r.trace_file, path.join(dest, 'trace.zip'))) base.trace = `${lang}/${tx.id}/trace.zip`;
        if (copyIfExists(r.log_file, path.join(dest, 'run.log'))) base.log = `${lang}/${tx.id}/run.log`;
        fs.writeFileSync(path.join(dest, 'result.json'), JSON.stringify(r, null, 2));
        base.steps = (r.manual && r.manual.steps || []).map(s => {
          let shot = null;
          if (s.screenshot && copyIfExists(path.join(outDir, s.screenshot), path.join(dest, 'shots', path.basename(s.screenshot))))
            shot = `${lang}/${tx.id}/shots/${path.basename(s.screenshot)}`;
          return { no: s.no, title: s.title, description: s.description || null, status: s.status, error: s.error, screenshot: shot };
        });
        const firstBad = base.steps.find(s => s.status !== 'passed');
        if (firstBad) base.failed_step = firstBad.no;
        for (const [k, v] of Object.entries(base.captured)) exported[`${tx.id}.${k}`] = v;
      }
      log(`run ${run.id}: ${lang}/${tx.id} ${base.status}`);
      txResults.push(base);
      if (base.status === 'failed' && run.on_failure === 'stop') stopAll = true;
      run.progress = { lang, transaction: tx.id };
      store.save(run);
    }
    const st = txResults.map(t => t.status);
    results[lang] = { status: st.every(s => s === 'passed') ? 'passed' : st.some(s => s === 'passed') ? 'partial' : 'failed', transactions: txResults };
  }

  // Put the user's language back, whatever happened above.
  if (originalLang && run.langs.at(-1) !== originalLang) {
    const flowFile = path.join(work, 'flows', 'restore-lang.txt');
    fs.writeFileSync(flowFile, restoreFlow(originalLang));
    const outDir = path.join(work, 'restore');
    await spawnKit(kitArgs('restore-lang', flowFile, {}), { ...baseEnv, TRACE_OUT_DIR: outDir }, 120, () => {});
    const r = newestResult(outDir);
    run.lang_restore = { lang: originalLang, status: r && r.status === 'passed' ? 'passed' : 'failed' };
  } else if (originalLang) {
    run.lang_restore = { lang: originalLang, status: 'not needed' };
  }

  const all = Object.values(results).flatMap(r => r.transactions.map(t => t.status));
  run.status = control.cancelled ? 'cancelled'
    : all.length && all.every(s => s === 'passed') ? 'passed'
    : run.on_failure === 'continue' && all.some(s => s === 'passed') ? 'partial' : 'failed';
  run.finished_at = new Date().toISOString();
  run.results = Object.fromEntries(Object.entries(results).map(([l, r]) => [l, {
    status: r.status,
    transactions: r.transactions.map(t => ({ id: t.id, status: t.status, error: t.error, failed_step: t.failed_step, captured: t.captured })),
  }]));

  const manifest = {
    schema: 'trace-kit-manifest/1', run_id: run.id, status: run.status,
    created_at: run.created_at, finished_at: run.finished_at,
    target: run.target, langs: run.langs, viewport: { width: 1440, height: 900 },
    static_checks: run.static_checks, lang_restore: run.lang_restore || null,
    results,
  };
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (run.output.manual) {
    for (const lang of run.langs) {
      const title = textFor(run.output.manual.title, lang) || null;
      if (run.output.manual.formats.includes('md')) {
        fs.mkdirSync(path.join(bundleDir, 'manual'), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'manual', `${lang}.md`), renderMarkdown(manifest, lang, title));
      }
      if (run.output.manual.formats.includes('html')) {
        fs.mkdirSync(path.join(bundleDir, 'manual'), { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'manual', `${lang}.html`), renderHtml(manifest, lang, title, runDir));
      }
    }
  }
  buildBundle(runDir);
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  store.save(run);
  return run;
}

// (Re)build bundle.zip from the bundle/ directory — also used after retention
// has removed traces, so the zip always matches what is still on disk.
function buildBundle(runDir) {
  const bundleDir = path.join(runDir, 'bundle');
  if (!fs.existsSync(bundleDir)) return null;
  const files = listFiles(bundleDir).sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)));
  const out = path.join(runDir, 'bundle.zip');
  writeZip(out, files.map(f => ({ name: f, file: path.join(bundleDir, f) })));
  return out;
}

module.exports = { executeRun, buildBundle, staticChecks, serverVersion };
