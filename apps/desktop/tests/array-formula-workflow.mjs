import assert from 'node:assert/strict';

export async function verifyArrayFormulaWorkflow(page) {
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, input });
  let items = await call('/tables', 'POST', { name: 'Array items' });
  items = await call('/tables/' + items.id + '/fields', 'POST', { expectedVersion: items.version, name: 'Amount', type: 'number' });
  const amount = items.fields[1].id;
  const rows = (await call('/tables/' + items.id + '/records', 'POST', [3, 7].map((value, index) => ({
    values: { [amount]: value, [items.primaryFieldId]: index === 0 ? 'Alpha' : 'Beta' },
  })))).records;
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Array calculations');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Array calculations', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Array calculations');
  table = await call('/tables/' + table.id + '/fields', 'POST', { expectedVersion: table.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } });
  const link = table.fields[1].id;
  for (const [name, fieldId] of [['Amounts', amount], ['Names', items.primaryFieldId]]) {
    table = await call('/tables/' + table.id + '/fields', 'POST', { expectedVersion: table.version, name, type: 'lookup', lookup: { relationFieldId: link, fieldId } });
  }
  const record = (await call('/tables/' + table.id + '/records', 'POST', [{ values: { [table.primaryFieldId]: 'Summary', [link]: rows.map(row => row.id) } }])).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  await page.getByText('1 record · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  for (const [name, type, expression] of [
    ['Total', 'number', 'ARRAYSUM(["Amounts"])'],
    ['Item count', 'number', 'ARRAYLEN(["Items"])'],
    ['Labels', 'text', 'ARRAYJOIN(ARRAYUNIQUE(["Names"]), ", ")'],
  ]) {
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
    await dialog.getByLabel('Field name', { exact: true }).fill(name);
    await dialog.getByLabel('Field type', { exact: true }).selectOption('formula');
    await dialog.getByLabel('Result type', { exact: true }).selectOption(type);
    assert.equal(await dialog.getByLabel('Insert field', { exact: true }).locator('option').filter({ hasText: /^Items$/ }).count(), 1);
    assert.equal(await dialog.getByLabel('Insert field', { exact: true }).locator('option').filter({ hasText: /^Amounts$/ }).count(), 1);
    await dialog.getByLabel('Formula', { exact: true }).fill(expression);
    if (name === 'Labels') await page.screenshot({ path: '.artifacts/desktop-array-formula-editor.png' });
    await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
    await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await ready();
  await page.locator('.dvn-scroller').click({ position: { x: 100, y: 58 } });
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await dialog.getByLabel('Total', { exact: true }).textContent(), '10');
  assert.equal(await dialog.getByLabel('Item count', { exact: true }).textContent(), '2');
  assert.equal(await dialog.getByLabel('Labels', { exact: true }).textContent(), 'Alpha, Beta');
  await page.waitForFunction(() => document.querySelector('.relation-results')?.getAttribute('aria-busy') === 'false');
  await dialog.getByLabel('Labels', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/desktop-array-formula-record.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await call('/tables/' + items.id + '/records', 'PATCH', [{ id: rows[0].id, expectedVersion: rows[0].version, values: { [amount]: 8 } }]);
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  table = await call('/tables/' + table.id);
  assert.equal((await call('/tables/' + table.id + '/records/' + record.id)).values[table.fields[4].id], 15);
  await page.locator('.dvn-scroller').click({ position: { x: 100, y: 58 } });
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await dialog.getByLabel('Total', { exact: true }).textContent(), '15');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await call('/tables/' + items.id, 'DELETE', { expectedVersion: (await call('/tables/' + items.id)).version });
}
