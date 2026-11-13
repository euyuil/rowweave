import assert from 'node:assert/strict';

export async function verifyQueryWorkflow(page, application) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Queries lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Queries lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(`${connection.url}${path}`, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare the query fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Queries lab');
    for (const field of [{ name: 'Priority', type: 'number' }, { name: 'Done', type: 'checkbox' },
      { name: 'Tags', type: 'multiSelect', options: [{ name: 'X' }, { name: 'Y' }] }]) {
      table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version });
    }
    const [name, priority, done, tags] = table.fields;
    const { records } = await call(`/tables/${table.id}/records`, 'POST', ['A', 'B', 'C', 'D', 'E'].map((value, index) => ({
      values: { [name.id]: value, [priority.id]: [20, 20, 20, 10, 5][index], [done.id]: index === 2,
        [tags.id]: [tags.options[index % 2].id] },
    })));
    return { table, records };
  });
  const read = () => page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const views = await fetch(`${connection.url}/tables/${id}/views`, { headers }).then(r => r.json());
    const view = views.find(view => view.name === 'My priorities');
    const page = view && await fetch(`${connection.url}/tables/${id}/views/${view.id}/query`, {
      method: 'POST', headers, body: JSON.stringify({ offset: 0, limit: 10 }),
    }).then(r => r.json());
    return { views, view, page };
  }, fixture.table.id);
  const rule = path => page.getByRole('group', { name: `Filter ${path}`, exact: true });
  const add = path => page.getByRole('button', { name: `Add condition to group ${path}`, exact: true }).click();
  const setRule = async (path, field, operator) => {
    await rule(path).getByLabel('Filter field', { exact: true }).selectOption({ label: field });
    await rule(path).getByLabel('Filter operator', { exact: true }).selectOption(operator);
  };
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('5 records · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('My priorities');
  await add('1');
  await setRule('1.1', 'Done', 'eq');
  await rule('1.1').getByLabel('Value', { exact: true }).selectOption('false');
  await page.getByRole('button', { name: 'Add subgroup to group 1', exact: true }).click();
  await page.getByLabel('Match group 1.2', { exact: true }).selectOption('or');
  await add('1.2');
  await setRule('1.2.1', 'Priority', 'gte');
  await rule('1.2.1').getByLabel('Value *', { exact: true }).fill('not a number');
  await add('1.2');
  await setRule('1.2.2', 'Tags', 'hasAny');
  await rule('1.2.2').getByLabel('Value', { exact: true }).selectOption({ label: 'X' });
  for (const [index, field] of ['Priority', 'Name'].entries()) {
    await page.getByRole('button', { name: 'Add sort', exact: true }).click();
    const sort = page.getByRole('group', { name: `Sort ${index + 1}`, exact: true });
    await sort.getByLabel('Sort field', { exact: true }).selectOption({ label: field });
    await sort.getByLabel('Sort direction', { exact: true }).selectOption('desc');
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Create view', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'decimal number' }).waitFor();
  assert.equal((await read()).views.length, 1);
  await rule('1.2.1').getByLabel('Value *', { exact: true }).fill('10');
  await rule('1.2.1').getByLabel('Filter operator', { exact: true }).selectOption('gt');
  assert.equal(await rule('1.2.1').getByLabel('Value *', { exact: true }).inputValue(), '10');
  await rule('1.2.1').getByLabel('Filter operator', { exact: true }).selectOption('gte');
  await page.getByRole('dialog').getByRole('button', { name: 'Create view', exact: true }).click();
  await page.getByText('4 records · 4 fields', { exact: true }).waitFor();
  const saved = await read();
  assert.deepEqual(saved.page.records.map(record => record.values[fixture.table.primaryFieldId]), ['B', 'A', 'D', 'E']);
  assert.equal(saved.view.query.filter.conditions[1].conjunction, 'or');
  assert.equal(saved.view.query.sort.length, 2);
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 15, bounds.y + 58);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'B');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  assert.equal(await rule('1.2.1').getByLabel('Value *', { exact: true }).inputValue(), '10');
  assert.equal(await page.getByLabel('Match group 1.2', { exact: true }).inputValue(), 'or');
  await page.getByRole('dialog').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '.artifacts/desktop-query-editor.png' });
  await page.getByRole('button', { name: 'Move sort 2 up', exact: true }).click();
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual((await read()).page.records.map(record => record.values[fixture.table.primaryFieldId]), ['E', 'D', 'B', 'A']);
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Clear sorting', exact: true }).click();
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByText('5 records · 4 fields', { exact: true }).waitFor();
  assert.deepEqual((await read()).page.records.map(record => record.values[fixture.table.primaryFieldId]), ['A', 'B', 'C', 'D', 'E']);
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(1024, 768); return size;
  });
  const filters = page.getByRole('button', { name: 'Filters', exact: true });
  const sorting = page.getByRole('button', { name: 'Sort', exact: true });
  const dialog = page.getByRole('dialog');
  const save = async () => {
    await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  };
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const grid = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(grid.x + 100, grid.y + 58);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Draft A');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.fill('B');
  await page.getByText('1 record · 4 fields', { exact: true }).waitFor();
  await sorting.click();
  assert.equal(await dialog.getByRole('region', { name: 'Filters', exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('Saved search', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Add sort', exact: true }).click();
  await dialog.getByLabel('Sort direction', { exact: true }).selectOption('desc');
  await save();
  assert.equal(await search.inputValue(), 'B');
  assert.equal((await read()).view.query.search, '');
  assert.equal((await read()).view.query.sort[0].direction, 'desc');
  assert.match(await sorting.textContent(), /1/);
  await filters.click();
  const trigger = await filters.boundingBox();
  const panel = await dialog.boundingBox();
  assert.ok(Math.abs(panel.y - (trigger.y + trigger.height + 6)) < 2);
  assert.ok(panel.x >= 12 && panel.x + panel.width <= 1012);
  assert.ok(panel.width <= 600);
  assert.ok(panel.y + panel.height <= 756);
  assert.equal(await dialog.getByRole('region', { name: 'Sorting', exact: true }).count(), 0);
  await add('1');
  await setRule('1.1', 'Priority', 'gte');
  await rule('1.1').getByLabel('Value *', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Add subgroup to group 1', exact: true }).click();
  await add('1.2');
  await setRule('1.2.1', 'Name', 'isNotEmpty');
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '.artifacts/desktop-contextual-filters.png' });
  await rule('1.1').getByLabel('Value *', { exact: true }).press('Control+s');
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await read()).view.query.sort[0].direction, 'desc');
  assert.match(await filters.textContent(), /On/);
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  const configuredFilter = (await read()).view.query.filter;
  await sorting.click();
  await dialog.getByLabel('Sort direction', { exact: true }).selectOption('asc');
  await save();
  assert.deepEqual((await read()).view.query.filter, configuredFilter);
  await sorting.click();
  await dialog.getByRole('button', { name: 'Clear sorting', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal((await read()).view.query.sort.length, 1);
  await filters.click();
  const beforeCancel = (await read()).view;
  await rule('1.1').getByLabel('Value *', { exact: true }).fill('100');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual((await read()).view, beforeCancel);
  assert.equal(await filters.evaluate(element => element === document.activeElement), true);
  await filters.click();
  await rule('1.1').getByLabel('Value *', { exact: true }).fill('30');
  await page.evaluate(async ({ tableId, view }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${tableId}/views/${view.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: view.version, columns: view.columns.map(column => ({ ...column, width: column.width + 1 })) }),
    });
    if (!response.ok) throw new Error('Could not prepare a concurrent query-panel update.');
  }, { tableId: fixture.table.id, view: beforeCancel });
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'view changed' }).waitFor();
  assert.equal(await rule('1.1').getByLabel('Value *', { exact: true }).inputValue(), '30');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await filters.click();
  await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Match group 1', { exact: true }).selectOption('or');
  await save();
  await page.getByText('0 records · 4 fields', { exact: true }).waitFor();
  assert.match(await filters.textContent(), /On/);
  await filters.click();
  await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await save();
  assert.equal(await filters.textContent(), 'Filters');
  await sorting.click();
  await page.screenshot({ path: '.artifacts/desktop-contextual-sort.png' });
  await dialog.getByRole('button', { name: 'Clear sorting', exact: true }).click();
  await save();
  assert.equal(await sorting.textContent(), 'Sort');
  await search.fill('');
  await page.getByText('5 records · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await read()).page.records[0].values[fixture.table.primaryFieldId], 'Draft A');
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
