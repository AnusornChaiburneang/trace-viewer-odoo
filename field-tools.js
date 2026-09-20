// Odoo 17 DOM helpers. Use normal widget events; never write through OWL/ORM internals.
const { randomUUID } = require('crypto');
const norm = value => String(value).replace(/\s+/g, ' ').trim();
const fieldName = name => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name || '')) throw new Error(`Invalid Odoo field name: ${name}`);
  return name;
};
const attr = value => JSON.stringify(String(value));

function createFieldTools(page, waitIdle, getTimeout) {
  async function withScope(action) {
    await waitIdle();
    const token = randomUUID();
    const chosen = await page.evaluate(token => {
      const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const modals = [...document.querySelectorAll('.modal')].filter(visible);
      // Bootstrap/Odoo overlays use z-index; DOM order breaks ties for stacked dialogs.
      modals.sort((a, b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
      let scope = modals.at(-1);
      if (!scope) {
        const forms = [...document.querySelectorAll('.o_action_manager .o_form_view, .o_form_view')]
          .filter(el => visible(el) && !el.closest('.modal'));
        if (forms.length !== 1) return { error: `expected one active form, found ${forms.length}` };
        scope = forms[0];
      }
      if (scope.closest('[inert]')) return { error: 'active form/dialog is inert' };
      scope.setAttribute('data-pw-field-scope', token);
      return { modal: scope.matches('.modal') };
    }, token);
    if (chosen.error) throw new Error(chosen.error);
    const scope = page.locator(`[data-pw-field-scope=${attr(token)}]`);
    try { return await action(scope); }
    finally { await scope.evaluate(el => el.removeAttribute('data-pw-field-scope')).catch(() => {}); }
  }

  async function namedWidget(scope, name) {
    fieldName(name);
    const candidates = await scope.locator(`.o_field_widget[name=${attr(name)}]:visible`).all();
    const widgets = [];
    for (const candidate of candidates) {
      if (!await candidate.evaluate(el => !!el.closest('tr.o_data_row'))) widgets.push(candidate);
    }
    if (widgets.length !== 1) {
      const available = await scope.locator('.o_field_widget[name]:visible').evaluateAll(els =>
        [...new Set(els.filter(el => !el.closest('tr.o_data_row')).map(el => el.getAttribute('name')))]);
      throw new Error(`field ${name}: expected one visible widget, found ${widgets.length}; available fields: ${available.join(', ')}`);
    }
    return widgets[0];
  }

  async function ensureWritable(widget) {
    if (await widget.evaluate(el => !!el.closest('.o_readonly_modifier, .o_form_readonly, [inert]')))
      throw new Error('Field is readonly; enter Edit mode or choose an editable record');
  }

  async function setWidget(widget, value, scope) {
    await ensureWritable(widget);
    const unsupported = await widget.evaluate(el => el.matches('.o_field_date, .o_field_datetime, .o_field_daterange, .o_field_many2many_tags, .o_field_one2many, .o_field_many2many') || !!el.querySelector('.o_field_date, .o_field_datetime, .o_field_daterange, .o_field_many2many_tags, input[type="file"]'));
    if (unsupported) throw new Error('Unsupported composite/date/file widget; use its dedicated trace command');
    let expected = value, kind = 'text';
    const radios = widget.locator('input[type="radio"]:visible');
    const boxes = widget.locator('input[type="checkbox"]:visible');
    const selects = widget.locator('select:visible');
    const inputs = widget.locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):visible, textarea:visible');
    if (await radios.count()) {
      const options = await radios.evaluateAll(els => els.map(el => ({
        key: el.getAttribute('data-value') || el.value,
        label: [...(el.labels || [])].map(l => l.textContent).join(' ').replace(/\s+/g, ' ').trim(),
      })));
      const matches = options.map((option, i) => ({ ...option, i })).filter(option => option.key === value || option.label === norm(value));
      if (matches.length !== 1) throw new Error(`Radio option must match once: ${value}; options: ${options.map(o => o.label).join(' | ')}`);
      expected = matches[0].key; kind = 'radio';
      await radios.nth(matches[0].i).check();
    } else if (await boxes.count()) {
      if (await boxes.count() !== 1) throw new Error('Ambiguous checkbox widget');
      if (!/^(on|off|true|false|1|0)$/i.test(value)) throw new Error('Boolean value must be on/off or true/false');
      expected = /^(on|true|1)$/i.test(value); kind = 'boolean';
      await boxes.setChecked(expected);
    } else if (await selects.count()) {
      if (await selects.count() !== 1) throw new Error('Ambiguous selection widget');
      const choices = await selects.locator('option').evaluateAll(els => els.map(el => ({ value: el.value, label: el.textContent.trim(), disabled: el.disabled })));
      const matching = choices.filter(o => !o.disabled && (o.label === value || o.value === value));
      if (matching.length !== 1) throw new Error(`Selection must match once: ${value}; options: ${choices.map(o => o.label).join(' | ')}`);
      expected = matching[0].value; kind = 'selection';
      await selects.selectOption(expected);
    } else {
      if (await inputs.count() !== 1) throw new Error(`Expected one editable input, found ${await inputs.count()}; field may be readonly or use an unsupported widget`);
      if (!await inputs.isEditable()) throw new Error('Input is readonly or disabled');
      const autocomplete = await inputs.getAttribute('role') === 'combobox';
      await inputs.fill(value);
      if (autocomplete) {
        kind = 'many2one';
        // Only exact existing options in THIS widget. Never choose Create/Search More.
        const deadline = Date.now() + getTimeout();
        let picked = false, candidates = [];
        do {
          const options = widget.locator('.o-autocomplete--dropdown-item:visible:not(.o_m2o_dropdown_option):not(.o_m2o_start_typing):not(.o_m2o_no_result)');
          candidates = await options.allTextContents();
          const matching = candidates.map((text, i) => ({ text: norm(text), i }))
            .filter(o => !/^(loading|searching)[.\u2026\s]*$/i.test(o.text) && o.text === norm(value));
          if (matching.length > 1) throw new Error(`Ambiguous autocomplete option: ${value}`);
          if (matching.length === 1) { await options.nth(matching[0].i).click(); picked = true; break; }
          await page.waitForTimeout(100);
        } while (Date.now() < deadline);
        if (!picked) throw new Error(`Existing autocomplete option not found: ${value}; candidates: ${candidates.map(norm).join(' | ')}`);
      } else {
        // Odoo useInputField commits through change/blur; a DOM fill alone is insufficient.
        await inputs.dispatchEvent('change');
      }
    }
    // Blur without Tab/Escape: neither move to a different row nor dismiss the dialog.
    await widget.evaluate(el => { if (el.contains(document.activeElement)) document.activeElement.blur(); });
    await waitIdle();
    if (!await scope.isVisible() || await scope.evaluate(el => !!el.closest('[inert]')))
      throw new Error('Editing changed or blocked the active form/dialog');
    const outcome = await widget.evaluate((el, args) => {
      const { kind, expected } = args;
      if (el.matches('.o_field_invalid, .o_invalid_cell') || el.querySelector('.o_field_invalid, .o_invalid_cell, [aria-invalid="true"]'))
        return { ok: false, actual: 'Odoo marked the field invalid' };
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const controls = [...el.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(visible);
      let actual;
      if (kind === 'boolean') actual = controls.find(e => e.type === 'checkbox')?.checked;
      else if (kind === 'radio') {
        const radio = controls.find(e => e.type === 'radio' && e.checked);
        actual = radio && (radio.getAttribute('data-value') || radio.value);
      } else {
        const control = controls.find(e => e.type !== 'radio' && e.type !== 'checkbox');
        actual = control ? control.value : (el.textContent || '').trim();
      }
      if (actual === expected) return { ok: true, actual };
      const numeric = kind === 'text' && (el.matches('.o_field_float, .o_field_integer, .o_field_monetary, .o_field_percentage, .o_list_number') || el.querySelector('input[type="number"]'));
      if (numeric && String(actual).trim() && String(expected).trim()) {
        // Read Odoo's loaded locale parser; never guess the database's decimal separator.
        const parser = window.odoo?.loader?.modules?.get('@web/views/fields/parsers')?.parseFloat;
        const parse = el.querySelector('input[type="number"]') ? Number : parser || (text => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN);
        try {
          const a = parse(String(actual)), b = parse(String(expected));
          if (Number.isFinite(a) && Number.isFinite(b) && a === b) return { ok: true, actual };
        } catch { /* report mismatch below */ }
      }
      return { ok: false, actual };
    }, { kind, expected });
    if (!outcome.ok) throw new Error(`Value did not stick after change/blur: expected ${JSON.stringify(expected)}, got ${JSON.stringify(outcome.actual)}`);
    return outcome.actual;
  }

  async function field(name, value) {
    return withScope(async scope => setWidget(await namedWidget(scope, name), value, scope));
  }

  async function rowset(tableField, rowSpec, column, value) {
    fieldName(column);
    return withScope(async scope => {
      const container = await namedWidget(scope, tableField);
      await ensureWritable(container);
      const table = container.locator('table.o_list_table:visible');
      if (await table.count() !== 1) throw new Error(`Expected one visible list table in ${tableField}`);
      const rows = table.locator(':scope > tbody > tr.o_data_row:visible');
      let selected;
      if (/^#[1-9]\d*$/.test(rowSpec)) {
        const index = Number(rowSpec.slice(1)) - 1;
        if (index < await rows.count()) selected = rows.nth(index);
      } else {
        const match = rowSpec.match(/^([a-zA-Z_]\w*)=(.*)$/s);
        if (!match) throw new Error('Row must be #<visible position> or <field>=<exact value>');
        const matches = [];
        for (const row of await rows.all()) {
          const cell = row.locator(`:scope > td[name=${attr(match[1])}]`);
          if (await cell.count() !== 1) continue;
          const text = await cell.evaluate(el => {
            const input = el.querySelector('input:not([type="hidden"]), textarea');
            return input ? input.value : el.textContent;
          });
          if (norm(text) === norm(match[2])) matches.push(row);
        }
        if (matches.length > 1) throw new Error(`Ambiguous row ${rowSpec}: ${matches.length} matches; use #<position>`);
        selected = matches[0];
      }
      if (!selected) throw new Error(`Row not found: ${rowSpec}; ${await rows.count()} visible data rows in ${tableField}`);
      // Bind to Odoo's UI row identity BEFORE editing; never retarget by the value being changed.
      const id = await selected.getAttribute('data-id');
      if (!id) throw new Error('Row has no stable data-id; cannot verify it across a rerender');
      const row = table.locator(`:scope > tbody > tr.o_data_row[data-id=${attr(id)}]`);
      if (await row.count() !== 1) throw new Error(`Ambiguous row identity: ${id}`);
      const cell = row.locator(`:scope > td[name=${attr(column)}]`);
      if (await cell.count() !== 1 || !await cell.isVisible()) {
        const columns = await row.locator(':scope > td[name]').evaluateAll(els => els.map(e => e.getAttribute('name')));
        throw new Error(`Column ${column} not found/visible; columns: ${columns.join(', ')}`);
      }
      await ensureWritable(cell);
      // ListRenderer.onCellClicked enters edit mode asynchronously. The stable locator
      // resolves the replacement cell when OWL rerenders the row.
      await cell.evaluate(el => el.click());
      await cell.locator('input:not([type="hidden"]):visible, textarea:visible, select:visible').first().waitFor({ state: 'visible', timeout: getTimeout() });
      return setWidget(cell, value, scope);
    });
  }
  return { field, rowset };
}
module.exports = { createFieldTools };
