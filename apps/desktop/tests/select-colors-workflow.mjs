import assert from 'node:assert/strict';

export async function verifySelectColorsWorkflow(page) {
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const colors = locator => locator.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }));
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Select colors');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Select colors', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Select colors');
  const add = async field => { table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version }); return table.fields.at(-1); };
  const status = await add({ name: 'Status', type: 'singleSelect', options: [{ id: 'ready', name: 'Ready 中文', color: '#0055aa' }, { id: 'done', name: 'Done', color: '#ffee00' }] });
  const tags = await add({ name: 'Tags', type: 'multiSelect', options: [{ id: 'review', name: '<Review>', color: '#007744' }, { id: 'priority', name: 'Priority', color: '#ffcc55' }] });
  const relation = await add({ name: 'Related', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const lookup = await add({ name: 'Related statuses', type: 'lookup', lookup: { relationFieldId: relation.id, fieldId: status.id } });
  const amount = await add({ name: 'Estimate', type: 'number' });
  const count = await add({ name: 'Related count', type: 'lookup', lookup: { relationFieldId: relation.id, fieldId: amount.id, operation: 'count' } });
  let record = (await call(`/tables/${table.id}/records`, 'POST', [{ values: { [table.primaryFieldId]: 'Review release', [status.id]: 'ready', [tags.id]: ['review', 'priority'], [amount.id]: 1 } }])).records[0];
  record = (await call(`/tables/${table.id}/records`, 'PATCH', [{ id: record.id, expectedVersion: record.version, values: { [relation.id]: [record.id] } }])).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 7 fields', { exact: true }).waitFor(); await ready();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas'), { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let blue = 0, green = 0, yellow = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 0 && data[i + 1] === 85 && data[i + 2] === 170) blue++;
      if (data[i] === 0 && data[i + 1] === 119 && data[i + 2] === 68) green++;
      if (data[i] === 255 && data[i + 1] === 204 && data[i + 2] === 85) yellow++;
    }
    return blue > 100 && green > 100 && yellow > 100;
  });
  await page.screenshot({ path: '.artifacts/desktop-select-colors-grid.png' });
  await page.locator('.dvn-scroller').click({ position: { x: 280, y: 58 } });
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => await navigator.clipboard.readText() === 'Ready 中文');
  await page.keyboard.press('Enter');
  const editor = page.locator('.rowweave-cell-editor');
  assert.deepEqual(await colors(editor.getByLabel('Cell value', { exact: true })), { background: 'rgb(0, 85, 170)', text: 'rgb(255, 255, 255)' });
  await editor.getByLabel('Cell value', { exact: true }).selectOption('done');
  await page.keyboard.press('Escape');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await editor.getByLabel('Cell value', { exact: true }).selectOption('done');
  await page.keyboard.press('Tab');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await editor.getByLabel('Cell value', { exact: true }).selectOption(['priority', 'review']);
  assert.equal(await editor.locator('.select-value').count(), 2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.deepEqual(await colors(dialog.getByLabel('Status', { exact: true })), { background: 'rgb(255, 238, 0)', text: 'rgb(0, 0, 0)' });
  assert.deepEqual(await colors(dialog.locator('.select-value').filter({ hasText: '<Review>' })), { background: 'rgb(0, 119, 68)', text: 'rgb(255, 255, 255)' });
  assert.equal(await dialog.getByLabel('Related statuses', { exact: true }).textContent(), 'Done');
  assert.equal(await dialog.getByLabel('Related count', { exact: true }).textContent(), '1');
  await page.screenshot({ path: '.artifacts/desktop-select-colors-form.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Colored board');
  await page.getByLabel('View type', { exact: true }).selectOption('board');
  await page.getByLabel('Board group field', { exact: true }).selectOption(status.id);
  await page.getByRole('button', { name: 'Create view', exact: true }).click();
  const lane = page.getByRole('region', { name: 'Done column', exact: true });
  await lane.getByRole('button', { name: 'Review release', exact: true }).waitFor();
  assert.deepEqual(await colors(lane.locator('header .select-value')), { background: 'rgb(255, 238, 0)', text: 'rgb(0, 0, 0)' });
  assert.deepEqual(await colors(lane.locator('.board-card .select-value').filter({ hasText: '<Review>' })), { background: 'rgb(0, 119, 68)', text: 'rgb(255, 255, 255)' });
  await page.screenshot({ path: '.artifacts/desktop-select-colors-board.png' });
  const saved = await call(`/tables/${table.id}/records/${record.id}`);
  assert.equal(saved.values[status.id], 'done');
  assert.deepEqual(saved.values[tags.id], ['review', 'priority']);
  assert.deepEqual(saved.values[lookup.id], ['done']); assert.equal(saved.values[count.id], 1);
  const updated = await call(`/tables/${table.id}`);
  assert.deepEqual(updated.fields.find(field => field.id === status.id).options, status.options);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
