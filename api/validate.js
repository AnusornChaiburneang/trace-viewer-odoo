// Validate a POST /runs body. Returns { errors: [...], run } where `run` is the
// normalized request (defaults filled in, secrets split out by the caller).
// Every error names the JSON path so the calling system can point at it.
const COMMANDS = new Set(require('../commands.json').map(c => c.name));
// Managed by the compiler or unsafe for submitted flows.
const RESERVED = new Set(['login', 'lang', 'step', 'done', 'strict', 'eval', 'cookie']);
const ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const LANG = /^[a-z]{2,3}(_[A-Za-z0-9@]+)?$/;
const CAPTURE = /^(field [a-zA-Z_][a-zA-Z0-9_]*|url id|text .+)$/;

const LIMITS = {
  transactions: Number(process.env.MAX_TRANSACTIONS_PER_RUN || 20),
  steps: 60,
  commands: 60,
  langs: 4,
};

function validateRun(body, env = process.env) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: [{ path: '', message: 'body must be a JSON object' }] };

  // --- target -----------------------------------------------------------------
  const t = body.target || {};
  let url = null;
  try {
    url = new URL(t.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch { err('target.url', 'must be an http(s) URL'); }
  const allow = (env.TRACE_TARGET_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (url && allow.length && !allow.includes(url.hostname.toLowerCase()))
    err('target.url', `host ${url.hostname} is not in TRACE_TARGET_ALLOWLIST`);
  if (!t.db || typeof t.db !== 'string') err('target.db', 'required');
  if (t.version != null && !/^\d{2}(\.\d+)?/.test(String(t.version))) err('target.version', 'expected e.g. "17.0"');
  if (!t.login || typeof t.login !== 'string') err('target.login', 'required (the browser logs in with login/password)');
  if (!t.password || typeof t.password !== 'string') err('target.password', 'required');

  // --- languages / options ----------------------------------------------------
  const langs = body.lang == null ? ['en_US'] : (Array.isArray(body.lang) ? body.lang : [body.lang]);
  if (!langs.length || langs.length > LIMITS.langs) err('lang', `1–${LIMITS.langs} languages`);
  langs.forEach((l, i) => { if (!LANG.test(l)) err(`lang[${i}]`, `"${l}" is not a language code like th_TH`); });
  if (new Set(langs).size !== langs.length) err('lang', 'duplicate language');

  const onFailure = body.on_failure == null ? 'stop' : body.on_failure;
  if (!['stop', 'continue'].includes(onFailure)) err('on_failure', 'stop or continue');
  if (body.callback_url != null) {
    try { const c = new URL(body.callback_url); if (!['http:', 'https:'].includes(c.protocol)) throw new Error(); }
    catch { err('callback_url', 'must be an http(s) URL'); }
  }
  const o = body.options || {};
  const options = {
    mode: o.mode == null ? 'human' : o.mode,
    timeout_ms: o.timeout_ms == null ? 8000 : o.timeout_ms,
    transaction_timeout_s: o.transaction_timeout_s == null ? 600 : o.transaction_timeout_s,
  };
  if (!['human', 'quick'].includes(options.mode)) err('options.mode', 'human or quick');
  if (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 1000 || options.timeout_ms > 60000) err('options.timeout_ms', '1000–60000');
  if (!Number.isInteger(options.transaction_timeout_s) || options.transaction_timeout_s < 30 || options.transaction_timeout_s > 3600) err('options.transaction_timeout_s', '30–3600');

  // --- output -----------------------------------------------------------------
  const out = body.output || {};
  let manual = null;
  if (out.manual) {
    const formats = out.manual.formats || ['md', 'html'];
    if (!Array.isArray(formats) || !formats.length || formats.some(f => !['md', 'html'].includes(f))) err('output.manual.formats', 'md and/or html');
    manual = { formats, title: out.manual.title || null };
    if (manual.title != null) checkText(manual.title, 'output.manual.title', langs, err, true);
  }

  // --- transactions -----------------------------------------------------------
  const txs = body.transactions;
  if (!Array.isArray(txs) || !txs.length) err('transactions', 'at least one transaction');
  else if (txs.length > LIMITS.transactions) err('transactions', `at most ${LIMITS.transactions}`);
  const seen = new Set();
  (Array.isArray(txs) ? txs : []).forEach((tx, i) => {
    const p = `transactions[${i}]`;
    if (!tx || typeof tx !== 'object') return err(p, 'must be an object');
    if (!ID.test(tx.id || '')) err(`${p}.id`, 'letters/digits/_ , starting with a letter (e.g. T1)');
    else if (seen.has(tx.id)) err(`${p}.id`, `duplicate id ${tx.id}`);
    checkText(tx.title, `${p}.title`, langs, err, true);
    if (tx.depends_on != null) {
      const deps = Array.isArray(tx.depends_on) ? tx.depends_on : [tx.depends_on];
      deps.forEach(d => { if (!seen.has(d)) err(`${p}.depends_on`, `"${d}" must be an earlier transaction id`); });
    }
    if (!Array.isArray(tx.steps) || !tx.steps.length) err(`${p}.steps`, 'at least one step');
    else if (tx.steps.length > LIMITS.steps) err(`${p}.steps`, `at most ${LIMITS.steps}`);
    (tx.steps || []).forEach((st, j) => {
      const sp = `${p}.steps[${j}]`;
      if (!st || typeof st !== 'object') return err(sp, 'must be an object');
      checkText(st.title, `${sp}.title`, langs, err, true);
      if (st.description != null) checkText(st.description, `${sp}.description`, langs, err, true);
      checkCommands(st.commands, `${sp}.commands`, err, true);
      if (st.expect != null) {
        if (!Array.isArray(st.expect)) err(`${sp}.expect`, 'array of expect arguments, e.g. ["state sale"]');
        else st.expect.forEach((e, k) => { if (typeof e !== 'string' || !e.trim() || /[\r\n]/.test(e) || unbalanced(e)) err(`${sp}.expect[${k}]`, 'one line, balanced quotes'); });
      }
      if (st.highlight != null) {
        if (typeof st.highlight.selector !== 'string' || !st.highlight.selector) err(`${sp}.highlight.selector`, 'required');
        else if (st.highlight.selector.includes("'")) err(`${sp}.highlight.selector`, "use double quotes inside selectors, not '");
        if (st.highlight.caption != null) checkText(st.highlight.caption, `${sp}.highlight.caption`, langs, err, true);
      }
    });
    if (tx.capture != null) {
      if (typeof tx.capture !== 'object' || Array.isArray(tx.capture)) err(`${p}.capture`, 'object { name: "field x" | "url id" | "text <selector>" }');
      else for (const [k, v] of Object.entries(tx.capture)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) err(`${p}.capture.${k}`, 'invalid name');
        if (typeof v !== 'string' || !CAPTURE.test(v)) err(`${p}.capture.${k}`, 'field <name> | url id | text <selector>');
      }
    }
    if (tx.unit != null && !Array.isArray(tx.unit)) err(`${p}.unit`, 'array (RPC data checks arrive in P4)');
    if (tx.id) seen.add(tx.id);
  });

  if (errors.length) return { errors };
  return {
    errors,
    run: {
      target: { url: url.href, db: t.db, version: t.version == null ? null : String(t.version) },
      credentials: { login: t.login, password: t.password, api_key: t.api_key || null },
      langs, on_failure: onFailure, callback_url: body.callback_url || null, options,
      output: { bundle: out.bundle !== false, manual },
      transactions: txs.map(tx => ({
        id: tx.id, title: tx.title,
        depends_on: tx.depends_on == null ? [] : (Array.isArray(tx.depends_on) ? tx.depends_on : [tx.depends_on]),
        steps: tx.steps.map(st => ({ title: st.title, description: st.description ?? null, commands: st.commands,
          expect: st.expect || [], highlight: st.highlight || null })),
        capture: tx.capture || {},
        unit: tx.unit || [],
      })),
    },
  };
}

// A caption is a string (only when one language is requested) or an object
// with an entry for EVERY requested language — captions are never invented.
function checkText(value, path, langs, err, required) {
  if (value == null) { if (required) err(path, 'required'); return; }
  if (typeof value === 'string') {
    if (!value.trim()) err(path, 'must not be empty');
    else if (langs.length > 1) err(path, `give one text per language: {${langs.map(l => `"${l}": "…"`).join(', ')}}`);
    else if (/[\r\n]/.test(value)) err(path, 'one line only');
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return err(path, 'string or {lang: text}');
  for (const l of langs) {
    const v = value[l];
    if (typeof v !== 'string' || !v.trim()) err(`${path}.${l}`, `missing ${l} text (captions_complete)`);
    else if (/[\r\n]/.test(v)) err(`${path}.${l}`, 'one line only');
  }
}

function unbalanced(s) { return (s.match(/'/g) || []).length % 2 === 1; }

function checkCommands(list, path, err, required) {
  if (!Array.isArray(list) || (required && !list.length)) return err(path, 'non-empty array of flow command lines');
  if (list.length > LIMITS.commands) return err(path, `at most ${LIMITS.commands}`);
  list.forEach((line, i) => {
    const p = `${path}[${i}]`;
    if (typeof line !== 'string' || !line.trim()) return err(p, 'must be a non-empty string');
    if (/[\r\n]/.test(line)) return err(p, 'one command per string (no newlines)');
    const cmd = line.trim().split(/\s+/)[0];
    if (cmd.startsWith('#')) return;
    if (!COMMANDS.has(cmd)) return err(p, `unknown command "${cmd}" (flow_syntax)`);
    if (RESERVED.has(cmd)) return err(p, `"${cmd}" is managed by the API and cannot be used in a step`);
    if (unbalanced(line)) err(p, 'unclosed single quote');
  });
}

const textFor = (value, lang) => (value == null ? '' : typeof value === 'string' ? value : value[lang]);

module.exports = { validateRun, textFor, LIMITS };
