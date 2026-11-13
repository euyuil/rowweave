import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyCatalogRefresh(page, application) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const original = await call('/tables'), created = new Set(), dialog = page.getByRole('dialog');
  const nav = page.getByRole('navigation', { name: 'Tables', exact: true });
  const item = name => nav.getByRole('button', { name, exact: true });
  const create = async name => { const table = await call('/tables', 'POST', { name }); created.add(table.id); return table; };
  const remove = async table => {
    const latest = await call('/tables/' + table.id);
    await call('/tables/' + table.id, 'DELETE', { expectedVersion: latest.version }); created.delete(table.id);
  };
  const catalogPoll = request => request.url().endsWith('/workspace/state') && Object.keys(request.postDataJSON()).length === 0;
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  const tableName = dialog.getByLabel('Table name', { exact: true });
  await tableName.fill('Local catalog draft 中文');
  let current = await create('Catalog current');
  await item('Catalog current').waitFor();
  assert.equal(await tableName.inputValue(), 'Local catalog draft 中文');
  assert.equal(await tableName.evaluate(element => element === document.activeElement), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (!original.length) await page.getByRole('heading', { name: 'Choose a table', exact: true }).waitFor();
  await item('Catalog current').click(); await ready();
  await call('/tables/' + current.id + '/records', 'POST', [{ values: { [current.primaryFieldId]: 'Saved record' } }]);
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();
  await ready();
  await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === 'Saved record');
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
  if (await editor.count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Open record' && !button.disabled));
  await page.keyboard.press('Enter'); await editor.fill('Keep catalog draft 中文');
  await editor.dispatchEvent('compositionstart');
  current = await call('/tables/' + current.id, 'PATCH', { expectedVersion: current.version, name: 'Catalog renamed' });
  await item('Catalog renamed').waitFor();
  let other = await create('Catalog other');
  await item('Catalog other').waitFor();
  other = await call('/tables/' + other.id, 'PATCH', { expectedVersion: other.version, name: 'Catalog other renamed' });
  await item('Catalog other renamed').waitFor();
  await remove(other); await item('Catalog other renamed').waitFor({ state: 'detached' });
  assert.equal(await editor.inputValue(), 'Keep catalog draft 中文');
  assert.equal(await editor.evaluate(element => element === document.activeElement), true);
  await page.getByRole('heading', { name: 'Catalog current', exact: true }).waitFor();
  await editor.dispatchEvent('compositionend', { data: '中文' }); await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  other = await create('Catalog destination'); await item(other.name).waitFor();
  await remove(current);
  await item('Catalog renamed').waitFor({ state: 'detached' });
  await page.getByText('This table was deleted elsewhere. Visible edits are retained. Choose another table when ready.', { exact: true }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await item(other.name).click();
  await page.getByRole('heading', { name: 'Catalog current', exact: true }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-catalog-retained-draft.png' });
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await item(other.name).click(); await page.getByRole('heading', { name: other.name, exact: true }).waitFor(); await ready();

  let release, arrived, finished, intercept = true;
  const held = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const slowList = async route => {
    if (route.request().method() !== 'GET' || !intercept) return route.continue();
    intercept = false;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    finally { finished(); }
  };
  await page.route('**/tables', slowList);
  try {
    await create('Catalog held response'); await waitForResponse(responseReady, 'catalog response');
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await dialog.getByLabel('Table name', { exact: true }).fill('Catalog local creation');
    await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name: 'Catalog local creation', exact: true }).waitFor();
    await nav.evaluate(element => {
      window.catalogCreationRemoved = false;
      window.catalogObserver = new MutationObserver(() => {
        if (![...element.querySelectorAll('.table-name')].some(name => name.textContent === 'Catalog local creation')) window.catalogCreationRemoved = true;
      });
      window.catalogObserver.observe(element, { childList: true, subtree: true });
    });
    release(); await waitForResponse(settled, 'catalog response release');
    await page.waitForRequest(catalogPoll);
    assert.equal(await page.evaluate(() => window.catalogCreationRemoved), false, 'A late catalog snapshot must not remove a completed local creation.');
    await item('Catalog local creation').waitFor();
    const local = (await call('/tables')).find(table => table.name === 'Catalog local creation'); created.add(local.id);
  } finally {
    release();
    try { if (!intercept) await waitForResponse(settled, 'catalog cleanup'); }
    finally {
      await page.unroute('**/tables', slowList);
      await page.evaluate(() => { window.catalogObserver?.disconnect(); delete window.catalogObserver; delete window.catalogCreationRemoved; });
    }
  }

  let outage = true;
  const unavailable = route => outage && route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CATALOG_UNAVAILABLE', message: 'Synthetic catalog outage' } }) })
    : route.continue();
  await page.route('**/tables', unavailable);
  try {
    const added = await create('Catalog recovered');
    await page.getByText('Could not update the table list: Synthetic catalog outage', { exact: true }).waitFor();
    await item('Catalog local creation').waitFor(); await item(other.name).waitFor();
    outage = false; await item(added.name).waitFor();
    await page.getByText('Could not update the table list: Synthetic catalog outage', { exact: true }).waitFor({ state: 'detached' });
  } finally { await page.unroute('**/tables', unavailable); }
  let lists = 0;
  const requested = request => { if (request.url().endsWith('/tables') && request.method() === 'GET') lists++; };
  page.on('request', requested);
  try {
    await page.waitForRequest(catalogPoll); await page.waitForRequest(catalogPoll);
    assert.equal(lists, 0, 'Unchanged catalog checks must not reload all table schemas.');
  } finally { page.off('request', requested); }
  await page.screenshot({ path: '.artifacts/desktop-catalog-current.png' });
  if (original[0]) {
    await item(original[0].name).click(); await page.getByRole('heading', { name: original[0].name, exact: true }).waitFor(); await ready();
  }
  for (const id of created) await remove({ id });
}
