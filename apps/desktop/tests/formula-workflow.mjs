import assert from 'node:assert/strict';

export async function verifyFormulaWorkflow(page) {
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const select = async (column = 0) => {
    await ready();
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58);
    if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Formula lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Formula lab', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Formula lab');
  for (const name of ['Quantity', 'Price']) table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name, type: 'number' });
  const quantity = table.fields[1].id, price = table.fields[2].id;
  const row = (await call(`/tables/${table.id}/records`, 'POST', [{ values: { [table.primaryFieldId]: 'Estimate', [quantity]: 3, [price]: 120 } }])).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Total');
  await page.getByLabel('Field type', { exact: true }).selectOption('formula');
  await page.getByLabel('Insert field', { exact: true }).selectOption(quantity);
  assert.equal(await page.getByLabel('Formula', { exact: true }).inputValue(), '["Quantity"]');
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[aria-label="Formula"]');
    return document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  });
  await page.getByLabel('Formula', { exact: true }).fill('["Quantity"] * ["Price"]');
  assert.equal(await page.getByLabel('Formula', { exact: true }).inputValue(), '["Quantity"] * ["Price"]');
  await page.getByLabel('Number format', { exact: true }).selectOption('currency');
  assert.equal(await page.getByLabel('Require a value', { exact: true }).count(), 0);
  await page.screenshot({ path: '.artifacts/desktop-formula-editor.png' });
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  table = await call(`/tables/${table.id}`);
  const formula = table.fields[3];
  assert.ok(formula.formula.expression.includes(quantity));
  await select(3);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) === '360');
  await page.evaluate(() => navigator.clipboard.writeText('999'));
  await page.keyboard.press('Control+v');
  await page.getByRole('alert').filter({ hasText: 'read-only' }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
  await page.keyboard.press('Delete');
  await page.getByRole('alert').filter({ hasText: 'read-only' }).waitFor();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Total', { exact: true }).textContent(), '$360.00');
  await page.getByLabel('Quantity', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal((await call(`/tables/${table.id}/records/${row.id}`)).values[formula.id], 480);
  table = await call(`/tables/${table.id}/fields/${quantity}`, 'PATCH', { expectedVersion: table.version, name: 'Hours' });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('group', { name: 'Total', exact: true }).getByRole('button', { name: 'Configure', exact: true }).click();
  assert.equal(await page.getByLabel('Formula', { exact: true }).inputValue(), '["Hours"] * ["Price"]');
  await page.getByLabel('Formula', { exact: true }).fill('["Hours"] / 0');
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await select(3);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Division by zero'));
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.match(await page.getByLabel('Total', { exact: true }).textContent(), /Division by zero/);
  await page.screenshot({ path: '.artifacts/desktop-formula-error.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
