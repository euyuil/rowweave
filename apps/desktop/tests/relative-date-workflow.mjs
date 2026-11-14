import assert from 'node:assert/strict';

export async function verifyRelativeDateWorkflow(page, app) {
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Relative schedule');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Relative schedule', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Relative schedule');
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1].id;
  table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const at = table.fields[2].id;
  const today = new Date().toISOString().slice(0, 10);
  const day = delta => new Date(Date.parse(`${today}T12:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
  await call(`/tables/${table.id}/records`, 'POST', [-1, 0, 1, null].map(delta => ({ values: {
    [table.primaryFieldId]: delta === null ? 'Unscheduled' : delta === 0 ? 'Today task' : `${delta} day task`,
    [due]: delta === null ? null : day(delta), [at]: delta === null ? null : `${day(delta)}T12:00:00.000Z`,
  } })));
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('4 records · 3 fields', { exact: true }).waitFor();
  const open = () => page.getByRole('button', { name: 'Filters', exact: true }).click();
  const save = async () => {
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' }); await ready();
  };
  await open();
  await page.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
  await page.getByLabel('Filter field', { exact: true }).selectOption(due);
  await page.getByLabel('Filter operator', { exact: true }).selectOption('relativeDate');
  await page.getByLabel('Relative time zone', { exact: true }).fill('UTC');
  await page.screenshot({ path: '.artifacts/desktop-relative-date-settings.png' });
  await save();
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  const view = (await call(`/tables/${table.id}/views`))[0];
  assert.deepEqual(view.query.filter.conditions[0], { fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } });
  assert.equal((await call(`/tables/${table.id}/views/${view.id}/query`, 'POST', {})).records[0].values[table.primaryFieldId], 'Today task');
  await open();
  assert.equal(await page.getByLabel('Relative period', { exact: true }).inputValue(), 'today');
  await page.getByLabel('Relative period', { exact: true }).selectOption('pastDays');
  await page.getByLabel('Calendar days', { exact: true }).fill('2');
  await page.getByLabel('Relative time zone', { exact: true }).fill('Invalid/Zone');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'valid named time zone' }).waitFor();
  assert.equal(await page.getByLabel('Calendar days', { exact: true }).inputValue(), '2');
  assert.equal((await call(`/tables/${table.id}/views`))[0].version, view.version);
  await page.getByLabel('Relative time zone', { exact: true }).fill('UTC');
  await save();
  await page.getByText('2 records · 3 fields', { exact: true }).waitFor();
  await call(`/tables/${table.id}/records`, 'POST', Array.from({ length: 53 }, (_, i) => ({ values: {
    [table.primaryFieldId]: `Additional ${i}`, [due]: today,
  } })));
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  const groupResponse = page.waitForResponse(response => response.url().endsWith('/summary') && response.request().postDataJSON().groupBy === table.primaryFieldId);
  await page.getByLabel('Group by', { exact: true }).selectOption(table.primaryFieldId);
  const summary = await (await groupResponse).json();
  assert.match(summary.dateContext, /^[a-f0-9]{64}$/);
  await page.getByText('1–50 of 55 groups', { exact: true }).waitFor();
  const continuation = page.waitForRequest(request => request.url().endsWith('/summary') && request.postDataJSON().offset === 50);
  await page.getByRole('button', { name: 'Next groups', exact: true }).click();
  assert.equal((await continuation).postDataJSON().expectedDateContext, summary.dateContext);
  await page.getByText('51–55 of 55 groups', { exact: true }).waitFor();
  const refresh = page.waitForRequest(request => request.url().endsWith('/summary') && request.postDataJSON().offset === 0);
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  assert.equal((await refresh).postDataJSON().expectedDateContext, undefined);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await open();
  assert.equal(await page.getByLabel('Calendar days', { exact: true }).inputValue(), '2');
  await page.screenshot({ path: '.artifacts/desktop-relative-date-days.png' });
  await page.getByLabel('Filter field', { exact: true }).selectOption(at);
  await page.getByLabel('Filter operator', { exact: true }).selectOption('relativeDate');
  await page.getByLabel('Relative period', { exact: true }).selectOption('tomorrow');
  await page.getByLabel('Relative time zone', { exact: true }).fill('UTC');
  await save();
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  assert.equal((await call(`/tables/${table.id}/views/${view.id}/query`, 'POST', {})).records[0].values[table.primaryFieldId], '1 day task');
  const year = Number(today.slice(0, 4)), annualDates = [-1, 0, 1].map(delta => `${year + delta}-07-01`);
  const annualRows = (await call(`/tables/${table.id}/records`, 'POST', annualDates.map(date => ({ values: {
    [table.primaryFieldId]: `Annual ${date}`, [due]: date, [at]: `${date}T12:00:00.000Z`,
  } })))).records;
  for (const [period, delta] of [['lastYear', -1], ['thisYear', 0], ['nextYear', 1]]) {
    await open();
    await page.getByLabel('Relative period', { exact: true }).selectOption('pastDays');
    await page.getByLabel('Calendar days', { exact: true }).fill('7');
    await page.getByLabel('Relative period', { exact: true }).selectOption(period);
    assert.equal(await page.getByLabel('Calendar days', { exact: true }).count(), 0);
    await page.getByLabel('Relative time zone', { exact: true }).fill('UTC');
    if (period === 'thisYear') await page.screenshot({ path: '.artifacts/desktop-relative-year-settings.png' });
    await save();
    const expected = [day(-1), day(0), day(1), ...annualDates].filter(date => Number(date.slice(0, 4)) === year + delta).length;
    await page.getByText(`${expected} ${expected === 1 ? 'record' : 'records'} · 3 fields`, { exact: true }).waitFor();
    const saved = await call(`/tables/${table.id}/views/${view.id}`);
    assert.deepEqual(saved.query.filter.conditions[0].relative, { period, timeZone: 'UTC' });
    const matching = await call(`/tables/${table.id}/views/${view.id}/query`, 'POST', {});
    assert.ok(matching.records.some(row => row.id === annualRows[delta + 1].id));
    await open();
    assert.equal(await page.getByLabel('Relative period', { exact: true }).inputValue(), period);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await open();
  await page.getByLabel('Relative time zone', { exact: true }).fill('Asia/Shanghai');
  await call(`/tables/${table.id}/views/${view.id}`, 'PATCH', { expectedVersion: (await call(`/tables/${table.id}/views`))[0].version, name: 'Changed elsewhere' });
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'view changed' }).waitFor();
  assert.equal(await page.getByLabel('Relative time zone', { exact: true }).inputValue(), 'Asia/Shanghai');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), original);
}
