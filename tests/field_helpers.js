// Synthetic Odoo-shaped DOM tests: widget events, async row replacement, and scoping.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createFieldTools } = require('../field-tools');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(600);
  const helpers = createFieldTools(page, () => page.waitForTimeout(120), () => 450);
  const form = content => `<div class="o_form_view">${content}</div>`;
  const input = (name, value = '', extra = '') => `<div class="o_field_widget ${extra}" name="${name}"><input value="${value}"></div>`;
  const valueOf = selector => page.locator(selector).inputValue();
  let count = 0;
  async function test(name, fn) { await fn(); count++; console.log(`  PASS ${name}`); }
  await test('field wrapper resolves nested input and commits change', async () => {
    await page.setContent(form(input('amount', '0', 'o_field_float')));
    await page.locator('input').evaluate(el => el.addEventListener('change', () => window.committed = el.value));
    await helpers.field('amount','10');
    assert.equal(await page.evaluate(() => window.committed),'10');
  });
  await test('top dialog wins over underlying form and hidden duplicates', async () => {
    await page.setContent(form(input('amount','1')) + `<div class="modal" style="z-index:10">${input('amount','2')}</div><div class="modal" style="z-index:20">${input('amount','3')}<div style="display:none">${input('amount','4')}</div></div>`);
    await helpers.field('amount','10');
    assert.deepEqual(await page.locator('input').evaluateAll(els=>els.map(el=>el.value)),['1','2','10','4']);
  });
  await test('ambiguous fields fail without edits; missing fields list candidates', async () => {
    await page.setContent(form(input('amount','1')+input('amount','2')));
    await assert.rejects(helpers.field('amount','10'),/found 2/);
    await assert.rejects(helpers.field('missing','10'),/available fields: amount/);
    assert.deepEqual(await page.locator('input').evaluateAll(els=>els.map(el=>el.value)),['1','2']);
  });
  await test('readonly widgets and unsupported date widgets are rejected', async () => {
    await page.setContent(form(input('amount','1','o_readonly_modifier')+input('date','old','o_field_date')));
    await assert.rejects(helpers.field('amount','10'),/readonly/);
    await assert.rejects(helpers.field('date','new'),/Unsupported/);
  });
  await test('onchange-reverted and invalid inputs fail verification', async () => {
    await page.setContent(form(input('amount','1')));
    await page.locator('input').evaluate(el=>el.addEventListener('change',()=>setTimeout(()=>el.value='1',40)));
    await assert.rejects(helpers.field('amount','10'),/did not stick/);
    await page.setContent(form(input('amount','1')));
    await page.locator('input').evaluate(el=>el.addEventListener('change',()=>el.parentElement.classList.add('o_field_invalid')));
    await assert.rejects(helpers.field('amount','oops'),/invalid/);
  });
  await test('numeric display formatting uses actual Odoo locale parser', async () => {
    await page.setContent(form(input('amount','1,00','o_field_float')));
    await page.evaluate(()=> {
      window.odoo={loader:{modules:new Map([['@web/views/fields/parsers',{parseFloat:value=>Number(value.replaceAll('.','').replace(',','.'))}]])}};
      document.querySelector('input').addEventListener('change',e=> e.target.value='1.000,00');
    });
    assert.equal(await helpers.field('amount','1000,00'),'1.000,00');
    await page.evaluate(()=>delete window.odoo);
  });
  await test('checkbox, native selection and radio selection', async () => {
    await page.setContent(form(`<div class="o_field_widget" name="flag"><input type="checkbox"></div><div class="o_field_widget" name="choice"><select><option value="a">Alpha</option><option value="b">Beta</option></select></div><div class="o_field_widget" name="method"><input id="del" type="radio" name="method" data-value="delivered" checked><label for="del">Regular invoice</label><input id="pct" type="radio" name="method" data-value="percentage"><label for="pct">Down payment</label></div>`));
    assert.equal(await helpers.field('flag','on'),true);
    assert.equal(await helpers.field('choice','Beta'),'b');
    assert.equal(await helpers.field('method','percentage'),'percentage');
    await assert.rejects(helpers.field('flag','maybe'),/Boolean/);
  });
  await test('autocomplete waits and selects exact existing option in its widget', async () => {
    await page.setContent(form(`<div class="o_field_widget o_field_many2one" name="partner"><input role="combobox"></div>`));
    await page.locator('input').evaluate(el=>el.addEventListener('input',()=>{
      el.parentElement.querySelector('ul')?.remove();
      const menu=document.createElement('ul');el.parentElement.append(menu);
      menu.innerHTML='<li class="o-autocomplete--dropdown-item">Loading...</li>';
      setTimeout(()=>{
        menu.innerHTML='<li class="o-autocomplete--dropdown-item">Partner A</li>';
        menu.firstChild.addEventListener('click',()=>{el.value='Partner A';window.picked=true;menu.remove();});
      },150);
    }));
    assert.equal(await helpers.field('partner','Partner A'),'Partner A');
    assert.equal(await page.evaluate(()=>window.picked),true);
  });
  await test('autocomplete never clicks create options', async () => {
    await page.setContent(form(`<div class="o_field_widget" name="partner"><input role="combobox"><li class="o-autocomplete--dropdown-item o_m2o_dropdown_option">New Partner</li></div>`));
    await page.locator('li').evaluate(el=>el.addEventListener('click',()=>window.created=true));
    await assert.rejects(helpers.field('partner','New Partner'),/not found/);
    assert.notEqual(await page.evaluate(()=>window.created),true);
  });
  const table = `<div class="o_field_widget o_field_one2many" name="invoice_line_ids"><table class="o_list_table"><tbody>
<tr class="o_data_row" data-id="row-a"><td name="name">Service A</td><td name="quantity" class="o_list_number">1.00</td></tr>
<tr class="o_data_row" data-id="row-b"><td name="name">Service B</td><td name="quantity" class="o_list_number">7.00</td></tr>
</tbody></table></div>`;
  async function editableTable() {
    await page.setContent(form(table));
    await page.evaluate(()=>{
      window.rowValues={'row-a':1,'row-b':7};
      document.querySelector('tbody').addEventListener('click',event=>{
        const cell=event.target.closest('td'); if(!cell||cell.querySelector('input'))return;
        const row=cell.parentElement,id=row.dataset.id,name=cell.getAttribute('name');
        const text=cell.textContent;
        // Odoo replaces row/cell DOM asynchronously when entering edit mode.
        setTimeout(()=>{
          const replacement=row.cloneNode(true);row.replaceWith(replacement);
          const next=[...replacement.children].find(el=>el.getAttribute('name')===name);
          next.innerHTML='<input>';
          const input=next.firstChild;input.value=text;
          input.addEventListener('change',()=>{
            if(name==='quantity') { window.rowValues[id]=Number(input.value); input.value=Number(input.value).toFixed(2); }
            else window.editedName=input.value;
          });
        },80);
      });
    });
  }
  await test('existing numeric row enters edit mode across OWL-style DOM replacement', async () => {
    await editableTable();
    assert.equal(await helpers.rowset('invoice_line_ids','name=Service B','quantity','2'),'2.00');
    assert.deepEqual(await page.evaluate(()=>window.rowValues),{'row-a':1,'row-b':2});
  });
  await test('position-based row and changing its own matching column keep identity', async () => {
    await editableTable();
    await helpers.rowset('invoice_line_ids','#1','quantity','3');
    await helpers.rowset('invoice_line_ids','name=Service A','name','Renamed service');
    assert.equal(await page.evaluate(()=>window.editedName),'Renamed service');
    assert.equal(await page.locator('[data-id="row-b"] td[name="name"]').innerText(),'Service B');
  });
  await test('row ambiguity and missing columns fail before clicks', async () => {
    await editableTable();
    await page.locator('[data-id="row-b"] td[name="name"]').evaluate(el=>el.textContent='Service A');
    await assert.rejects(helpers.rowset('invoice_line_ids','name=Service A','quantity','2'),/Ambiguous row/);
    await assert.rejects(helpers.rowset('invoice_line_ids','#8','quantity','2'),/Row not found/);
    await assert.rejects(helpers.rowset('invoice_line_ids','#1','missing','2'),/columns: name, quantity/);
    assert.equal(await page.locator('td input').count(),0);
  });
  await test('readonly row cells never receive clicks or writes', async () => {
    await editableTable();
    await page.locator('[data-id="row-a"] td[name="quantity"]').evaluate(el=>el.classList.add('o_readonly_modifier'));
    await assert.rejects(helpers.rowset('invoice_line_ids','#1','quantity','2'),/readonly/);
    assert.deepEqual(await page.evaluate(()=>window.rowValues),{'row-a':1,'row-b':7});
  });
  await test('absent editor times out without typing into another field', async () => {
    await page.setContent(form(input('other','untouched')+table));
    await page.locator('input').focus();
    await assert.rejects(helpers.rowset('invoice_line_ids','#1','quantity','2'),/Timeout/);
    assert.equal(await valueOf('input'),'untouched');
  });
  assert.equal(await page.locator('[data-pw-field-scope]').count(),0);
  console.log(`\n  ${count} field/row helper tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
