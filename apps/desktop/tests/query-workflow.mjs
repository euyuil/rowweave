import assert from 'node:assert/strict';

export async function verifyQueryWorkflow(page) {
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
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
