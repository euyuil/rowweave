import assert from 'node:assert/strict';

export async function verifyDateFormulaWorkflow(page) {
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, input });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Date calculations');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Date calculations', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Date calculations');
  table = await call('/tables/' + table.id + '/fields', 'POST', { expectedVersion: table.version, name: 'Start', type: 'date' });
  const start = table.fields[1].id;
  const record = (await call('/tables/' + table.id + '/records', 'POST', [{ values: { [table.primaryFieldId]: 'Renewal', [start]: '2024-01-31' } }])).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  await page.getByText('1 record · 2 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  for (const [name, type, expression] of [['Due', 'date', 'DATEADD(["Start"], 1, "month")'], ['Midnight', 'datetime', 'DATETIMEVALUE(["Due"])']]) {
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
    await dialog.getByLabel('Field name', { exact: true }).fill(name);
    await dialog.getByLabel('Field type', { exact: true }).selectOption('formula');
    await dialog.getByLabel('Result type', { exact: true }).selectOption(type);
    await dialog.getByLabel('Formula', { exact: true }).fill(expression);
    assert.equal(await dialog.getByLabel('Number format', { exact: true }).count(), 0);
    if (name === 'Due') await page.screenshot({ path: '.artifacts/desktop-date-formula-editor.png' });
    await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
    await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await ready();
  table = await call('/tables/' + table.id);
  const due = table.fields[2].id, midnight = table.fields[3].id;
  assert.equal(table.fields[2].formula.resultType, 'date'); assert.ok(table.fields[2].formula.expression.includes(start));
  await page.locator('.dvn-scroller').click({ position: { x: 460, y: 58 } });
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => await navigator.clipboard.readText() === '2024-02-29');
  await page.keyboard.press('Enter'); assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await dialog.getByLabel('Due', { exact: true }).textContent(), '2024-02-29');
  assert.equal(await dialog.getByLabel('Midnight (UTC)', { exact: true }).textContent(), '2024-02-29T00:00:00.000Z');
  await page.screenshot({ path: '.artifacts/desktop-date-formula-record.png' });
  await dialog.getByLabel('Start', { exact: true }).fill('2024-02-29');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  const changed = await call('/tables/' + table.id + '/records/' + record.id);
  assert.equal(changed.values[due], '2024-03-29'); assert.equal(changed.values[midnight], '2024-03-29T00:00:00.000Z');
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  await dialog.getByLabel('Filter field', { exact: true }).selectOption(due);
  assert.equal(await dialog.getByLabel('Filter operator', { exact: true }).locator('option[value="relativeDate"]').count(), 1);
  await dialog.getByLabel('Filter operator', { exact: true }).selectOption('gt');
  await dialog.getByLabel('Value *', { exact: true }).fill('2024-03-01');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  const view = (await call('/tables/' + table.id + '/views'))[0];
  assert.equal(view.query.filter.conditions[0].value, '2024-03-01');
  assert.equal((await call('/tables/' + table.id + '/views/' + view.id + '/query', 'POST', {})).total, 1);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
