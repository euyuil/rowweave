import assert from 'node:assert/strict';

const call = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  const connection = await window.rowweave.connection();
  const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
}, { path, method, body });
const ready = page => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
const cell = (page, row, text) => page.waitForFunction(({ row, text }) =>
  document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent.includes(text), { row, text });
const click = async (page, row, column = 0) => {
  await ready(page); const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58 + row * 36, { delay: 50 });
  assert.equal((await page.locator('canvas').first().boundingBox()).y, bounds.y, 'Selection wording must not move the grid during a click.');
};
const choose = async (page, name) => {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor(); await ready(page);
};

export async function verifyNestedGroups(page) {
  const name = 'Nested group editing';
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  let table = (await call(page, '/tables')).find(table => table.name === name);
  const root = '/tables/' + table.id;
  for (const field of [
    { name: 'Team', type: 'singleSelect', options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'empty', name: 'Empty' }] },
    { name: 'Category', type: 'text' }, { name: 'Done', type: 'checkbox' }, { name: 'Amount', type: 'number' },
  ]) table = await call(page, root + '/fields', 'POST', { expectedVersion: table.version, ...field });
  const [title, team, category, done, amount] = table.fields.map(field => field.id);
  const records = (await call(page, root + '/records', 'POST', [
    ['Alpha', 'a', false, 1], ['Bravo', 'a', true, 2], ['Delta', 'b', false, 4], ['Echo', 'b', true, 5],
  ].map(values => ({ values: { [title]: values[0], [team]: values[1], [category]: 'Shared', [done]: values[2], [amount]: values[3] } })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready(page);
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('Grid group field', { exact: true }).selectOption(team);
  await page.getByRole('button', { name: 'Add grouping level', exact: true }).click();
  await page.getByLabel('Grid group field 2', { exact: true }).selectOption(category);
  await page.getByRole('button', { name: 'Add grouping level', exact: true }).click();
  await page.getByLabel('Grid group field 3', { exact: true }).selectOption(done);
  assert.equal(await page.getByRole('button', { name: 'Add grouping level', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Move group 3 up', exact: true }).click();
  assert.equal(await page.getByLabel('Grid group field 2', { exact: true }).inputValue(), done);
  await page.getByRole('button', { name: 'Move group 3 up', exact: true }).click();
  await page.getByRole('button', { name: 'Add measure', exact: true }).click();
  await page.getByRole('dialog').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '.artifacts/desktop-nested-group-settings.png' });
  await page.getByRole('dialog').getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' }); await ready(page);
  let view = (await call(page, root + '/views'))[0];
  assert.deepEqual(view.groupBy, [team, category, done]);
  await cell(page, 0, '▾ A · 2 records · Sum Amount: 3');
  await cell(page, 1, '　▾ Shared · 2 records · Sum Amount: 3');
  await cell(page, 2, '　　▾ Unchecked · 1 record · Sum Amount: 1');
  assert.equal(await page.getByRole('button', { name: 'Groups', exact: true }).locator('.query-badge').innerText(), '3');
  await click(page, 1); await ready(page);
  await cell(page, 1, '▸ Shared'); await cell(page, 3, '▾ Shared'); await cell(page, 5, 'Delta');
  await click(page, 0); await ready(page); await cell(page, 0, '▸ A'); await cell(page, 4, 'Delta');
  await click(page, 0); await ready(page); await cell(page, 1, '▸ Shared'); await cell(page, 5, 'Delta');
  let bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(bounds.x + 150, bounds.y + 58 + 4 * 36);
  await page.waitForFunction(() => document.querySelector('.grid-host').title.includes('B / Shared / Unchecked'));
  await page.screenshot({ path: '.artifacts/desktop-nested-group-paths.png' });
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  assert.equal(await page.getByLabel('Grid group field 3', { exact: true }).inputValue(), done);
  await page.getByRole('button', { name: 'Remove group 2', exact: true }).click();
  assert.equal(await page.getByLabel('Grid group field 2', { exact: true }).inputValue(), done);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await click(page, 5); if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.evaluate(() => navigator.clipboard.writeText('pending copy')); await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === 'Delta\nEcho');
  // Reset the range with keyboard navigation; a repeated mouse click can open the cell editor.
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelectorAll('canvas [role="gridcell"][aria-selected="true"]').length === 1);
  await page.evaluate(() => navigator.clipboard.writeText('Pasted Delta\nPasted Echo')); await page.keyboard.press('Control+v');
  await page.getByText('2 unsaved cells', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await page.getByText('2 unsaved cells', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByText('All changes saved', { exact: true }).waitFor(); await ready(page);
  assert.equal((await call(page, root + '/records/' + records[2].id)).values[title], 'Pasted Delta');
  assert.equal((await call(page, root + '/records/' + records[3].id)).values[title], 'Pasted Echo');
  for (const record of records.slice(0, 2)) assert.deepEqual(await call(page, root + '/records/' + record.id), record);

  await click(page, 5, 2); if (!await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Enter');
  await page.getByLabel('Cell value', { exact: true }).fill('Other'); await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.keyboard.press('Control+s'); await page.getByText('All changes saved', { exact: true }).waitFor(); await ready(page);
  await cell(page, 3, '▾ Other'); await cell(page, 5, 'Pasted Delta');
  assert.equal((await call(page, root + '/records/' + records[2].id)).values[category], 'Other');
  assert.equal((await call(page, root + '/records/' + records[3].id)).values[category], 'Shared');

  await click(page, 5); if (!await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Enter');
  const editor = page.getByLabel('Cell value', { exact: true });
  await editor.fill('保留输入'); await editor.dispatchEvent('compositionstart');
  const remote = await call(page, root + '/records/' + records[3].id);
  await call(page, root + '/records', 'PATCH', [{ id: remote.id, expectedVersion: remote.version, values: { [title]: 'Remote Echo', [amount]: 15 } }]);
  await page.waitForRequest(request => request.url().endsWith('/workspace/state') && request.postDataJSON()?.viewId === view.id);
  assert.equal(await editor.inputValue(), '保留输入'); assert.equal(await editor.evaluate(element => element === document.activeElement), true);
  await cell(page, 2, 'Sum Amount: 9');
  await editor.dispatchEvent('compositionend', { data: '保留输入' }); await page.keyboard.press('Escape');
  await cell(page, 2, 'Sum Amount: 19'); await cell(page, 5, 'Pasted Delta');
  await click(page, 3); await ready(page); await cell(page, 3, '▸ Other'); await cell(page, 6, 'Remote Echo');
  const failGroups = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'GROUPS_UNAVAILABLE', message: 'Synthetic nested layout failure' } }) });
  await page.route('**' + root + '/groups/query', failGroups);
  try {
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic nested layout failure' }).waitFor(); await ready(page);
    await cell(page, 1, '▸ Shared'); await cell(page, 3, '▸ Other');
  } finally { await page.unroute('**' + root + '/groups/query', failGroups); }
  await page.reload(); await choose(page, name);
  await cell(page, 1, '▸ Shared'); await cell(page, 3, '▸ Other'); await cell(page, 6, 'Remote Echo');
  const namespace = JSON.stringify([view.id, [team, category, done], ['singleSelect', 'text', 'checkbox']]);
  const preference = await page.evaluate(namespace => JSON.parse(localStorage.getItem('rowweave.groups.' + namespace)), namespace);
  assert.deepEqual(preference, { defaultCollapsed: false, exceptions: [['a', 'Shared'], ['b', 'Other']] });
  await page.screenshot({ path: '.artifacts/desktop-nested-group-editing.png' });
  return { name, root, records, title, category, view };
}

export async function verifyNestedGroupsAfterRestart(page, fixture) {
  await choose(page, fixture.name);
  await cell(page, 1, '▸ Shared'); await cell(page, 3, '▸ Other'); await cell(page, 6, 'Remote Echo');
  await click(page, 3); await ready(page); await cell(page, 5, 'Pasted Delta');
  assert.equal((await call(page, fixture.root + '/records/' + fixture.records[2].id)).values[fixture.category], 'Other');
  await page.screenshot({ path: '.artifacts/desktop-nested-group-restarted.png' });
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
