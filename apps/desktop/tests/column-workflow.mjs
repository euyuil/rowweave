import assert from 'node:assert/strict';

export async function verifyColumnWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Column lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Column lab', exact: true }).waitFor();
  const table = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(connection.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare column fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Column lab');
    for (const field of [{ name: 'Score', type: 'number' }, { name: 'Notes', type: 'text' }]) {
      table = await call(`/tables/${table.id}/fields`, 'POST', { ...field, expectedVersion: table.version });
    }
    const [name, score, notes] = table.fields;
    await call(`/tables/${table.id}/records`, 'POST', ['Alpha', 'Beta', 'Gamma'].map((value, i) => ({ values: {
      [name.id]: value, [score.id]: [3, 1, 2][i], [notes.id]: ['z', 'y', 'x'][i],
    } })));
    const [view] = await call(`/tables/${table.id}/views`);
    await call(`/tables/${table.id}/views/${view.id}`, 'PATCH', { expectedVersion: view.version,
      query: { filter: { conjunction: 'and', conditions: [{ fieldId: name.id, operator: 'isNotEmpty' }] },
        sort: [{ fieldId: notes.id, direction: 'desc' }] } });
    return table;
  });
  const [name, score, notes] = table.fields;
  const readView = () => page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    return fetch(`${connection.url}/tables/${id}/views`, { headers: { Authorization: `Bearer ${connection.token}` } })
      .then(response => response.json()).then(views => views[0]);
  }, table.id);
  const menu = async (column, dropdown = false) => {
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + (dropdown ? 195 : 100) + column * 180, bounds.y + 20, { button: dropdown ? 'left' : 'right' });
    await page.getByRole('dialog').waitFor();
  };
  const action = async label => {
    await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('3 records · 3 fields', { exact: true }).waitFor();
  const corner = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(corner.x + 15, corner.y + 20, { button: 'right' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await menu(1);
  await page.screenshot({ path: '.artifacts/desktop-column-actions.png' });
  await action('Sort ascending');
  const sorted = await readView();
  assert.deepEqual(sorted.query.sort, [{ fieldId: score.id, direction: 'asc' }, { fieldId: notes.id, direction: 'desc' }]);
  assert.equal(sorted.query.filter.conditions[0].fieldId, name.id);
  await menu(1, true);
  await action('Move left');
  assert.deepEqual((await readView()).columns.map(column => column.fieldId), [score.id, name.id, notes.id]);
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => await navigator.clipboard.readText() === '1');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('textbox', { name: 'Cell value', exact: true }).inputValue(), 'Beta');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+F10');
  await page.getByRole('dialog', { name: 'Name column actions', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.tagName === 'CANVAS');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '5');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  const pendingBounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(pendingBounds.x + 100, pendingBounds.y + 20, { button: 'right' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByText('Save or discard grid edits before changing columns.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  assert.equal(await page.getByLabel('View name', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  await page.getByLabel('Filter field', { exact: true }).selectOption(score.id);
  await page.getByLabel('Filter operator', { exact: true }).selectOption('gt');
  await page.getByLabel('Value *', { exact: true }).fill('3');
  await action('Save view');
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  await menu(0);
  await page.getByRole('button', { name: 'Configure field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Points');
  await action('Save field');
  await menu(2);
  await action('Hide in this view');
  await menu(1);
  await action('Hide in this view');
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();
  await menu(0);
  assert.equal(await page.getByRole('button', { name: 'Hide in this view', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Move left', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.evaluate(async ({ tableId, view }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${tableId}/views/${view.id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: view.version, name: 'Updated elsewhere' }),
    });
    if (!response.ok) throw new Error('Could not change the view fixture.');
  }, { tableId: table.id, view: await readView() });
  await menu(0);
  await page.getByRole('button', { name: 'Sort descending', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'view changed' }).waitFor();
  assert.equal((await readView()).query.sort[0].direction, 'asc');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
