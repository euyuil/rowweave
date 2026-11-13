import assert from 'node:assert/strict';

export async function verifyBoardWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Board lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Board lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(connection.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare board fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Board lab');
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect', defaultValue: 'todo',
      options: [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `extra${i}`, name: `Extra ${i}` }))] });
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Cost', type: 'number' });
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Notes', type: 'text' });
    const [name, status, cost, notes] = table.fields;
    const result = await call(`/tables/${table.id}/records`, 'POST', Array.from({ length: 506 }, (_, i) => ({ values: {
      [name.id]: `Task ${String(i).padStart(3, '0')}`, [status.id]: i < 501 ? 'todo' : i < 504 ? 'doing' : i === 504 ? 'done' : null,
      [cost.id]: i, [notes.id]: `Hidden note ${i}`,
    } })));
    return { table, status: status.id, cost: cost.id, conflict: result.records[1] };
  });
  const requests = [];
  const capture = request => {
    if (request.method() === 'POST' && /\/views\/[^/]+\/query$/.test(request.url())) {
      const body = request.postDataJSON(); if (body.lane !== undefined) requests.push(body);
    }
  };
  page.on('request', capture);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('506 records · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('By status');
  await page.getByLabel('View type', { exact: true }).selectOption('board');
  await page.getByLabel('Board group field', { exact: true }).selectOption(fixture.status);
  await page.getByLabel('Show Notes', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Create view', exact: true }).click();
  const todo = page.getByRole('region', { name: 'To do column', exact: true });
  const doing = page.getByRole('region', { name: 'Doing column', exact: true });
  const done = page.getByRole('region', { name: 'Done column', exact: true });
  await todo.getByText('501', { exact: true }).waitFor();
  await todo.getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  assert.equal(await todo.locator('.board-card').count(), 25);
  assert.ok(requests.every(request => request.limit === 25));
  assert.ok(!requests.some(request => request.lane === null));
  await page.screenshot({ path: '.artifacts/desktop-status-board.png' });
  await todo.getByLabel('Move Task 000 to', { exact: true }).selectOption('doing');
  await doing.getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  await todo.getByText('500', { exact: true }).waitFor();
  await doing.getByRole('button', { name: 'Task 000', exact: true }).click();
  await page.locator('.drawer-dialog').waitFor();
  assert.ok(await page.locator('.drawer-dialog .dialog-actions').evaluate(element => Math.abs(element.getBoundingClientRect().bottom - innerHeight) <= 2));
  await page.screenshot({ path: '.artifacts/desktop-board-record-panel.png' });
  assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), 'Hidden note 0');
  await page.getByLabel('Name', { exact: true }).fill('Moved task');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await doing.getByRole('button', { name: 'Moved task', exact: true }).waitFor();
  await todo.getByRole('button', { name: '+ New record', exact: true }).click();
  assert.equal(await page.getByLabel('Status', { exact: true }).inputValue(), 'todo');
  await page.getByLabel('Name', { exact: true }).fill('Fresh task');
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.fill('Fresh task');
  await todo.getByRole('button', { name: 'Fresh task', exact: true }).waitFor();
  await todo.locator('.board-card').filter({ has: page.getByRole('button', { name: 'Fresh task', exact: true }) }).dragTo(done);
  await done.getByRole('button', { name: 'Fresh task', exact: true }).waitFor();
  await todo.getByText('No matching records', { exact: true }).waitFor();
  await search.fill('');
  await todo.getByRole('button', { name: 'Task 001', exact: true }).waitFor();
  await todo.getByRole('button', { name: 'Next records in To do', exact: true }).click();
  await todo.getByRole('button', { name: 'Task 026', exact: true }).waitFor();
  assert.equal(await todo.locator('.board-card').count(), 25);
  await todo.getByRole('button', { name: 'Previous records in To do', exact: true }).click();
  await todo.getByRole('button', { name: 'Task 001', exact: true }).waitFor();
  await page.evaluate(async ({ table, cost, conflict }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${table.id}/records`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: conflict.id, expectedVersion: conflict.version, values: { [cost]: 999 } }]),
    });
    if (!response.ok) throw new Error('Could not change the board fixture.');
  }, fixture);
  await todo.getByLabel('Move Task 001 to', { exact: true }).selectOption('doing');
  await page.getByRole('alert').filter({ hasText: 'Refresh the board before moving another record' }).waitFor();
  assert.equal(await todo.getByLabel('Move Task 001 to', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
  await todo.locator('.board-card').filter({ has: page.getByRole('button', { name: 'Task 001', exact: true }) }).getByText('999', { exact: true }).waitFor();
  assert.equal(await todo.getByLabel('Move Task 001 to', { exact: true }).inputValue(), 'todo');
  const empty = page.getByRole('region', { name: 'No value column', exact: true });
  await empty.scrollIntoViewIfNeeded();
  await empty.getByRole('button', { name: 'Task 505', exact: true }).waitFor();
  assert.ok(requests.some(request => request.lane === null));
  await empty.getByRole('button', { name: '+ New record', exact: true }).click();
  assert.equal(await page.getByLabel('Status', { exact: true }).inputValue(), '');
  await page.getByLabel('Name', { exact: true }).fill('No group task');
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await empty.getByRole('button', { name: 'No group task', exact: true }).waitFor();
  assert.ok(await page.locator('.board-scroll').evaluate(element => element.scrollLeft > 1000));
  await page.getByRole('tab', { name: 'All records', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Keep this draft');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'By status', exact: true }).click();
  await page.getByRole('region', { name: 'By status board', exact: true }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await doing.scrollIntoViewIfNeeded();
  await doing.getByRole('button', { name: 'Keep this draft', exact: true }).waitFor();
  page.off('request', capture);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
