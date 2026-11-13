import assert from 'node:assert/strict';

export async function verifyViewportCache(page, application) {
  const size = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], previous = window.getContentSize(); window.setContentSize(1220, 2100); return previous;
  });
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const cell = row => page.locator('canvas').first().locator(`[aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`);
  const click = async row => {
    await ready(); const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36, { delay: 50 });
  };
  try {
    await page.waitForFunction(() => window.innerHeight >= 2000);
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await dialog.getByLabel('Table name', { exact: true }).fill('Visible group records');
    await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name: 'Visible group records', exact: true }).waitFor();
    let table = (await call('/tables')).find(table => table.name === 'Visible group records');
    const root = '/tables/' + table.id, name = table.primaryFieldId;
    const options = Array.from({ length: 14 }, (_, index) => [
      { id: 'heavy' + index, name: 'Hidden ' + index }, { id: 'shown' + index, name: 'Visible ' + index },
    ]).flat();
    table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Group', type: 'singleSelect', options });
    const field = table.fields[1];
    const records = (await call(root + '/records', 'POST', options.flatMap(option => Array.from({ length: option.id.startsWith('heavy') ? 100 : 1 }, (_, index) => ({
      values: { [name]: option.name + ' record ' + index, [field.id]: option.id },
    }))))).records;
    const view = (await call(root + '/views'))[0];
    await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, groupBy: field.id });
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await ready();
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    for (let index = 0; index < 14; index++) {
      await click(index * 3 + 1);
      await page.waitForFunction(index => document.querySelector(`canvas [aria-rowindex="${index * 3 + 4}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === `Visible ${index} record 0`, index, { polling: 100 });
    }
    await page.waitForFunction(() => Array.from({ length: 14 }, (_, index) =>
      document.querySelector(`canvas [aria-rowindex="${index * 3 + 4}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === `Visible ${index} record 0`).every(Boolean), undefined, { polling: 100 });
    await page.screenshot({ path: '.artifacts/desktop-viewport-fragmented-groups.png' });
    await click(2);
    const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
    if (await editor.count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Open record' && !button.disabled));
    for (let index = 0; index < 39; index++) await page.keyboard.press('Shift+ArrowDown');
    await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
    await page.keyboard.press('Control+c');
    const expected = Array.from({ length: 14 }, (_, index) => `Visible ${index} record 0`).join('\n');
    await page.waitForFunction(async expected => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === expected, expected, { polling: 100 });
    assert.equal(await cell(2).textContent(), 'Visible 0 record 0');
    await click(2);
    if (await editor.count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.keyboard.press('Enter'); await editor.fill('保留可见草稿');
    await editor.dispatchEvent('compositionstart');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(await editor.inputValue(), '保留可见草稿');
    await editor.dispatchEvent('compositionend', { data: '保留可见草稿' }); await page.keyboard.press('Tab');
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.equal(await cell(2).textContent(), 'Visible 0 record 0');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor(); await ready();
    assert.equal((await call(root + '/records/' + records[100].id)).values[name], '保留可见草稿');
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  } finally {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
  }
}
