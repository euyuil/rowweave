import assert from 'node:assert/strict';

export async function verifyFieldPanelWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(1024, 768); return size;
  });
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Field panel lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Field panel lab', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Field panel lab');
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: Array.from({ length: 12 }, (_, index) => ({ name: `Stage ${index + 1}` })) });
  const { records } = await call(`/tables/${table.id}/records`, 'POST', ['10', 'invalid'].map(value => ({ values: { [table.primaryFieldId]: value } })));
  const readTable = () => call(`/tables/${table.id}`);
  const readRecords = () => call(`/tables/${table.id}/records?offset=0&limit=10`);
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const configure = async (column = 0) => {
    await ready();
    const grid = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(grid.x + 100 + column * 180, grid.y + 20, { button: 'right' });
    await dialog.getByRole('button', { name: 'Configure field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).waitFor();
    const panel = await dialog.boundingBox();
    assert.ok(panel.width <= 460 && panel.x >= 12 && panel.x + panel.width <= 1012);
    assert.ok(Math.abs(panel.y - (grid.y + 46)) < 2, 'Keep field settings beside the selected header.');
    assert.ok(panel.y + panel.height <= 756);
  };
  const cancel = async () => {
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
  };
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await configure();
  const original = await readTable();
  await page.getByLabel('Field name', { exact: true }).fill('Canceled name');
  await cancel();
  assert.deepEqual(await readTable(), original);
  await configure(1);
  assert.ok(await dialog.evaluate(element => element.scrollHeight > element.clientHeight));
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '.artifacts/desktop-field-options-panel.png' });
  await page.getByLabel('Option 12 name', { exact: true }).fill('Canceled option');
  const actions = await dialog.locator('.dialog-actions').boundingBox();
  assert.ok(actions.y + actions.height <= 756);
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await cancel();
  assert.deepEqual(await readTable(), original);
  await configure();
  await page.getByLabel('Field type', { exact: true }).selectOption('number');
  await dialog.getByRole('button', { name: 'Preview conversion', exact: true }).click();
  await page.getByText('1 changed · 1 invalid', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Apply conversion', exact: true }).isDisabled(), true);
  await dialog.getByRole('region', { name: 'Conversion preview', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/desktop-field-conversion-panel.png' });
  assert.equal((await readTable()).fields[0].type, 'text');
  assert.deepEqual((await readRecords()).records.map(record => record.values[table.primaryFieldId]), ['10', 'invalid']);
  await cancel();
  await configure();
  await page.getByLabel('Field name', { exact: true }).fill('Keep schema draft');
  table = await call(`/tables/${table.id}/fields/${table.fields[1].id}`, 'PATCH', { expectedVersion: table.version, name: 'Phase' });
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'schema changed' }).waitFor();
  assert.equal(await page.getByLabel('Field name', { exact: true }).inputValue(), 'Keep schema draft');
  assert.equal((await readTable()).fields[0].name, 'Name');
  await cancel();
  await call(`/tables/${table.id}/records`, 'PATCH', [{ id: records[1].id, expectedVersion: records[1].version, values: { [table.primaryFieldId]: '20' } }]);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await configure();
  await page.getByLabel('Field type', { exact: true }).selectOption('number');
  await dialog.getByRole('button', { name: 'Preview conversion', exact: true }).click();
  await page.getByText('2 changed · 0 invalid', { exact: true }).waitFor();
  assert.equal((await readTable()).fields[0].type, 'text');
  await dialog.getByRole('button', { name: 'Apply conversion', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await ready();
  assert.equal((await readTable()).fields[0].type, 'number');
  assert.deepEqual((await readRecords()).records.map(record => record.values[table.primaryFieldId]), [10, 20]);
  await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
