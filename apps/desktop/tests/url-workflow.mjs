import assert from 'node:assert/strict';

export async function verifyUrlWorkflow(page, application) {
  await application.evaluate(({ shell }) => {
    globalThis.originalUrlOpener = shell.openExternal;
    globalThis.openedUrls = [];
    shell.openExternal = async url => { globalThis.openedUrls.push(url); };
  });
  const opened = () => application.evaluate(() => globalThis.openedUrls);
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('URL lab');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'URL lab', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Website');
  await page.getByLabel('Field type', { exact: true }).selectOption('url');
  await page.getByLabel('Field description', { exact: true }).fill('A page that helps explain this record.');
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Documentation');
  await page.getByLabel('Website', { exact: true }).fill('file:///C:/test.exe');
  assert.equal(await dialog.getByRole('button', { name: 'Open link ↗', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'http://' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Documentation');
  const address = 'https://例子.测试/文档?q=one%20two';
  await page.getByLabel('Website', { exact: true }).fill(address);
  await dialog.getByRole('button', { name: 'Open link ↗', exact: true }).click();
  assert.deepEqual(await opened(), [new URL(address).href]);
  await page.screenshot({ path: '.artifacts/desktop-url-entry.png' });
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' }); await ready();
  const records = () => page.evaluate(async () => {
    const connection = await window.rowweave.connection(), headers = { Authorization: `Bearer ${connection.token}` };
    const table = (await fetch(connection.url + '/tables', { headers }).then(response => response.json())).find(table => table.name === 'URL lab');
    return { table, page: await fetch(`${connection.url}/tables/${table.id}/query`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json()) };
  });
  const saved = await records(), field = saved.table.fields[1].id;
  assert.equal(saved.page.records.length, 1); assert.equal(saved.page.records[0].values[field], address);
  assert.equal((await opened()).length, 1, 'Saving does not automatically open a URL.');
  for (const value of ['file:///C:/test.exe', 'javascript:alert(1)', 'https://user:password@example.com']) {
    assert.equal(await page.evaluate(async value => { try { await window.rowweave.openUrl(value); return false; } catch { return true; } }, value), true);
  }
  assert.equal((await opened()).length, 1);
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 280, bounds.y + 58);
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Enter');
  const editor = page.locator('.rowweave-cell-editor');
  await editor.getByLabel('Cell value', { exact: true }).fill('https://example.com/new');
  await editor.getByRole('button', { name: 'Open link ↗', exact: true }).click();
  assert.deepEqual(await opened(), [new URL(address).href, 'https://example.com/new']);
  assert.equal((await records()).page.records[0].values[field], address);
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async address => await navigator.clipboard.readText() === address, address);
  await page.keyboard.press('Enter');
  await editor.getByLabel('Cell value', { exact: true }).fill('https://example.com/saved');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await records()).page.records[0].values[field], 'https://example.com/saved');
  assert.equal((await opened()).length, 2);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await application.evaluate(({ shell }) => { shell.openExternal = globalThis.originalUrlOpener; delete globalThis.originalUrlOpener; delete globalThis.openedUrls; });
}
