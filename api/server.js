#!/usr/bin/env node
// Trace Kit API — accepts test-case batches from other systems, runs them with
// pw_trace.js and returns a bundle (screenshots, manifest, traces) and an
// optional draft manual. No framework: node:http + a small router.
//
//   TRACE_API_TOKENS="manual-system:<token>"   (or TRACE_API_TOKENS_FILE, one name:token per line)
//   node api/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { validateRun } = require('./validate');
const { executeRun, buildBundle, staticChecks } = require('./runner');

const VERSION = require('../package.json').version;

function loadTokens(env) {
  const lines = [];
  if (env.TRACE_API_TOKENS) lines.push(...env.TRACE_API_TOKENS.split(','));
  if (env.TRACE_API_TOKENS_FILE && fs.existsSync(env.TRACE_API_TOKENS_FILE))
    lines.push(...fs.readFileSync(env.TRACE_API_TOKENS_FILE, 'utf8').split('\n'));
  const tokens = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 1 || line.length - i - 1 < 16) throw new Error(`bad token line "${line.slice(0, 12)}…" — expected name:token (token ≥ 16 chars)`);
    tokens.set(line.slice(i + 1), line.slice(0, i));
  }
  return tokens;
}

function createApp(env = process.env) {
  const tokens = loadTokens(env);
  if (!tokens.size) throw new Error('No API tokens configured: set TRACE_API_TOKENS or TRACE_API_TOKENS_FILE');
  const store = new Store(env.TRACE_DATA_DIR || '/data');
  const maxConcurrent = Math.max(1, Number(env.MAX_CONCURRENT_RUNS || 1));
  const publicUrl = (env.TRACE_PUBLIC_URL || '').replace(/\/+$/, '');
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

  const queue = [];            // [{ id, secrets }] — secrets live only here
  const active = new Map();    // id → control { cancelled, child }

  // Credentials are never written to disk, so runs that were queued or running
  // when the server stopped cannot be resumed.
  for (const run of store.list()) {
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'error';
      run.error = 'the API server restarted before this run finished; submit it again';
      run.finished_at = new Date().toISOString();
      store.save(run);
    }
  }

  const links = (id) => {
    const b = `${publicUrl}/api/v1/runs/${id}`;
    return { self: b, manifest: `${b}/manifest`, bundle: `${b}/bundle.zip`, manual_md: `${b}/manual.md`, manual_html: `${b}/manual.html` };
  };
  const summary = (run) => ({
    run_id: run.id, status: run.status, client: run.client, created_at: run.created_at,
    started_at: run.started_at || null, finished_at: run.finished_at || null,
    target: run.target, langs: run.langs, on_failure: run.on_failure, progress: run.progress || null,
    static_checks: run.static_checks || [], results: run.results || null, lang_restore: run.lang_restore || null,
    callback: run.callback || null, traces_expired: !!run.traces_expired, error: run.error || null,
    links: links(run.id),
  });

  async function sendCallback(run) {
    if (!run.callback_url) return;
    const body = JSON.stringify({ event: 'run.finished', ...summary(run) });
    const headers = { 'Content-Type': 'application/json', 'User-Agent': `trace-kit/${VERSION}` };
    if (env.TRACE_CALLBACK_SECRET)
      headers['X-TraceKit-Signature'] = `sha256=${crypto.createHmac('sha256', env.TRACE_CALLBACK_SECRET).update(body).digest('hex')}`;
    const delays = [0, 1000, 5000, 15000];
    run.callback = { url: run.callback_url, status: 'failed', attempts: 0, last_error: null };
    for (const d of delays) {
      if (d) await new Promise(r => setTimeout(r, d));
      run.callback.attempts++;
      try {
        const r = await fetch(run.callback_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
        if (r.ok) { run.callback.status = 'delivered'; run.callback.last_error = null; break; }
        run.callback.last_error = `HTTP ${r.status}`;
      } catch (e) { run.callback.last_error = e.message; }
    }
    store.save(run);
  }

  function pump() {
    while (active.size < maxConcurrent && queue.length) {
      const { id, secrets } = queue.shift();
      const run = store.get(id);
      if (!run || run.status !== 'queued') continue;
      const control = { cancelled: false, child: null };
      active.set(id, control);
      log(`run ${id} started (${run.transactions.length} transaction(s) × ${run.langs.length} language(s))`);
      executeRun({ store, run, secrets, control, log })
        .catch((e) => {
          const r = store.get(id) || run;
          r.status = 'error'; r.error = String(e && e.message || e); r.finished_at = new Date().toISOString();
          store.save(r);
          log(`run ${id} error: ${r.error}`);
        })
        .then(() => sendCallback(store.get(id)))
        .finally(() => { active.delete(id); log(`run ${id} finished: ${(store.get(id) || {}).status}`); pump(); });
    }
  }

  // Retention: traces (the large part) after TRACE_RETENTION_DAYS, everything
  // after TRACE_KEEP_DAYS. Screenshots, manifest and manuals stay longer.
  function retention(now = Date.now()) {
    const traceDays = Number(env.TRACE_RETENTION_DAYS || 14), keepDays = Number(env.TRACE_KEEP_DAYS || 180);
    for (const run of store.list()) {
      if (!run.finished_at) continue;
      const age = (now - Date.parse(run.finished_at)) / 86400000;
      if (age > keepDays) { store.remove(run.id); log(`retention: removed run ${run.id}`); continue; }
      if (age > traceDays && !run.traces_expired) {
        const bundleDir = store.file(run.id, 'bundle');
        if (fs.existsSync(bundleDir)) {
          const dropTraces = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) dropTraces(p);
              else if (e.name === 'trace.zip') fs.rmSync(p, { force: true });
            }
          };
          dropTraces(bundleDir);
          buildBundle(store.dir(run.id));
        }
        run.traces_expired = true;
        store.save(run);
        log(`retention: traces expired for run ${run.id}`);
      }
    }
  }

  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const sendFile = (res, file, type, downloadName) => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    const headers = { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(Object.assign(new Error('body larger than 1 MB'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('body is not valid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const TYPES = { '.png': 'image/png', '.json': 'application/json', '.zip': 'application/zip', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && p === '/api/v1/health')
      return send(res, 200, { ok: true, version: VERSION, running: active.size, queued: queue.length, max_concurrent_runs: maxConcurrent });

    const auth = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const client = auth && tokens.get(auth[1].trim());
    if (!client) return send(res, 401, { error: 'missing or invalid bearer token' }, { 'WWW-Authenticate': 'Bearer' });

    if (req.method === 'POST' && (p === '/api/v1/runs' || p === '/api/v1/checks')) {
      const body = await readBody(req);
      const { errors, run: spec } = validateRun(body, env);
      if (errors.length) return send(res, 422, { error: 'validation failed', details: errors });
      if (p === '/api/v1/checks') {
        const checks = await staticChecks(spec);
        const ok = checks.every(c => c.status === 'passed');
        return send(res, ok ? 200 : 422, { ok, static_checks: [{ name: 'request', status: 'passed', detail: 'schema, flow_syntax, captions_complete' }, ...checks] });
      }
      const id = crypto.randomUUID();
      const { credentials, ...rest } = spec;
      const run = { id, client, status: 'queued', created_at: new Date().toISOString(), ...rest };
      store.save(run);
      queue.push({ id, secrets: credentials });
      log(`run ${id} queued by ${client}`);
      pump();
      return send(res, 202, { run_id: id, status: 'queued', position: queue.length, links: links(id) }, { Location: links(id).self });
    }

    if (req.method === 'GET' && p === '/api/v1/runs') {
      const status = url.searchParams.get('status');
      const limit = Math.min(200, Number(url.searchParams.get('limit') || 50));
      const runs = store.list().filter(r => r.client === client && (!status || r.status === status)).slice(0, limit);
      return send(res, 200, { runs: runs.map(summary) });
    }

    const m = p.match(/^\/api\/v1\/runs\/([0-9a-f-]{36})(\/.*)?$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const run = store.get(m[1]);
    if (!run || run.client !== client) return send(res, 404, { error: 'run not found' });
    const sub = m[2] || '';
    const finished = !['queued', 'running'].includes(run.status);

    if (req.method === 'GET' && sub === '') return send(res, 200, summary(run));
    if (req.method === 'POST' && sub === '/cancel') {
      if (finished) return send(res, 409, { error: `run already ${run.status}` });
      const control = active.get(run.id);
      if (control) { control.cancelled = true; if (control.child) control.child.kill('SIGTERM'); }
      else {
        const qi = queue.findIndex(q => q.id === run.id);
        if (qi >= 0) queue.splice(qi, 1);
        run.status = 'cancelled'; run.finished_at = new Date().toISOString(); store.save(run);
      }
      return send(res, 202, { run_id: run.id, status: control ? 'cancelling' : 'cancelled' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (!finished) return send(res, 409, { error: `run is ${run.status}; results are available when it finishes`, status: run.status });

    const bundleDir = store.file(run.id, 'bundle');
    if (sub === '/manifest') return sendFile(res, path.join(bundleDir, 'manifest.json'), 'application/json');
    if (sub === '/bundle.zip') {
      const zip = store.file(run.id, 'bundle.zip');
      if (!fs.existsSync(zip)) buildBundle(store.dir(run.id));
      return sendFile(res, zip, 'application/zip', `trace-bundle-${run.id}.zip`);
    }
    const mm = sub.match(/^\/manual\.(md|html)$/);
    if (mm) {
      const lang = url.searchParams.get('lang') || run.langs[0];
      if (!run.langs.includes(lang)) return send(res, 404, { error: `run has no language ${lang}` });
      return sendFile(res, path.join(bundleDir, 'manual', `${lang}.${mm[1]}`), TYPES[`.${mm[1]}`]);
    }
    const tm = sub.match(/^\/tx\/([A-Za-z][A-Za-z0-9_]*)\/trace\.zip$/);
    if (tm) {
      const lang = url.searchParams.get('lang') || run.langs[0];
      if (!run.langs.includes(lang)) return send(res, 404, { error: `run has no language ${lang}` });
      return sendFile(res, store.file(run.id, 'bundle', lang, tm[1], 'trace.zip'), 'application/zip', `${tm[1]}-${lang}-trace.zip`);
    }
    const fm = sub.match(/^\/files\/(.+)$/);
    if (fm) {
      let file;
      try { file = store.file(run.id, 'bundle', ...decodeURIComponent(fm[1]).split('/')); } catch { return send(res, 400, { error: 'bad path' }); }
      // Only files inside bundle/ — not run.json or anything else in the run directory.
      if (!file.startsWith(bundleDir + path.sep)) return send(res, 400, { error: 'bad path' });
      return sendFile(res, file, TYPES[path.extname(file)] || 'application/octet-stream');
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) log(`error: ${e.stack || e}`);
    });
  });
  return { server, store, retention, active, queue };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.TRACE_API_PORT || 8080), host = process.env.TRACE_API_HOST || '0.0.0.0';
  app.server.listen(port, host, () => console.log(`trace-kit API ${VERSION} listening on ${host}:${port} (max ${process.env.MAX_CONCURRENT_RUNS || 1} concurrent run(s))`));
  app.retention();
  setInterval(() => app.retention(), 3600 * 1000).unref();
  const stop = () => { console.log('shutting down'); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = { createApp, loadTokens };
