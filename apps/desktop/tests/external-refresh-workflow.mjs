import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyExternalRefresh(page, application) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const originalTables = await call('/tables'), dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('External refresh');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'External refresh', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'External refresh');
  const root = '/tables/' + table.id;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Rank', type: 'number' });
  const rank = table.fields[1].id, name = table.primaryFieldId;
  const records = (await call(root + '/records', 'POST', ['Alpha', 'Beta', 'Gamma'].map((value, index) => ({ values: { [name]: value, [rank]: index + 1 } })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('3 records · 2 fields', { exact: true }).waitFor();
  const cell = (column, row) => page.locator('canvas').first().locator(`[aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="${column + 1}"]`);
  const waitCell = (column, row, text) => page.waitForFunction(({ column, row, text }) =>
    document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="${column + 1}"]`)?.textContent === text,
  { column, row, text }, { polling: 100 });
  const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
  const select = async row => {
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36);
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement) || !!document.querySelector('.rowweave-cell-editor'));
    if (await editor.count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Open record' && !button.disabled));
  };
  const update = async (record, values) => {
    const current = await call(root + '/records/' + record.id);
    await call(root + '/records', 'PATCH', [{ id: current.id, expectedVersion: current.version, values }]);
  };

  let pollCount = 0, inFlight = 0, peak = 0;
  const polling = new Set();
  const requested = request => {
    if (request.url().endsWith('/workspace/state') && request.postDataJSON()?.tableId === table.id && request.postDataJSON()?.viewId) {
      polling.add(request); pollCount++; inFlight++; peak = Math.max(peak, inFlight);
    }
  };
  const finished = request => { if (polling.delete(request)) inFlight--; };
  page.on('request', requested); page.on('requestfinished', finished); page.on('requestfailed', finished);
  try {
    let view = await call(root + '/views', 'POST', { name: 'Sorted', query: { sort: [{ fieldId: rank, direction: 'asc' }] } });
    await page.getByRole('tab', { name: 'Sorted', exact: true }).click();
    await waitCell(0, 0, 'Alpha'); await select(0);
    await update(records[0], { [rank]: 4 });
    await waitCell(0, 2, 'Alpha');
    assert.equal(await page.evaluate(() => document.querySelector('canvas')?.contains(document.activeElement)), true);
    await page.keyboard.press('Enter'); await editor.waitFor();
    assert.equal(await editor.inputValue(), 'Alpha', 'Selection must follow the record UUID after sorting.');
    await page.keyboard.press('Escape');

    table = await call(root + '/fields/' + name, 'PATCH', { expectedVersion: table.version, name: 'Title' });
    await page.waitForFunction(() => [...document.querySelectorAll('canvas [role="columnheader"]')].some(element => element.textContent === 'Title'));
    view = await call(root + '/views/' + view.id, 'GET');
    view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, name: 'Current work' });
    await page.getByRole('tab', { name: 'Current work', exact: true }).waitFor();

    await page.getByRole('button', { name: '+ New record', exact: true }).click();
    const form = dialog.getByLabel('Title', { exact: true });
    await form.fill('Unsaved form 中文');
    await update(records[1], { [name]: 'Remote Beta' });
    await page.waitForFunction(() => [...document.querySelectorAll('.notice-banner')].some(element => element.textContent.includes('Updates are available')), undefined, { polling: 100 });
    assert.equal(await form.inputValue(), 'Unsaved form 中文');
    assert.equal(await form.evaluate(element => element === document.activeElement), true);
    assert.equal(await cell(0, 0).textContent(), 'Beta');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitCell(0, 0, 'Remote Beta');

    let release, arrived, completed;
    const held = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { arrived = resolve; });
    const settled = new Promise(resolve => { completed = resolve; });
    let intercept = true;
    const slowQuery = async route => {
      if (!intercept) return route.continue();
      intercept = false;
      try {
        const response = await route.fetch(); arrived(); await held;
        await route.fulfill({ response });
      } finally { completed(); }
    };
    const queryPath = '**' + root + '/views/' + view.id + '/query';
    await page.route(queryPath, slowQuery);
    try {
      await update(records[2], { [name]: 'Remote Gamma' }); await waitForResponse(ready, 'the held grid query');
      await select(1); await page.keyboard.press('Enter'); await editor.fill('保留输入草稿');
      await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '保留输入草稿' })));
      release(); await waitForResponse(settled, 'the released grid query');
      await page.waitForRequest(request => request.url().endsWith('/workspace/state') && !!request.postDataJSON()?.viewId);
      assert.equal(await editor.inputValue(), '保留输入草稿');
      assert.equal(await editor.evaluate(element => element === document.activeElement), true);
      assert.equal(await cell(0, 1).textContent(), 'Gamma');
      await page.screenshot({ path: '.artifacts/desktop-external-refresh-draft.png' });
      const previousSize = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0], size = window.getSize(); window.setSize(800, 700); return size;
      });
      await page.waitForFunction(() => window.innerWidth <= 800);
      assert.equal(await editor.inputValue(), '保留输入草稿');
      assert.equal(await page.locator('.table-workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas').getBoundingClientRect();
        const editor = document.querySelector('.rowweave-cell-editor textarea').getBoundingClientRect();
        return Math.abs(editor.y - (canvas.y + 40 + 36)) < 6;
      }, undefined, { polling: 100 });
      await page.screenshot({ path: '.artifacts/desktop-external-refresh-narrow.png' });
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
      await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '保留输入草稿' })));
      await page.keyboard.press('Enter');
      await page.getByText('1 unsaved cell', { exact: true }).waitFor();
      assert.equal((await call(root + '/records/' + records[2].id)).values[name], 'Remote Gamma');
    } finally {
      release();
      try { if (!intercept) await waitForResponse(settled, 'grid query cleanup'); }
      finally { await page.unroute(queryPath, slowQuery); }
    }
    view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, name: 'Changed while editing' });
    await page.waitForRequest(request => request.url().endsWith('/workspace/state') && !!request.postDataJSON()?.viewId);
    await page.getByRole('tab', { name: 'Current work', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
    await page.getByRole('tab', { name: 'Changed while editing', exact: true }).waitFor();
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await waitCell(0, 1, 'Remote Gamma');
    await call(root + '/views/' + view.id, 'DELETE', { expectedVersion: view.version });
    await page.getByRole('tab', { name: 'All records', exact: true, selected: true }).waitFor();
    await waitCell(0, 0, 'Alpha');
    let outage = true;
    const stateRoute = route => outage && route.request().postDataJSON()?.viewId
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STATE_UNAVAILABLE', message: 'Synthetic state outage' } }) }) : route.continue();
    await page.route('**/workspace/state', stateRoute);
    try {
      await page.getByText('Could not check for updates: Synthetic state outage', { exact: true }).waitFor();
      assert.equal(await cell(0, 0).textContent(), 'Alpha');
      const history = await call(root + '/batches/query', 'POST', {});
      outage = false;
      await update(records[0], { [name]: 'Connection restored' });
      await waitCell(0, 0, 'Connection restored');
      assert.equal((await call(root + '/batches/query', 'POST', {})).batches.length, history.batches.length + 1);
      assert.equal(await page.getByText('Could not check for updates: Synthetic state outage', { exact: true }).count(), 0);
    } finally { await page.unroute('**/workspace/state', stateRoute); }
    await page.screenshot({ path: '.artifacts/desktop-external-refresh-current.png' });
    table = await call(root);
    await call(root, 'DELETE', { expectedVersion: table.version });
    await page.getByText('This table was deleted elsewhere. Visible edits are retained. Choose another table when ready.', { exact: true }).waitFor();
    assert.equal(await cell(0, 0).textContent(), 'Connection restored');
    assert.ok(pollCount > 3); assert.equal(peak, 1, 'Selected-view status polls must not overlap.');
    if (originalTables[0]) {
      await page.getByRole('navigation', { name: 'Tables' }).getByRole('button', { name: originalTables[0].name, exact: true }).click();
      const count = pollCount;
      await page.waitForTimeout(2_500);
      assert.equal(pollCount, count, 'Switching tables must dispose the old polling loop.');
    }
  } finally {
    page.off('request', requested); page.off('requestfinished', finished); page.off('requestfailed', finished);
  }
}
