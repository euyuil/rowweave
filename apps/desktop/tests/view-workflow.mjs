import assert from 'node:assert/strict';

export async function verifyViewWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Views lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Views lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(`${connection.url}${path}`, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare the view fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Views lab');
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Notes', type: 'text' });
    const notes = table.fields[1].id;
    const { records } = await call(`/tables/${table.id}/records`, 'POST', ['alpha', 'beta', 'gamma'].map((note, index) => ({
      values: { [table.primaryFieldId]: ['A', 'B', 'C'][index], [notes]: note },
    })));
    await call(`/tables/${table.id}/views`, 'POST', { name: 'Reverse', query: { sort: [{ fieldId: table.primaryFieldId, direction: 'desc' }] } });
    return { table, notes, records };
  });
  const read = () => page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}` };
    const views = await fetch(`${connection.url}/tables/${id}/views`, { headers }).then(r => r.json());
    const { records } = await fetch(`${connection.url}/tables/${id}/records?offset=0&limit=10`, { headers }).then(r => r.json());
    return { views, records };
  }, fixture.table.id);
  let lastCellClick = 0;
  const selectCell = async (row = 0, column = 0, width = 180) => {
    // Keep independent selections outside the grid's double-click edit interval.
    const remaining = 600 - (performance.now() - lastCellClick);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * width, bounds.y + 58 + row * 36);
    lastCellClick = performance.now();
    if (await page.getByRole('textbox', { name: 'Cell value' }).count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('3 records · 2 fields', { exact: true }).waitFor();
  const tabs = page.getByRole('tablist', { name: 'Views', exact: true });
  await tabs.getByRole('tab', { name: 'All records', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.getByRole('tab', { name: 'Reverse', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await tabs.getByRole('tab', { name: 'All records', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter');
  await page.getByRole('tabpanel', { name: 'Reverse', exact: true }).waitFor();
  await tabs.getByRole('tab', { name: 'Reverse', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-disabled') === 'false');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.getByRole('tabpanel', { name: 'All records', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Compact');
  await page.getByLabel('Saved search', { exact: true }).fill('beta');
  await page.getByLabel('Show Name', { exact: true }).uncheck();
  await page.getByLabel('Notes width', { exact: true }).fill('260');
  await page.getByRole('dialog').getByRole('button', { name: 'Create view', exact: true }).click();
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();
  const compact = (await read()).views.find(view => view.name === 'Compact');
  assert.equal(compact.columns.find(column => column.fieldId === fixture.notes).width, 260);
  assert.equal(compact.query.search, 'beta');
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Notes only');
  await page.getByLabel('Saved search', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Move Notes up', exact: true }).click();
  await page.keyboard.press('Control+s');
  await page.getByText('3 records · 1 field', { exact: true }).waitFor();
  const reordered = (await read()).views.find(view => view.id === compact.id);
  assert.equal(reordered.columns[0].fieldId, fixture.notes);
  await selectCell();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'A');
  assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), 'alpha');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectCell();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('draft alpha');
  await page.getByText('Editing cell…', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.evaluate(async ({ id, view }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${id}/views/${view.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: view.version, columns: view.columns.map(column => ({ ...column, width: 270 })) }),
    });
    if (!response.ok) throw new Error('Could not prepare the concurrent column update.');
  }, { id: fixture.table.id, view: reordered });
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Reverse', exact: true }).click();
  await page.getByText('3 records · 2 fields', { exact: true }).waitFor();
  await selectCell(2, 1);
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('textbox', { name: 'Cell value' }).inputValue(), 'draft alpha');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await read()).records.find(record => record.id === fixture.records[0].id).values[fixture.notes], 'draft alpha');
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.dispatchEvent('compositionstart');
  await search.fill('gamma');
  await page.waitForTimeout(350);
  assert.equal(await page.getByText('3 records · 2 fields', { exact: true }).count(), 1);
  await search.dispatchEvent('compositionend', { data: 'gamma' });
  await page.getByText('1 record · 2 fields', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Reverse', exact: true }).click();
  assert.equal(await search.inputValue(), 'gamma');
  await page.getByText('1 record · 2 fields', { exact: true }).waitFor();
  await search.fill('');
  await page.getByText('3 records · 2 fields', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Notes only', exact: true }).click();
  await page.getByText('3 records · 1 field', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-views.png' });
  await page.reload();
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Views lab', exact: true }).click();
  await page.getByText('3 records · 1 field', { exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Notes only', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Keep my view draft');
  await page.evaluate(async ({ id, view }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${id}/views/${view.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: view.version, name: 'Shared name' }),
    });
    if (!response.ok) throw new Error('Could not prepare the concurrent view update.');
  }, { id: fixture.table.id, view: (await read()).views.find(view => view.id === compact.id) });
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'view changed' }).waitFor();
  assert.equal(await page.getByLabel('View name', { exact: true }).inputValue(), 'Keep my view draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByRole('button', { name: 'Delete view', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await read()).views.length, 3);
  await page.getByRole('button', { name: 'Delete view', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete view', exact: true }).click();
  await page.getByText('3 records · 2 fields', { exact: true }).waitFor();
  assert.equal((await read()).records.length, 3);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
