import assert from 'node:assert/strict';

const call = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  const connection = await window.rowweave.connection();
  const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(await response.text()); return response.json();
}, { path, method, body });
const ready = page => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
const waitCell = (page, row, text) => page.waitForFunction(({ row, text }) =>
  document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === text,
{ row, text }, { polling: 100 });
const choose = async (page, name) => {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor(); await ready(page);
};
const create = async (page, name) => {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor(); await ready(page);
};
const remove = async page => {
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
};
const heading = async (page, row) => {
  await ready(page);
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36, { delay: 50 }); await ready(page);
};

export async function verifyGroupPreferences(page) {
  const name = 'Remembered group choices';
  await create(page, name);
  let table = (await call(page, '/tables')).find(table => table.name === name);
  const root = '/tables/' + table.id;
  table = await call(page, root + '/fields', 'POST', { expectedVersion: table.version, name: 'Category', type: 'singleSelect',
    options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'unused', name: 'Unused' }] });
  const category = table.fields[1].id;
  const records = (await call(page, root + '/records', 'POST', [
    { values: { [table.primaryFieldId]: 'Alpha', [category]: 'a' } }, { values: { [table.primaryFieldId]: 'Beta', [category]: 'b' } },
  ])).records;
  let view = (await call(page, root + '/views'))[0];
  view = await call(page, root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, groupBy: category });
  await call(page, root + '/views', 'POST', { name: 'Alternate groups', groupBy: category });
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready(page);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click(); await ready(page);
  await heading(page, 0); await waitCell(page, 1, 'Alpha');
  await heading(page, 3); await waitCell(page, 3, '▾ Unused · 0 records');
  await page.getByRole('tab', { name: 'Alternate groups', exact: true }).click(); await ready(page);
  await waitCell(page, 3, 'Beta');
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click(); await ready(page);
  await heading(page, 1); await waitCell(page, 2, 'Beta');
  await page.getByRole('tab', { name: 'All records', exact: true }).click(); await ready(page);
  await waitCell(page, 1, 'Alpha'); await waitCell(page, 2, '▸ B · 1 record');

  await create(page, 'Preference navigation fixture'); await remove(page); await choose(page, name);
  await waitCell(page, 1, 'Alpha'); await waitCell(page, 2, '▸ B · 1 record');
  await page.reload(); await choose(page, name);
  await waitCell(page, 1, 'Alpha'); await waitCell(page, 3, '▾ Unused · 0 records');

  const failGroups = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'GROUPS_UNAVAILABLE', message: 'Synthetic preference layout failure' } }) });
  await page.route('**' + root + '/groups/query', failGroups);
  try {
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic preference layout failure' }).waitFor();
    await ready(page); await waitCell(page, 2, '▸ B · 1 record');
  } finally { await page.unroute('**' + root + '/groups/query', failGroups); }
  await page.reload(); await choose(page, name);
  await waitCell(page, 1, 'Alpha'); await waitCell(page, 2, '▸ B · 1 record');

  await page.evaluate(() => {
    window.originalGroupStorage = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('rowweave.groups.')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return window.originalGroupStorage.call(this, key, value);
    };
  });
  try {
    await page.getByRole('button', { name: 'Expand all', exact: true }).click(); await ready(page);
    await waitCell(page, 3, 'Beta');
    await page.getByRole('alert').filter({ hasText: 'Could not remember group choices' }).waitFor();
  } finally {
    await page.evaluate(() => { Storage.prototype.setItem = window.originalGroupStorage; delete window.originalGroupStorage; });
  }
  await page.reload(); await choose(page, name);
  await waitCell(page, 1, 'Alpha'); await waitCell(page, 2, '▸ B · 1 record');
  table = await call(page, root);
  table = await call(page, root + '/fields/' + category, 'PATCH', { expectedVersion: table.version,
    options: [{ id: 'a', name: 'Renamed A' }, { id: 'b', name: 'B' }] });
  await waitCell(page, 0, '▾ Renamed A · 1 record'); await waitCell(page, 2, '▸ B · 1 record');
  const namespace = JSON.stringify([view.id, category, 'singleSelect']);
  await page.waitForFunction(key => {
    const choice = JSON.parse(localStorage.getItem('rowweave.groups.' + key));
    return choice.defaultCollapsed && JSON.stringify(choice.exceptions) === '["a"]';
  }, namespace);
  for (const record of records) assert.deepEqual(await call(page, root + '/records/' + record.id), record);
  return { name, root, records };
}

export async function verifyGroupPreferencesAfterRestart(page, fixture) {
  await choose(page, fixture.name);
  await waitCell(page, 0, '▾ Renamed A · 1 record'); await waitCell(page, 1, 'Alpha'); await waitCell(page, 2, '▸ B · 1 record');
  await page.getByRole('tab', { name: 'Alternate groups', exact: true }).click(); await ready(page);
  await waitCell(page, 0, '▸ Renamed A · 1 record'); await waitCell(page, 2, 'Beta');
  await page.getByRole('tab', { name: 'All records', exact: true }).click(); await ready(page);
  await waitCell(page, 1, 'Alpha');
  await page.screenshot({ path: '.artifacts/desktop-group-preferences-restarted.png' });
  for (const record of fixture.records) assert.deepEqual(await call(page, fixture.root + '/records/' + record.id), record);
  await remove(page);
}
