import assert from 'node:assert/strict';

export async function verifyGridWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Grid lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Grid lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(`${connection.url}${path}`, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error(`Could not prepare the grid fixture: ${await response.text()}`);
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Grid lab');
    for (const field of [
      { name: 'Cost', type: 'number' }, { name: 'Done', type: 'checkbox' }, { name: 'Due', type: 'date' },
      { name: 'Time', type: 'datetime' }, { name: 'Notes', type: 'multiline' },
      { name: 'Status', type: 'singleSelect', options: [{ name: 'Ready' }, { name: 'Complete' }] },
      { name: 'Tags', type: 'multiSelect', options: [{ name: '中文' }, { name: 'Review' }] },
    ]) table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version });
    await call(`/tables/${table.id}/records`, 'POST', [{ values: {} }, { values: {} }]);
    for (const field of table.fields) await call(`/tables/${table.id}/views`, 'POST', {
      name: field.name, columns: table.fields.map(item => ({ fieldId: item.id, width: 260, hidden: item.id !== field.id })),
    });
    return table;
  });
  const read = () => page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    return fetch(`${connection.url}/tables/${id}/records?offset=0&limit=10`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    }).then(r => r.json()).then(result => result.records);
  }, fixture.id);
  const field = name => fixture.fields.find(field => field.name === name);
  const value = async name => (await read())[0].values[field(name).id];
  const editor = () => page.getByRole('textbox', { name: 'Cell value', exact: true });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  let lastClick = 0;
  const select = async (row = 0) => {
    const delay = 600 - (performance.now() - lastClick);
    if (delay > 0) await page.waitForTimeout(delay);
    await ready();
    const editing = await page.locator('.rowweave-cell-editor').count();
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36);
    lastClick = performance.now();
    if (!editing) {
      // Normalize Glide's repeated-click activation when this helper requests selection only.
      if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    }
  };
  const open = async name => {
    await page.getByRole('tab', { name, exact: true }).click();
    await select();
    await page.keyboard.press('Enter');
    await page.locator('.rowweave-cell-editor').waitFor();
  };
  const save = async () => {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
  };
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('2 records · 8 fields', { exact: true }).waitFor();

  await open('Cost');
  await editor().fill('not a number');
  await page.keyboard.press('Enter');
  await page.locator('.rowweave-cell-editor').getByRole('alert').waitFor();
  await select(1);
  assert.equal(await editor().inputValue(), 'not a number');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  assert.equal(await editor().inputValue(), 'not a number');
  assert.equal(await value('Cost'), null);
  await page.screenshot({ path: '.artifacts/desktop-grid-validation.png' });
  await editor().fill('12.5');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.keyboard.press('Control+z');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.keyboard.press('Control+y');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await save();
  assert.equal(await value('Cost'), 12.5);
  await open('Cost');
  await editor().fill('invalid again');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('.rowweave-cell-editor').waitFor({ state: 'detached' });
  await page.getByText('All changes saved', { exact: true }).waitFor();

  await open('Due');
  await page.getByLabel('Cell value', { exact: true }).fill('2026-12-31');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await save();
  assert.equal(await value('Due'), '2026-12-31');
  await open('Time');
  await page.getByLabel('Cell value (UTC)', { exact: true }).fill('2026-12-31T23:59:12.123');
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(await value('Time'), '2026-12-31T23:59:12.123Z');
  await open('Status');
  const statusEditor = page.getByLabel('Cell value', { exact: true });
  await statusEditor.selectOption({ label: 'Complete' });
  assert.equal(await statusEditor.inputValue(), field('Status').options[1].id);
  await page.getByText('Editing cell…', { exact: true }).waitFor();
  await statusEditor.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await save();
  assert.equal(await value('Status'), field('Status').options[1].id);
  await open('Tags');
  await page.getByLabel('Cell value', { exact: true }).selectOption([{ label: '中文' }, { label: 'Review' }]);
  await page.screenshot({ path: '.artifacts/desktop-grid-options.png' });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await save();
  assert.deepEqual(await value('Tags'), field('Tags').options.map(option => option.id));
  await open('Tags');
  await page.getByRole('button', { name: 'Clear Cell value', exact: true }).click();
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(await value('Tags'), null);

  await page.getByRole('tab', { name: 'Done', exact: true }).click();
  await select();
  await page.keyboard.press('Space');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
  await save();
  assert.equal(await value('Done'), true);
  await select();
  await page.keyboard.press('Delete');
  await save();
  assert.equal(await value('Done'), null);

  await open('Name');
  await page.keyboard.press('Enter');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(await value('Name'), null);
  await select();
  await page.keyboard.type('First key');
  assert.equal(await editor().inputValue(), 'First key');
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(await value('Name'), 'First key');

  await open('Notes');
  await editor().fill('First line');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Second line');
  await editor().dispatchEvent('compositionstart');
  await editor().fill('First line\nSecond line 中文');
  await editor().dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 1);
  await editor().dispatchEvent('compositionend', { data: '中文' });
  await page.keyboard.press('Tab');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await save();
  assert.equal(await value('Notes'), 'First line\nSecond line 中文');

  // Delete a two-row rectangle, then undo it as one action without touching stored data.
  await select();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Delete');
  await page.getByText('2 unsaved cells', { exact: true }).waitFor();
  await page.keyboard.press('Control+z');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(await value('Notes'), 'First line\nSecond line 中文');
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
