import assert from 'node:assert/strict';

export async function verifyTrashWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], size = window.getSize(); window.setSize(1024, 768); return size;
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Recovery lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Recovery lab', exact: true }).waitFor();
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  let table = (await call('/tables')).find(table => table.name === 'Recovery lab');
  const root = `/tables/${table.id}`;
  for (const field of [{ name: 'Cost', type: 'number' }, { name: 'Notes', type: 'multiline' }, { name: 'Done', type: 'checkbox' }, { name: 'Reference', type: 'text' }]) {
    table = await call(`${root}/fields`, 'POST', { ...field, expectedVersion: table.version });
  }
  const [name, cost, notes, done, reference] = table.fields.map(field => field.id);
  table = await call(`${root}/fields`, 'POST', { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${cost}] * 2`, resultType: 'number' } });
  const double = table.fields.at(-1).id;
  const rows = (await call(`${root}/records`, 'POST', Array.from({ length: 12 }, (_, i) => ({ values: {
    [name]: `Recovery ${i}`, [cost]: i, [notes]: '中文 🌱\nKeep this value', [done]: false, [reference]: '7',
  } })))).records;
  await call(`${root}/records`, 'DELETE', rows.map(row => ({ id: row.id, expectedVersion: row.version })));
  const deleted = (await call(`${root}/trash/query`, 'POST', {})).records;
  const dialog = page.getByRole('dialog'), open = async () => {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: 'Trash', exact: true }).focus(); await page.keyboard.press('Enter');
    await dialog.locator('.trash-list li').first().waitFor();
  };
  const select = row => dialog.getByRole('checkbox', { name: `Select deleted record ${row.id}`, exact: true });
  const inspect = async row => {
    await dialog.getByRole('button', { name: `Inspect deleted record ${row.id}`, exact: true }).click();
    await dialog.getByRole('region', { name: 'Deleted record details', exact: true }).waitFor();
    await page.waitForFunction(id => document.querySelector('.trash-details code')?.textContent === id, row.id);
  };
  await open();
  assert.equal(await dialog.locator('.trash-list li').count(), 10);
  await select(deleted[0]).check();
  await dialog.getByRole('button', { name: 'Older deletions', exact: true }).click();
  await select(deleted.at(-1)).check();
  assert.equal(await dialog.locator('.trash-list li').count(), 2);
  await inspect(deleted.at(-1));
  assert.match(await dialog.locator('.history-comparison').innerText(), /中文 🌱/);
  assert.match(await dialog.locator('.history-comparison').innerText(), /false/);
  assert.match(await dialog.locator('.history-comparison').innerText(), /Cost\s+0/);
  await dialog.getByText('Adjust values for restoration', { exact: true }).click();
  await dialog.getByLabel('Notes', { exact: true }).fill('Restored 中文 🌱');
  await page.keyboard.press('Escape');
  await dialog.getByRole('region', { name: 'Unsaved restoration changes', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
  assert.equal(await dialog.getByLabel('Notes', { exact: true }).inputValue(), 'Restored 中文 🌱');
  await dialog.getByRole('button', { name: 'Newer deletions', exact: true }).click();
  await select(deleted[0]).waitFor(); assert.equal(await select(deleted[0]).isChecked(), true);
  await page.screenshot({ path: '.artifacts/desktop-trash.png' });
  await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click();
  await dialog.getByRole('heading', { name: 'Restore 2 records?', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-trash-confirmation.png' });
  await dialog.getByRole('button', { name: 'Cancel restoration', exact: true }).click();
  assert.equal((await call(`${root}/query`, 'POST', {})).total, 0);
  await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore records', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('2 records restored.', { exact: true }).waitFor();
  const recovered = (await call(`${root}/query`, 'POST', {})).records;
  assert.deepEqual(recovered.map(row => row.id), [deleted[0].id, deleted.at(-1).id]);
  const repaired = recovered[1];
  assert.equal(repaired.version, 2); assert.equal(repaired.values[notes], 'Restored 中文 🌱');
  assert.equal(repaired.values[double], 0); assert.equal(repaired.values[done], false);
  await open();
  const stale = deleted[1];
  await select(stale).check();
  await call(`${root}/trash/restore`, 'POST', [{ id: stale.id, deletionId: stale.deletionId }]);
  await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore records', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /already restored/);
  await page.screenshot({ path: '.artifacts/desktop-trash-conflict.png' });
  assert.equal((await call(`${root}/query`, 'POST', {})).total, 3);
  await dialog.getByRole('button', { name: 'Refresh trash', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.trash-toolbar > span')?.textContent === '0 selected');
  await select(stale).waitFor({ state: 'detached' });
  await dialog.locator('.trash-list li').first().waitFor();
  assert.equal(await select(stale).count(), 0);
  await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();

  table = await call(root);
  table = await call(`${root}/fields`, 'POST', { expectedVersion: table.version, name: 'Required code', type: 'text', defaultValue: 'Default code' });
  const required = table.fields.at(-1).id;
  const current = (await call(`${root}/query`, 'POST', {})).records;
  await call(`${root}/records`, 'PATCH', current.map(row => ({ id: row.id, expectedVersion: row.version, values: { [required]: 'Default code' } })));
  table = await call(`${root}/fields/${required}`, 'PATCH', { expectedVersion: table.version, required: true });
  table = await call(`${root}/fields/${reference}/conversion/apply`, 'POST', { expectedVersion: table.version, field: { name: 'Reference', type: 'number' } });
  await open();
  const chosen = deleted[2];
  await select(chosen).check(); await inspect(chosen);
  await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore records', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Reference' }).waitFor();
  assert.equal((await call(`${root}/query`, 'POST', {})).total, 3);
  await dialog.getByText('Adjust values for restoration', { exact: true }).click();
  await dialog.getByText('The saved value is incompatible with Reference.', { exact: false }).waitFor();
  await dialog.getByLabel('Reference', { exact: true }).fill('9');
  assert.equal(await dialog.getByLabel('Required code *', { exact: true }).inputValue(), 'Default code');
  await dialog.getByLabel('Required code *', { exact: true }).fill('Adjusted code');
  await page.screenshot({ path: '.artifacts/desktop-trash-adjustments.png' });
  await dialog.getByRole('button', { name: 'Refresh trash', exact: true }).click();
  await dialog.getByRole('region', { name: 'Unsaved restoration changes', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Restore records', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await call(`${root}/records/${chosen.id}`)).values[required], 'Adjusted code');
  assert.equal((await call(`${root}/records/${chosen.id}`)).values[reference], 9);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
