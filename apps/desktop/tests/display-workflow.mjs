import assert from 'node:assert/strict';

export async function verifyDisplayWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Display lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Display lab', exact: true }).waitFor();
  const table = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(connection.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare display fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Display lab');
    for (let i = 1; i < 12; i++) table = await call(`/tables/${table.id}/fields`, 'POST', {
      expectedVersion: table.version, name: `Field ${i}`, type: 'text',
    });
    await call(`/tables/${table.id}/records`, 'POST', ['One', 'Two', 'Three'].map((name, row) => ({
      values: Object.fromEntries(table.fields.map((field, column) => [field.id, column === 0 ? name : `${row}:${column}`])),
    })));
    await call(`/tables/${table.id}/views`, 'POST', { name: 'Default layout' });
    return table;
  });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('3 records · 12 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  assert.equal(await page.getByLabel('Row density', { exact: true }).inputValue(), '36');
  assert.equal(await page.getByLabel('Frozen columns', { exact: true }).inputValue(), '0');
  await page.getByLabel('Row density', { exact: true }).selectOption('48');
  await page.getByLabel('Frozen columns', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.locator('.dvn-scroller').evaluate(element => { element.scrollLeft = 1000; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 64);
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'One');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Two');
  await page.screenshot({ path: '.artifacts/desktop-frozen-columns.png' });
  await page.evaluate(() => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '布局测试');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  const rows = await page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    return fetch(`${connection.url}/tables/${id}/records?offset=0&limit=3`, { headers: { Authorization: `Bearer ${connection.token}` } })
      .then(response => response.json()).then(result => result.records);
  }, table.id);
  assert.equal(rows[1].values[table.primaryFieldId], '布局测试');
  assert.equal(rows[1].values[table.fields[1].id], '1:1');
  await page.getByLabel('Current view', { exact: true }).selectOption({ label: 'Default layout' });
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  assert.equal(await page.getByLabel('Row density', { exact: true }).inputValue(), '36');
  assert.equal(await page.getByLabel('Frozen columns', { exact: true }).inputValue(), '0');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Current view', { exact: true }).selectOption({ label: 'All records' });
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.reload();
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Display lab', exact: true }).click();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  assert.equal(await page.getByLabel('Row density', { exact: true }).inputValue(), '48');
  assert.equal(await page.getByLabel('Frozen columns', { exact: true }).inputValue(), '1');
  await page.screenshot({ path: '.artifacts/desktop-display-settings.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
