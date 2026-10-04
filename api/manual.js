// Draft user manual (Markdown + self-contained HTML) built from the manifest.
// One transaction = one chapter, one step = one section with its screenshot.
// A failed or skipped step gets a visible warning instead of a picture, so an
// image of something that did not work never slips into a manual.
const fs = require('fs');
const path = require('path');

const WORDS = {
  th: { step: 'ขั้นตอนที่', failed: 'ขั้นตอนนี้ทำไม่สำเร็จในการรันอัตโนมัติ จึงไม่มีภาพประกอบ', skipped: 'ไม่ได้ทำ (ข้ามเพราะขั้นก่อนหน้าไม่สำเร็จ)', contents: 'สารบัญ', generated: 'ร่างโดย Trace Kit', manual: 'คู่มือการใช้งาน' },
  en: { step: 'Step', failed: 'This step did not complete in the automated run, so it has no screenshot.', skipped: 'Not run (skipped because an earlier part failed)', contents: 'Contents', generated: 'Drafted by Trace Kit', manual: 'User manual' },
};
const words = (lang) => WORDS[lang.slice(0, 2)] || WORDS.en;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mdEsc = (s) => String(s ?? '').replace(/([\\`*_[\]#])/g, '\\$1');

function chapters(manifest, lang) {
  const result = manifest.results[lang];
  return result.transactions.map((t, i) => ({ no: i + 1, ...t }));
}

function renderMarkdown(manifest, lang, title) {
  const w = words(lang);
  const out = [`# ${mdEsc(title || w.manual)}`, '', `_${w.generated} · ${manifest.target.url} · ${manifest.finished_at || ''}_`, ''];
  for (const ch of chapters(manifest, lang)) {
    out.push(`## ${ch.no}. ${mdEsc(ch.title)}`, '');
    if (ch.status === 'skipped') { out.push(`> ⚠️ ${w.skipped}`, ''); continue; }
    for (const st of ch.steps) {
      out.push(`### ${w.step} ${ch.no}.${st.no} ${mdEsc(st.title)}`, '');
      if (st.description) out.push(mdEsc(st.description), '');
      if (st.status === 'passed' && st.screenshot) out.push(`![${mdEsc(st.title)}](../${st.screenshot})`, '');
      else out.push(`> ⚠️ ${w.failed}`, '');
    }
  }
  return out.join('\n');
}

function renderHtml(manifest, lang, title, runDir) {
  const w = words(lang);
  const img = (rel) => {
    try { return `data:image/png;base64,${fs.readFileSync(path.join(runDir, 'bundle', rel)).toString('base64')}`; }
    catch { return null; }
  };
  const chs = chapters(manifest, lang);
  const toc = chs.map(ch => `<li><a href="#ch${ch.no}">${ch.no}. ${esc(ch.title)}</a></li>`).join('');
  const body = chs.map(ch => {
    if (ch.status === 'skipped') return `<section id="ch${ch.no}"><h2>${ch.no}. ${esc(ch.title)}</h2><p class="warn">⚠️ ${esc(w.skipped)}</p></section>`;
    const steps = ch.steps.map(st => {
      const src = st.status === 'passed' && st.screenshot ? img(st.screenshot) : null;
      return `<article><h3>${esc(w.step)} ${ch.no}.${st.no} ${esc(st.title)}</h3>`
        + (st.description ? `<p>${esc(st.description)}</p>` : '')
        + (src ? `<figure><img src="${src}" alt="${esc(st.title)}" width="1440" height="900"></figure>` : `<p class="warn">⚠️ ${esc(w.failed)}</p>`)
        + '</article>';
    }).join('');
    return `<section id="ch${ch.no}"><h2>${ch.no}. ${esc(ch.title)}</h2>${steps}</section>`;
  }).join('');
  return `<!doctype html><html lang="${esc(lang.slice(0, 2))}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title || w.manual)}</title>
<style>
body{font-family:"Sarabun","IBM Plex Sans Thai","Noto Sans Thai","Segoe UI",system-ui,sans-serif;max-width:980px;margin:0 auto;padding:24px 16px 64px;line-height:1.7;color:#1f2933;background:#fff}
h1{font-size:30px;margin:0 0 4px}h2{font-size:22px;margin:40px 0 8px;padding-top:12px;border-top:1px solid #e3e7eb}
h3{font-size:17px;margin:24px 0 6px}.meta{color:#616e7c;font-size:13px;margin:0 0 24px}
figure{margin:8px 0 0}img{max-width:100%;height:auto;border:1px solid #d9dee3;border-radius:4px}
.warn{background:#fff7e0;border-left:3px solid #c98a00;padding:8px 12px;border-radius:4px}
nav ol{list-style:none;padding-left:0}
</style></head><body>
<h1>${esc(title || w.manual)}</h1>
<p class="meta">${esc(w.generated)} · ${esc(manifest.target.url)} · ${esc(manifest.finished_at || '')}</p>
<nav><strong>${esc(w.contents)}</strong><ol>${toc}</ol></nav>
${body}
</body></html>
`;
}

module.exports = { renderMarkdown, renderHtml };
