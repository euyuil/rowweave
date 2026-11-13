import assert from 'node:assert/strict';

export async function verifyGroupMeasures(page) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const heading = (row, text) => page.waitForFunction(({ row, text }) =>
    document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent.includes(text), { row, text });
  const click = async (row, column = 0) => {
    await ready(); const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58 + row * 36, { delay: 50 });
  };
  const saveView = async () => {
    await page.getByRole('dialog').getByRole('button', { name: 'Save view', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' }); await ready();
  };
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Group measures');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Group measures', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Group measures');
  const root = '/tables/' + table.id;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'planned', name: 'Planned' }, { id: 'done', name: 'Done' }, { id: 'empty', name: 'Empty' }] });
  const status = table.fields[1].id;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[2].id;
  const records = (await call(root + '/records', 'POST', Array.from({ length: 507 }, (_, index) => ({ values: {
    [table.primaryFieldId]: 'Task ' + index, [status]: index < 501 ? 'planned' : index < 506 ? 'done' : null, [amount]: index,
  } })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('Grid group field', { exact: true }).selectOption(status);
  await page.getByRole('button', { name: 'Add measure', exact: true }).click();
  await page.getByRole('button', { name: 'Add measure', exact: true }).click();
  await page.getByLabel('Measure 2 calculation', { exact: true }).selectOption('average');
  await page.screenshot({ path: '.artifacts/desktop-group-measure-settings.png' });
  await saveView();
  let view = (await call(root + '/views'))[0];
  assert.deepEqual(view.groupMeasures, [{ fieldId: amount, operation: 'sum' }, { fieldId: amount, operation: 'average' }]);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click(); await ready();
  await heading(0, '▸ Planned · 501 records · Sum Amount: 125,250 · Average Amount: 250');
  await heading(1, '▸ Done · 5 records · Sum Amount: 2,515 · Average Amount: 503');
  await heading(2, '▸ Empty · 0 records · Sum Amount: — · Average Amount: —');
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(bounds.x + 150, bounds.y + 58);
  assert.match(await page.locator('.grid-host').getAttribute('title'), /Sum Amount: 125,250 · Average Amount: 250/);
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  assert.equal(await page.getByLabel('Measure 1 field', { exact: true }).inputValue(), amount);
  assert.equal(await page.getByLabel('Measure 2 calculation', { exact: true }).inputValue(), 'average');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  table = await call(root + '/fields/' + amount, 'PATCH', { expectedVersion: table.version, name: 'Budget' });
  await heading(0, 'Sum Budget: 125,250');
  await call(root + '/records', 'PATCH', [{ id: records[0].id, expectedVersion: records[0].version, values: { [amount]: 5 } }]);
  await heading(0, 'Sum Budget: 125,255');
  await click(1); await ready();
  await heading(1, '▾ Done · 5 records · Sum Budget: 2,515');
  await click(2, 2);
  if (!await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Enter');
  await page.getByLabel('Cell value', { exact: true }).fill('900');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await heading(1, 'Sum Budget: 2,515');
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor(); await ready();
  await heading(1, 'Sum Budget: 2,914 · Average Budget: 582.8');
  assert.equal((await call(root + '/records/' + records[501].id)).values[amount], 900);
  assert.equal((await call(root + '/records/' + records[502].id)).values[amount], 502);
  await click(2); if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+ArrowDown');
  await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === 'Task 501\nTask 502');
  await page.screenshot({ path: '.artifacts/desktop-group-measures.png' });
  await page.reload();
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Group measures', exact: true }).click();
  await page.getByRole('heading', { name: 'Group measures', exact: true }).waitFor(); await ready();
  await heading(0, 'Sum Budget: 125,255'); await heading(1, 'Sum Budget: 2,914');
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByRole('button', { name: 'Remove measure 1', exact: true }).click(); await saveView();
  await heading(1, 'Done · 5 records · Average Budget: 582.8');
  view = (await call(root + '/views'))[0]; assert.deepEqual(view.groupMeasures, [{ fieldId: amount, operation: 'average' }]);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
