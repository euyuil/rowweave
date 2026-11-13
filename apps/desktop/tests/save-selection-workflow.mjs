import assert from 'node:assert/strict';

export async function verifySaveSelection(page) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: {
      Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog'), canvas = page.locator('canvas').first();
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const open = page.getByRole('button', { name: 'Open record', exact: true });
  const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
  const notice = page.getByText('Changes saved. The selection was cleared; select records again before editing.', { exact: true });
  const select = async (row, text) => {
    await ready();
    await page.waitForFunction(({ row, text }) =>
      document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === text,
    { row, text }, { polling: 100 });
    const bounds = await canvas.boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36);
    if (await editor.count()) await page.keyboard.press('Escape');
  };
  const copy = async expected => {
    await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
    await page.keyboard.press('Control+c');
    await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, expected);
  };
  for (const scenario of ['grouped', 'sorted', 'filtered', 'failed write', 'failed refresh']) {
    const title = 'Save selection: ' + scenario;
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await dialog.getByLabel('Table name', { exact: true }).fill(title);
    await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const table = (await call('/tables')).find(table => table.name === title), root = '/tables/' + table.id;
    const name = table.primaryFieldId;
    const records = (await call(root + '/records', 'POST', ['A', 'B', 'C'].map(value => ({ values: { [name]: value } })))).records;
    const view = (await call(root + '/views'))[0];
    await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
      ...(scenario === 'grouped' ? { groupBy: name } : {}),
      query: scenario === 'filtered' ? { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'eq', value: 'B' }] } }
        : { sort: [{ fieldId: name, direction: 'asc' }] },
    });
    await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
    await select(scenario === 'grouped' ? 3 : scenario === 'filtered' ? 0 : 1, 'B');
    await copy('B');
    await page.keyboard.press('Control+s');
    assert.equal(await open.isEnabled(), true, 'A save without edits must retain the selection.');
    assert.equal((await call(root + '/records/' + records[1].id)).version, 1);
    await page.keyboard.press('Enter'); await editor.fill('Z');
    let writes = 0;
    const failure = route => {
      if (scenario === 'failed write') writes++;
      return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SYNTHETIC_OUTAGE', message: 'Synthetic save-selection outage' } }) });
    };
    const failureUrl = scenario === 'failed write' ? '**' + root + '/records' : '**' + root;
    if (scenario.startsWith('failed')) await page.route(failureUrl, failure);
    try {
      await page.keyboard.press('Control+s');
      if (scenario === 'failed write') {
        await page.getByRole('alert').filter({ hasText: 'Synthetic save-selection outage' }).waitFor();
        await page.getByText('1 unsaved cell', { exact: true }).waitFor();
        await copy('Z');
        assert.equal(await notice.count(), 0, 'A rejected write must not announce a saved selection reset.');
        assert.equal(writes, 1);
        assert.equal((await call(root + '/records/' + records[1].id)).values[name], 'B');
      } else {
        if (scenario === 'failed refresh') await page.getByRole('alert').filter({ hasText: 'Changes saved, but refreshing failed' }).waitFor();
        await notice.waitFor();
        assert.equal(await open.isEnabled(), false, 'Saved row positions must not select a different record.');
        assert.equal(await page.getByRole('button', { name: 'Delete records', exact: true }).isEnabled(), false);
        assert.equal((await call(root + '/records/' + records[1].id)).values[name], 'Z');
        assert.equal((await call(root + '/records/' + records[2].id)).version, 1);
      }
    } finally { if (scenario.startsWith('failed')) await page.unroute(failureUrl, failure); }
    if (scenario === 'failed write') {
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await notice.waitFor(); assert.equal(await open.isEnabled(), false);
      assert.equal((await call(root + '/records/' + records[1].id)).values[name], 'Z');
    }
    if (scenario === 'failed refresh') await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await ready();
    if (scenario !== 'filtered') {
      await select(scenario === 'grouped' ? 5 : 2, 'Z');
      await copy('Z'); await open.click();
      assert.equal(await dialog.getByLabel('Name', { exact: true }).inputValue(), 'Z');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else await page.getByText('0 records · 1 field', { exact: true }).waitFor();
    if (scenario === 'grouped') await page.screenshot({ path: '.artifacts/desktop-save-selection.png' });
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
}
