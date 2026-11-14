import assert from 'node:assert/strict';

export async function verifyBusinessDayWorkflow(page, application) {
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
  await page.getByLabel('Table name', { exact: true }).fill('Working schedule');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Working schedule', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Working schedule');
  const root = `/tables/${table.id}`;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Day', type: 'date' });
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const day = table.fields[1].id, at = table.fields[2].id, origin = Date.parse(new Date().toISOString().slice(0, 10) + 'T12:00:00Z');
  const records = (await call(root + '/records', 'POST', Array.from({ length: 41 }, (_, i) => {
    const value = new Date(origin + (i - 20) * 86_400_000).toISOString();
    return { values: { [table.primaryFieldId]: value.slice(0, 10), [day]: value.slice(0, 10), [at]: value } };
  }))).records;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('41 records · 3 fields', { exact: true }).waitFor();
  const view = (await call(root + '/views'))[0];
  const open = () => page.getByRole('button', { name: 'Filters', exact: true }).click();
  const save = async () => {
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  };
  await open();
  await page.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  for (const field of [day, at]) for (const [period, direction] of [['pastBusinessDays', -1], ['nextBusinessDays', 1]]) {
    await page.getByLabel('Filter field', { exact: true }).selectOption(field);
    await page.getByLabel('Filter operator', { exact: true }).selectOption('relativeDate');
    await page.getByLabel('Relative period', { exact: true }).selectOption(field === at ? 'pastHours' : 'pastDays');
    await page.getByLabel(field === at ? 'Elapsed hours' : 'Calendar days', { exact: true }).fill('2');
    await page.getByLabel('Relative period', { exact: true }).selectOption(period);
    assert.equal(await page.getByLabel('Elapsed hours', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Calendar days', { exact: true }).count(), 0);
    await page.getByLabel('Business days', { exact: true }).fill('5');
    await page.getByLabel('Relative time zone', { exact: true }).fill('UTC');
    if (field === day && direction === -1) await page.screenshot({ path: '.artifacts/desktop-business-day-settings.png' });
    await save();
    await page.getByText('5 records · 3 fields', { exact: true }).waitFor();
    assert.deepEqual((await call(root + '/views/' + view.id)).query.filter.conditions[0].relative, { period, days: 5, timeZone: 'UTC' });
    const cursor = new Date(), expected = [];
    while (expected.length < 5) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) expected.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + direction);
    }
    expected.sort();
    const matching = await call(root + '/views/' + view.id + '/query', 'POST', {});
    assert.deepEqual(matching.records.map(row => row.id), records.filter(row => expected.includes(row.values[day])).map(row => row.id));
    await page.waitForFunction(first => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === first, expected[0]);
    assert.equal((await call(root + '/summary', 'POST', { viewId: view.id, expectedDateContext: matching.dateContext })).totals.count, 5);
    await open();
    assert.equal(await page.getByLabel('Relative period', { exact: true }).inputValue(), period);
    assert.equal(await page.getByLabel('Business days', { exact: true }).inputValue(), '5');
  }
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), original);
}
