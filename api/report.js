// Test report (self-contained HTML) built from the manifest: what was checked in
// every step and whether it held, with the screenshots. The draft manual hides
// failures; this report is for whoever has to judge the run, so it shows them.
const fs = require('fs');
const path = require('path');
const { readZip } = require('./zip');

const WORDS = {
  th: { report: 'รายงานผลทดสอบ', step: 'ขั้นตอน', result: 'ผล', shots: 'ภาพหน้าจอ', failures: 'จุดที่ไม่ผ่าน',
    final: 'ภาพสุดท้าย (หน้าจอตอนจบ)', skipped: 'ไม่ได้ทำ', target: 'ระบบ', db: 'ฐานข้อมูล', run: 'Run',
    finished: 'จบเมื่อ', checks: 'ตรวจก่อนรัน', summary: 'สรุป', noShots: 'ไม่มีภาพ', errorDialog: 'ไม่มี error dialog' },
  en: { report: 'Test report', step: 'Step', result: 'Result', shots: 'Screenshots', failures: 'Failures',
    final: 'Last screen', skipped: 'Not run', target: 'Target', db: 'Database', run: 'Run',
    finished: 'Finished', checks: 'Static checks', summary: 'Summary', noShots: 'No screenshots', errorDialog: 'No error dialog' },
};
const words = (lang) => WORDS[lang.slice(0, 2)] || WORDS.en;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Same tokenizing rule as the flow parser: single quotes group words.
function tokens(line) {
  const out = []; let cur = '', quoted = false, any = false;
  for (const ch of String(line)) {
    if (ch === "'") { quoted = !quoted; any = true; continue; }
    if (/\s/.test(ch) && !quoted) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

// One entry per expect / mark / capture command inside a manual step's line range.
function stepChecks(result, manualStep) {
  const lo = manualStep.line || 0, hi = manualStep.end_line || manualStep.last_line || Infinity;
  const captured = result.captured || {};
  const checks = [];
  for (const c of result.steps || []) {
    if (!(c.line > lo && c.line <= hi)) continue;
    const [cmd, ...rest] = tokens(c.command || '');
    const base = { line: c.line, status: c.status, error: c.error || null };
    if (cmd === 'expect' && rest.length) {
      const [kind, ...args] = rest;
      checks.push({ kind: 'expect', label: clip(`${kind} ${args.join(' ')}`, 120), ...base });
    } else if (cmd === 'mark' && rest.length > 1) {
      checks.push({ kind: 'mark', label: clip(rest[rest.length - 1], 120), ...base });
    } else if (cmd === 'capture' && rest.length) {
      const v = Object.prototype.hasOwnProperty.call(captured, rest[0]) ? captured[rest[0]] : null;
      checks.push({ kind: 'capture', label: clip(`${rest[0]} = ${v ?? '—'}`, 120), ...base });
    } else if (c.status !== 'passed') {
      // Any other command that broke is the reason the step failed: show it.
      checks.push({ kind: 'command', label: clip(c.command, 120), ...base });
    }
  }
  return checks;
}

// The screencast frame Playwright recorded last: the screen as the transaction ended.
function extractFinalFrame(traceZip, dest) {
  try {
    const entries = readZip(traceZip);
    let best = null, bestTs = -1;
    for (const name of Object.keys(entries)) {
      const m = name.match(/page@[^/]*-(\d+)\.jpe?g$/);
      if (m && Number(m[1]) > bestTs) { best = name; bestTs = Number(m[1]); }
    }
    if (!best) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entries[best]());
    return true;
  } catch { return false; }
}

function checkLabel(c, w) {
  if (c.kind === 'expect' && /^hidden \.o_error_dialog$/.test(c.label)) return w.errorDialog;
  if (c.kind === 'expect' && c.label.startsWith('state ')) return `state = ${c.label.slice(6)}`;
  return c.label;
}

function renderReport(manifest, lang, runDir) {
  const w = words(lang);
  const res = manifest.results[lang];
  const img = (rel) => {
    if (!rel) return null;
    try {
      const mime = /\.jpe?g$/i.test(rel) ? 'image/jpeg' : 'image/png';
      return `data:${mime};base64,${fs.readFileSync(path.join(runDir, 'bundle', rel)).toString('base64')}`;
    } catch { return null; }
  };
  const passed = res.status === 'passed';
  let nSteps = 0, nFailed = 0;
  const figures = [], rows = [], failures = [];
  for (const tx of res.transactions) {
    if (tx.status === 'skipped') {
      rows.push(`<tr class="bad"><td>${esc(tx.id)} ${esc(tx.title)}</td><td>⏭ ${esc(w.skipped)} — ${esc(tx.error || '')}</td></tr>`);
      continue;
    }
    for (const st of tx.steps || []) {
      nSteps++;
      const ok = st.status === 'passed';
      if (!ok) { nFailed++; failures.push(`<li><b>${esc(tx.id)}.${st.no} ${esc(st.title)}</b><br><code>${esc(clip(st.error, 300))}</code></li>`); }
      const checks = (st.checks || []).map(c => `<li class="${c.status === 'passed' ? '' : 'x'}">${c.status === 'passed' ? '✓' : '✗'} ${esc(checkLabel(c, w))}`
        + (c.status !== 'passed' && c.error ? `<br><small>${esc(clip(c.error, 200))}</small>` : '') + '</li>').join('');
      rows.push(`<tr class="${ok ? '' : 'bad'}"><td>${esc(tx.id)}.${st.no} ${esc(st.title)}</td><td>${ok ? '✅' : '❌'} ${esc(st.description || '')}`
        + (checks ? `<ul>${checks}</ul>` : '') + '</td></tr>');
      const src = img(st.screenshot);
      if (src) figures.push(figure(`${tx.id}.${st.no} ${st.title}`, ok, ok ? '' : st.error, src));
    }
    if (tx.status === 'failed' && !(tx.steps || []).length) {
      nFailed++;
      failures.push(`<li><b>${esc(tx.id)} ${esc(tx.title)}</b><br><code>${esc(clip(tx.error, 300))}</code></li>`);
      rows.push(`<tr class="bad"><td>${esc(tx.id)} ${esc(tx.title)}</td><td>❌ ${esc(clip(tx.error, 300))}</td></tr>`);
    }
    const last = img(tx.final_screenshot);
    if (last) figures.push(figure(`${tx.id} ${w.final}`, tx.status === 'passed', tx.status === 'passed' ? '' : tx.error, last));
  }
  const facts = [
    [w.target, `${manifest.target.url}`], [w.db, manifest.target.db], ['Version', manifest.target.version || '—'],
    [w.run, manifest.run_id], [w.finished, manifest.finished_at || '—'],
    [w.checks, (manifest.static_checks || []).map(c => `${c.name}=${c.status}`).join(', ') || '—'],
    [w.summary, `${res.status} — ${nSteps} steps, ${nFailed} failed`],
  ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

  return `<!doctype html><html lang="${esc(lang.slice(0, 2))}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.report)} ${esc(manifest.run_id)}</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#1f7a3a;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--fg:#ecebe6;--muted:#a3a29c;--card:#252524;--line:#3a3a38;--ok:#5cc27a;--bad:#f0766a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Sarabun","Noto Sans Thai",system-ui,sans-serif}
main{max-width:1100px;margin:auto;padding:24px 16px}h1{margin:0 0 4px;font-size:22px}
.verdict{font-weight:700;color:var(${passed ? '--ok' : '--bad'})}
table{border-collapse:collapse;margin:16px 0;width:100%;background:var(--card)}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
table.facts th{width:160px;color:var(--muted);font-weight:500}
ul.fail{background:var(--card);border-left:4px solid var(--bad);padding:12px 12px 12px 32px}code{font-size:13px;word-break:break-word}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,480px),1fr))}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
figure.bad{border-color:var(--bad)}figcaption{padding:8px 12px}figcaption span{color:var(--bad);font-size:13px}
img{display:block;width:100%;height:auto;border-top:1px solid var(--line)}
table.steps th{font-weight:600}table.steps td:first-child{width:38%}
table.steps ul{margin:4px 0 0;padding-left:4px;list-style:none;color:var(--muted);font-size:13px}
table.steps li.x,table.steps tr.bad td:last-child{color:var(--bad)}
</style></head><body><main>
<h1>${esc(w.report)}</h1><div class="verdict">${esc(res.status.toUpperCase())}</div>
<table class="facts">${facts}</table>
${failures.length ? `<h2>${esc(w.failures)}</h2><ul class="fail">${failures.join('')}</ul>` : ''}
<h2>${esc(w.shots)} (${figures.length})</h2><div class="grid">${figures.join('') || `<p>${esc(w.noShots)}</p>`}</div>
<h2>${esc(w.step)} / ${esc(w.result)}</h2><table class="steps"><tr><th>${esc(w.step)}</th><th>${esc(w.result)}</th></tr>${rows.join('')}</table>
</main></body></html>
`;
}

function figure(caption, ok, note, src) {
  return `<figure class="${ok ? 'ok' : 'bad'}"><figcaption><b>${esc(caption)}</b> ${ok ? '✅' : '❌'}`
    + (note ? `<br><span>${esc(clip(note, 200))}</span>` : '') + `</figcaption><img src="${src}" alt="${esc(caption)}" loading="lazy"></figure>`;
}

module.exports = { stepChecks, extractFinalFrame, renderReport, tokens };
