import assert from 'node:assert/strict';

export async function verifyRelativeHourWorkflow(page, application) {
  const original = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, body });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Hourly schedule');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Hourly schedule', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Hourly schedule');
  const root = `/tables/${table.id}`;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'At', type: 'datetime' });
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Day', type: 'date' });
  const at = table.fields[1].id, day = table.fields[2].id, origin = Date.now();
  const records = (await call(root + '/records', 'POST', [-3, -1, 1, 3].map(hours => ({ values: {
    [table.primaryFieldId]: `${hours} hours`, [at]: new Date(origin + hours * 3_600_000).toISOString(),
  } })))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('4 records · 3 fields', { exact: true }).waitFor();
  const view = (await call(root + '/views'))[0];
  const open = () => page.getByRole('button', { name: 'Filters', exact: true }).click();
  const save = async () => {
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  };
  await open();
  await page.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  await page.getByLabel('Filter field', { exact: true }).selectOption(day);
  await page.getByLabel('Filter operator', { exact: true }).selectOption('relativeDate');
  assert.equal(await page.getByLabel('Relative period', { exact: true }).locator('option[value="pastHours"]').count(), 0);
  await page.getByLabel('Filter field', { exact: true }).selectOption(at);
  await page.getByLabel('Filter operator', { exact: true }).selectOption('relativeDate');
  for (const [period, index] of [['pastHours', 1], ['nextHours', 2]]) {
    await page.getByLabel('Relative period', { exact: true }).selectOption('pastDays');
    await page.getByLabel('Calendar days', { exact: true }).fill('7');
    await page.getByLabel('Relative period', { exact: true }).selectOption(period);
    assert.equal(await page.getByLabel('Calendar days', { exact: true }).count(), 0);
    await page.getByLabel('Elapsed hours', { exact: true }).fill('2');
    await page.getByLabel('Relative time zone', { exact: true }).fill('America/New_York');
    if (period === 'pastHours') await page.screenshot({ path: '.artifacts/desktop-relative-hour-settings.png' });
    await save();
    await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
    assert.deepEqual((await call(root + '/views/' + view.id)).query.filter.conditions[0].relative,
      { period, hours: 2, timeZone: 'America/New_York' });
    assert.deepEqual((await call(root + '/views/' + view.id + '/query', 'POST', {})).records.map(row => row.id), [records[index].id]);
    await open();
    assert.equal(await page.getByLabel('Elapsed hours', { exact: true }).inputValue(), '2');
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Simulate an expired context response; service-clock expiration is covered by SQLite tests.
  let expired = false, queries = 0;
  const stateRoute = async route => {
    const input = route.request().postDataJSON();
    if (input.tableId !== table.id || input.viewId !== view.id) return route.continue();
    const response = await route.fetch(), state = await response.json();
    if (expired) state.table.view.dateContext = 'expired-test-context';
    await route.fulfill({ response, json: state });
  };
  const queryObserved = request => { if (request.url().endsWith(root + '/views/' + view.id + '/query')) queries++; };
  await page.route('**/workspace/state', stateRoute);
  page.on('request', queryObserved);
  try {
    for (let index = 0; index < 2; index++) {
      const poll = await page.waitForRequest(request => request.url().endsWith('/workspace/state') && request.postDataJSON()?.viewId === view.id);
      assert.match(poll.postDataJSON().dateContext, /^h:-?\d+:[a-f0-9]{64}$/);
    }
    assert.equal(queries, 0, 'A valid rolling anchor must not trigger a refresh on every poll.');
    await page.getByRole('button', { name: '+ New record', exact: true }).click();
    const draft = page.getByRole('dialog').getByLabel('Name', { exact: true });
    await draft.fill('Retained hourly draft');
    expired = true;
    await page.getByText('Updates are available', { exact: false }).waitFor();
    assert.equal(await draft.inputValue(), 'Retained hourly draft');
    assert.equal(queries, 0);
    expired = false;
    // Keep a real external change pending after the simulated clock boundary.
    await call(root + '/records', 'POST', [{ values: { [table.primaryFieldId]: 'Another future record', [at]: new Date(Date.now() + 3_600_000).toISOString() } }]);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByText('2 records · 3 fields', { exact: true }).waitFor();
    assert.ok(queries > 0);
  } finally { await page.unroute('**/workspace/state', stateRoute); page.off('request', queryObserved); }
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), original);
}
