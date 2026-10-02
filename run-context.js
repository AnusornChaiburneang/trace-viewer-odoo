// Shared startup context for both trace launchers. No "latest session" guessing.
const { execFileSync } = require('child_process');
const { loadConfig } = require('./config');

function parseOptions(argv, env = process.env, cfg = loadConfig(env)) {
  const opts = { task: env.ODOO_TASK || '', sessionId: env.ODOO_SESSION_ID || '', db: env.ODOO_DB || '' };
  opts.config = cfg;
  // Flow variables, substituted into {{name}} placeholders. Secrets (passwords,
  // API keys) belong in TRACE_VAR_<NAME> environment variables, not --var:
  // command-line arguments are visible to every user via `ps`.
  opts.vars = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('TRACE_VAR_') && k.length > 10) opts.vars[k.slice(10)] = v;
  }
  const positionals = [];
  const keys = { '--task': 'task', '--session-id': 'sessionId', '--db': 'db', '--flow': 'flowFile' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--python-trace') { opts.pythonTrace = true; }
    else if (arg === '--var') {
      const pair = argv[i + 1];
      const m = pair && pair.match(/^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/s);
      if (!m) throw new Error('--var needs NAME=VALUE (NAME: letters, digits, _ and .)');
      opts.vars[m[1]] = m[2];
      i++;
    }
    else if (keys[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[keys[arg]] = argv[++i];
    } else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  if (!positionals.length || positionals.length > 2) {
    // Name the script actually invoked — saying "trace-local.sh" to someone
    // running ./trace.sh sends them looking for a file they may not have.
    const via = (process.argv[1] || '').split(/[\\/]/).pop() || 'trace.sh';
    throw new Error(`Usage: ${via} <name> [url] [--task TICKET] [--session-id SID] [--db DB] [--flow path.txt] [--var NAME=VALUE]... [--python-trace]`);
  }
  opts.name = positionals[0];
  if (/[\/\\]/.test(opts.name) || opts.name === '.' || opts.name === '..') throw new Error('Trace name cannot contain path separators');
  // The accepted ticket format is configurable (config.taskPattern) so this
  // works with any tracker, or none at all. A task is always optional.
  if (opts.task && !cfg.taskRegExp.test(opts.task)) {
    throw new Error(`Task ${JSON.stringify(opts.task)} does not match the configured task format ${cfg.taskPattern} (set taskPattern in trace.config.json to change it)`);
  }
  const url = new URL(positionals[1] || cfg.defaultUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Target must be an HTTP(S) URL');
  const urlDb = url.searchParams.get('db');
  if (opts.db && urlDb && opts.db !== urlDb) throw new Error('--db conflicts with the target URL database');
  opts.db = opts.db || urlDb || '';
  if (opts.db) url.searchParams.set('db', opts.db);
  opts.targetUrl = url.href;
  return opts;
}

async function resolveContext(opts, dashboard = (opts.config && opts.config.dashboardUrl) || process.env.ODOO_DASHBOARD_URL || null) {
  // No dashboard configured is the normal case for a standalone checkout: skip
  // the lookup entirely rather than timing out against a URL nobody is serving.
  if (!opts.task && opts.sessionId && dashboard) {
    // Exact lookup also works for sessions not discovered from Claude log files.
    try {
      const r = await fetch(`${dashboard}/api/sessions/${encodeURIComponent(opts.sessionId)}/context`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const context = await r.json();
      if (context.session_id !== opts.sessionId) throw new Error('session ID mismatch');
      if (context.task_number && !/^T\d{2}-\d{5}$/.test(context.task_number)) throw new Error('invalid task number');
      opts.task = context.task_number || '';
    } catch (e) {
      console.error(`Context: task lookup unavailable (${e.message}); task remains unassigned. Use --task to assign it.`);
    }
  }
  return opts;
}

function sourceRevision(cwd) {
  try {
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return { directory: cwd, revision: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain', '--untracked-files=no')) };
  } catch { return { directory: cwd, revision: null, dirty: null }; }
}
module.exports = { parseOptions, resolveContext, sourceRevision };
