import assert from 'node:assert/strict';

export async function verifyRecordTimesWorkflow(page) {
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Record times');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Record times', exact: true }).waitFor();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Original');
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  for (const [name, type] of [['Created', 'createdTime'], ['Edited', 'updatedTime']]) {
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).fill(name);
    await page.getByLabel('Field type', { exact: true }).selectOption(type);
    assert.equal(await dialog.getByLabel('Require a value', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await ready();
  const select = async () => {
    await page.locator('.dvn-scroller').click({ position: { x: 100, y: 58 } });
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  const created = await dialog.getByLabel('Created (UTC)', { exact: true }).textContent();
  const edited = await dialog.getByLabel('Edited (UTC)', { exact: true }).textContent();
  assert.match(created, /^\d{4}-\d{2}-\d{2}T.*Z$/); assert.equal(edited, created);
  assert.equal(await dialog.getByRole('button', { name: 'Clear Edited', exact: true }).count(), 0);
  await dialog.getByLabel('Name', { exact: true }).fill('Saved again');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready(); await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await dialog.getByLabel('Created (UTC)', { exact: true }).textContent(), created);
  assert.ok(await dialog.getByLabel('Edited (UTC)', { exact: true }).textContent() > edited);
  await page.screenshot({ path: '.artifacts/desktop-record-times.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  assert.equal(await dialog.getByLabel('Created (UTC)', { exact: true }).textContent(), '');
  assert.equal(await dialog.getByLabel('Edited (UTC)', { exact: true }).textContent(), '');
  await dialog.getByLabel('Name', { exact: true }).fill('New copy');
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  const saved = await page.evaluate(async () => {
    const connection = await window.rowweave.connection(), headers = { Authorization: `Bearer ${connection.token}` };
    const table = (await fetch(connection.url + '/tables', { headers }).then(response => response.json())).find(table => table.name === 'Record times');
    const result = await fetch(`${connection.url}/tables/${table.id}/query`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json());
    return result.records.map(row => [row.values[table.fields[1].id], row.values[table.fields[2].id]]);
  });
  assert.equal(saved.length, 2); assert.ok(saved[1][0] > created); assert.equal(saved[1][0], saved[1][1]);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
