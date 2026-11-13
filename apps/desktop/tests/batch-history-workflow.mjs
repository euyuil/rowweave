import assert from 'node:assert/strict';

export async function verifyBatchHistoryWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], size = window.getSize(); window.setSize(1024, 768); return size;
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Saved operations lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved operations lab', exact: true }).waitFor();
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  let table = (await call('/tables')).find(table => table.name === 'Saved operations lab');
  const root = `/tables/${table.id}`;
  for (const field of [{ name: 'Cost', type: 'number' }, { name: 'Done', type: 'checkbox' }]) {
    table = await call(`${root}/fields`, 'POST', { ...field, expectedVersion: table.version });
  }
  const [name, cost, done] = table.fields.map(field => field.id);
  table = await call(`${root}/fields`, 'POST', { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${cost}] * 2`, resultType: 'number' } });
  const double = table.fields.at(-1).id;
  const created = await call(`${root}/records`, 'POST', Array.from({ length: 12 }, (_, index) => ({ values: { [name]: `Record ${index} 中文`, [cost]: index, [done]: false } })));
  const rows = created.records, read = id => call(`${root}/records/${id}`);
  let noisy = rows[11];
  for (let index = 0; index < 11; index++) noisy = (await call(`${root}/records`, 'PATCH', [{ id: noisy.id, expectedVersion: noisy.version, values: { [cost]: index } }])).records[0];
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const reload = async () => { await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready(); };
  await reload();
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 280, bounds.y + 58);
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement) ||
    !!document.querySelector('.rowweave-cell-editor'));
  if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('5');
  assert.equal(await page.getByRole('button', { name: 'Saved changes', exact: true }).isDisabled(), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button', { name: 'Saved changes', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  const saved = (await call(`${root}/batches/query`, 'POST', {})).batches[0];
  await call(`${root}/records`, 'PATCH', [{ id: rows[1].id, expectedVersion: 1, values: { [cost]: 8 } }]);
  const dialog = page.getByRole('dialog');
  const details = dialog.getByRole('region', { name: 'Operation record details', exact: true });
  const open = async button => {
    await page.getByRole('button', { name: button, exact: true }).focus(); await page.keyboard.press('Enter');
    await details.waitFor();
  };
  await open('Undo saved change');
  assert.equal(await dialog.getByRole('button', { name: `Review operation ${saved.id}`, exact: true }).getAttribute('aria-pressed'), 'true');
  assert.match(await details.getByRole('row', { name: /Cost/ }).innerText(), /0\s+5/);
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Undo this saved operation?', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-saved-undo.png' });
  await dialog.getByRole('button', { name: 'Cancel undo', exact: true }).click();
  assert.equal((await read(rows[0].id)).values[cost], 5);
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo all changes', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read(rows[0].id)).values[cost], 0);
  assert.equal((await read(rows[1].id)).values[cost], 8);
  await ready(); await open('Redo saved change');
  await dialog.getByRole('button', { name: 'Redo operation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Redo all changes', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const redone = await read(rows[0].id);
  assert.equal(redone.version, 4); assert.equal(redone.values[cost], 5); assert.equal(redone.values[double], 10);

  await ready(); await open('Saved changes');
  assert.equal(await dialog.getByRole('list', { name: 'Saved operations', exact: true }).locator('li').count(), 10);
  await dialog.getByRole('button', { name: 'Older operations', exact: true }).click();
  await dialog.getByRole('button', { name: `Review operation ${created.batchId}`, exact: true }).click();
  const affected = dialog.getByRole('region', { name: 'Affected records', exact: true });
  await affected.getByText('12 of 12 changes remain in history.', { exact: false }).waitFor();
  assert.equal(await affected.locator('li').count(), 10);
  await dialog.getByRole('button', { name: 'Older record changes', exact: true }).click();
  await dialog.getByRole('button', { name: `Inspect operation record ${rows[0].id}`, exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.trash-details code')?.textContent === id, rows[0].id);
  assert.equal(await affected.locator('li').count(), 2);
  assert.match(await details.innerText(), /中文/); assert.match(await details.innerText(), /false/);
  await page.screenshot({ path: '.artifacts/desktop-saved-operation-details.png' });
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();

  let external = await read(rows[2].id);
  external = (await call(`${root}/records`, 'PATCH', [{ id: external.id, expectedVersion: external.version, values: { [cost]: 20 } }])).records[0];
  await open('Saved changes');
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  external = (await call(`${root}/records`, 'PATCH', [{ id: external.id, expectedVersion: external.version, values: { [cost]: 21 } }])).records[0];
  await dialog.getByRole('button', { name: 'Undo all changes', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'changed after this batch' }).waitFor();
  assert.deepEqual(await read(external.id), external);
  await page.screenshot({ path: '.artifacts/desktop-saved-undo-conflict.png' });
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();

  await call(`${root}/records`, 'DELETE', [{ id: rows[1].id, expectedVersion: (await read(rows[1].id)).version }]);
  await open('Saved changes');
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo all changes', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read(rows[1].id)).values[cost], 8);
  table = await call(root);
  await call(`${root}/fields/${double}`, 'PATCH', { expectedVersion: table.version, formula: { expression: `[${cost}] * 3`, resultType: 'number' } });
  await ready(); await open('Saved changes');
  await dialog.getByRole('status').filter({ hasText: 'changed the schema' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Undo operation', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();

  const target = await call('/tables', 'POST', { name: 'Related operation lab' });
  const linked = (await call(`/tables/${target.id}/records`, 'POST', [{ values: { [target.primaryFieldId]: 'Linked record' } }])).records[0];
  table = await call(root);
  table = await call(`${root}/fields`, 'POST', { expectedVersion: table.version, name: 'Related', type: 'relation',
    relation: { tableId: target.id, multiple: true }, reverseField: { name: 'Sources', multiple: true, expectedVersion: target.version } });
  const relation = table.fields.at(-1);
  await call(`${root}/records`, 'PATCH', [{ id: rows[0].id, expectedVersion: (await read(rows[0].id)).version, values: { [relation.id]: [linked.id] } }]);
  await reload(); await open('Saved changes');
  await dialog.getByRole('button', { name: `Inspect operation record ${linked.id}`, exact: true }).click();
  await details.getByRole('heading', { name: 'Related operation lab', exact: true }).waitFor();
  assert.match(await details.getByRole('row', { name: /Sources/ }).innerText(), new RegExp(rows[0].id));
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo all changes', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read(rows[0].id)).values[relation.id], null);
  assert.equal((await call(`/tables/${target.id}/records/${linked.id}`)).values[relation.relation.inverseFieldId], null);
  await call(`${root}/fields/${relation.id}`, 'DELETE', { expectedVersion: (await call(root)).version });
  await call(`/tables/${target.id}`, 'DELETE', { expectedVersion: (await call(`/tables/${target.id}`)).version });
  await reload();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
