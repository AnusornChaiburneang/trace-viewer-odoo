#!/usr/bin/env node
// Unit test for pickFromDropdown — the autocomplete matcher shared by `pick`
// and `m2o`. It has had three separate bugs (blind-clicking the first item,
// clicking a "Loading..." placeholder, and picking Create options), so it gets
// real coverage.
//
// The function source is EXTRACTED from pw_trace.js rather than copied, so this
// test cannot silently drift from the implementation it claims to test.
//
//   node tests/unit_dropdown.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in pw_trace.js`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const KIT = path.join(__dirname, '..', 'pw_trace.js');
const FN = extractFn(fs.readFileSync(KIT, 'utf8'), 'pickFromDropdown');

// Each case: visible dropdown item texts -> what pick/m2o should do.
const CASES = [
  { name: 'only "Loading..." -> reports loading, clicks nothing',
    items: ['Loading...'], search: 'product it', expect: { loading: true } },

  { name: 'unicode ellipsis "Loading…" also treated as a placeholder',
    items: ['Loading…'], search: 'product it', expect: { loading: true } },

  { name: '"Searching..." also treated as a placeholder',
    items: ['Searching...'], search: 'product it', expect: { loading: true } },

  { name: 'two placeholders (the reported failure) -> loading, not a bogus match',
    items: ['Loading...', 'Loading...'], search: 'product it', expect: { loading: true } },

  { name: 'placeholder alongside real results -> picks the REAL one',
    items: ['Loading...', 'Product IT - A'], search: 'product it', expect: { text: 'Product IT - A' } },

  { name: 'exact match wins over a contains match',
    items: ['Product IT - A', 'Product IT'], search: 'product it', expect: { text: 'Product IT' } },

  { name: 'contains match when there is no exact one',
    items: ['RMA Demo Product A'], search: 'demo product', expect: { text: 'RMA Demo Product A' } },

  { name: 'never blind-clicks the first item when nothing matches',
    items: ['Totally Other Thing'], search: 'product it', expect: { notFound: true } },

  { name: 'Create options are not matched when a real option exists',
    items: ['Create "Product IT"', 'Product IT - A'], search: 'product it', expect: { text: 'Product IT - A' } },

  { name: 'hidden items are ignored -> treated as not-yet-rendered, not a match',
    items: ['Product IT - A'], hide: true, search: 'product it',
    expect: { loading: true, empty: true } },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let pass = 0, fail = 0;

  for (const c of CASES) {
    const html = `<!doctype html><ul class="o-autocomplete--dropdown-menu">` +
      c.items.map(t => `<li class="o-autocomplete--dropdown-item"` +
        (c.hide ? ' style="display:none"' : '') + `>${t}</li>`).join('') + `</ul>`;
    await page.setContent(html);
    // expose the real function, then record what it clicked
    await page.evaluate(`window.__clicked = null;
      document.querySelectorAll('.o-autocomplete--dropdown-item').forEach(e =>
        e.addEventListener('click', () => { window.__clicked = e.textContent.trim(); }));
      window.pickFromDropdown = ${FN};`);
    const res = await page.evaluate(w => window.pickFromDropdown(w), c.search);
    const clicked = await page.evaluate(() => window.__clicked);

    const e = c.expect;
    let ok, detail;
    if (e.loading) {
      ok = res.loading === true && res.ok === false && clicked === null &&
           (e.empty === undefined || res.empty === e.empty);
      detail = `loading=${res.loading} empty=${res.empty} ok=${res.ok} clicked=${JSON.stringify(clicked)}`;
    } else if (e.notFound) {
      ok = res.ok === false && !res.loading && clicked === null;
      detail = `ok=${res.ok} loading=${res.loading} clicked=${JSON.stringify(clicked)}`;
    } else {
      ok = res.ok === true && res.text === e.text && clicked === e.text;
      detail = `text=${JSON.stringify(res.text)} clicked=${JSON.stringify(clicked)}`;
    }
    if (ok) { pass++; console.log(`  PASS  ${c.name}`); }
    else { fail++; console.log(`  FAIL  ${c.name}\n          got: ${detail}`); }
  }

  await browser.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
