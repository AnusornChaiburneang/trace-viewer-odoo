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
// Trace saved to ./traces/<name>.zip
// View:  npx playwright show-trace traces/<name>.zip
//        or drag-drop to https://trace.playwright.dev

const { chromium } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const label = process.argv[2];
const targetUrl = process.argv[3] || 'http://localhost:8069/web/login';

if (!label) {
  console.error('Usage: node pw_trace.js <name> [target_url]');
  console.error('Example: node pw_trace.js DEMO http://localhost:8069/web/login');
  process.exit(1);
}

const tracesDir = process.env.TRACE_OUT_DIR || path.join(__dirname, 'traces');
if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });

const traceFile = path.join(tracesDir, `${label}.zip`);

(async () => {
  console.log(`\nStarting trace: ${label}`);
  console.log(`Target:  ${targetUrl}`);
  console.log(`Output:  ${traceFile}`);

  const browser = await chromium.launch({ headless: true });

  // Reuse the login session between runs (cookies persisted per host+port+db)
  // so flows don't have to log in every single time
  const sessionsDir = path.join(__dirname, '.sessions');
  let sessionFile = null;
  try {
    const u = new URL(targetUrl);
    const db = u.searchParams.get('db') || 'default';
    sessionFile = path.join(sessionsDir, `${u.hostname}_${u.port || '80'}_${db}.json`);
  } catch { /* non-URL target — skip session reuse */ }

  const contextOpts = { viewport: { width: 1440, height: 900 } };
  if (sessionFile && fs.existsSync(sessionFile)) {
    contextOpts.storageState = sessionFile;
    console.log(`Session: reusing saved login (${path.basename(sessionFile)})`);
  }
  const context = await browser.newContext(contextOpts);

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

  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();

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

  console.log('\n--- Commands ---');
  console.log('  login <user> <pass>      log in — auto-skips if the saved session is still valid');
  console.log('  goto <url>               navigate');
  console.log('  mode human|quick         nav style for navmenu (human=click through, quick=jump via @id)');
  console.log('  navmenu A > B > C [@id]   navigate by clicking menu labels (human) or #action=id (quick)');
  console.log('  click <sel>              standard Playwright click (waits for visibility)');
  console.log('  fclick <sel>             force click (bypasses visibility checks)');
  console.log('  jclick <sel>             JS .click() (OWL2-friendly for Odoo SPA buttons)');
  console.log('  clickbtn <text>          click button by visible label (prints internal name)');
  console.log('  buttons                  list visible buttons: internal name + label');
  console.log('  fill <sel> <text>        fill input (use single quotes for selectors with spaces)');
  console.log('  type <text>              type text into focused element (keyboard events, no selector)');
  console.log('  m2o <cell_sel> <text>    many2one: click cell → type → pick first dropdown result');
  console.log('  addline <field_name>     add row to One2many list, waits for new row to appear');
  console.log('  press <key>              keyboard press (Enter, Tab, Escape, ArrowDown...)');
  console.log('  wait <ms>                pause (fixed — prefer waitidle/waitfor)');
  console.log('  waitidle [maxMs]         wait until Odoo is idle (network + loading overlay), fast');
  console.log('  screenshot [name]        save screenshot to traces/');
  console.log('  snapshot                 print page element tree (for selector discovery)');
  console.log('  eval <js>                evaluate JS and print result');
  console.log('  cookie <n> <v> [domain]  set a raw browser cookie (works for HttpOnly, e.g. session_id)');
  console.log('  highlight <sel>          draw Playwright\'s native pink box (screenshot-only, invisible in trace viewer)');
  console.log('  mark <sel> [caption]     inject a REAL red box+caption around an element (visible in trace viewer Snapshot tab)');
  console.log('  unmark                   remove all marks added by `mark`');
  console.log('  bbox <sel>               print an element\'s {x,y,width,height} viewport box (for custom annotation)');
  console.log('  evals <sel>              print outerHTML of matched elements (structure inspection)');
  console.log('  find <sel>               print matching elements (max 5)');
  console.log('  waitfor <sel>            wait for selector to appear');
  console.log('  url                      print current URL');
  console.log('  title                    print page title');
  console.log('  done                     stop trace, save zip, exit\n');

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
      // Overlays only count if visible — Odoo keeps a permanent hidden
      // <div class="o_loading"> in the DOM and toggles display
      const overlays = document.querySelectorAll('.o_loading_indicator, .o_loading, .o_blockUI');
      const visible = Array.from(overlays).some(el => el.offsetParent !== null);
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
    return Date.now() - t0;
  };

  // Navigation mode: 'human' clicks through the menu; 'quick' short-circuits
  // navmenu to goto #action=<id> when the flow supplies one (`... @<id>`).
  // Set per-flow with the `mode` directive, or via NAV_MODE env var.
  let navMode = (process.env.NAV_MODE || 'human').toLowerCase();
  if (navMode !== 'human' && navMode !== 'quick') navMode = 'human';

  // In-page resolver for one menu level. Matches on RENDERED visible text
  // (exact-then-contains, case-insensitive) so translated labels (e.g. Thai)
  // work — the flow author writes whatever appears on screen. Odoo 14 markup:
  //   app      → .o_menu_apps a.o_app
  //   section  → .o_menu_sections > li > a  (dropdown-toggle = opens; else leaf)
  //   dropdown → .dropdown-header (group, not clickable) + a.dropdown-item (leaf)
  const navPick = (spec) => page.evaluate((spec) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const w = norm(spec.label);
    const listText = els => els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);

    if (spec.level === 'app') {
      const items = Array.from(document.querySelectorAll('.o_menu_apps a.o_app'));
      const el = items.find(e => norm(e.textContent) === w) || items.find(e => norm(e.textContent).includes(w));
      if (!el) return { ok: false, candidates: listText(items) };
      el.click();
      return { ok: true, text: el.textContent.trim(), leaf: true };
    }

    if (spec.level === 'section') {
      const secs = Array.from(document.querySelectorAll('.o_menu_sections > li'));
      const getA = li => li.querySelector('a');
      const match = secs.find(li => { const a = getA(li); return a && norm(a.textContent) === w; })
                 || secs.find(li => { const a = getA(li); return a && norm(a.textContent).includes(w); });
      if (!match) return { ok: false, candidates: secs.map(li => { const a = getA(li); return a ? a.textContent.trim() : ''; }).filter(Boolean) };
      const a = getA(match);
      const isToggle = a.classList.contains('dropdown-toggle');
      a.click();
      return { ok: true, text: a.textContent.trim(), leaf: !isToggle };
    }

    // level === 'dropdown' — inside the currently open section dropdown
    const menu = document.querySelector('.o_menu_sections .dropdown-menu.show')
              || document.querySelector('.o_menu_sections li.show .dropdown-menu')
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
    const clickInfo = el => ({ ok: true, text: el.textContent.trim(), kind: 'item', leaf: !el.classList.contains('dropdown-toggle') });
    let el = items.find(e => norm(e.textContent) === w);
    if (el) { el.click(); return clickInfo(el); }
    let hd = headers.find(e => norm(e.textContent) === w);
    if (hd) return { ok: true, text: hd.textContent.trim(), kind: 'header' };
    el = items.find(e => norm(e.textContent).includes(w));
    if (el) { el.click(); return clickInfo(el); }
    hd = headers.find(e => norm(e.textContent).includes(w));
    if (hd) return { ok: true, text: hd.textContent.trim(), kind: 'header' };

    return { ok: false, candidates: nodes.map(n => (n.classList.contains('dropdown-header') ? '[group] ' : '') + n.textContent.trim()).filter(Boolean) };
  }, spec);

  // Walk a `>`-separated label path by clicking each menu level, with an
  // implicit waitidle between navigating clicks. Returns true on success.
  const navMenuWalk = async (labels) => {
    const showCandidates = list => (list || []).forEach(c => console.log(`      · ${c}`));

    // Level 0 — app: open the apps menu (for visual fidelity) then click it
    await page.evaluate(() => { const t = document.querySelector('.o_menu_apps a.full, .o_menu_apps .dropdown-toggle'); if (t) t.click(); }).catch(() => {});
    await page.waitForTimeout(250); // apps dropdown CSS animation (no network)
    let r = await navPick({ level: 'app', label: labels[0] });
    if (!r.ok) { console.log(`  navmenu NOT FOUND: "${labels[0]}" (app level)`); showCandidates(r.candidates); return false; }
    console.log(`  navmenu → app "${r.text}"`);
    await waitIdle();
    if (labels.length === 1) return true;

    // Level 1 — section (top menu bar of the current app)
    r = await navPick({ level: 'section', label: labels[1] });
    if (!r.ok) { console.log(`  navmenu NOT FOUND: "${labels[1]}" (section level)`); showCandidates(r.candidates); return false; }
    if (r.leaf) {
      console.log(`  navmenu → section "${r.text}" (leaf)`);
      await waitIdle();
      if (labels.length > 2) console.log(`  navmenu WARNING: "${r.text}" navigated but ${labels.length - 2} more label(s) remain`);
      return true;
    }
    console.log(`  navmenu → opened section "${r.text}"`);
    await page.waitForTimeout(250); // dropdown CSS animation

    // Levels 2+ — inside the open dropdown (group headers + leaf items)
    let group = null;
    for (let i = 2; i < labels.length; i++) {
      r = await navPick({ level: 'dropdown', label: labels[i], group });
      if (!r.ok) {
        console.log(`  navmenu NOT FOUND: "${labels[i]}" (under "${labels[i - 1]}")`);
        if (r.nomenu) console.log('      (no open dropdown menu found)');
        showCandidates(r.candidates);
        return false;
      }
      const isLast = i === labels.length - 1;
      if (r.kind === 'header') {
        group = r.text;
        console.log(`  navmenu → group "${r.text}"${isLast ? '  (WARNING: group header, not a clickable item)' : ''}`);
      } else {
        console.log(`  navmenu → item "${r.text}"${r.leaf ? '' : ' (submenu)'}`);
        group = null;
        if (r.leaf) await waitIdle();
        else await page.waitForTimeout(250);
      }
    }
    return true;
  };

  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    // Quote-aware tokenizer: 'my selector with spaces' becomes one token
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue; // skip empty lines and comments

    const parts = [];
    let cur = '', inQ = false;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "'" && !inQ) { inQ = true; }
      else if (raw[i] === "'" && inQ) { inQ = false; }
      else if (raw[i] === ' ' && !inQ) { if (cur) { parts.push(cur); cur = ''; } }
      else { cur += raw[i]; }
    }
    if (cur) parts.push(cur);

    const cmd = parts[0];
    // rawRest used by eval/jclick to avoid quote-stripping JS code
    const rawRest = raw.slice(cmd.length + 1);

    try {
      if (cmd === 'done') {
        break;

      } else if (cmd === 'goto') {
        await page.goto(parts.slice(1).join(' '), { timeout: 20000 });
        await page.waitForLoadState('domcontentloaded');
        console.log(`  → ${page.url()}`);

      } else if (cmd === 'mode') {
        // Set navigation mode for subsequent `navmenu` commands.
        // Usage: mode human   (click through menus)
        //        mode quick   (short-circuit navmenu to goto #action=<id>)
        const m = (parts[1] || '').toLowerCase();
        if (m === 'human' || m === 'quick') {
          navMode = m;
          console.log(`  nav mode: ${navMode}`);
        } else {
          console.log(`  mode expects 'human' or 'quick' (got "${parts[1] || ''}")`);
        }

      } else if (cmd === 'navmenu') {
        // Navigate by clicking menu items instead of a hash URL.
        // Usage: navmenu App > Section > [Group >] Item [@<actionId>]
        //   human mode → clicks each label in turn (shows the real breadcrumb)
        //   quick  mode → jumps to #action=<id> if @<id> is given; else clicks through
        let spec = rawRest.trim();
        let actionId = null;
        const m = spec.match(/\s*@(\d+)\s*$/);
        if (m) { actionId = m[1]; spec = spec.slice(0, m.index).trim(); }
        const labels = spec.split('>').map(s => s.trim()).filter(Boolean);
        if (labels.length === 0) {
          console.log('  navmenu: no menu path given (e.g. navmenu Inventory > Configuration > Products > Purchase Product Group)');
        } else if (navMode === 'quick' && actionId) {
          const origin = new URL(page.url()).origin;
          await page.goto(`${origin}/web#action=${actionId}`, { timeout: 20000 });
          const ms = await waitIdle(15000);
          console.log(`  navmenu [quick] → #action=${actionId} (${ms}ms): ${labels.join(' > ')}`);
        } else {
          if (navMode === 'quick' && !actionId) {
            console.log('  navmenu [quick] no @<actionId> supplied — clicking through instead');
          }
          await navMenuWalk(labels);
        }

      } else if (cmd === 'click') {
        await page.click(rawRest, { timeout: 30000 }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  clicked: ${rawRest}`);

      } else if (cmd === 'fclick') {
        // Force click — bypasses Playwright visibility/stability checks
        // Good for: SPA buttons that Playwright thinks aren't actionable
        await page.click(rawRest, { force: true, timeout: 15000 }).catch(async (e) => {
          const count = await page.evaluate((s) => document.querySelectorAll(s).length, rawRest).catch(() => -1);
          const hint = count === 0 ? 'selector matched 0 elements' : `selector matched ${count} element(s) but was not actionable`;
          throw new Error(`${e.message.split('\n')[0]} — ${hint}`);
        });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  fclicked: ${rawRest}`);

      } else if (cmd === 'jclick') {
        // JS click — dispatches .click() directly on the DOM element
        // Good for: Odoo OWL2 action buttons in forms
        const found = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          el.click();
          return true;
        }, rawRest);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`  jclicked (${found ? 'found' : 'NOT FOUND'}): ${rawRest}`);

      } else if (cmd === 'fill') {
        const sel = parts[1];
        const text = parts.slice(2).join(' ');
        await page.fill(sel, text);
        console.log(`  filled: ${sel} = "${text}"`);

      } else if (cmd === 'type') {
        // Type text into the currently-focused element via keyboard events (no selector needed)
        const text = parts.slice(1).join(' ');
        await page.keyboard.type(text, { delay: 50 });
        console.log(`  typed: "${text}"`);

      } else if (cmd === 'm2o') {
        // Many2one field helper: click cell → type search → wait for dropdown → pick first result
        // Fixes fill() failing on role="combobox" inputs in OWL editable tree rows
        const cellSel = parts[1];
        const searchText = parts.slice(2).join(' ');
        await page.click(cellSel, { timeout: 10000 });
        await page.keyboard.type(searchText, { delay: 50 });
        await page.waitForSelector('.o-autocomplete--dropdown-item', { timeout: 10000 });
        await page.click('.o-autocomplete--dropdown-item');
        console.log(`  m2o: ${cellSel} = "${searchText}"`);

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
        await page.waitForSelector('tr.o_selected_row', { timeout: 10000 });
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
            return j.result && j.result.uid ? { uid: j.result.uid, db: j.result.db } : null;
          } catch { return null; }
        });
        let sess = await getSession();
        // Guard against wrong-DB sessions: if the target URL pins a db (?db=...)
        // and the restored session belongs to a different one, discard it —
        // otherwise the trace would silently record against the wrong database
        const wantDb = (() => {
          try { return new URL(targetUrl).searchParams.get('db'); } catch { return null; }
        })();
        if (sess && wantDb && sess.db !== wantDb) {
          console.log(`  session is for db "${sess.db}" but target wants "${wantDb}" — discarding session, logging in fresh`);
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
            console.log(`  login FAILED for "${user}" — still on login form (check credentials/db)`);
          } else {
            const after = await getSession();
            console.log(`  logged in as ${user} (db=${after ? after.db : '?'}, ${ms}ms)`);
          }
        }

      } else if (cmd === 'screenshot') {
        const imgName = parts[1] || `${label}-${Date.now()}`;
        const imgPath = path.join(tracesDir, imgName.endsWith('.png') ? imgName : `${imgName}.png`);
        await page.screenshot({ path: imgPath, fullPage: true });
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
        const result = await page.evaluate(new Function(`return (${rawRest})`));
        console.log(`  eval: ${JSON.stringify(result)}`);

      } else if (cmd === 'highlight') {
        // Playwright's native highlight: draws a pink box around the element
        // directly in the live page — shows up in the next screenshot, but
        // NOT in the trace viewer's Snapshot/DOM tab (Playwright strips its
        // own debug overlay before serializing snapshots). Use `mark`
        // instead if the annotation needs to survive in the trace viewer.
        // Usage: highlight <selector>
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
        const sel = parts[1];
        const caption = parts.slice(2).join(' ');
        const rect = await page.locator(sel).first().boundingBox().catch(() => null);
        if (!rect) {
          console.log(`  mark NOT FOUND: ${sel}`);
        } else {
          await page.evaluate(({ rect, caption }) => {
            const box = document.createElement('div');
            box.setAttribute('data-pw-mark', '1');
            box.style.cssText = `position:fixed;left:${rect.x - 6}px;top:${rect.y - 6}px;` +
              `width:${rect.width + 12}px;height:${rect.height + 12}px;border:3px solid #dc1e1e;` +
              `border-radius:6px;z-index:2147483647;pointer-events:none;box-sizing:border-box;`;
            document.body.appendChild(box);
            if (caption) {
              const label = document.createElement('div');
              label.setAttribute('data-pw-mark', '1');
              label.textContent = caption;
              label.style.cssText = `position:fixed;left:${rect.x}px;top:${Math.max(rect.y - 38, 4)}px;` +
                `background:#dc1e1e;color:#fff;font:bold 14px sans-serif;padding:4px 10px;` +
                `border-radius:4px;z-index:2147483647;pointer-events:none;white-space:nowrap;`;
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
        // Click a button by its VISIBLE TEXT (exact match first, then contains, case-insensitive).
        // Use when you know the label but not the internal name. Prints the name it resolved to.
        const wanted = rawRest.trim().toLowerCase();
        const result = await page.evaluate((w) => {
          const els = Array.from(document.querySelectorAll('button, a[role="button"], .btn'))
            .filter(e => e.offsetParent !== null && !e.disabled);
          const norm = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
          const el = els.find(e => norm(e) === w) || els.find(e => norm(e).includes(w));
          if (!el) return null;
          el.click();
          return { text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), name: el.getAttribute('name') || '' };
        }, wanted);
        if (result) {
          console.log(`  clickbtn: "${result.text}" (name="${result.name}")`);
        } else {
          console.log(`  clickbtn NOT FOUND: "${rawRest}" — run 'buttons' to list what's visible`);
        }

      } else if (cmd === 'evals') {
        // Print outerHTML (first 300 chars) of each matched element — instant structure inspection
        const sel = rawRest;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            e.outerHTML.slice(0, 300)
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches for: ${sel})`);
        results.forEach((r, i) => console.log(`  [${i}] ${r}`));

      } else if (cmd === 'find') {
        const sel = rawRest;
        const results = await page.evaluate((s) => {
          return Array.from(document.querySelectorAll(s)).slice(0, 5).map(e =>
            `${e.tagName}.${e.className.replace(/\s+/g, '.')} | text="${e.textContent?.trim().slice(0, 60)}"`
          );
        }, sel);
        if (results.length === 0) console.log(`  (no matches)`);
        results.forEach(r => console.log(`  ${r}`));

      } else if (cmd === 'waitfor') {
        const sel = rawRest;
        await page.waitForSelector(sel, { timeout: 15000 });
        console.log(`  appeared: ${sel}`);

      } else if (cmd === 'url') {
        console.log(`  ${page.url()}`);

      } else if (cmd === 'title') {
        console.log(`  ${await page.title()}`);

      } else if (cmd !== '') {
        console.log(`  Unknown command: ${cmd}`);
      }
    } catch (e) {
      console.error(`  ERROR [${cmd}]: ${e.message.split('\n')[0]}`);
    }
  }

  rl.close();
  console.log('\nStopping trace...');
  // Persist the login session so the next run against the same host+db
  // can skip the login step entirely
  if (sessionFile) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    await context.storageState({ path: sessionFile }).catch(() => {});
  }
  await context.tracing.stop({ path: traceFile });
  await browser.close();

  const size = fs.statSync(traceFile).size;
  console.log(`\nTrace saved: ${traceFile}`);
  console.log(`Size:        ${(size / 1024).toFixed(0)} KB\n`);
  console.log('View options:');
  console.log(`  npx playwright show-trace ${path.relative(process.cwd(), traceFile)}`);
  console.log(`  drag-drop to https://trace.playwright.dev`);
})();
