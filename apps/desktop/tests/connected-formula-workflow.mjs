import assert from 'node:assert/strict';

export async function verifyConnectedFormulaWorkflow(page) {
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const create = async name => {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('0 records · 1 field', { exact: true }).waitFor();
    return (await call('/tables')).find(table => table.name === name);
  };
  const select = async () => {
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58);
    if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  };
  let items = await create('Calculation items');
  items = await call(`/tables/${items.id}/fields`, 'POST', { expectedVersion: items.version, name: 'Amount', type: 'number' });
  const amount = items.fields[1].id;
  const item = (await call(`/tables/${items.id}/records`, 'POST', [{ values: { [items.primaryFieldId]: 'Line item', [amount]: 25 } }])).records[0];
  let orders = await create('Calculation orders');
  orders = await call(`/tables/${orders.id}/fields`, 'POST', { expectedVersion: orders.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } });
  const link = orders.fields[1].id;
  for (const [name, operation] of [['Subtotal', 'sum'], ['Amounts', 'values']]) {
    orders = await call(`/tables/${orders.id}/fields`, 'POST', { expectedVersion: orders.version, name, type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation } });
  }
  const subtotal = orders.fields[2].id, array = orders.fields[3].id;
  const order = (await call(`/tables/${orders.id}/records`, 'POST', [{ values: { [orders.primaryFieldId]: 'Estimate', [link]: [item.id] } }])).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Total');
  await page.getByLabel('Field type', { exact: true }).selectOption('formula');
  const picker = page.getByLabel('Insert field', { exact: true });
  assert.equal(await picker.locator(`option[value="${array}"]`).count(), 0);
  assert.equal(await picker.locator(`option[value="${link}"]`).count(), 0);
  await picker.selectOption(subtotal);
  assert.equal(await page.getByLabel('Formula', { exact: true }).inputValue(), '["Subtotal"]');
  await page.getByLabel('Formula', { exact: true }).fill('["Subtotal"] * 2');
  await page.getByLabel('Number format', { exact: true }).selectOption('currency');
  await page.screenshot({ path: '.artifacts/desktop-connected-formula-editor.png' });
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  orders = await call(`/tables/${orders.id}`);
  const total = orders.fields.at(-1).id;
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Total', { exact: true }).textContent(), '$50.00');
  await page.getByLabel('Name', { exact: true }).fill('Retained draft');
  await call(`/tables/${items.id}/records`, 'PATCH', [{ id: item.id, expectedVersion: item.version, values: { [amount]: 40 } }]);
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Retained draft');
  assert.equal((await call(`/tables/${orders.id}/records/${order.id}`)).values[total], 80);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Total', { exact: true }).textContent(), '$80.00');
  await page.getByRole('checkbox', { name: 'Line item', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-connected-formula-result.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const name of ['Calculation orders', 'Calculation items']) {
    await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
}
