import assert from 'node:assert/strict';

export async function verifyGroupedWorkflow(page, app) {
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const select = async (row, column = 0) => {
    await ready();
    await page.locator('canvas').first().waitFor({ state: 'visible' });
    const canvas = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(canvas.x + 100 + column * 180, canvas.y + 58 + row * 36, { delay: 50 });
    if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  };
  const copy = async expected => {
    await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
    await page.keyboard.press('Control+c');
    await page.evaluate(async expected => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === expected) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('The copied records did not match the selected group rows.');
    }, expected);
  };
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Grouped tasks');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Grouped tasks', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Grouped tasks');
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'planned', name: 'Planned' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] });
  const status = table.fields[1].id;
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Effort', type: 'number' });
  const effort = table.fields[2].id;
  const records = (await call(`/tables/${table.id}/records`, 'POST', Array.from({ length: 506 }, (_, index) => ({ values: {
    [table.primaryFieldId]: `Task ${index}`, [status]: index < 501 ? 'planned' : index < 503 ? 'doing' : index < 505 ? 'done' : null, [effort]: index,
  } })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('506 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('Grid group field', { exact: true }).selectOption(status);
  await page.screenshot({ path: '.artifacts/desktop-group-settings.png' });
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await ready();
  assert.equal((await call(`/tables/${table.id}/views`))[0].groupBy, status);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await page.locator('canvas').first().focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await select(4);
  await select(7);
  await page.screenshot({ path: '.artifacts/desktop-grouped-records.png' });
  await select(3);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await copy('Task 502\nTask 503');
  await select(3);
  await page.evaluate(() => navigator.clipboard.writeText('Doing draft\nDone draft'));
  await page.keyboard.press('Control+v');
  await page.getByText('2 unsaved cells', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByText('2 unsaved cells', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await ready();
  assert.equal((await call(`/tables/${table.id}/records/${records[502].id}`)).values[table.primaryFieldId], 'Doing draft');
  assert.equal((await call(`/tables/${table.id}/records/${records[503].id}`)).values[table.primaryFieldId], 'Done draft');
  assert.equal((await call(`/tables/${table.id}/records/${records[500].id}`)).version, 1);
  await select(1);
  await select(2, 1);
  await page.keyboard.press('Enter');
  await page.getByLabel('Cell value', { exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await ready();
  assert.equal((await call(`/tables/${table.id}/records/${records[501].id}`)).values[status], 'done');
  await select(2);
  await copy('Doing draft');
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Doing draft');
  await page.getByLabel('Effort', { exact: true }).fill('42');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal((await call(`/tables/${table.id}/records/${records[502].id}`)).values[effort], 42);
  await ready();
  await select(2, 2);
  await page.keyboard.press('Delete');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.keyboard.press('Control+z');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await select(2);
  await page.keyboard.press('Enter');
  const editor = page.getByLabel('Cell value', { exact: true });
  await editor.dispatchEvent('compositionstart');
  await editor.fill('中文分组草稿');
  await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 1);
  await editor.dispatchEvent('compositionend', { data: '中文' });
  await page.keyboard.press('Tab');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  const current = await call(`/tables/${table.id}/records/${records[502].id}`);
  await call(`/tables/${table.id}/records`, 'PATCH', [{ id: current.id, expectedVersion: current.version, values: { [effort]: 99 } }]);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await ready();
  await select(2);
  await copy('中文分组草稿');
  assert.equal((await call(`/tables/${table.id}/records/${records[502].id}`)).values[table.primaryFieldId], 'Doing draft');
  await app.evaluate(({ dialog }) => {
    globalThis.groupedPreviousDialog = dialog.showMessageBox;
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  try {
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    await ready();
  }
  finally { await app.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.groupedPreviousDialog; delete globalThis.groupedPreviousDialog; }); }
  await page.getByLabel('Search records', { exact: true }).fill('Task 505');
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  await ready();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await select(4);
  await copy('Task 505');
  await page.getByLabel('Search records', { exact: true }).fill('');
  await page.getByText('506 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  assert.equal(await page.getByLabel('Grid group field', { exact: true }).inputValue(), status);
  await page.getByLabel('Grid group field', { exact: true }).selectOption('');
  const savedView = (await call(`/tables/${table.id}/views`))[0];
  await call(`/tables/${table.id}/views/${savedView.id}`, 'PATCH', { expectedVersion: savedView.version, name: 'Updated groups' });
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'view changed' }).waitFor();
  assert.equal(await page.getByLabel('Grid group field', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('Grid group field', { exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await ready();
  assert.equal((await call(`/tables/${table.id}/views`))[0].groupBy, undefined);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), original);
}
