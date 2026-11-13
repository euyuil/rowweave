import assert from 'node:assert/strict';

export async function verifyRecordPanelWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(1024, 768); return size;
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Record panel lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Record panel lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(connection.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare the record panel fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Record panel lab');
    for (const field of [{ name: 'Notes', type: 'multiline' }, { name: 'Cost', type: 'number', numberFormat: 'currency', currency: 'USD', precision: 2 },
      { name: 'Done', type: 'checkbox' }, ...Array.from({ length: 10 }, (_, index) => ({ name: `Detail ${index + 1}`, type: 'text' }))]) {
      table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version });
    }
    const name = 'Quarterly launch — a longer record title that remains readable alongside the workspace';
    const { records } = await call(`/tables/${table.id}/records`, 'POST', [{ values: {
      [table.primaryFieldId]: name, [table.fields[1].id]: 'First line\n中文第二行', [table.fields[2].id]: 12.5, [table.fields[3].id]: false,
    } }]);
    return { table, record: records[0], name };
  });
  const read = () => page.evaluate(async ({ table, record }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${table.id}/records/${record.id}`, { headers: { Authorization: `Bearer ${connection.token}` } });
    if (!response.ok) throw new Error('Could not read the panel record.');
    return response.json();
  }, fixture);
  const dialog = page.getByRole('dialog');
  const open = async () => {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const grid = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(grid.x + 15, grid.y + 58);
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    await dialog.waitFor();
  };
  await open();
  await dialog.getByRole('heading', { name: fixture.name, exact: true }).waitFor();
  const bounds = await dialog.boundingBox();
  assert.equal(bounds.x + bounds.width, 1024);
  assert.equal(bounds.height, 768);
  assert.ok(bounds.x > 300, 'Keep the left-hand table context visible.');
  const heading = await dialog.locator('.drawer-heading').boundingBox();
  const body = dialog.locator('.drawer-body');
  assert.ok(await body.evaluate(element => element.scrollHeight > element.clientHeight));
  await page.screenshot({ path: '.artifacts/desktop-record-panel.png' });
  await page.getByLabel('Detail 10', { exact: true }).fill('Last field draft');
  const actions = await dialog.locator('.dialog-actions').boundingBox();
  assert.ok(actions.y + actions.height <= 768);
  assert.equal((await dialog.locator('.drawer-heading').boundingBox()).y, heading.y);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
  await dialog.getByRole('region', { name: 'Unsaved record changes', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Keep editing', exact: true }).evaluate(element => element === document.activeElement), true);
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByLabel('Detail 10', { exact: true }).inputValue(), 'Last field draft');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await read(), fixture.record);
  await open();
  await page.getByLabel('Cost', { exact: true }).fill('77');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(await read(), fixture.record);
  await open();
  await page.getByLabel('Cost', { exact: true }).fill('99');
  await page.evaluate(async ({ table, record }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${table.id}/records`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: record.id, expectedVersion: record.version, values: { [table.fields[2].id]: 33 } }]),
    });
    if (!response.ok) throw new Error('Could not prepare a concurrent record update.');
  }, fixture);
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await page.getByLabel('Cost', { exact: true }).inputValue(), '99');
  assert.equal((await read()).values[fixture.table.fields[2].id], 33);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await open();
  await page.getByLabel('Cost', { exact: true }).fill('34');
  await page.keyboard.press('Control+s');
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read()).values[fixture.table.fields[2].id], 34);
  await page.evaluate(async ({ table }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${table.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: table.version, primaryFieldId: table.fields[2].id }),
    });
    if (!response.ok) throw new Error('Could not change the primary display field.');
  }, fixture);
  await open();
  await dialog.getByRole('heading', { name: '$34.00', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
