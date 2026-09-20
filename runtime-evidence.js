// Link browser requests to their initiating step and the actual server response.
// This observes traffic; it does not instrument Python or infer successful writes.
const fs = require('fs');
const path = require('path');
const { createHmac } = require('crypto');
const STATE = process.env.TRACEKIT_STATE_DIR || path.join(__dirname, '.runtime');
const SECRET = /password|passwd|secret|token|authorization|cookie|api.?key/i;
function sanitize(value, depth = 0) {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 40).map(v => sanitize(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60).map(([k,v]) => [k, SECRET.test(k) ? '[redacted]' : sanitize(v, depth + 1)]));
  return value;
}
function attachRuntimeEvidence(context, report, getStep, targetUrl) {
  const origin = new URL(targetUrl).origin;
  const requests = new Map(), pending = new Set();
  let stopped = false, traceRoute = null;
  report.runtime = { schema_version: 1, source: 'browser_rpc_responses', requests: [], dropped_requests: 0,
    association: 'step active when request started; background traffic may overlap',
    limits: { requests: 500, response_bytes: 1048576 }, instrumentation: false };
  const onRequest = request => {
    try {
      if (requests.has(request)) return;
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'POST') return;
      let body;
      try { body = request.postDataJSON(); } catch { return; }
      if (!body || (body.jsonrpc !== '2.0' && !url.pathname.startsWith('/web/dataset/'))) return;
      if (report.runtime.requests.length >= 500) { report.runtime.dropped_requests++; return; }
      const step = getStep(), params = body.params || {};
      const sensitive = /authenticate|login|password|token/i.test(url.pathname + ' ' + (params.method || ''));
      const entry = { request_id: `${report.run_id}-rpc-${report.runtime.requests.length + 1}`,
        step_id: step?.step_id || null, line: step?.line || null, started_at: new Date().toISOString(),
        endpoint: url.pathname, rpc_id: sanitize(body.id), model: sanitize(params.model), method: sanitize(params.method || body.method),
        params: sensitive ? '[authentication parameters omitted]' : sanitize(params),
        status: 'pending', duration_ms: null, response_source: 'same browser request' };
      if (sensitive) entry.sensitive = true;
      report.runtime.requests.push(entry);
      requests.set(request, { entry, start: Date.now() });
    } catch { /* Non-RPC traffic must not interfere with the browser. */ }
  };
  const onResponse = response => {
    const record = requests.get(response.request());
    if (!record) return;
    const job = (async () => {
      const { entry, start } = record;
      entry.http_status = response.status();
      entry.status = response.ok() ? 'response_unavailable' : 'http_error';
      try {
        const size = Number(response.headers()['content-length'] || 0);
        if (size > 1048576) { entry.capture_note = 'Response exceeds 1 MiB capture limit'; return; }
        const buffer = await response.body();
        if (stopped) return;
        if (buffer.length > 1048576) { entry.capture_note = 'Response exceeds 1 MiB capture limit'; return; }
        let body;
        try { body = JSON.parse(buffer.toString('utf8')); }
        catch { entry.capture_note = 'Response was not JSON'; return; }
        if (body && typeof body === 'object' && body.error) {
          entry.status = 'rpc_error';
          const error = body.error, data = error.data || {};
          entry.error = entry.sensitive ? { message: 'Authentication RPC failed; details omitted' } : {
            name: String(data.name || '').slice(0, 500),
            message: String(data.message || error.message || 'RPC failed').slice(0, 8000),
            code: sanitize(error.code), traceback: String(data.debug || '').slice(0, 24000),
          };
        } else if (body && Object.hasOwn(body, 'result')) {
          if (response.ok()) entry.status = 'ok';
          // Do not retain business data. A return value alone does not prove a commit.
          entry.result_type = Array.isArray(body.result) ? 'array' : body.result === null ? 'null' : typeof body.result;
        } else entry.capture_note = 'No JSON-RPC result or error in response';
      } catch { if (!stopped) entry.capture_note = 'Response body unavailable'; }
      finally {
        if (!stopped) entry.duration_ms = Date.now() - start;
        requests.delete(response.request());
      }
    })();
    pending.add(job); job.finally(() => pending.delete(job));
  };
  const onFailed = request => {
    const record = requests.get(request);
    if (!record) return;
    record.entry.status = 'network_error';
    record.entry.error = { message: request.failure()?.errorText || 'Request failed' };
    record.entry.duration_ms = Date.now() - record.start;
    requests.delete(request);
  };
  context.on('request', onRequest); context.on('response', onResponse); context.on('requestfailed', onFailed);
  return {
    async enablePythonTrace() {
      let key;
      try { key = fs.readFileSync(path.join(STATE, 'key')); }
      catch { throw new Error('Python tracing is not enabled. Run server-trace.py enable --config /path/to/odoo.conf, then restart Odoo through the dashboard CLI.'); }
      if (key.length !== 32) throw new Error('Invalid runtime observer key; run server-trace.py enable');
      report.runtime.instrumentation = true;
      report.runtime.python_trace = { status: 'requested', matched_requests: 0 };
      traceRoute = async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'POST') return route.continue();
        onRequest(request);
        const entry = requests.get(request)?.entry;
        if (!entry?.step_id || entry.sensitive) return route.continue();
        const signature = createHmac('sha256', key).update([report.run_id, entry.request_id, entry.step_id].join('\n')).digest('hex');
        entry.python_trace = { status: 'requested' };
        await route.continue({ headers: { ...request.headers(),
          'x-tracekit-run': report.run_id, 'x-tracekit-request': entry.request_id,
          'x-tracekit-step': entry.step_id, 'x-tracekit-signature': signature } });
      };
      await context.route('**/web/dataset/**', traceRoute);
    },
    async finish() {
      if (stopped) return;
      // Bounded drain includes requests whose responses have not started yet.
      const deadline = Date.now() + 2000;
      while ((requests.size || pending.size) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      stopped = true;
      context.off('request', onRequest); context.off('response', onResponse); context.off('requestfailed', onFailed);
      for (const {entry,start} of requests.values()) {
        if (entry.status === 'pending' || entry.status === 'response_unavailable') entry.status = 'incomplete';
        entry.duration_ms = Date.now() - start;
        entry.capture_note = 'Run ended before response capture completed';
      }
      requests.clear();
      if (traceRoute) {
        await context.unroute('**/web/dataset/**', traceRoute);
        let embeddedBytes = 0;
        for (const entry of report.runtime.requests.filter(r => r.python_trace)) {
          try {
            const filename = path.join(STATE, 'traces', report.run_id, entry.request_id + '.json');
            const bytes = fs.statSync(filename).size;
            if (bytes > 4 * 1024 * 1024) throw new Error('Server trace exceeds 4 MiB');
            if (embeddedBytes + bytes > 8 * 1024 * 1024) throw new Error('Run Python evidence exceeds 8 MiB; original remains in the server trace directory');
            const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (data.run_id !== report.run_id || data.request_id !== entry.request_id || data.step_id !== entry.step_id || !Array.isArray(data.calls)) throw new Error('Server trace correlation mismatch');
            embeddedBytes += bytes;
            entry.python_trace = data;
            report.runtime.python_trace.matched_requests++;
          } catch (error) {
            entry.python_trace = { status: 'unavailable', note: error.code === 'ENOENT' ? 'No server trace found. Check that the observer is loaded in this Odoo process and shares this trace directory.' : error.message };
          }
        }
        report.runtime.python_trace.status = report.runtime.python_trace.matched_requests ? 'received' : 'unavailable';
      }
    },
  };
}
module.exports = { attachRuntimeEvidence, sanitize };
