import assert from 'node:assert/strict';

export async function verifyAutomaticNumberWorkflow(page, application) {
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Automatic tickets');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Automatic tickets', exact: true }).waitFor();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Existing ticket');
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Ticket');
  await page.getByLabel('Field type', { exact: true }).selectOption('autoNumber');
  assert.equal(await dialog.getByLabel('Require a value', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('Use a default for new records', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await ready();
  const select = async () => {
    await page.locator('.dvn-scroller').click({ position: { x: 280, y: 58 } });
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await dialog.getByLabel('Ticket', { exact: true }).textContent(), '1');
  assert.equal(await dialog.getByRole('button', { name: 'Clear Ticket', exact: true }).count(), 0);
  await page.screenshot({ path: '.artifacts/desktop-automatic-number.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await select();
  await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => await navigator.clipboard.readText() === '1');
  await application.evaluate(({ clipboard }) => clipboard.writeText('99'));
  await page.keyboard.press('Control+v');
  await page.getByRole('alert').filter({ hasText: 'read-only' }).waitFor();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  assert.equal(await dialog.getByLabel('Ticket', { exact: true }).textContent(), '');
  await dialog.getByLabel('Name', { exact: true }).fill('Copied ticket');
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  const saved = await page.evaluate(async () => {
    const connection = await window.rowweave.connection(), headers = { Authorization: `Bearer ${connection.token}` };
    const table = (await fetch(connection.url + '/tables', { headers }).then(response => response.json())).find(table => table.name === 'Automatic tickets');
    const result = await fetch(`${connection.url}/tables/${table.id}/query`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json());
    return result.records.map(row => [row.values[table.primaryFieldId], row.values[table.fields[1].id]]);
  });
  assert.deepEqual(saved, [['Existing ticket', 1], ['Copied ticket', 2]]);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
