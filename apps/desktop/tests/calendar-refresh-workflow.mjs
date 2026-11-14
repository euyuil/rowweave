import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyCalendarRefresh(page, fixture) {
  const { root, name, start, end, records } = fixture;
  let { table, view } = fixture;
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const update = async (record, values) => {
    const current = await call(root + '/records/' + record.id);
    await call(root + '/records', 'PATCH', [{ id: current.id, expectedVersion: current.version, values }]);
  };
  const calendar = page.getByRole('region', { name: 'Schedule calendar', exact: true });
  const pane = calendar.getByRole('complementary', { name: 'Calendar records', exact: true });
  const dialog = page.getByRole('dialog');
  await calendar.locator('[data-calendar-day="2024-02-29"]').click();
  await pane.getByRole('button', { name: 'Next', exact: true }).click();
  await pane.getByRole('button', { name: 'Task 030', exact: true }).waitFor();
  await pane.evaluate(element => { window.calendarPane = element; element.scrollTop = 160; });
  await calendar.focus();
  const top = await pane.evaluate(element => element.scrollTop);
  await update(records[30], { [name]: 'Remote 030' });
  await pane.getByRole('button', { name: 'Remote 030', exact: true }).waitFor();
  assert.equal(await pane.evaluate(element => element === window.calendarPane), true);
  assert.equal(await pane.evaluate(element => element.scrollTop), top);
  await pane.getByText('26–50 of 55', { exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Task 026', exact: true }).focus();
  await update(records[26], { [name]: 'Remote 026' });
  const retained = pane.getByRole('button', { name: 'Remote 026', exact: true });
  await retained.waitFor();
  assert.equal(await retained.evaluate(element => element === document.activeElement), true);
  await pane.getByRole('button', { name: 'Task 027', exact: true }).focus();
  await update(records[27], { [start]: '2024-02-28' });
  const moved = calendar.locator('[data-calendar-date="2024-02-28"]').getByRole('button', { name: 'Task 027', exact: true });
  await moved.waitFor();
  assert.equal(await moved.evaluate(element => element === document.activeElement), true);
  await update(records[27], { [start]: '2024-02-29' });
  await pane.getByRole('button', { name: 'Task 027', exact: true }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Task 027', exact: true }).evaluate(element => element === document.activeElement), true);
  await retained.focus();
  await page.keyboard.press('Enter');
  const input = dialog.getByLabel('Name', { exact: true });
  await input.fill('日历草稿'); await input.dispatchEvent('compositionstart');
  await update(records[31], { [name]: 'Remote 031' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '日历草稿');
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await input.dispatchEvent('compositionend', { data: '日历草稿' });
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await pane.getByRole('button', { name: 'Remote 031', exact: true }).waitFor();
  await pane.getByRole('button', { name: '日历草稿', exact: true }).waitFor();

  let release, arrived, finished, intercept = true;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const path = '**' + root + '/calendar/records';
  const slowPage = async route => {
    if (!intercept) return route.continue();
    intercept = false;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    finally { finished(); }
  };
  await calendar.focus();
  await page.route(path, slowPage);
  try {
    await update(records[32], { [name]: 'Remote 032' }); await waitForResponse(ready, 'calendar refresh page');
    await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
    await calendar.getByRole('heading', { name: 'March 2024', exact: true }).waitFor();
    release(); await waitForResponse(settled, 'released calendar refresh page');
    await calendar.locator('[data-calendar-date="2024-03-01"]').getByRole('button', { name: 'Task 000', exact: true }).waitFor();
    assert.equal(await calendar.getByLabel('Calendar month', { exact: true }).inputValue(), '2024-03');
    assert.equal(await pane.count(), 0);
  } finally { release(); await page.unroute(path, slowPage); }
  await calendar.getByRole('button', { name: 'Previous month', exact: true }).click();
  await calendar.locator('[data-calendar-day="2024-02-29"]').click();
  await pane.getByRole('button', { name: 'Next', exact: true }).click();
  await pane.getByRole('button', { name: 'Next', exact: true }).click();
  await pane.getByText('51–55 of 55', { exact: true }).waitFor();
  await calendar.focus();
  const removal = records.slice(48, 53);
  await call(root + '/records', 'DELETE', await Promise.all(removal.map(async record => {
    const current = await call(root + '/records/' + record.id); return { id: current.id, expectedVersion: current.version };
  })));
  await pane.getByText('26–50 of 50', { exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Remote 032', exact: true }).waitFor();
  assert.equal(await pane.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);

  // Keep polling from applying the new schema before the explicit reload begins.
  await calendar.getByLabel('Calendar month', { exact: true }).focus();
  table = await call(root);
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Replacement start', type: 'date' });
  const replacement = table.fields.at(-1).id;
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    calendar: { startFieldId: replacement, endFieldId: end, timeZone: 'Asia/Shanghai' } });
  table = await call(root + '/fields/' + start, 'DELETE', { expectedVersion: table.version });
  let releaseSchema, schemaArrived, schemaFinished, schemaFailure, holdSchema = true;
  const schemaHeld = new Promise(resolve => { releaseSchema = resolve; });
  const schemaReady = new Promise(resolve => { schemaArrived = resolve; });
  const schemaSettled = new Promise(resolve => { schemaFinished = resolve; });
  const tablePath = '**' + root;
  const slowSchema = async route => {
    if (!holdSchema || route.request().method() !== 'GET') return route.continue();
    holdSchema = false;
    try { const response = await route.fetch(); schemaArrived(); await schemaHeld; await route.fulfill({ response }); }
    catch (error) { schemaFailure = error; }
    finally { schemaFinished(); }
  };
  await page.route(tablePath, slowSchema);
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitForResponse(schemaReady, 'calendar reload schema');
    assert.equal(await calendar.count(), 1, 'Reload keeps the mounted month until its schema and view are ready together.');
    assert.equal(await calendar.getByLabel('Calendar month', { exact: true }).inputValue(), '2024-02');
    releaseSchema(); await waitForResponse(schemaSettled, 'released calendar schema');
    await calendar.getByRole('button', { name: 'Unscheduled (52)', exact: true }).waitFor();
    assert.equal(await calendar.getByLabel('Calendar month', { exact: true }).inputValue(), '2024-02');
    await calendar.getByRole('button', { name: 'Close calendar records', exact: true }).click();
  } finally {
    releaseSchema();
    if (!holdSchema) await waitForResponse(schemaSettled, 'calendar schema cleanup');
    await page.unroute(tablePath, slowSchema);
  }
  assert.equal(schemaFailure, undefined);
  const created = (await call(root + '/query', 'POST', { search: 'Created on calendar' })).records[0];
  await update(created, { [replacement]: '2024-02-26' });
  await calendar.getByRole('button', { name: 'Created on calendar', exact: true }).waitFor();
  let releaseSearch, searchArrived, searchFinished, searchFailure, holdSearch = true;
  const searchHeld = new Promise(resolve => { releaseSearch = resolve; });
  const searchReady = new Promise(resolve => { searchArrived = resolve; });
  const searchSettled = new Promise(resolve => { searchFinished = resolve; });
  const layoutPath = '**' + root + '/calendar/query';
  const slowSearch = async route => {
    if (!holdSearch) return route.continue();
    holdSearch = false;
    try { const response = await route.fetch(); searchArrived(); await searchHeld; await route.fulfill({ response }); }
    catch (error) { searchFailure = error; }
    finally { searchFinished(); }
  };
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await page.route(layoutPath, slowSearch);
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await waitForResponse(searchReady, 'calendar search during reload');
    await search.fill('Created on calendar');
    releaseSearch(); await waitForResponse(searchSettled, 'released calendar search reload');
    await calendar.getByText('1 record in this range · 1 matching', { exact: true }).waitFor();
    assert.equal(await search.inputValue(), 'Created on calendar');
  } finally {
    releaseSearch();
    if (!holdSearch) await waitForResponse(searchSettled, 'calendar search cleanup');
    await page.unroute(layoutPath, slowSearch);
  }
  assert.equal(searchFailure, undefined);
  await search.fill('');
  await calendar.getByRole('button', { name: 'Unscheduled (51)', exact: true }).waitFor();
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Calendar temporarily unavailable.' } }) });
  await page.route(layoutPath, unavailable);
  try {
    await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
    await calendar.getByRole('alert').filter({ hasText: 'Calendar temporarily unavailable.' }).waitFor();
    assert.equal(await calendar.locator('.calendar-preview').count(), 0, 'A failed month read cannot display the previous month records.');
    assert.equal(await calendar.getByLabel('Calendar month', { exact: true }).inputValue(), '2024-03');
  } finally { await page.unroute(layoutPath, unavailable); }
  await calendar.getByRole('button', { name: 'Reload calendar', exact: true }).click();
  await calendar.getByText('1 record in this range · 52 matching', { exact: true }).waitFor();
  await calendar.getByRole('button', { name: 'Previous month', exact: true }).click();
  await calendar.getByRole('button', { name: 'Created on calendar', exact: true }).waitFor();
  console.log('Calendar external refresh retained paging, focus, composition drafts, navigation and atomic schema reload.');
  return { ...fixture, start: replacement, table, view };
}
