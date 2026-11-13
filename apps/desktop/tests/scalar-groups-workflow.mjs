import assert from 'node:assert/strict';

export async function verifyScalarGroups(page) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog'), canvas = page.locator('canvas').first();
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const waitCell = (row, text) => page.waitForFunction(({ row, text }) =>
    document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === text,
  { row, text }, { polling: 100 });
  const home = async () => { await ready(); await canvas.focus(); await page.keyboard.press('Control+Home'); };
  const copy = async expected => {
    await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
    await page.keyboard.press('Control+c');
    await page.waitForFunction(async expected => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === expected, expected, { polling: 100 });
  };
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Scalar group windows');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Scalar group windows', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Scalar group windows');
  const root = '/tables/' + table.id, name = table.primaryFieldId;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Category', type: 'text' });
  const category = table.fields[1].id;
  const records = (await call(root + '/records', 'POST', Array.from({ length: 800 }, (_, index) => ({
    values: { [name]: 'Record ' + index, [category]: 'Group ' + String(index).padStart(4, '0') },
  })))).records;
  let view = (await call(root + '/views'))[0];
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    columns: view.columns.map(column => ({ ...column, hidden: column.fieldId === category })) });
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await dialog.getByLabel('Grid group field', { exact: true }).selectOption(category);
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  await ready(); await waitCell(0, '▾ Group 0000 · 1 record');
  const requests = [];
  const observe = request => { if (request.url().endsWith(root + '/groups/query')) requests.push(request.postDataJSON()); };
  page.on('request', observe);
  try {
    await canvas.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowUp');
    await waitCell(1599, 'Record 799'); await copy('Record 799');
    await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
    await editor.fill('Deep draft 中文'); await page.keyboard.press('Tab');
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor(); await ready();
    assert.equal((await call(root + '/records/' + records[799].id)).values[name], 'Deep draft 中文');
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click(); await home();
    await waitCell(0, '▸ Group 0000 · 1 record');
    await page.keyboard.press('Enter'); await ready(); await waitCell(1, 'Record 0');
    await canvas.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowUp');
    await waitCell(800, '▸ Group 0799 · 1 record');
    await page.keyboard.press('Enter'); await ready(); await waitCell(801, 'Deep draft 中文');
    await page.screenshot({ path: '.artifacts/desktop-scalar-group-deep.png' });
    await home(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Control+Shift+End');
    await copy('Record 0\nDeep draft 中文');
    await home(); await page.keyboard.press('ArrowDown');
    await page.evaluate(() => navigator.clipboard.writeText('First pasted\nLast pasted'));
    const failExpanded = route => route.request().postDataJSON().window === 'expandedRecords'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'GROUPS_UNAVAILABLE', message: 'Synthetic expanded-window outage' } }) })
      : route.continue();
    await page.route('**' + root + '/groups/query', failExpanded);
    try {
      await page.keyboard.press('Control+v');
      await page.getByRole('alert').filter({ hasText: 'Synthetic expanded-window outage' }).waitFor();
      await page.getByText('All changes saved', { exact: true }).waitFor();
      assert.equal((await call(root + '/records/' + records[0].id)).version, 1);
    } finally { await page.unroute('**' + root + '/groups/query', failExpanded); }
    await page.keyboard.press('Control+v');
    await page.getByText('2 unsaved cells', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByText('2 unsaved cells', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor(); await ready();
    assert.equal((await call(root + '/records/' + records[0].id)).values[name], 'First pasted');
    assert.equal((await call(root + '/records/' + records[799].id)).values[name], 'Last pasted');
    assert.equal((await call(root + '/records/' + records[400].id)).version, 1);
    await home(); await waitCell(1, 'First pasted');
    const failCollapse = route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'GROUPS_UNAVAILABLE', message: 'Synthetic collapse outage' } }) });
    await page.route('**' + root + '/groups/query', failCollapse);
    try {
      await page.getByRole('button', { name: 'Expand all', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic collapse outage' }).waitFor();
      await ready(); await waitCell(1, 'First pasted'); await waitCell(2, '▸ Group 0001 · 1 record');
    } finally { await page.unroute('**' + root + '/groups/query', failCollapse); }
    await page.getByRole('button', { name: 'Expand all', exact: true }).click(); await ready();
    await waitCell(3, 'Record 1');
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click(); await home();
    await page.keyboard.press('Enter'); await ready(); await waitCell(1, 'First pasted');
    await page.screenshot({ path: '.artifacts/desktop-scalar-group-first.png' });
    assert.ok(requests.some(query => query.offset > 500), 'Deep navigation must use bounded metadata windows.');
    assert.ok(requests.some(query => query.window === 'expandedRecords' && query.limit === 2), 'Pasting must skip the collapsed headings.');
    assert.ok(requests.every(query => query.limit <= 500));
  } finally { page.off('request', observe); }
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
