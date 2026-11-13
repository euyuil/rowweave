import assert from 'node:assert/strict';

export async function verifyCalculationControls(page, application) {
  const dialog = page.getByRole('dialog'), button = page.getByRole('button', { name: 'Calculations', exact: true });
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Calculation controls');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Calculation controls', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Calculation controls');
  const root = '/tables/' + table.id;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const record = (await call(root + '/records', 'POST', [{ values: { [table.primaryFieldId]: 'Saved name' } }])).records[0];
  const history = await call(root + '/batches/query', 'POST', {});
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 2 fields', { exact: true }).waitFor();
  await button.click();
  await dialog.getByText('Automatically every minute', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Update calculations', exact: true }).click();
  await dialog.getByRole('button', { name: 'Update calculations', exact: true }).waitFor();
  await dialog.getByRole('status').filter({ hasText: 'Calculations updated' }).waitFor();
  assert.match(await dialog.locator('time').textContent(), /UTC$/);
  const status = await call('/calculations/status');
  assert.equal((await call(root + '/records/' + record.id)).values[table.fields[1].id], status.lastResult.evaluatedAt);
  assert.deepEqual(await call(root + '/batches/query', 'POST', {}), history);
  await page.screenshot({ path: '.artifacts/desktop-calculation-controls.png' });
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], size = window.getSize(); window.setSize(800, 700); return size;
  });
  await page.waitForFunction(() => window.innerWidth <= 800);
  assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: '.artifacts/desktop-calculation-controls-narrow.png' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await button.evaluate(element => element === document.activeElement), true);

  let mocked = { ...status, running: true }, statusFailure = false, refreshCalls = 0;
  const statusRoute = async route => mocked === undefined ? route.continue() : route.fulfill({
    status: statusFailure ? 503 : 200, contentType: 'application/json',
    body: JSON.stringify(statusFailure ? { error: { code: 'STATUS_UNAVAILABLE', message: 'Synthetic status outage' } } : mocked) });
  const refreshRoute = async route => {
    refreshCalls++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CALCULATION_FAILED', message: 'Synthetic refresh failure' } }) });
  };
  await page.route('**/calculations/status', statusRoute);
  try {
    const bounds = await page.locator('canvas').first().boundingBox();
    const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
    const openName = async () => {
      await page.mouse.click(bounds.x + 100, bounds.y + 58);
      await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement) || !!document.querySelector('.rowweave-cell-editor'));
      if (!await editor.count()) await page.keyboard.press('Enter');
      await editor.waitFor();
    };
    await openName();
    await editor.fill('保留中文草稿');
    await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '保留中文草稿' })));
    await button.filter({ hasText: 'Updating' }).waitFor();
    assert.equal(await editor.inputValue(), '保留中文草稿');
    assert.equal(await editor.evaluate(element => element === document.activeElement), true);
    await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '保留中文草稿' })));
    await page.keyboard.press('Enter'); await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    await button.click();
    assert.equal(await dialog.getByRole('button', { name: 'Updating…', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();

    mocked = { ...status, running: false, lastError: 'Synthetic background failure' };
    await button.locator('[class~="failed"]').waitFor();
    await button.click(); await dialog.getByRole('alert').filter({ hasText: 'Last calculation failed: Synthetic background failure' }).waitFor();
    mocked = { automatic: false, running: false };
    await dialog.getByText('Manual updates on this service', { exact: true }).waitFor();
    await dialog.getByText('No completed calculation in this session', { exact: true }).waitFor();
    await page.route('**/calculations/refresh', refreshRoute);
    await dialog.getByRole('button', { name: 'Update calculations', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Synthetic refresh failure' }).waitFor();
    assert.equal(refreshCalls, 1);
    statusFailure = true;
    await dialog.getByRole('alert').filter({ hasText: 'Synthetic status outage' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Update calculations', exact: true }).isDisabled(), true);
    statusFailure = false; mocked = status;
    await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
    await dialog.getByText('Automatically every minute', { exact: true }).waitFor();
    await page.unroute('**/calculations/refresh', refreshRoute);
    mocked = undefined;
    let releaseResponse, responseReady, responseFinished;
    const held = new Promise(resolve => { releaseResponse = resolve; });
    const ready = new Promise(resolve => { responseReady = resolve; });
    const finished = new Promise(resolve => { responseFinished = resolve; });
    const heldRefresh = async route => { const response = await route.fetch(); responseReady(); await held; await route.fulfill({ response }); responseFinished(); };
    await page.route('**/calculations/refresh', heldRefresh);
    try {
      await dialog.getByRole('button', { name: 'Update calculations', exact: true }).click();
      await ready;
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByText('1 unsaved cell', { exact: true }).waitFor();
      assert.match(await button.textContent(), /Updating/);
    } finally { releaseResponse(); await finished; await page.unroute('**/calculations/refresh', heldRefresh); }
    await button.click();
    await dialog.getByRole('status').filter({ hasText: 'Calculations updated' }).waitFor();
    assert.equal(refreshCalls, 1, 'Status polling must never repeat a failed refresh request.');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByText('1 unsaved cell', { exact: true }).waitFor();
    assert.equal((await call(root + '/records/' + record.id)).values[table.primaryFieldId], 'Saved name');
    await openName();
    assert.equal(await editor.inputValue(), '保留中文草稿');
    await page.keyboard.press('Escape');
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: '+ New record', exact: true }).click();
    const formName = dialog.getByLabel('Name', { exact: true });
    await formName.fill('Unsaved form 中文');
    mocked = { ...status, running: true };
    await page.waitForFunction(() => document.querySelector('.calculation-button')?.textContent.includes('Updating'), undefined, { polling: 100 });
    assert.equal(await formName.inputValue(), 'Unsaved form 中文');
    assert.equal(await formName.evaluate(element => element === document.activeElement), true);
  } finally {
    await page.unroute('**/calculations/status', statusRoute);
    await page.unroute('**/calculations/refresh', refreshRoute);
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
