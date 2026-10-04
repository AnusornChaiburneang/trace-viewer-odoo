#!/usr/bin/env node
// pw_trace.js — Interactive Playwright trace REPL for Odoo visual testing
//
// Usage:
//   node pw_trace.js <name> [target_url]
//   node pw_trace.js demo http://localhost:8069/web/login
//   node pw_trace.js so-flow http://192.168.1.10:8069/web/login
//
// Then type commands line-by-line (or pipe a command file):
//   node pw_trace.js so-flow http://localhost:8069/web/login < flows/so-invoice-payment.txt
//
// Trace saved to ./traces/<name> <timestamp> <run-id>.zip
// View:  npx playwright show-trace "<printed-trace-path>"
//        or drag-drop to https://trace.playwright.dev

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const { parseOptions, resolveContext, sourceRevision } = require('./run-context');
const { createFieldTools } = require('./field-tools');
const { createCapture } = require('./run-capture');
const { randomUUID } = require('crypto');
const { attachRuntimeEvidence } = require('./runtime-evidence');
let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (e) { console.error(e.message); process.exit(2); }

(async () => {
await resolveContext(options);
const targetUrl = options.targetUrl;
const runId = randomUUID();
const startedAt = new Date().toISOString();
const cfg = options.config;
const label = [cfg.taskInFilename ? options.task : '', options.name,
  startedAt.replace(/[:.]/g, '-'), runId].filter(Boolean).join(' ');
const capture = createCapture(options.flowFile);
const tracesDir = cfg.outputDir;
if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });

const traceFile = path.join(tracesDir, `${label}.zip`);
const logFile = path.join(tracesDir, `${label}.log`);

// Tee every console line to a per-run log file, flushed SYNCHRONOUSLY, so a run
// killed by SIGTERM/timeout still shows the last command it reached (stdout may
// be block-buffered and lost on kill; the log file is durable).
// Flow variables ({{name}}): --var / TRACE_VAR_* plus values recorded by
// `capture` during this run. Values of secret-looking names are masked in
// every console/log line, so `fill #password {{PASSWORD}}` can never leak.
const vars = { ...options.vars };
const captured = {};
const SECRET_NAME = /pass|secret|token|key|pwd/i;
const secretValues = Object.entries(vars)
  .filter(([k, v]) => SECRET_NAME.test(k) && String(v).length >= 3).map(([, v]) => String(v));
const maskSecrets = (s) => secretValues.reduce((out, v) => out.split(v).join('[redacted]'), s);
const substituteVars = (text) => text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g, (m, name) => {
  if (Object.prototype.hasOwnProperty.call(captured, name)) return String(captured[name]);
  if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
  throw new Error(`unknown variable {{${name}}} — pass it with --var ${name}=... or TRACE_VAR_${name}, or capture it earlier in the flow`);
});

// API mode (set by the API server): only the target's origin (plus
// TRACE_ALLOWED_HOSTS) may be navigated to, `eval` is disabled, and every
// screenshot is kept because it is part of the deliverable.
const apiMode = /^(1|true|on|yes)$/i.test(process.env.TRACE_API_MODE || '');
const allowedHosts = new Set([new URL(options.targetUrl).hostname,
  ...(process.env.TRACE_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const hostAllowed = (url) => { try { return allowedHosts.has(new URL(url).hostname.toLowerCase()); } catch { return false; } };

try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
const _appendLog = (s) => { try { fs.appendFileSync(logFile, s + '\n'); } catch { /* ignore */ } };
{
  const _stdout = console.log.bind(console);
  const _stderr = console.error.bind(console);
  const fmt = (a) => maskSecrets(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = (...a) => { const s = fmt(a); _appendLog(s); _stdout(s); };
  console.error = (...a) => { const s = fmt(a); _appendLog(s); _stderr(s); };
}

const resultFile = path.join(tracesDir, `${label}.result.json`);
const report = {
  schema_version: 3, run_id: runId, flow_name: options.name, status: 'running', started_at: startedAt,
  context: { task: options.task || null, session_id: options.sessionId || null,
    target_url: targetUrl, requested_db: options.db || null, verified_session: null,
    source: sourceRevision(process.cwd()), toolkit: sourceRevision(__dirname) },
  steps: [], trace_file: traceFile, log_file: logFile,
  // `step` blocks: one manual section each, with a viewport screenshot.
  manual: { viewport: { width: 1440, height: 900 }, shots_dir: null, steps: [] },
  // Values recorded by `capture`, for later transactions ({{name}}).
  captured,
  // Variable NAMES only; values may be secrets.
  variables: Object.keys(vars).sort(),
  api_mode: apiMode,
};
const saveReport = () => {
  report.flow = capture.snapshot();
  report.updated_at = new Date().toISOString();
  fs.writeFileSync(resultFile + '.tmp', JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(resultFile + '.tmp', resultFile);
};
saveReport();
const heartbeat = setInterval(saveReport, 15000);
heartbeat.unref();
let browser, context, tracing = false, runtimeEvidence, activeStep = null;
try {
  // Fail-fast: per-command action timeout (bad selectors fail in seconds, not
  // Playwright's silent 30s default). Override with CMD_TIMEOUT env or the
  // `timeout <ms>` directive. `strict` (STRICT env / `strict on`) aborts the
  // flow on the first error/timeout instead of continuing.
  let actionTimeout = parseInt(process.env.CMD_TIMEOUT || '8000', 10);
  if (!(actionTimeout > 0)) actionTimeout = 8000;
  let strict = /^(1|true|on|yes)$/i.test(process.env.STRICT || '');
  let aborted = false;

  // Screenshots taken this run — deleted on exit (they're captured in the
  // trace too), so one flow leaves just one .zip + .log. Set KEEP_SHOTS=1 to keep.
  const shots = [];
  const keepShots = apiMode || /^(1|true|on|yes)$/i.test(process.env.KEEP_SHOTS || '');

  // Warn when a selector-taking command (fill/date/mark/m2o) got an UNQUOTED
  // selector that the tokenizer likely split — the classic silent failure
  // (`fill .o_field[name="x"] input V` → selector=".o_field[name=\"x\"]",
  // value="input V"). Selectors with spaces must be wrapped in 'single quotes'.
  // NB: 'a' and 'i' are deliberately NOT here — they are ordinary words ("A
  // company"), and including them made this fire on real values.
  const SEL_TAG_RE = /^(input|button|span|div|textarea|select|td|tr|th|label|ul|li|table|form|section|nav|option)$/i;
  // `fatal` for the value-writing commands (fill/date/m2o): a truncated selector
  // there writes into the WRONG element and still logs success, which cascades
  // silently through every later step (see
  // issues/2026-09-09-product-name-field-is-textarea-not-input.txt). `mark` only
  // draws an annotation, so it stays a warning.
  //
  // The "looks like a selector fragment" test is deliberately narrow. It used to
  // count any token containing '.' '#' or '>', which fired on ~112 perfectly good
  // lines across flows/ — `fill input#password <pw-with-a-dot>` (a dot in a password)
  // and `<CUSTOMER_NAME>` placeholders. A warning that cries wolf is one people
  // learn to scroll past, which is exactly what happened.
  const warnIfTruncated = (parts, quoted, cmdName) => {
    if (quoted[1]) return;                         // selector was quoted → safe
    const sel = parts[1] || '', next = parts[2];
    if (next === undefined) return;                // nothing trailing to fold in
    const selIsCss = /[.#\[\]>]/.test(sel);
    const nextIsFrag = SEL_TAG_RE.test(next) || /^[.#[]/.test(next) || /[\[\]]/.test(next);
    if (!(selIsCss && nextIsFrag)) return;
    const msg = `selector "${sel}" looks unquoted and was truncated at "${next}" — `
      + `wrap selectors containing spaces in 'single quotes', e.g. ${cmdName || 'fill'} '${sel} ${next}' <value>`;
    if (cmdName === 'fill' || cmdName === 'date' || cmdName === 'm2o') {
      throw new Error(msg + ' (refusing to write into whatever that truncated selector matched)');
    }
    console.log(`  WARNING: ${msg}`);
  };

  // Opposite mistake: click/fclick/jclick/waitfor/bbox/find/evals take the
  // WHOLE REST OF THE LINE as the selector, unquoted, by design (so a raw CSS
  // selector with quotes inside it, e.g. [name="x"], survives intact). Wrapping
  // one of these in 'single quotes' the same way fill/m2o/date need for
  // selectors with spaces makes the outer quotes literal characters in the
  // selector, which then silently matches nothing ("-1 elements", no hint why).
  // See issues/2026-08-06-quoted-click-selector.txt.
  // A quoted selector here can never match anything — the quotes become literal
  // characters in the CSS — so this is a hard error, not advice. It used to be a
  // warning printed just above the TIMEOUT it caused, which read as two
  // unrelated messages (see issues/2026-09-09-fresh-rma-flow-build-gotchas.txt).
  const warnIfWrapped = (cmdName, sel) => {
    if (sel.length >= 2 && sel[0] === "'" && sel[sel.length - 1] === "'") {
      throw new Error(
        `"${cmdName}" takes the whole rest of the line unquoted, so the outer quotes around ${sel} `
        + `are literal characters in the selector and can never match. Remove them — quotes are only `
        + `needed for fill/date/m2o/mark, whose selector is one token.`);
    }
  };

  // Does an observed /web/ request plausibly belong to the button we just
  // clicked? Used by `clickrpc`. Deliberately CONSERVATIVE: a false failure is
  // loud and easy to check, a false success is the exact bug clickrpc exists to
  // catch. Two real false positives drove this (see
  // issues/2026-08-21-clickrpc-accepts-unrelated-call_kw.txt):
  //   * call_kw/access.management/get_remove_options — unrelated background JS
  //     from another module that merely landed inside the wait window.
  //   * call_kw/stock.picking/web_save — the framework's pre-button save, which
  //     happens whether or not the button's own method then runs.
  const FRAMEWORK_METHODS = /^(web_save|web_read|web_search_read|read|search_read|search_count|onchange|name_search|name_get|name_create|read_group|web_read_group|has_group|load_views|get_views|fields_get|default_get|check_access_rights|systray_get_activities)$/;
  const HELPER_MODELS = /^(access\.management|ks_|mail\.|bus\.|ir\.|res\.users$|res\.lang|res\.config)/;
  const rpcQualifies = (pathname, buttonName) => {
    // A type="object"/type="action" button always goes through call_button.
    if (/\/web\/dataset\/call_button/.test(pathname)) return true;
    const m = pathname.match(/\/web\/dataset\/call_kw\/([^/]+)\/([^/]+)/);
    if (!m) return false;
    const model = m[1], method = m[2];
    if (buttonName && method === buttonName) return true;   // strongest signal
    if (FRAMEWORK_METHODS.test(method)) return false;       // form noise, not the action
    if (HELPER_MODELS.test(model)) return false;            // another module's background chatter
    return true;
  };

  // Shared button matcher for `clickbtn` and `clickrpc`: find an action control
  // by the label you SEE (exact → contains), falling back to title/aria-label
  // (icon buttons) and the internal name.
  //
  // NB: do NOT treat a leftover raw `invisible=`/`readonly=` attribute on the
  // rendered button as a fault signal. Verified against Odoo 17 source: the
  // compiler READS the modifier (view_compiler.js getModifier = getAttribute,
  // no removal) and compileButton then passes every remaining attribute through
  // in `attrs`, which views.ViewButton spreads onto the DOM via t-att. So a
  // healthy button with invisible="state != 'x'" in its arch always renders
  // with that attribute still present. It carries no diagnostic meaning.
  // Use `clickrpc` (does an RPC actually fire?) to detect a dead button.
  function clickButtonByLabel(w) {
    // Buttons + only-OPEN dropdown/cog-menu items. NOT every .dropdown-item in
    // the DOM (the apps-menu portal is always present and would flood the
    // candidates), and never the apps grid itself (that's navmenu's job).
    const els = Array.from(document.querySelectorAll(
      'button, a[role="button"], .btn, .o_statusbar_buttons button, ' +
      '.dropdown-menu.show .dropdown-item, .o-dropdown--menu.d-block .dropdown-item'))
      .filter(e => e.offsetParent !== null && !e.disabled && e.getAttribute('aria-disabled') !== 'true'
        && !e.closest('.o_menu_apps, .o_grid_apps_menu, .o-app-menu'));
    const label = e => (e.textContent || '').trim().replace(/\s+/g, ' ');
    const txt = e => label(e).toLowerCase();
    const alt = e => ((e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
    const nm = e => (e.getAttribute('name') || '').toLowerCase();
    let el = null;
    if (w) {
      el = els.find(e => txt(e) === w) ||               // exact label
        els.find(e => nm(e) === w) ||                   // exact internal name
        els.find(e => txt(e).includes(w) && txt(e)) ||  // label contains
        els.find(e => alt(e).includes(w) && alt(e)) ||  // title/aria contains (icon buttons)
        els.find(e => nm(e).includes(w) && nm(e));      // name contains
    }
    if (!el) {
      const labels = [...new Set(els.map(e => label(e) || `[icon] ${alt(e)}` || `[name] ${nm(e)}`).filter(Boolean))].slice(0, 20);
      return { ok: false, labels };
    }
    el.click();
    return { ok: true, text: label(el).slice(0, 40), name: el.getAttribute('name') || '' };
  }

  // Shared dropdown-item matcher for `pick` and `m2o`: works for OWL
  // (.o-autocomplete--dropdown-item) and v14 jQuery-UI (.ui-menu-item). Skips
  // "Create"/"Create and Edit"/"Search More" so a blank/ambiguous search never
  // lands on a create option (a v14 trap). Exact text match first, then
  // contains, case-insensitive; only clicks a REAL match — never blind-clicks
  // whatever happens to be first (see
  // issues/2026-08-06-m2o-blind-click-and-escape-closes-modal.txt).
  //
  // Odoo renders a "Loading..." placeholder that matches the SAME item selector
  // before the name_search RPC results replace it, so the dropdown existing does
  // not mean the options exist. Placeholders are never selectable, and when they
  // are all that is present this reports {loading:true} so the caller can wait
  // instead of failing (see issues/2026-09-04-autocomplete-loading-placeholder.txt).
  function pickFromDropdown(w) {
    const norm = e => (e.textContent || '').replace(/\s+/g, ' ').trim();
    const isCreate = t => /^(create\b|create and edit|search more|start typing)/i.test(t);
    const isLoading = t => /^(loading|searching)[.\u2026\s]*$/i.test(t);
    const items = Array.from(document.querySelectorAll(
      '.o-autocomplete--dropdown-item, ul.ui-autocomplete li.ui-menu-item, .ui-menu-item a'))
      .filter(e => e.offsetParent !== null);
    const settled = items.filter(e => !isLoading(norm(e)));
    if (!settled.length) {
      // Either a placeholder is showing, or nothing has rendered yet. Both mean
      // "not ready" — the caller should wait rather than fail. `empty` only
      // affects the wording of the eventual give-up message.
      return { ok: false, loading: true, empty: items.length === 0,
               candidates: items.map(norm).filter(Boolean).slice(0, 12) };
    }
    const real = settled.filter(e => !isCreate(norm(e)));
    const pool = real.length ? real : settled;
    let el = w ? pool.find(e => norm(e).toLowerCase() === w) : null;
    if (!el && w) el = pool.find(e => norm(e).toLowerCase().includes(w));
    if (!el && !w) el = pool[0];
    if (!el) return { ok: false, candidates: settled.map(norm).filter(Boolean).slice(0, 12) };
    el.click();
    return { ok: true, text: norm(el).slice(0, 50) };
  }

  // Call pickFromDropdown, waiting out any "Loading..." placeholder. Replaces
  // the `wait 1000` that flows were adding by hand after `waitfor`.
  const pickWhenSettled = async (wanted) => {
    const deadline = Date.now() + actionTimeout;
    let res = await page.evaluate(pickFromDropdown, wanted);
    while (res.loading && Date.now() < deadline) {
      await page.waitForTimeout(120);
      res = await page.evaluate(pickFromDropdown, wanted);
    }
    return res;
  };

  console.log(`\nStarting trace: ${label}`);
  console.log(`Log:     ${logFile}`);
  console.log(`Target:  ${targetUrl}`);
  console.log(`Context: task=${options.task || "(unassigned)"}, session=${options.sessionId || "(unassigned)"}, db=${options.db || "(unpinned)"}`);
  console.log(`Output:  ${traceFile}`);
  console.log(`Timeout: ${actionTimeout}ms/action, strict=${strict}`);

  browser = await chromium.launch({ headless: true });

  // Reuse the login session between runs (cookies persisted per host+port+db)
  // so flows don't have to log in every single time
  const sessionsDir = process.env.TRACE_SESSION_DIR || path.join(__dirname, '.sessions');
  let sessionFile = null;
  try {
    const u = new URL(targetUrl);
    const db = u.searchParams.get('db') || 'default';
    sessionFile = path.join(sessionsDir, `${u.protocol.slice(0, -1)}_${u.hostname}_${u.port || (u.protocol === 'https:' ? '443' : '80')}_${encodeURIComponent(db)}.json`);
  } catch { /* non-URL target — skip session reuse */ }

  const contextOpts = { viewport: { width: 1440, height: 900 } };
  if (sessionFile && fs.existsSync(sessionFile)) {
    contextOpts.storageState = sessionFile;
    console.log(`Session: reusing saved login (${path.basename(sessionFile)})`);
  }
  context = await browser.newContext(contextOpts);

  // API mode: a submitted flow must not be able to point the server's browser
  // at internal hosts (SSRF). Block top-level/frame document loads to any host
  // that is not the target or listed in TRACE_ALLOWED_HOSTS. Sub-resources
  // (fonts, images) are left alone so Odoo pages still render.
  if (apiMode) {
    await context.route('**/*', (route) => {
      const req = route.request();
      if (req.resourceType() === 'document' && !hostAllowed(req.url())) {
        console.error(`  BLOCKED navigation to ${new URL(req.url()).host} (API mode allows: ${[...allowedHosts].join(', ')})`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
  }

  // Track in-flight RPCs (excluding the bus/longpolling connections that never close)
  // so `waitidle` can detect real idle instead of relying on networkidle
  await context.addInitScript(() => {
    window.__odooPending = 0;
    const skip = (u) => {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      return url.includes('/longpolling/') || url.includes('/websocket') || url.includes('/bus/');
    };
    const origFetch = window.fetch;
    window.fetch = function (...a) {
      if (skip(a[0])) return origFetch.apply(this, a);
      window.__odooPending++;
      return origFetch.apply(this, a).finally(() => window.__odooPending--);
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      this.__skipCount = skip(u);
      return origOpen.call(this, m, u, ...r);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...a) {
      if (!this.__skipCount) {
        window.__odooPending++;
        this.addEventListener('loadend', () => window.__odooPending--, { once: true });
      }
      return origSend.apply(this, a);
    };
  });

  // Kill CSS animations/transitions during recording. Odoo's app-menu and
  // dropdown overlays fade/scale in; if a trace snapshot lands mid-transition
  // the previous view bleeds through (the trace viewer freezes transitions and
  // doesn't composite backdrop-filter), which reads as "flickering/overlapping"
  // in the viewer. With transitions off, overlays snap to their final opaque
  // state, so snapshots are clean. Also neutralize backdrop blur for the same
  // reason. Purely cosmetic for the recording — does not change click behavior.
  await context.addInitScript(() => {
    const apply = () => {
      if (document.getElementById('__pw_no_anim')) return;
      const s = document.createElement('style');
      s.id = '__pw_no_anim';
      s.textContent =
        '*,*::before,*::after{transition:none!important;animation:none!important;' +
        'animation-duration:0s!important;transition-duration:0s!important}' +
        '.o-dropdown--menu,.o_app_menu,.dropdown-menu{backdrop-filter:none!important}';
      (document.head || document.documentElement).appendChild(s);
    };
    apply();
    // head may not exist at document_start — re-apply once the DOM is ready
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  });

  await context.tracing.start({ screenshots: true, snapshots: true });
  tracing = true;
  runtimeEvidence = attachRuntimeEvidence(context, report, () => activeStep, targetUrl);
  if (options.pythonTrace) await runtimeEvidence.enablePythonTrace();
  const page = await context.newPage();
  // Fail-fast default for all Playwright waits (click/fill/waitForSelector/…);
  // waitidle/login keep their own longer internal deadlines.
  page.setDefaultTimeout(actionTimeout);

  // Track in-flight document navigations (form POSTs, redirects) — these are NOT
  // XHR/fetch so the in-page counter can't see them, and waitidle would pass early
  let pendingNav = 0;
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pendingNav++;
  });
  const navDone = (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pendingNav = Math.max(0, pendingNav - 1);
  };
  page.on('requestfinished', navDone);
  page.on('requestfailed', navDone);

  await page.goto(targetUrl, { timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  console.log(`\nLoaded: ${await page.title()}`);
  console.log(`URL:    ${page.url()}`);

  // The command list helps someone typing at a terminal; in a file/piped/API
  // run it is just 50 lines of noise in every log.
  if (capture.snapshot().capture === 'interactive') {
    console.log('\n--- Commands ---');
    for (const command of require('./commands.json')) {
      console.log(`  ${command.usage.padEnd(42)} ${command.description}`);
    }
  }


  // Shared idle-wait: no pending document navigation (Node-side counter),
  // no pending RPCs (in-page fetch/XHR counter, bus/longpolling excluded),
  // no visible loading overlay, document complete — and stable 250ms later
  const waitIdle = async (maxMs = 15000) => {
    const t0 = Date.now();
    const deadline = t0 + maxMs;
    // Lead-in: give the previous action time to start its request/navigation
    await page.waitForTimeout(400);
    const checkIdle = () => page.evaluate(() => {
      const pending = window.__odooPending || 0;
      // Overlays only count if visible AND actually occupying space — Odoo
      // keeps a permanent hidden <div class="o_loading"> in the DOM and
      // toggles display, and (Odoo 19+) a permanent zero-height empty
      // <div class="o_blockUI"></div> that stays in the layout (has an
      // offsetParent) but never obstructs anything.
      const overlays = document.querySelectorAll('.o_loading_indicator, .o_loading, .o_blockUI');
      const visible = Array.from(overlays).some(el => {
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return pending === 0 && !visible && document.readyState === 'complete';
    }).catch(() => false); // evaluate throws mid-navigation → not idle
    while (Date.now() < deadline) {
      if (pendingNav > 0) {
        await page.waitForLoadState('load', { timeout: deadline - Date.now() }).catch(() => {});
        await page.waitForTimeout(100);
        continue;
      }
      if (await checkIdle()) {
        await page.waitForTimeout(250);
        if (pendingNav === 0 && await checkIdle()) break;
      } else {
        await page.waitForTimeout(150);
      }
    }
    if (pendingNav !== 0 || !(await checkIdle())) throw new Error(`waitidle timed out after ${maxMs}ms`);
    return Date.now() - t0;
  };

  const fieldTools = createFieldTools(page, waitIdle, () => actionTimeout);

  // Navigation mode: 'human' clicks through the menu; 'quick' short-circuits
  // navmenu to goto #action=<id> when the flow supplies one (`... @<id>`).
  // Set per-flow with the `mode` directive, or via NAV_MODE env var.
  let navMode = (process.env.NAV_MODE || 'human').toLowerCase();
  if (navMode !== 'human' && navMode !== 'quick') navMode = 'human';

  // Red-pointer helpers (shared with the `mark` command's drawing style):
  // inject a real box + caption that survives into the trace viewer, and
  // clear them. Used by navmenu's human mode to explain each menu step.
  const clearMarks = () => page.evaluate(() => {
    document.querySelectorAll('[data-pw-mark]').forEach(e => e.remove());
  }).catch(() => {});
  const drawMarkRect = (rect, caption) => page.evaluate(({ rect, caption }) => {
    if (!rect || !rect.width) return;
    const box = document.createElement('div');
    box.setAttribute('data-pw-mark', '1');
    box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
      `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
      `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
    document.body.appendChild(box);
    if (caption) {
      const maxW = Math.min(320, window.innerWidth - 24);
      const left = Math.min(Math.max(rect.x, 8), window.innerWidth - maxW - 8);
      const label = document.createElement('div');
      label.setAttribute('data-pw-mark', '1');
      label.textContent = caption;
      // caption below the box if there's no room above (e.g. top navbar)
      const below = rect.y < 40;
      label.style.cssText = `position:fixed;left:${left}px;` +
        `top:${below ? rect.y + rect.height + 6 : Math.max(rect.y - 48, 4)}px;` +
        `max-width:${maxW}px;background:#dc1e1e;color:#fff;font:bold 13px sans-serif;` +
        `line-height:1.3;padding:4px 9px;border-radius:4px;z-index:2147483647;` +
        `pointer-events:none;white-space:normal;`;
      document.body.appendChild(label);
    }
  }, { rect, caption }).catch(() => {});

  // In-page resolver for one menu level. Matches on RENDERED visible text
  // (exact-then-contains, case-insensitive) so translated labels (e.g. Thai)
  // work — the flow author writes whatever appears on screen. It does NOT
  // click: it TAGS the target with data-nav-target and returns its bounding
  // box, so the caller can draw the red pointer first, then click. Selectors
  // are UNIONS across Odoo 14/16/17 so one flow runs unchanged on any of them:
  //   app      → v14 .o_menu_apps a.o_app  |  v16/17 a.o-app-menu-item
  //   section  → v14 .o_menu_sections > li > a  |  v16/17 .o_menu_sections > .o-dropdown > button.dropdown-toggle
  //   dropdown → v14 .dropdown-menu.show inline  |  v16/17 body portal .o-dropdown--menu.d-block
  //   items    → .dropdown-header (group, not clickable) + a.dropdown-item / .dropdown-item (leaf)
  const navLocate = (spec) => page.evaluate((spec) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const w = norm(spec.label);
    const listText = els => els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const rectOf = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const tag = el => {
      document.querySelectorAll('[data-nav-target]').forEach(e => e.removeAttribute('data-nav-target'));
      el.setAttribute('data-nav-target', '1');
    };

    if (spec.level === 'app') {
      // Odoo 14: .o_menu_apps a.o_app  |  Odoo 16/17: a.o-app-menu-item carries the
      // app label (its child div.o_app is icon-only, so match the anchor).
      const items = Array.from(document.querySelectorAll('.o_menu_apps a.o_app, a.o-app-menu-item, a.o_app'));
      const el = items.find(e => norm(e.textContent) === w) || items.find(e => norm(e.textContent).includes(w));
      if (!el) return { ok: false, candidates: listText(items) };
      tag(el);
      return { ok: true, text: el.textContent.trim(), kind: 'item', leaf: true, rect: rectOf(el) };
    }

    if (spec.level === 'section') {
      // Odoo 14: sections are <li><a> ; Odoo 16/17: <div.o-dropdown><button.dropdown-toggle>
      // Odoo 19: .o_menu_sections' direct children ARE the <a>/<button> themselves
      // (no <li>/.o-dropdown wrapper), e.g. <a class="o-navigable">Dashboard</a> or
      // <button class="dropdown-toggle"><span data-section="...">Configuration</span></button>
      const secs = Array.from(document.querySelectorAll('.o_menu_sections > li, .o_menu_sections > .o-dropdown, .o_menu_sections > a, .o_menu_sections > button'));
      const getA = li => (li.matches('a, button') ? li : li.querySelector('a, button.dropdown-toggle, button'));
      const match = secs.find(li => { const a = getA(li); return a && norm(a.textContent) === w; })
                 || secs.find(li => { const a = getA(li); return a && norm(a.textContent).includes(w); });
      if (!match) return { ok: false, candidates: secs.map(li => { const a = getA(li); return a ? a.textContent.trim() : ''; }).filter(Boolean) };
      const a = getA(match);
      tag(a);
      return { ok: true, text: a.textContent.trim(), kind: 'item', leaf: !a.classList.contains('dropdown-toggle'), rect: rectOf(a) };
    }

    // level === 'dropdown' — inside the currently open section dropdown
    const menu = document.querySelector('.o_menu_sections .dropdown-menu.show')
              || document.querySelector('.o_menu_sections li.show .dropdown-menu')
              // Odoo 16/17: the section dropdown renders in a body-level portal
              || document.querySelector('.o-dropdown--menu.dropdown-menu.d-block')
              || document.querySelector('.o-dropdown--menu.d-block')
              || document.querySelector('.o-dropdown--menu.show')
              // Odoo 19: rendered as an o_popover (position:fixed, so
              // offsetParent is always null regardless of visibility — the
              // popover component is only mounted in the DOM while open, so
              // existence alone is enough, no visibility check needed)
              || document.querySelector('.o_popover.o-dropdown--menu')
              || document.querySelector('.o_menu_sections .dropdown-menu');
    if (!menu) return { ok: false, nomenu: true, candidates: [] };
    const nodes = Array.from(menu.querySelectorAll('.dropdown-header, .dropdown-item'));
    const headers = nodes.filter(n => n.classList.contains('dropdown-header'));
    let items = nodes.filter(n => n.classList.contains('dropdown-item'));

    // If a group header was matched previously, scope items to that group
    // (between this header and the next) — Odoo 14 flattens groups into a
    // single menu with .dropdown-header separators, so "Products" as an
    // intermediate label narrows which items the next label may match.
    if (spec.group) {
      const gw = norm(spec.group);
      const hidx = nodes.findIndex(n => n.classList.contains('dropdown-header') && (norm(n.textContent) === gw || norm(n.textContent).includes(gw)));
      if (hidx !== -1) {
        let end = nodes.length;
        for (let j = hidx + 1; j < nodes.length; j++) { if (nodes[j].classList.contains('dropdown-header')) { end = j; break; } }
        items = nodes.slice(hidx + 1, end).filter(n => n.classList.contains('dropdown-item'));
      }
    }

    // Resolution order: exact item → exact header → contains item → contains
    // header. Exact-header-before-contains-item stops "Delivery" (a group)
    // from wrongly matching the item "Delivery Packages".
    const foundItem = el => { tag(el); return { ok: true, text: el.textContent.trim(), kind: 'item', leaf: !el.classList.contains('dropdown-toggle'), rect: rectOf(el) }; };
    const foundHeader = el => { tag(el); return { ok: true, text: el.textContent.trim(), kind: 'header', rect: rectOf(el) }; };
    let el = items.find(e => norm(e.textContent) === w);
    if (el) return foundItem(el);
    let hd = headers.find(e => norm(e.textContent) === w);
    if (hd) return foundHeader(hd);
    el = items.find(e => norm(e.textContent).includes(w));
    if (el) return foundItem(el);
    hd = headers.find(e => norm(e.textContent).includes(w));
    if (hd) return foundHeader(hd);

    return { ok: false, candidates: nodes.map(n => (n.classList.contains('dropdown-header') ? '[group] ' : '') + n.textContent.trim()).filter(Boolean) };
  }, spec);

  // Click whatever navLocate tagged, and clear the tag.
  const navClickTagged = () => page.evaluate(() => {
    const el = document.querySelector('[data-nav-target]');
    if (!el) return false;
    el.removeAttribute('data-nav-target');
    el.click();
    return true;
  });

  // Walk a `>`-separated label path by clicking each menu level, with an
  // implicit waitidle between navigating clicks. When opts.mark is set (human
  // mode), a red box + caption is drawn on each target before it is clicked,
  // so the trace explains every step. Returns true on success.
  const navMenuWalk = async (labels, opts = {}) => {
    const mark = !!opts.mark;
    const showCandidates = list => (list || []).forEach(c => console.log(`      · ${c}`));
    // draw the pointer, pause so it's captured in the trace, then (optionally) click
    const point = async (rect, caption) => {
      if (!mark) return;
      await clearMarks();
      await drawMarkRect(rect, caption);
      await page.waitForTimeout(600); // hold the pointer so it's visible in the trace
    };
    const fail = async (msg, r) => {
      console.log(`  navmenu NOT FOUND: ${msg}`);
      if (r && r.nomenu) console.log('      (no open dropdown menu found)');
      showCandidates(r && r.candidates);
      if (mark) await clearMarks();
      throw new Error(`navmenu NOT FOUND: ${msg}`);
    };

    // Level 0 — app: open the apps menu (for visual fidelity) then click it
    // Open the apps menu across versions (v14 .full toggle / v16 navbar apps /
    // v17 grid button). Skip if the app items are already present (menu open).
    await page.evaluate(() => {
      if (document.querySelector('a.o-app-menu-item, .o_menu_apps a.o_app')) return; // already open
      // Try in PRIORITY order — a comma-union querySelector returns the first
      // match in DOM order, which is the .o_navbar_apps_menu *container* (a
      // no-op click), not the button inside it. v17 grid button first.
      // Odoo 19 (enterprise) inside an app shows only `a.o_menu_toggle`, which
      // returns to the home app grid — last, so older versions keep their opener.
      const sels = ['.o_grid_apps_menu__button', '.o_navbar_apps_menu button', '.o_menu_apps a.full', '.o_menu_apps .dropdown-toggle', '.o_navbar_apps_menu', 'a.o_menu_toggle'];
      for (const s of sels) { const t = document.querySelector(s); if (t) { t.click(); return; } }
    }).catch(() => {});
    // Wait for the app grid to actually populate (portal render can outlast a
    // fixed sleep) — robust across versions instead of a flaky 250ms guess.
    await page.waitForSelector('a.o-app-menu-item, .o_menu_apps a.o_app', { timeout: actionTimeout }).catch(() => {});
    await page.waitForTimeout(200); // let the overlay finish painting before the mark/snapshot
    let r = await navLocate({ level: 'app', label: labels[0] });
    if (!r.ok) return fail(`"${labels[0]}" (app level)`, r);
    await point(r.rect, `App: ${r.text}`);
    await navClickTagged();
    if (mark) await clearMarks(); // clicking the app navigates — drop the stale box
    console.log(`  navmenu → app "${r.text}"`);
    await waitIdle();
    if (labels.length === 1) return true;

    // Level 1 — section (top menu bar of the current app)
    r = await navLocate({ level: 'section', label: labels[1] });
    if (!r.ok) return fail(`"${labels[1]}" (section level)`, r);
    await point(r.rect, `Menu: ${r.text}`);
    await navClickTagged();
    if (r.leaf) {
      if (mark) await clearMarks(); // navigated — drop the stale box
      console.log(`  navmenu → section "${r.text}" (leaf)`);
      await waitIdle();
      if (labels.length > 2) console.log(`  navmenu WARNING: "${r.text}" navigated but ${labels.length - 2} more label(s) remain`);
      return true;
    }
    // dropdown toggle: keep the navbar mark up while the dropdown is open
    console.log(`  navmenu → opened section "${r.text}"`);
    // Wait for the section dropdown to actually render (v17 body portal / v14 inline)
    await page.waitForSelector('.o-dropdown--menu.d-block, .o-dropdown--menu.show, .o_menu_sections .dropdown-menu.show', { timeout: actionTimeout }).catch(() => {});
    await page.waitForTimeout(200); // let the dropdown finish painting before the mark/snapshot

    // Levels 2+ — inside the open dropdown (group headers + leaf items)
    let group = null;
    for (let i = 2; i < labels.length; i++) {
      r = await navLocate({ level: 'dropdown', label: labels[i], group });
      if (!r.ok) return fail(`"${labels[i]}" (under "${labels[i - 1]}")`, r);
      const isLast = i === labels.length - 1;
      if (r.kind === 'header') {
        // group header — explain it with the pointer but do NOT click
        await point(r.rect, `Group: ${r.text}`);
        group = r.text;
        if (isLast) {
          // Previously this only WARNED and the flow carried on against the
          // wrong page, so every later selector timed out for a reason that
          // looked unrelated. A group header is never what the flow wanted.
          if (mark) await clearMarks();
          const probe = await navLocate({ level: 'dropdown', label: '__no_such_item__', group: r.text });
          const opts = (probe && probe.candidates) || [];
          throw new Error(
            `navmenu: "${r.text}" is a GROUP HEADER, not a clickable menu item — nothing was opened.` +
            (opts.length ? ` This menu contains: ${opts.slice(0, 16).join(' | ')}` : '') +
            ` (If the record has no menu item at all, use: record <model> <id>)`);
        }
        console.log(`  navmenu → group "${r.text}"`);
      } else {
        await point(r.rect, `${isLast ? 'Open' : 'Menu'}: ${r.text}`);
        await navClickTagged();
        console.log(`  navmenu → item "${r.text}"${r.leaf ? '' : ' (submenu)'}`);
        group = null;
        if (r.leaf) { if (mark) await clearMarks(); await waitIdle(); } // navigated — drop stale box
        else await page.waitForTimeout(250);
      }
    }
    if (mark) await clearMarks();
    return true;
  };

  // --- Odoo RPC from the logged-in page --------------------------------------
  // Uses the browser's own session, so it sees exactly what the user sees
  // (rights, language). user_context carries lang so names come back translated.
  const odooRpc = (model, method, args, kwargs = {}) => page.evaluate(async ({ model, method, args, kwargs }) => {
    const post = async (url, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params }) });
      const j = await r.json();
      if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message || 'RPC error');
      return j.result;
    };
    const info = await post('/web/session/get_session_info', {});
    const context = { ...((info && info.user_context) || {}), ...(kwargs.context || {}) };
    return post(`/web/dataset/call_kw/${model}/${method}`, { model, method, args, kwargs: { ...kwargs, context } });
  }, { model, method, args, kwargs });

  // xmlid → { labels: [app, section, …, item], actionId } for navmenu @xmlid.
  const resolveMenuXmlid = async (xmlid) => {
    const dot = xmlid.indexOf('.');
    if (dot < 1) throw new Error(`navmenu: "@${xmlid}" is not an xmlid (expected module.name, e.g. sale.menu_sale_quotations)`);
    const rows = await odooRpc('ir.model.data', 'search_read',
      [[['module', '=', xmlid.slice(0, dot)], ['name', '=', xmlid.slice(dot + 1)], ['model', '=', 'ir.ui.menu']]],
      { fields: ['res_id'], limit: 1 });
    if (!rows || !rows.length) throw new Error(`navmenu: no menu with xmlid ${xmlid}`);
    const labels = [];
    let id = rows[0].res_id, actionId = null;
    for (let depth = 0; id && depth < 12; depth++) {
      const [menu] = await odooRpc('ir.ui.menu', 'read', [[id], ['name', 'parent_id', 'action']]);
      if (!menu) break;
      labels.unshift(menu.name);
      if (depth === 0 && menu.action) { const m = String(menu.action).match(/,(\d+)$/); if (m) actionId = m[1]; }
      id = menu.parent_id && menu.parent_id[0];
    }
    return { labels, actionId };
  };

  // ISO date → the user's display format (res.lang date_format/time_format).
  let langFormats = null;
  const toUserDate = async (iso) => {
    if (!langFormats) {
      const info = await page.evaluate(async () => {
        const r = await fetch('/web/session/get_session_info', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }) });
        return (await r.json()).result;
      }).catch(() => null);
      const lang = info && info.user_context && info.user_context.lang;
      if (!lang) throw new Error('date: cannot read the user language to convert an ISO date — log in first, or give the date in the display format');
      const [row] = await odooRpc('res.lang', 'search_read', [[['code', '=', lang]]], { fields: ['date_format', 'time_format'], limit: 1 });
      if (!row) throw new Error(`date: language ${lang} not found in res.lang`);
      langFormats = { lang, date: row.date_format, time: row.time_format || '%H:%M:%S' };
    }
    const [, Y, mo, d, H = '00', Mi = '00', S = '00'] = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    const h12 = String(((+H + 11) % 12) + 1).padStart(2, '0');
    const tokens = { '%d': d, '%m': mo, '%Y': Y, '%y': Y.slice(2), '%H': H, '%M': Mi, '%S': S, '%I': h12, '%p': +H < 12 ? 'AM' : 'PM', '%%': '%' };
    const render = (fmt) => fmt.replace(/%./g, (t) => {
      if (!(t in tokens)) throw new Error(`date: unsupported format token ${t} in ${fmt} (${langFormats.lang})`);
      return tokens[t];
    });
    const hasTime = /[ T]\d{2}:\d{2}/.test(iso);
    return hasTime ? `${render(langFormats.date)} ${render(langFormats.time)}` : render(langFormats.date);
  };

  // --- Manual steps -----------------------------------------------------------
  // `step '<title>' ['<description>']` opens a section of the user manual. When
  // the next step starts (or the flow ends), the section is closed: a viewport
  // screenshot is taken with any `mark` boxes still visible, then the marks are
  // cleared so they never bleed into the next step.
  const shotsDir = path.join(tracesDir, `${label}.shots`);
  let currentStep = null;
  const slugify = (s) => s.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'step';
  const closeStep = async () => {
    const s = currentStep;
    if (!s) return;
    currentStep = null;
    s.end_line = s.last_line;
    delete s.last_line;
    try {
      // Park the mouse in the bottom-right corner: a pointer left on the last
      // clicked field shows a hover tooltip that does not belong in a manual.
      await page.mouse.move(1439, 899).catch(() => {});
      await waitIdle(5000).catch(() => {});
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      // Hide counters that change between runs (unread chat, activities) so
      // the same step produces the same picture every time.
      await page.evaluate(() => {
        const st = document.createElement('style');
        st.id = '__pw_stable_shot';
        st.textContent = '.o_menu_systray .badge,.o_menu_systray .o-mail-MessagingMenu-counter,' +
          '.o_menu_systray .o_notification_counter{visibility:hidden!important}';
        document.head.appendChild(st);
      }).catch(() => {});
      fs.mkdirSync(shotsDir, { recursive: true });
      const file = `${String(s.no).padStart(2, '0')}-${slugify(s.title)}.png`;
      await page.screenshot({ path: path.join(shotsDir, file), fullPage: false, animations: 'disabled', caret: 'hide' });
      s.screenshot = path.join(path.basename(shotsDir), file);
      report.manual.shots_dir = shotsDir;
      console.log(`  step ${s.no} ${s.status}: "${s.title}" → ${s.screenshot}`);
    } catch (e) {
      s.screenshot = null;
      s.screenshot_error = String(e.message || e).split('\n')[0];
      console.error(`  step ${s.no}: screenshot failed — ${s.screenshot_error}`);
    } finally {
      await page.evaluate(() => { const st = document.getElementById('__pw_stable_shot'); if (st) st.remove(); }).catch(() => {});
      await clearMarks();
      saveReport();
    }
  };

  const rl = readline.createInterface({ input: capture.input });
  capture.start();

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    const template = line.trim();
    if (!template || template.startsWith('#')) continue; // skip empty lines and comments
    // {{name}} placeholders are resolved before tokenizing; the echo, the log
    // and result.json keep the TEMPLATE, so substituted secrets never print.
    let raw = template, varError = null;
    try { raw = substituteVars(template); } catch (e) { varError = e; }
    // Quote-aware tokenizer: 'my selector with spaces' becomes one token

    const parts = [];
    const quoted = [];               // parallel to parts: was this token single-quoted?
    let cur = '', inQ = false, curQuoted = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "'" && !inQ) { inQ = true; curQuoted = true; }
      else if (raw[i] === "'" && inQ) { inQ = false; }
      else if (raw[i] === ' ' && !inQ) { if (cur || curQuoted) { parts.push(cur); quoted.push(curQuoted); cur = ''; curQuoted = false; } }
      else { cur += raw[i]; }
    }
    if (cur || curQuoted) { parts.push(cur); quoted.push(curQuoted); }

    const cmd = parts[0];
    // rawRest used by eval/jclick to avoid quote-stripping JS code
    const rawRest = raw.slice(cmd.length + 1);
    const templateRest = template.slice(template.indexOf(' ') + 1 || template.length);

    // Echo the command as it STARTS — flushed to the log file immediately, so a
    // killed/hung run shows exactly which command it was on.
    const displayCommand = ['login', 'cookie'].includes(cmd) ? `${cmd} [redacted]` : template;
    console.log(`> ${displayCommand}`);
    const step = { step_id: `${runId}-step-${report.steps.length + 1}`, line: lineNumber, command: displayCommand, status: 'running', started_at: new Date().toISOString() };
    const stepStart = Date.now();
    activeStep = step;
    report.steps.push(step);
    saveReport();

    let stop = false;
    // Dispatch the command. Wrapped in Promise.race below so a genuine hang is
    // capped instead of looking like a silent multi-minute freeze.
    const dispatch = async () => {
      if (varError) throw varError;
      if (inQ && ['fill', 'date', 'm2o', 'celltype', 'boolcell', 'mark', 'expect', 'field', 'rowset', 'step', 'capture'].includes(cmd))
        throw new Error('Unclosed single quote');
      if (cmd !== 'step' && currentStep) currentStep.last_line = lineNumber;
      if (cmd === 'done') {
        await closeStep();
        return 'STOP';

      } else if (cmd === 'step') {
        // step '<title>' ['<description>']   — or: step <title words…>
        // Opens a user-manual section; the previous one is closed (and
        // photographed) first.
        await closeStep();
        const title = quoted[1] ? parts[1] : parts.slice(1).join(' ');
        const description = quoted[1] ? parts.slice(2).join(' ') : '';
        if (!title) throw new Error("step needs a title, e.g.  step 'Select the customer' 'Type the name and pick it'");
        currentStep = { no: report.manual.steps.length + 1, title, description, line: lineNumber,
          last_line: lineNumber, end_line: null, status: 'passed', error: null, screenshot: null };
        report.manual.steps.push(currentStep);
        console.log(`  step ${currentStep.no}: ${title}`);

      } else if (cmd === 'timeout') {
        const ms = parseInt(parts[1] || '', 10);
        if (ms > 0) { actionTimeout = ms; page.setDefaultTimeout(actionTimeout); console.log(`  action timeout: ${actionTimeout}ms`); }
        else throw new Error(`  timeout expects milliseconds (got "${parts[1] || ''}")`);

      } else if (cmd === 'strict') {
        const v = (parts[1] || '').toLowerCase();
        if (!/^(1|true|on|yes|0|false|off|no)$/.test(v)) throw new Error('strict expects on or off');
        strict = /^(1|true|on|yes)$/.test(v);
        console.log(`  strict mode: ${strict ? 'ON — abort on first error' : 'off'}`);

      } else if (cmd === 'goto') {
        // Relative paths (/web#action=12) resolve against the current page, so
        // a flow does not have to hard-code the host.
        const dest = new URL(parts.slice(1).join(' '), page.url()).href;
        if (apiMode && !hostAllowed(dest))
          throw new Error(`goto ${new URL(dest).host} is not allowed in API mode (allowed: ${[...allowedHosts].join(', ')})`);
        await page.goto(dest, { timeout: 20000 });
        await page.waitForLoadState('domcontentloaded');
        console.log(`  → ${page.url()}`);
        // An Odoo 18-style /odoo/<path> URL returns HTTP 200 on Odoo 17 but
        // renders NOTHING, so the next selectors fail with "0 elements" and it
        // reads as a selector bug. Say so here instead.
        // See issues/2026-08-20-no-scroll-command-and-odoo17-url.txt.
        const shell = await page.evaluate(() => {
          if (/\/web\/login|\/web\/database/.test(location.pathname)) return null; // auth pages: no action manager expected
          const am = document.querySelector('.o_action_manager');
          return { missing: !am, empty: !!am && am.textContent.trim().length === 0 };
        }).catch(() => null);
        if (shell && (shell.missing || shell.empty)) {
          console.log('  WARNING: the page rendered no action content (.o_action_manager is '
            + (shell.missing ? 'absent' : 'empty') + ').');
          console.log('      On Odoo 17 an /odoo/<path> style URL loads blank like this. Use the hash form');
          console.log('      /web#id=<id>&model=<model>&view_type=form  — or the `record <model> <id>` command.');
        }

      } else if (cmd === 'mode') {
        // Set navigation mode for subsequent `navmenu` commands.
        // Usage: mode human   (click through menus)
        //        mode quick   (short-circuit navmenu to goto #action=<id>)
        const m = (parts[1] || '').toLowerCase();
        if (m === 'human' || m === 'quick') {
          navMode = m;
          console.log(`  nav mode: ${navMode}`);
        } else {
          throw new Error(`  mode expects 'human' or 'quick' (got "${parts[1] || ''}")`);
        }

      } else if (cmd === 'navmenu') {
        // Navigate by clicking menu items instead of a hash URL.
        // Usage: navmenu App > Section > [Group >] Item [@<actionId>]
        //   human mode → clicks each label in turn (shows the real breadcrumb)
        //   quick  mode → jumps to #action=<id> if @<id> is given; else clicks through
        //   navmenu @module.menu_xmlid  → labels read from the menu itself, in the
        //   user's current language, so one flow works for EN and TH screens.
        let spec = rawRest.trim();
        let actionId = null;
        const m = spec.match(/\s*@(\d+)\s*$/);
        if (m) { actionId = m[1]; spec = spec.slice(0, m.index).trim(); }
        let labels = spec.split('>').map(s => s.trim()).filter(Boolean);
        const xm = spec.match(/\s*@([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)\s*$/);
        if (xm) {
          const given = spec.slice(0, xm.index).split('>').map(s => s.trim()).filter(Boolean);
          const resolved = await resolveMenuXmlid(xm[1]);
          actionId = resolved.actionId;
          // Explicit labels (for readability) are ignored in favour of the
          // menu's real, translated names — those are what is on screen.
          labels = resolved.labels;
          console.log(`  navmenu @${xm[1]} → ${labels.join(' > ')}${actionId ? ` (action ${actionId})` : ''}`
            + (given.length && given.join('>') !== labels.join('>') ? `  [flow said: ${given.join(' > ')}]` : ''));
        }
        if (labels.length === 0) {
          throw new Error('  navmenu: no menu path given (e.g. navmenu Inventory > Configuration > Products > Purchase Product Group)');
        } else if (navMode === 'quick' && actionId) {
          const origin = new URL(page.url()).origin;
          await page.goto(`${origin}/web#action=${actionId}`, { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  navmenu [quick] → #action=${actionId} (${ms}ms): ${labels.join(' > ')}`);
        } else {
          if (navMode === 'quick' && !actionId) {
            console.log('  navmenu [quick] no @<actionId> supplied — clicking through instead');
          }
          // Human mode always draws the red pointer at each step to explain it
          await navMenuWalk(labels, { mark: navMode === 'human' });
        }

      } else if (cmd === 'click') {
        warnIfWrapped('click', rawRest);
        await page.click(rawRest, { timeout: actionTimeout }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  clicked: ${rawRest}`);

      } else if (cmd === 'fclick') {
        // Force click — bypasses Playwright visibility/stability checks
        // Good for: SPA buttons that Playwright thinks aren't actionable
        warnIfWrapped('fclick', rawRest);
        await page.click(rawRest, { force: true, timeout: actionTimeout }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  fclicked: ${rawRest}`);

      } else if (cmd === 'jclick') {
        // JS click — dispatches .click() directly on the DOM element
        // Good for: Odoo OWL2 action buttons in forms
        warnIfWrapped('jclick', rawRest);
        const found = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, rawRest);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        if (!found) throw new Error(`jclick NOT FOUND: ${rawRest}`);
        console.log(`  jclicked (found): ${rawRest}`);

      } else if (cmd === 'field') {
        if (parts.length < 3) throw new Error('Usage: field <name> <value>');
        const actual = await fieldTools.field(parts[1], parts.slice(2).join(' '));
        console.log(`  field ${parts[1]}: verified ${JSON.stringify(actual)}`);

      } else if (cmd === 'rowset') {
        if (parts.length < 5) throw new Error('Usage: rowset <table-field> <#position|field=exact value> <column> <value>');
        const actual = await fieldTools.rowset(parts[1], parts[2], parts[3], parts.slice(4).join(' '));
        console.log(`  rowset ${parts[1]} ${parts[2]} ${parts[3]}: verified ${JSON.stringify(actual)}`);

      } else if (cmd === 'fill') {
        warnIfTruncated(parts, quoted, cmd);
        const sel = parts[1];
        const text = parts.slice(2).join(' ');
        await page.fill(sel, text, { timeout: actionTimeout });
        // Read the value back. A "filled:" line has to be evidence, not a claim:
        // Playwright reports success as long as SOME element accepted the text,
        // so a too-broad selector can write into the wrong node while the field
        // you meant stays empty — which then only surfaces many steps later as a
        // validation error on Save.
        const landed = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return { missing: true };
          const v = ('value' in el && el.value !== undefined) ? el.value : el.textContent;
          return { value: v == null ? '' : String(v), count: document.querySelectorAll(s).length };
        }, sel);
        if (landed.missing) throw new Error(`fill: "${sel}" matched nothing when reading the value back`);
        if (landed.value !== text) {
          throw new Error(
            `fill: wrote to "${sel}" but reading it back gives ${JSON.stringify(landed.value)}, `
            + `not ${JSON.stringify(text)} — the text most likely went into a different element `
            + `(is the selector specific enough, and does it point at the input/textarea itself?)`);
        }
        console.log(`  filled: ${sel} = "${text}"${landed.count > 1 ? `  (NOTE: selector matches ${landed.count} elements; the first was used)` : ''}`);

      } else if (cmd === 'date') {
        // Odoo 17 date/datetime inputs open a picker overlay that is NOT
        // clickable — a `click` before fill eats a full timeout. Fill the value
        // directly (Playwright fill fires input+change), fire change again for
        // OWL, close the picker (Escape), and commit (blur). No click.
        // Value format follows the user's lang (en_US on dv_sme:
        //   date  → %d/%m/%Y            e.g. 01/06/2026
        //   datetime → %d/%m/%Y %H:%M:%S e.g. 01/06/2026 18:00:00 (stored UTC)
        // Usage: date '<selector>' <value>   (quote selectors with spaces!)
        warnIfTruncated(parts, quoted, cmd);
        const sel = parts[1];
        let value = parts.slice(2).join(' ');
        // ISO input (2026-06-01 or 2026-06-01 18:00[:00]) is converted to the
        // logged-in user's date format, so a flow is language-independent.
        if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) {
          const iso = value;
          value = await toUserDate(iso);
          console.log(`  date: ISO ${iso} → ${value} (${langFormats.lang})`);
        }
        // Find the real <input>. Odoo ≤18: the selector is the input, or a field
        // that contains one. Odoo 19: the field shows a <button class="o_input">
        // with a condensed date ("Nov 1"); the input only exists after a click.
        // A v17-style '… input' selector that matches nothing is retried on the
        // field itself, so one flow runs on both.
        const token = `d${Date.now()}`;
        const findTarget = (s) => page.evaluate(({ s, token }) => {
          const el = document.querySelector(s);
          if (!el) return null;
          if (el.matches('input')) { el.setAttribute('data-pw-date', token); return 'input'; }
          const field = el.closest('.o_field_widget') || el;
          field.setAttribute('data-pw-date', token);
          if (field.querySelector('input')) return 'field-input';
          if (el.matches('button.o_input') || field.querySelector('button.o_input')) return 'button';
          return 'none';
        }, { s, token });
        let kind = await findTarget(sel);
        if (!kind && /\s+input$/.test(sel)) kind = await findTarget(sel.replace(/\s+input$/, ''));
        if (!kind || kind === 'none') throw new Error(`date: no date input found for ${sel}`);
        const inputSel = kind === 'input' ? `input[data-pw-date="${token}"]` : `[data-pw-date="${token}"] input`;
        if (kind === 'button') {
          await page.locator(`[data-pw-date="${token}"] button.o_input`).first().click({ timeout: actionTimeout });
          await page.waitForSelector(inputSel, { timeout: actionTimeout });
        }
        await page.fill(inputSel, value, { timeout: actionTimeout });
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
        }, inputSel);
        // Only dismiss a picker that is ACTUALLY open. `date` never clicks the
        // field, so usually no picker exists — and an Escape with nothing to
        // close bubbles to Odoo's Dialog component and shuts the whole
        // target='new' modal, after which every later step runs against the
        // screen behind it with no error from here. Same trap m2o/pick already
        // avoid. See issues/2026-09-11-date-command-escape-closes-target-new-dialog.txt
        const pickerOpen = await page.evaluate(() => !!document.querySelector(
          '.o_datetime_picker, .o_date_picker, .bootstrap-datetimepicker-widget, .datepicker'));
        if (pickerOpen) await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(({ s, token }) => {
          const el = document.querySelector(s);
          if (el) el.blur();
          document.querySelectorAll(`[data-pw-date="${token}"]`).forEach(e => e.removeAttribute('data-pw-date'));
        }, { s: inputSel, token });
        console.log(`  date: ${sel} = "${value}"${pickerOpen ? ' (closed open picker)' : ''}`);

      } else if (cmd === 'type') {
        // Type text into the currently-focused element via keyboard events (no selector needed)
        const text = parts.slice(1).join(' ');
        await page.keyboard.type(text, { delay: 50 });
        console.log(`  typed: "${text}"`);

      } else if (cmd === 'm2o') {
        // Many2one field helper: click cell → clear any pre-filled value → type
        // search → wait for a dropdown item → pick the one that actually
        // matches (via the same matcher as `pick`, not blindly the first item).
        // Fixes fill() failing on role="combobox" inputs in OWL editable tree rows.
        // Previously this clicked whatever dropdown item appeared first
        // regardless of the typed text, and never cleared a pre-filled combobox
        // before typing (so typing appended instead of replacing) — see
        // issues/2026-08-06-m2o-blind-click-and-escape-closes-modal.txt. `pick`
        // already closes its own dropdown via a direct element click, so no
        // trailing `press Escape` is needed (or wanted) after m2o/pick — an
        // Escape here can instead close the whole enclosing modal.
        const cellSel = parts[1];
        const searchText = parts.slice(2).join(' ');
        warnIfTruncated(parts, quoted, cmd);
        await page.click(cellSel, { timeout: actionTimeout });
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(searchText, { delay: 50 });
        await page.waitForSelector(
          '.o-autocomplete--dropdown-item, ul.ui-autocomplete li.ui-menu-item, .ui-menu-item a',
          { timeout: actionTimeout });
        const res = await pickWhenSettled(searchText.trim().toLowerCase());
        if (res.ok) {
          console.log(`  m2o: ${cellSel} = "${res.text}"`);
        } else if (res.loading) {
          throw new Error(`  m2o NOT FOUND: ${cellSel} = "${searchText}" — after ${actionTimeout}ms the dropdown ${res.empty ? 'still had no visible items' : 'still showed only a loading placeholder'}; the name_search results never arrived`);
        } else {
          throw new Error(`  m2o NOT FOUND: ${cellSel} = "${searchText}" — options: ${(res.candidates || []).join(" | ")}`);
        }

      } else if (cmd === 'pick') {
        // Pick an option from an ALREADY-OPEN autocomplete dropdown by text —
        // works for OWL (.o-autocomplete--dropdown-item) and v14 jQuery-UI
        // (.ui-menu-item). Skips "Create"/"Create and Edit"/"Search More" so
        // Enter/first-item never lands on a create option (a v14 trap). Selects
        // via JS .click(); exact match first, then contains, case-insensitive.
        // Usage: fill '<input>' Text  →  waitidle  →  pick Text
        const wanted = rawRest.trim().toLowerCase();
        const res = await pickWhenSettled(wanted);
        if (res.ok) console.log(`  pick: "${res.text}"`);
        else if (res.loading) {
          throw new Error(`  pick NOT FOUND: "${rawRest}" — after ${actionTimeout}ms the dropdown ${res.empty ? 'still had no visible items' : 'still showed only a loading placeholder'}; the name_search results never arrived (is an autocomplete actually open, and does the search text match anything?)`);
        } else {
          throw new Error(`  pick NOT FOUND: "${rawRest}" — options: ${(res.candidates || []).join(" | ")}`);
        }

      } else if (cmd === 'celltype') {
        // v14 editable-list cell: a readonly-styled <td> often reports "not
        // actionable" to click/fclick even though it IS clickable, and the
        // first click only enters row-edit mode WITHOUT focusing the inner
        // input (so `type` lands in whatever was focused before). This does the
        // two-stage dance: JS-click the cell to enter edit, then focus the
        // cell's own input/textarea, then type into it.
        // Usage: celltype '<td selector>' <text>   (quote selectors with spaces)
        warnIfTruncated(parts, quoted, cmd);
        const cellSel = parts[1];
        const text = parts.slice(2).join(' ');
        const entered = await page.evaluate((s) => {
          const cell = document.querySelector(s);
          if (!cell) return { ok: false };
          cell.click(); // enter row-edit mode (CSS-selector click can wrongly report not-actionable)
          return { ok: true };
        }, cellSel);
        if (!entered.ok) { throw new Error(`  celltype NOT FOUND cell: ${cellSel}`); }
        else {
          await page.waitForTimeout(150); // let the input render in the cell
          const focused = await page.evaluate((s) => {
            const cell = document.querySelector(s);
            const inp = cell && cell.querySelector('input, textarea, [contenteditable="true"]');
            if (!inp) return false;
            inp.focus();
            if ('select' in inp) try { inp.select(); } catch (e) {}
            return true;
          }, cellSel);
          if (!focused) throw new Error(`  celltype: no input in cell ${cellSel} (cell did not enter edit mode)`);
          await page.keyboard.type(text, { delay: 50 });
          console.log(`  celltype: ${cellSel} = "${text}"${focused ? '' : ' (WARN: cell had no input)'}`);
        }

      } else if (cmd === 'cols') {
        // Print a table's header cells with their column index — column order is
        // NOT stable across tables (e.g. the "Detailed Operations" popup differs
        // from the main Operations tab), so discover per-table instead of
        // reusing an index. Usage: cols [table selector]  (default: first list)
        warnIfWrapped('cols', rawRest.trim());
        const tableSel = rawRest.trim() || '.o_list_table, table.o_list_view, table';
        const heads = await page.evaluate((sel) => {
          const t = document.querySelector(sel);
          if (!t) return null;
          // first thead only — Odoo renders a duplicate sticky header
          const thead = t.querySelector('thead');
          const ths = Array.from((thead || t).querySelectorAll('th'));
          return ths.map((th, i) => ({ i, name: th.getAttribute('data-name') || th.getAttribute('name') || '', text: (th.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) }));
        }, tableSel);
        if (!heads) console.log(`  cols: no table matched ${tableSel}`);
        else heads.forEach(h => console.log(`  [${h.i}] "${h.text}"${h.name ? ` (name=${h.name})` : ''}`));

      } else if (cmd === 'addline') {
        // Add a row to a One2many list: jclick the "Add a line/product" link → wait for new row
        // Usage: addline <field_name>   e.g.  addline order_line
        const fieldName = parts[1];
        const found = await page.evaluate((f) => {
          const el = document.querySelector(`[name="${f}"] a`);
          if (!el) return false;
          el.click();
          return true;
        }, fieldName);
        if (!found) throw new Error(`addline NOT FOUND link: ${fieldName}`);
        await page.waitForSelector('tr.o_selected_row', { timeout: actionTimeout });
        console.log(`  addline (${found ? 'found' : 'NOT FOUND link'}): [name="${fieldName}"]`);

      } else if (cmd === 'press') {
        await page.keyboard.press(parts[1]);
        console.log(`  pressed: ${parts[1]}`);

      } else if (cmd === 'wait') {
        const ms = parseInt(parts[1] || '1000');
        await page.waitForTimeout(ms);
        console.log(`  waited ${ms}ms`);

      } else if (cmd === 'waitidle') {
        // Wait for Odoo to actually finish: RPCs drained + loading overlays gone.
        // Much faster than fixed waits — returns as soon as the page is ready.
        // Usage: waitidle [maxMs]   (default 15000)
        const ms = await waitIdle(parseInt(parts[1] || '15000'));
        console.log(`  idle after ${ms}ms`);

      } else if (cmd === 'login') {
        // Smart login: if the session (reused from .sessions/) is still valid,
        // skip the form and go straight to /web. NOTE: Odoo renders the login
        // form on /web/login even when authenticated — the form's presence
        // proves nothing; ask the server via get_session_info instead.
        // Usage: login <user> <password>
        const user = parts[1];
        const pass = parts.slice(2).join(' ');
        const getSession = () => page.evaluate(async () => {
          try {
            const r = await fetch('/web/session/get_session_info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
            });
            const j = await r.json();
            return j.result && j.result.uid ? { uid: j.result.uid, db: j.result.db, username: j.result.username, server_version: j.result.server_version } : null;
          } catch { return null; }
        });
        let sess = await getSession();
        // Guard against wrong-DB sessions: if the target URL pins a db (?db=...)
        // and the restored session belongs to a different one, discard it —
        // otherwise the trace would silently record against the wrong database
        const wantDb = (() => {
          try { return new URL(targetUrl).searchParams.get('db'); } catch { return null; }
        })();
        if (sess && ((wantDb && sess.db !== wantDb) || sess.username !== user)) {
          console.log(`  session is for ${sess.username} / db "${sess.db}" but target wants ${user} / db "${wantDb || "(unspecified)"}" — discarding session, logging in fresh`);
          await context.clearCookies();
          await page.goto(targetUrl, { timeout: 20000 });
          await waitIdle(10000);
          sess = null;
        }
        if (sess) {
          const origin = new URL(page.url()).origin;
          await page.goto(origin + '/web', { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  login skipped — session still valid (uid=${sess.uid}, db=${sess.db}, ${ms}ms)`);
        } else {
          await page.fill('input#login', user);
          await page.fill('input#password', pass);
          await page.keyboard.press('Enter');
          const ms = await waitIdle(20000);
          const failed = await page.evaluate(() => !!document.querySelector('input#login'));
          if (failed) {
            throw new Error(`  login FAILED for "${user}" — still on login form (check credentials/db)`);
          } else {
            const after = await getSession();
            if (!after || (wantDb && after.db !== wantDb) || after.username !== user) {
              const e = new Error('login FAILED: server did not verify the requested user/database');
              e.fatal = true;
              throw e;
            }
            sess = after;
            console.log(`  logged in as ${user} (db=${after ? after.db : '?'}, ${ms}ms)`);
          }
        }

        report.context.verified_session = sess;
        saveReport();

      } else if (cmd === 'expect') {
        const kind = parts[1];
        let selector = parts[2], expected = parts.slice(3).join(' ');
        if (kind === 'state') {
          expected = parts.slice(2).join(' ');
          selector = '.o_form_view .o_statusbar_status .o_arrow_button_current, .o_form_view .o_statusbar_status [aria-checked="true"]';
        } else if (kind === 'dialog') {
          expected = parts.slice(2).join(' ');
          selector = '.modal:visible .modal-title';
        }
        if (!['visible', 'hidden', 'text', 'value', 'state', 'dialog'].includes(kind) || !selector)
          throw new Error('Usage: expect visible|hidden|text|value <selector> [expected], or expect state|dialog <expected text>');
        const loc = page.locator(selector);
        const normalize = text => text.replace(/\s+/g, ' ').trim();
        const deadline = Date.now() + actionTimeout;
        let actual = null, matched = false;
        do {
          const count = await loc.count();
          if (kind === 'hidden') {
            actual = !(await Promise.all((await loc.all()).map(el => el.isVisible()))).some(Boolean);
            matched = actual;
          }
          else if (count === 1 && await loc.isVisible()) {
            actual = kind === 'value' ? await loc.inputValue() : normalize(await loc.innerText());
            matched = kind === 'visible' || actual === (kind === 'value' ? expected : normalize(expected));
            if (!matched && kind === 'state') {
              // `expect state sale` — the internal selection key, identical in
              // every UI language, carried by the statusbar button.
              const key = await loc.getAttribute('data-value').catch(() => null);
              if (key && key === expected.trim()) { matched = true; actual = `${actual} [${key}]`; }
              else if (key) actual = `${actual} [${key}]`;
            }
          } else { actual = `${count} matches (expected one visible element)`; }
          if (matched) break;
          await page.waitForTimeout(100);
        } while (Date.now() < deadline);
        if (!matched) throw new Error(`expect ${kind} failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} for ${selector}`);
        console.log(`  expect ${kind}: PASS`);

      } else if (cmd === 'screenshot') {
        // Usage: screenshot [name] [full|viewport]   (default full page)
        const modes = ['full', 'viewport'];
        const mode = modes.includes(parts.at(-1)) ? parts.at(-1) : 'full';
        const nameParts = modes.includes(parts.at(-1)) ? parts.slice(1, -1) : parts.slice(1);
        const imgName = nameParts[0] || `${label}-${Date.now()}`;
        const imgPath = path.join(tracesDir, imgName.endsWith('.png') ? imgName : `${imgName}.png`);
        // Wait for web-fonts (Font Awesome icons, Thai fonts) to finish loading,
        // else icon glyphs render as empty □ "tofu" boxes in the capture.
        await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
        await page.screenshot({ path: imgPath, fullPage: mode === 'full' });
        shots.push(imgPath); // tracked for end-of-run cleanup (they're in the trace)
        console.log(`  screenshot: ${imgPath}`);

      } else if (cmd === 'snapshot') {
        const s = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          const nodes = [];
          let n;
          while ((n = walker.nextNode()) && nodes.length < 100) {
            const role = n.getAttribute('role') || n.tagName.toLowerCase();
            const label = n.getAttribute('aria-label') || n.innerText?.slice(0, 60) || '';
            if (label) nodes.push(`${role}: ${label}`);
          }
          return nodes.join('\n');
        });
        console.log(s);

      } else if (cmd === 'eval') {
        if (apiMode) throw new Error('eval is disabled in API mode (it can run arbitrary code in the browser)');
        const result = await page.evaluate(new Function(`return (${rawRest})`));
        console.log(`  eval: ${JSON.stringify(result)}`);

      } else if (cmd === 'highlight') {
        // Playwright's native highlight: draws a pink box around the element
        // directly in the live page — shows up in the next screenshot, but
        // NOT in the trace viewer's Snapshot/DOM tab (Playwright strips its
        // own debug overlay before serializing snapshots). Use `mark`
        // instead if the annotation needs to survive in the trace viewer.
        // Usage: highlight <selector>
        warnIfWrapped('highlight', rawRest);
        await page.locator(rawRest).first().highlight();
        console.log(`  highlighted: ${rawRest}`);

      } else if (cmd === 'mark') {
        // Inject a REAL red box (+ optional caption) around an element —
        // unlike highlight(), this is genuine page content, so it survives
        // into the trace viewer's Snapshot/DOM tab and every screenshot
        // taken afterward, until cleared with `unmark`.
        // Resolve the target via Playwright's own locator (supports
        // :has-text() and friends, which plain querySelector cannot), then
        // draw using the already-resolved coordinates.
        // Usage: mark <selector> [caption text]  (wrap selector in 'single
        // quotes' if it contains spaces, e.g. 'button:has-text("Log in")')
        warnIfTruncated(parts, quoted, cmd);
        const sel = parts[1];
        const caption = parts.slice(2).join(' ');
        const rect = await page.locator(sel).first().boundingBox().catch(() => null);
        if (!rect) {
          throw new Error(`  mark NOT FOUND: ${sel}`);
        } else {
          await page.evaluate(({ rect, caption }) => {
            const box = document.createElement('div');
            box.setAttribute('data-pw-mark', '1');
            box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
              `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
              `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
            document.body.appendChild(box);
            if (caption) {
              // Wrap onto up to ~2 lines and keep the label inside the viewport —
              // long captions near the right edge used to run off-screen as one
              // unbroken nowrap line and get clipped by the screenshot itself.
              const maxW = Math.min(340, window.innerWidth - 24);
              const left = Math.min(Math.max(rect.x, 8), window.innerWidth - maxW - 8);
              const below = rect.y < 60;
              const label = document.createElement('div');
              label.setAttribute('data-pw-mark', '1');
              label.textContent = caption;
              label.style.cssText = `position:fixed;left:${left}px;` +
                `top:${below ? rect.y + rect.height + 8 : Math.max(rect.y - 54, 4)}px;` +
                `max-width:${maxW}px;background:#dc1e1e;color:#fff;font:bold 14px sans-serif;` +
                `line-height:1.35;padding:5px 10px;border-radius:4px;z-index:2147483647;` +
                `pointer-events:none;white-space:normal;`;
              document.body.appendChild(label);
            }
          }, { rect, caption });
          console.log(`  marked: ${sel}${caption ? ' — ' + caption : ''}`);
        }

      } else if (cmd === 'unmark') {
        // Remove all marks added by `mark`.
        await page.evaluate(() => {
          document.querySelectorAll('[data-pw-mark]').forEach((e) => e.remove());
        });
        console.log('  cleared all marks');

      } else if (cmd === 'bbox') {
        // Print an element's viewport bounding box as JSON — feed the
        // coordinates to an external tool (e.g. Pillow) to draw a custom
        // circle/arrow annotation on the saved screenshot.
        // Usage: bbox <selector>
        warnIfWrapped('bbox', rawRest);
        const box = await page.locator(rawRest).first().boundingBox();
        console.log(`  bbox: ${JSON.stringify(box)}`);

      } else if (cmd === 'cookie') {
        // Set a raw browser cookie at the context level — works even for
        // HttpOnly cookies (e.g. an Odoo session_id obtained out-of-band),
        // which page-JS document.cookie can never touch.
        // Usage: cookie <name> <value> [domain] [path]
        const name = parts[1];
        const value = parts[2];
        const domain = parts[3] || new URL(page.url()).hostname;
        const cpath = parts[4] || '/';
        if (apiMode && !allowedHosts.has(domain.replace(/^\./, '').toLowerCase()))
          throw new Error(`cookie for ${domain} is not allowed in API mode`);
        await context.addCookies([{ name, value, domain, path: cpath }]);
        console.log(`  cookie set: ${name} on ${domain}${cpath}`);

      } else if (cmd === 'buttons') {
        // List all visible buttons: internal name + visible label — the ground truth
        // for picking action buttons (names vary by module: action_confirm vs action_sale_ok vs numeric IDs)
        const list = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, a[role="button"]'))
            .filter(e => e.offsetParent !== null)
            .map(e => ({
              name: e.getAttribute('name') || '',
              text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
              disabled: !!e.disabled,
            }))
            .filter(b => b.text || b.name)
            .slice(0, 60);
        });
        if (list.length === 0) console.log('  (no visible buttons)');
        list.forEach(b => console.log(`  name="${b.name}" | "${b.text}"${b.disabled ? ' [disabled]' : ''}`));

      } else if (cmd === 'clickbtn') {
        // Click an action control by what you SEE, so you never hunt for
        // button[name="319"] / action_confirm / action_sale_ok. Matches on the
        // visible label (exact → contains), and also on title/aria-label (icon
        // buttons) and the internal name (so passing a name still works).
        // Covers header buttons, statusbar buttons, .btn, and dropdown/menu
        // items. On a miss it PRINTS the visible labels so you retry with the
        // right one instead of guessing a name/id.
        const wanted = rawRest.trim().toLowerCase();
        const result = await page.evaluate(clickButtonByLabel, wanted);
        if (result.ok) {
          console.log(`  clickbtn: "${result.text}" (name="${result.name}")`);
        } else {
          console.log(`  clickbtn NOT FOUND: "${rawRest}" — visible clickable labels (use one of these, don't guess a name/id):`);
          (result.labels || []).forEach(l => console.log(`      · ${l}`));
          throw new Error(`${cmd} NOT FOUND: ${rawRest}; visible labels: ${(result.labels || []).join(' | ')}`);
        }

      } else if (cmd === 'clickrpc') {
        // Like clickbtn, but PROVES the button's own method reached the server.
        // A "clicked:" line is not evidence, and neither is "some RPC happened":
        // the framework's pre-save and other modules' background JS both fire
        // during the window. So we keep watching until a request that plausibly
        // belongs to THIS button arrives (rpcQualifies), and on failure print
        // everything we did see — which is what makes the cause diagnosable.
        // Usage: clickrpc <label>        (same matching as clickbtn)
        const wanted = rawRest.trim().toLowerCase();
        const seen = [];
        const onReq = (r) => {
          const u = r.url();
          if (/\/web\//.test(u)) { try { seen.push(new URL(u).pathname); } catch (e) { /* ignore */ } }
        };
        page.on('request', onReq);   // attach BEFORE clicking or a fast RPC is missed
        try {
          const result = await page.evaluate(clickButtonByLabel, wanted);
          if (!result.ok) {
            console.log(`  clickrpc NOT FOUND: "${rawRest}" — visible clickable labels:`);
            (result.labels || []).forEach(l => console.log(`      · ${l}`));
            throw new Error(`${cmd} NOT FOUND: ${rawRest}; visible labels: ${(result.labels || []).join(' | ')}`);
          } else {
            const btnName = (result.name || '').trim();
            const deadline = Date.now() + actionTimeout;
            let matched = null;
            while (!matched && Date.now() < deadline) {
              matched = seen.find(pth => rpcQualifies(pth, btnName)) || null;
              if (!matched) await page.waitForTimeout(100);
            }
            if (!matched) {
              const uniq = [...new Set(seen)];
              let obs;
              if (!uniq.length) {
                obs = ' NO /web/ requests fired at all — the click reached the element but produced no server traffic whatsoever.';
              } else {
                obs = ` Requests seen, none of which is this button's action: ${uniq.join(', ')}.`;
                if (uniq.some(u => /web_save/.test(u))) {
                  obs += ' A web_save DID fire — check whether the record failed to save, which blocks the button method.';
                }
              }
              throw new Error(
                `clickrpc: clicked "${result.text}" (name="${btnName}") but its method never ` +
                `reached the server within ${actionTimeout}ms.${obs}`);
            }
            console.log(`  clickrpc: "${result.text}" (name="${btnName}") → ${matched} OK`);
            await waitIdle();
          }
        } finally {
          page.off('request', onReq);
        }

      } else if (cmd === 'evals') {
        // Print outerHTML (first 300 chars) of each matched element — instant structure inspection
        const sel = rawRest;
        warnIfWrapped('evals', sel);
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            e.outerHTML.slice(0, 300)
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches for: ${sel})`);
        results.forEach((r, i) => console.log(`  [${i}] ${r}`));

      } else if (cmd === 'find') {
        const sel = rawRest;
        warnIfWrapped('find', sel);
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            `${e.tagName}.${e.className.replace(/\s+/g, '.')} | text="${e.textContent?.trim().slice(0, 60)}"`
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches)`);
        results.forEach(r => console.log(`  ${r}`));

      } else if (cmd === 'waitfor') {
        const sel = rawRest;
        warnIfWrapped('waitfor', sel);
        await page.waitForSelector(sel, { timeout: actionTimeout });
        console.log(`  appeared: ${sel}`);

      } else if (cmd === 'scroll') {
        // Bring an element into view WITHOUT clicking or focusing it. Odoo forms
        // scroll inside .o_content, not the page body, so a fullPage screenshot
        // still misses a lower group; the old workaround was to click a field
        // down there, which dirties it and is wrong for a read-only check.
        // Usage: scroll <selector>
        warnIfWrapped('scroll', rawRest);
        const scrolled = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        }, rawRest);
        if (!scrolled) throw new Error(`scroll: ${rawRest} (NOT FOUND — 0 elements)`);
        await page.waitForTimeout(150); // let the scroll settle before any screenshot
        console.log(`  scroll: ${rawRest}${scrolled ? '' : '  (NOT FOUND \u2014 0 elements)'}`);

      } else if (cmd === 'record') {
        // Open a record's form directly by model + id. Some records have no menu
        // item at all (e.g. a picking with a custom operation type), and flows
        // were hand-writing the hash URL every time.
        // Usage: record <model> <id>
        const rModel = parts[1];
        const rId = parts[2];
        if (!rModel || !rId) {
          throw new Error('  record: usage is  record <model> <id>   e.g. record stock.picking 1234');
        } else {
          const origin = new URL(page.url()).origin;
          await page.goto(`${origin}/web#id=${rId}&model=${rModel}&view_type=form`, { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  record: ${rModel} #${rId} (${ms}ms) \u2192 ${page.url()}`);
        }

      } else if (cmd === 'breadcrumb') {
        // Breadcrumb links are flaky to click by CSS (often "not actionable", or
        // the wrong level gets hit). Click by INDEX via JS instead.
        // Usage: breadcrumb        -> the previous level (parent record)
        //        breadcrumb 1      -> the first crumb (top-level list)
        //        breadcrumb -1     -> the last crumb (current record)
        const argN = (parts[1] || '').trim();
        const res = await page.evaluate((n) => {
          const crumbs = Array.from(document.querySelectorAll(
            '.o_breadcrumb a, .breadcrumb a, .o_control_panel .o_breadcrumb .o_breadcrumb_item a'))
            .filter(e => e.offsetParent !== null);
          const all = Array.from(document.querySelectorAll(
            '.o_breadcrumb, .breadcrumb')).map(e => e.textContent.replace(/\s+/g, ' ').trim());
          if (!crumbs.length) return { ok: false, crumbs: all };
          let idx;
          if (n === '') idx = crumbs.length - 1;         // default: parent = last LINK
          else if (Number(n) < 0) idx = crumbs.length + Number(n);
          else idx = Number(n) - 1;
          const el = crumbs[idx];
          if (!el) return { ok: false, count: crumbs.length,
                            texts: crumbs.map(c => c.textContent.trim()) };
          const text = el.textContent.trim();
          el.click();
          return { ok: true, text, index: idx + 1, count: crumbs.length };
        }, argN);
        if (res.ok) {
          await waitIdle();
          console.log(`  breadcrumb: clicked #${res.index}/${res.count} "${res.text}"`);
        } else if (res.count) {
          throw new Error(`  breadcrumb: index out of range (there are ${res.count} clickable crumbs): ${(res.texts || []).join(' | ')}`);
        } else {
          throw new Error(`  breadcrumb: no clickable crumbs found. Breadcrumb text: ${(res.crumbs || []).join(' | ') || '(none)'}`);
        }

      } else if (cmd === 'boolcell') {
        // Editable-tree boolean cell. A raw click on the checkbox reports success
        // but .checked never flips, because the ROW has to be in edit mode first.
        // This clicks the cell to activate the row, toggles the checkbox, then
        // VERIFIES .checked actually changed (and says so if it didn't).
        // Usage: boolcell '<td selector>' [on|off]
        // See issues/2026-08-14-boolean-checkbox-click-in-editable-tree.txt.
        warnIfTruncated(parts, quoted, cmd);
        const bcSel = parts[1];
        const want = (parts[2] || '').toLowerCase();   // '', 'on'/'true'/'1', 'off'/'false'/'0'
        const target = ['on', 'true', '1', 'yes', 'check', 'checked'].includes(want) ? true
          : ['off', 'false', '0', 'no', 'uncheck', 'unchecked'].includes(want) ? false
          : null;                                       // null = just toggle
        const enter = await page.evaluate((sel) => {
          const cell = document.querySelector(sel);
          if (!cell) return false;
          cell.click();                                 // activate row-edit mode
          return true;
        }, bcSel);
        if (!enter) { throw new Error(`  boolcell NOT FOUND cell: ${bcSel}`); }
        else {
          await page.waitForTimeout(150);               // let the row enter edit mode
          const r = await page.evaluate(({ sel, target }) => {
            const cell = document.querySelector(sel);
            const box = cell && cell.querySelector('input[type="checkbox"]');
            if (!box) return { ok: false, noBox: true };
            const before = !!box.checked;
            if (target !== null && before === target) return { ok: true, before, after: before, skipped: true };
            box.click();
            let after = !!box.checked;
            if (after === before) {                     // click swallowed - force it
              box.checked = !before;
              box.dispatchEvent(new Event('input', { bubbles: true }));
              box.dispatchEvent(new Event('change', { bubbles: true }));
              after = !!box.checked;
            }
            return { ok: true, before, after, forced: after !== before ? false : true };
          }, { sel: bcSel, target });
          if (!r.ok) throw new Error(`  boolcell: no checkbox inside ${bcSel}`);
          else if (r.skipped) console.log(`  boolcell: ${bcSel} already ${r.before} \u2014 left alone`);
          else if (r.after === r.before) throw new Error(`  boolcell FAILED: ${bcSel} still ${r.after} after clicking AND forcing input/change \u2014 the widget is not accepting the toggle`);
          else console.log(`  boolcell: ${bcSel} ${r.before} \u2192 ${r.after}`);
        }

      } else if (cmd === 'url') {
        console.log(`  ${page.url()}`);

      } else if (cmd === 'title') {
        console.log(`  ${await page.title()}`);

      } else if (cmd === 'lang') {
        // Switch the logged-in user's interface language (res.users.lang), then
        // reload so the UI renders in it. Records the previous language in
        // result.json → lang_switch, so the caller can restore it afterwards.
        // Usage: lang <code>   e.g. lang th_TH
        const code = parts[1];
        if (!/^[a-z]{2,3}(_[A-Za-z0-9@]+)?$/.test(code || '')) throw new Error('Usage: lang <code>, e.g. lang th_TH');
        const info = await page.evaluate(async () => {
          const r = await fetch('/web/session/get_session_info', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }) });
          return (await r.json()).result;
        }).catch(() => null);
        if (!info || !info.uid) throw new Error('lang: not logged in — run login first');
        const previous = (info.user_context && info.user_context.lang) || null;
        if (!report.lang_switch) report.lang_switch = { from: previous, to: code };
        else report.lang_switch.to = code;
        if (previous === code) {
          console.log(`  lang: already ${code}`);
        } else {
          const active = await odooRpc('res.lang', 'search_read', [[['code', '=', code], ['active', '=', true]]], { fields: ['code'], limit: 1 });
          if (!active || !active.length) throw new Error(`lang: ${code} is not installed/active in this database (Settings → Languages)`);
          await odooRpc('res.users', 'write', [[info.uid], { lang: code }]);
          langFormats = null; // date format follows the language
          await page.reload({ timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  lang: ${previous} → ${code} (${ms}ms)`);
        }
        saveReport();

      } else if (cmd === 'capture') {
        // Record a value for later steps/transactions ({{name}}) and result.json.
        // Usage: capture <name> field <field_name>   value shown in the active form/dialog
        //        capture <name> url id               record id from the current URL
        //        capture <name> text <selector>      visible text of an element
        const name = parts[1], source = parts[2], arg = parts.slice(3).join(' ');
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name || '') || !['field', 'url', 'text'].includes(source))
          throw new Error('Usage: capture <name> field <field_name> | capture <name> url id | capture <name> text <selector>');
        let value = null;
        if (source === 'url') {
          const u = new URL(page.url());
          const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
          // Odoo ≤17: #id=42&model=… ; Odoo 18+: /odoo/<action>/42
          value = hash.get('id') || u.searchParams.get('id') || (u.pathname.match(/\/(\d+)\/?$/) || [])[1] || null;
          if (value) value = Number(value);
        } else if (source === 'text') {
          if (!arg) throw new Error('capture … text needs a selector');
          value = (await page.locator(arg).first().innerText({ timeout: actionTimeout })).replace(/\s+/g, ' ').trim();
        } else {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg)) throw new Error(`capture … field needs a field name, got "${arg}"`);
          await waitIdle(5000).catch(() => {});
          value = await page.evaluate((f) => {
            const visible = el => el && el.getClientRects().length > 0;
            const modals = [...document.querySelectorAll('.modal')].filter(visible);
            // Topmost dialog first, then the main form, then anywhere.
            const scopes = [modals.at(-1), document.querySelector('.o_action_manager .o_form_view'), document].filter(Boolean);
            const sel = `.o_field_widget[name="${f}"], div[name="${f}"], span[name="${f}"]`;
            let el = null;
            for (const scope of scopes) { el = [...scope.querySelectorAll(sel)].find(visible); if (el) break; }
            if (!el) return null;
            const input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
            if (input) return input.tagName === 'SELECT' ? (input.selectedOptions[0] || {}).textContent || '' : input.value;
            return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          }, arg);
        }
        if (value === null || value === '') throw new Error(`capture ${name}: no value found for ${source} ${arg}`.trim());
        captured[name] = value;
        saveReport();
        console.log(`  captured ${name} = ${JSON.stringify(value)}`);

      } else if (cmd !== '') {
        throw new Error(`  Unknown command: ${cmd}`);
      }
    };

    const HARD = Math.max(actionTimeout * 4, 60000);
    let hardTimer = null;
    try {
      const p = dispatch();
      p.catch(() => {}); // swallow a late rejection if the hard cap fires first
      const hardP = new Promise((_, rej) => { hardTimer = setTimeout(() => rej(new Error('__HARD_TIMEOUT__')), HARD); });
      const res = await Promise.race([p, hardP]);
      step.status = 'passed';
      if (res === 'STOP') stop = true;
    } catch (e) {
      const msg = maskSecrets(e && e.message ? String(e.message).split('\n')[0] : String(e));
      step.status = 'failed';
      step.error = msg;
      if (currentStep && cmd !== 'step') { currentStep.status = 'failed'; currentStep.error = currentStep.error || msg; }
      const tgt = ['login', 'cookie'].includes(cmd) ? '[redacted]' : templateRest.trim();
      if (msg === '__HARD_TIMEOUT__') {
        console.error(`  TIMEOUT on ${cmd} ${tgt} — exceeded ${Math.max(actionTimeout * 4, 60000)}ms hard cap`);
      } else if (/timeout|exceeded/i.test(msg)) {
        console.error(`  TIMEOUT on ${cmd} ${tgt} (${actionTimeout}ms): ${msg}`);
      } else {
        console.error(`  ERROR [${cmd}]: ${msg}`);
      }
      if (strict || e.fatal || ['login'].includes(cmd) || msg === '__HARD_TIMEOUT__') { console.error('  aborting flow after failure'); aborted = true; }
    } finally {
      activeStep = null;
      step.duration_ms = Date.now() - stepStart;
      saveReport();
      if (hardTimer) clearTimeout(hardTimer); // don't leave a 60s timer keeping the process alive
    }
    if (stop || aborted) break;
  }

  // A flow that ends without `done` (EOF, strict abort) still closes and
  // photographs its last manual step.
  await closeStep();
  rl.close();
  console.log('\nStopping trace...');
  // Persist the login session so the next run against the same host+db
  // can skip the login step entirely
  if (sessionFile) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    await context.storageState({ path: sessionFile }).catch(() => {});
  }
  await runtimeEvidence.finish();
  await context.tracing.stop({ path: traceFile });
  tracing = false;
  await browser.close();

  // Clean up this run's loose screenshots — they're captured in the trace, so
  // one flow leaves just <label>.zip + <label>.log. KEEP_SHOTS=1 to keep them.
  if (!keepShots && shots.length) {
    let n = 0;
    for (const p of shots) { try { fs.unlinkSync(p); n++; } catch { /* already gone */ } }
    if (n) console.log(`Cleaned ${n} screenshot(s) (they're in the trace; set KEEP_SHOTS=1 to keep)`);
  } else if (keepShots && shots.length) {
    console.log(`Kept ${shots.length} screenshot(s) (KEEP_SHOTS=1)`);
  }

  const size = fs.statSync(traceFile).size;
  console.log(`\nTrace saved: ${traceFile}`);
  console.log(`Size:        ${(size / 1024).toFixed(0)} KB\n`);
  console.log('View options:');
  console.log(`  npx playwright show-trace ${path.relative(process.cwd(), traceFile)}`);
  console.log(`  drag-drop to https://trace.playwright.dev`);
} catch (e) {
  report.error = String(e.message || e);
  console.error(`Run failed: ${report.error}`);
} finally {
  clearInterval(heartbeat);
  if (runtimeEvidence) await runtimeEvidence.finish();
  if (tracing && context) {
    try { await context.tracing.stop({ path: traceFile }); }
    catch (e) { report.cleanup_error = e.message; }
  }
  if (browser) await browser.close().catch(() => {});
  if (!report.steps.length && !report.error) report.error = 'No commands were executed';
  report.finished_at = new Date().toISOString();
  report.failed_steps = report.steps.filter(step => step.status !== 'passed').length;
  report.status = report.error || report.cleanup_error || report.failed_steps ? 'failed' : 'passed';
  process.exitCode = report.status === 'passed' ? 0 : 1;
  saveReport();
  console.log(`Result: ${report.status.toUpperCase()} — ${report.failed_steps} failed step(s). ${resultFile}`);
}
})().catch(e => { console.error(e.message); process.exitCode = 1; });
