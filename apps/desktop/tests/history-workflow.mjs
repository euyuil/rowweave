import assert from 'node:assert/strict';

export async function verifyHistoryWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], size = window.getSize(); window.setSize(1024, 768); return size;
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('History lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'History lab', exact: true }).waitFor();
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  let table = (await call('/tables')).find(table => table.name === 'History lab');
  for (const field of [{ name: 'Cost', type: 'number' }, { name: 'Notes', type: 'multiline' }, { name: 'Done', type: 'checkbox' }]) {
    table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version });
  }
  const [name, cost, notes, done] = table.fields.map(field => field.id);
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${cost}] * 2`, resultType: 'number' } });
  const double = table.fields.at(-1).id, root = `/tables/${table.id}`;
  let record = (await call(`${root}/records`, 'POST', [{ values: { [name]: 'Launch review', [cost]: 0, [notes]: 'Original notes\n中文 🌱 '.repeat(15), [done]: false } }])).records[0];
  const created = (await call(`${root}/records/${record.id}/history`, 'POST', {})).changes[0];
  for (let i = 1; i <= 12; i++) record = (await call(`${root}/records`, 'PATCH', [{ id: record.id, expectedVersion: record.version,
    values: { [cost]: i, [notes]: `Saved notes ${i}` } }])).records[0];
  const read = () => call(`${root}/records/${record.id}`);
  const dialog = page.getByRole('dialog'), history = dialog.getByRole('region', { name: 'Record history', exact: true });
  const open = async () => {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 15, bounds.y + 58);
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Launch review', exact: true }).waitFor();
  };
  const showHistory = async () => {
    await dialog.getByRole('button', { name: 'History', exact: true }).focus();
    await page.keyboard.press('Enter');
    await history.getByRole('region', { name: 'Saved change details', exact: true }).waitFor();
  };
  const selectOriginal = async () => {
    await history.getByRole('button', { name: 'Older changes', exact: true }).click();
    await history.getByRole('button', { name: `View change ${created.id}`, exact: true }).click();
    await history.getByRole('heading', { name: 'Record created → Version 1', exact: true }).waitFor();
  };
  await open(); await showHistory();
  assert.equal(await history.locator('.history-list > li').count(), 10);
  await selectOriginal();
  const details = history.getByRole('region', { name: 'Saved change details', exact: true });
  assert.match(await details.getByRole('row', { name: /Done/ }).innerText(), /false/);
  assert.match(await details.getByRole('row', { name: /Notes/ }).innerText(), /中文/);
  assert.equal(await details.getByRole('button', { name: 'Restore before change', exact: true }).isDisabled(), true);
  await details.getByRole('button', { name: 'Restore after change', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/desktop-record-history.png' });
  await details.getByRole('button', { name: 'Restore after change', exact: true }).click();
  const confirmation = history.getByRole('region', { name: 'Restore saved values', exact: true });
  await confirmation.getByRole('heading', { name: 'Restore version 1?', exact: true }).waitFor();
  assert.match(await confirmation.getByRole('row', { name: /Cost/ }).innerText(), /12\s+0/);
  await confirmation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/desktop-record-restore.png' });
  await confirmation.getByRole('button', { name: 'Cancel restoration', exact: true }).click();
  assert.deepEqual(await read(), record);
  await dialog.getByRole('button', { name: 'Details', exact: true }).click();
  await dialog.getByLabel('Cost', { exact: true }).fill('99');
  await showHistory();
  await history.getByRole('status').filter({ hasText: 'Your unsaved changes are kept' }).waitFor();
  assert.equal(await history.getByRole('button', { name: 'Restore before change', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await dialog.getByLabel('Cost', { exact: true }).inputValue(), '99');
  await showHistory(); await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  assert.deepEqual(await read(), record);
  await open(); await showHistory(); await selectOriginal();
  await details.getByRole('button', { name: 'Restore after change', exact: true }).click();
  record = (await call(`${root}/records`, 'PATCH', [{ id: record.id, expectedVersion: record.version, values: { [cost]: 14 } }])).records[0];
  await confirmation.getByRole('button', { name: 'Restore values', exact: true }).click();
  await history.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.deepEqual(await read(), record);
  await page.screenshot({ path: '.artifacts/desktop-history-conflict.png' });
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await open(); await showHistory(); await selectOriginal();
  await details.getByRole('button', { name: 'Restore after change', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Restore values', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const restored = await read();
  assert.equal(restored.id, record.id);
  assert.equal(restored.version, record.version + 1);
  assert.equal(restored.values[cost], 0); assert.equal(restored.values[double], 0); assert.equal(restored.values[done], false);
  const latest = (await call(`${root}/records/${record.id}/history`, 'POST', {})).changes[0];
  assert.deepEqual(latest.restoredFrom, { changeId: created.id, snapshot: 'after' });
  await open(); await showHistory();
  await history.getByRole('button', { name: `View change ${latest.id}`, exact: true }).getByText(`Restored · Version ${restored.version}`, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
