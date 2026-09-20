// Resolved settings for a run. Everything here has a working default, so the
// kit runs with zero setup after `npm install` — no dashboard, no task tracker,
// no fixed directory layout.
//
// Precedence (later wins):
//   built-in defaults  ->  trace.config.json  ->  environment  ->  CLI flags
//
// trace.config.json is OPTIONAL and gitignored: it is where one machine records
// its own paths and conventions (an output directory outside the repo, a
// stricter ticket format, a dashboard URL) without any of that leaking into the
// published tool. Copy trace.config.example.json to start one.
const fs = require('fs');
const path = require('path');

const KIT_DIR = __dirname;
const CONFIG_FILE = process.env.TRACE_CONFIG || path.join(KIT_DIR, 'trace.config.json');

const DEFAULTS = {
  // Where .zip/.log artifacts are written. Relative paths resolve against the kit.
  outputDir: 'traces',
  // Used when no target URL is given on the command line.
  defaultUrl: 'http://localhost:8069/web/login',
  // Accepted --task values. Deliberately permissive: any ticket scheme works
  // (ABC-123, 4815, sprint7). Teams that want their own convention enforced set
  // a stricter pattern here, e.g. "^T\\d{2}-\\d{5}$".
  taskPattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  // Put the task number in the artifact filename. Off by default so filenames
  // stay predictable for people with no ticket tracker.
  taskInFilename: false,
  // Only contacted to look up a task from a --session-id. null = never.
  dashboardUrl: null,
};

function readConfigFile(file = CONFIG_FILE) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // A broken config must not silently fall back to different behaviour.
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

function loadConfig(env = process.env, file = CONFIG_FILE) {
  const fromFile = readConfigFile(file);
  const cfg = { ...DEFAULTS, ...fromFile };

  // Environment overrides. TRACE_LOCAL is kept for backwards compatibility with
  // the original launcher, which put the task in the filename.
  if (env.TRACE_OUT_DIR) cfg.outputDir = env.TRACE_OUT_DIR;
  if (env.TRACE_DEFAULT_URL) cfg.defaultUrl = env.TRACE_DEFAULT_URL;
  if (env.TRACE_TASK_PATTERN) cfg.taskPattern = env.TRACE_TASK_PATTERN;
  if (env.ODOO_DASHBOARD_URL) cfg.dashboardUrl = env.ODOO_DASHBOARD_URL;
  if (env.TRACE_LOCAL === '1') cfg.taskInFilename = true;

  cfg.outputDir = path.isAbsolute(cfg.outputDir)
    ? cfg.outputDir : path.join(KIT_DIR, cfg.outputDir);

  try {
    cfg.taskRegExp = new RegExp(cfg.taskPattern);
  } catch (e) {
    throw new Error(`taskPattern is not a valid regular expression: ${cfg.taskPattern}`);
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, CONFIG_FILE, KIT_DIR };
