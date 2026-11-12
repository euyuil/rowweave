import assert from 'node:assert/strict';

export async function verifyLookupWorkflow(page) {
  const create = async name => {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('0 records · 1 field', { exact: true }).waitFor();
  };
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}${path}`, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const select = async (column = 0) => {
    await ready();
    await page.waitForTimeout(650);
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58);
    if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await create('Lookup projects');
  let target = (await call('/tables')).find(table => table.name === 'Lookup projects');
  target = await call(`/tables/${target.id}/fields`, 'POST', { expectedVersion: target.version, name: 'Budget', type: 'number', numberFormat: 'currency', currency: 'USD' });
  const budget = target.fields[1];
  const targets = (await call(`/tables/${target.id}/records`, 'POST', [0, 25].map((amount, index) => ({
    values: { [target.primaryFieldId]: `Project ${index + 1}`, [budget.id]: amount },
  })))).records;
  await create('Lookup tasks');
  let source = (await call('/tables')).find(table => table.name === 'Lookup tasks');
  source = await call(`/tables/${source.id}/fields`, 'POST', { expectedVersion: source.version, name: 'Projects', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const relation = source.fields[1];
  const records = (await call(`/tables/${source.id}/records`, 'POST', [targets.map(record => record.id), [targets[0].id]].map((ids, index) => ({
    values: { [source.primaryFieldId]: `Task ${index + 1}`, [relation.id]: ids },
  })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('2 records · 2 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Project budget');
  await page.getByLabel('Field type', { exact: true }).selectOption('lookup');
  await page.getByLabel('Linked field', { exact: true }).selectOption(relation.id);
  await page.getByLabel('Look up field', { exact: true }).selectOption(budget.id);
  assert.equal(await page.getByLabel('Require a value', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  source = await call(`/tables/${source.id}`);
  const lookup = source.fields.find(field => field.type === 'lookup');
  assert.deepEqual((await call(`/tables/${source.id}/records/${records[0].id}`)).values[lookup.id], [0, 25]);
  await select(2);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
  await page.keyboard.press('Delete');
  await page.getByRole('alert').filter({ hasText: 'read-only' }).waitFor();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await call(`/tables/${target.id}/fields/${budget.id}`, 'PATCH', { expectedVersion: target.version, name: 'Updated budget' });
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'schema changed' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await select(2);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Project budget', { exact: true }).textContent(), '$0.00, $25.00');
  await page.getByLabel('Name', { exact: true }).fill('Renamed task');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await select();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Duplicate task');
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByText('3 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('With budget');
  await page.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  const rule = page.getByRole('group', { name: 'Filter 1.1', exact: true });
  await rule.getByLabel('Filter field', { exact: true }).selectOption(lookup.id);
  await rule.getByLabel('Filter operator', { exact: true }).selectOption('gte');
  await rule.getByLabel('Value *', { exact: true }).fill('10');
  await page.getByRole('dialog').getByRole('button', { name: 'Create view', exact: true }).click();
  await page.getByText('2 records · 3 fields', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-lookups.png' });
  await call(`/tables/${target.id}/records`, 'PATCH', [{ id: targets[1].id, expectedVersion: 1, values: { [budget.id]: 5 } }]);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('0 records · 3 fields', { exact: true }).waitFor();
  await page.getByLabel('Current view', { exact: true }).selectOption({ label: 'All records' });
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Project budget', { exact: true }).textContent(), '$0.00, $5.00');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const name of ['Lookup tasks', 'Lookup projects']) {
    await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
    await ready();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
}
