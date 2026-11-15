import assert from 'node:assert/strict';
import { ganttApi } from './gantt-workflow.mjs';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyGanttRefresh(page, fixture) {
  const { root, name, start, end, at, records, hidden } = fixture;
  let { table, view } = fixture;
  const call = ganttApi(page), timeline = page.getByRole('region', { name: 'Project plan timeline', exact: true });
  const dialog = page.getByRole('dialog');
  const row = index => timeline.locator('[data-gantt-record="' + records[index].id + '"]');
  const bar = index => row(index).locator('.gantt-bar');
  const current = index => call(root + '/records/' + records[index].id);
  const update = async (index, values) => { const record = await current(index);
    return call(root + '/records', 'PATCH', [{ id: record.id, expectedVersion: record.version, values }]); };
  const reads = [];
  const capture = request => { if (request.url().endsWith('/views/' + view.id + '/query')) reads.push(request.postDataJSON()); };
  page.on('request', capture);
  await timeline.locator('.gantt-viewport').evaluate(element => { window.ganttViewport = element; element.scrollTop = 110; });
  await bar(3).focus();
  const scroll = await timeline.locator('.gantt-viewport').evaluate(element => element.scrollTop);
  await update(3, { [name]: 'Remote task 003' });
  await row(3).getByRole('button', { name: 'Remote task 003', exact: true }).waitFor();
  assert.equal(await bar(3).evaluate(element => element === document.activeElement), true);
  assert.equal(await timeline.locator('.gantt-viewport').evaluate(element => element === window.ganttViewport), true);
  assert.equal(await timeline.locator('.gantt-viewport').evaluate(element => element.scrollTop), scroll);
  await bar(9).focus();
  await update(9, { [start]: '2024-05-01', [end]: '2024-05-03' });
  await row(9).getByRole('button', { name: 'After range · Show date', exact: true }).waitFor();
  assert.equal(await row(9).getByRole('button', { name: 'Task 009', exact: true }).evaluate(element => element === document.activeElement), true);
  await update(9, { [start]: '2024-02-29', [end]: '2024-03-02' });
  await bar(9).waitFor();
  await row(4).getByRole('button', { name: 'Task 004', exact: true }).click();
  const input = dialog.getByLabel('Name', { exact: true });
  await input.fill('时间线草稿'); await input.dispatchEvent('compositionstart');
  await update(5, { [name]: 'Remote task 005' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '时间线草稿'); assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await input.dispatchEvent('compositionend', { data: '时间线草稿' });
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await row(4).getByRole('button', { name: '时间线草稿', exact: true }).waitFor();
  await row(5).getByRole('button', { name: 'Remote task 005', exact: true }).waitFor();

  const beginDrag = async index => {
    await bar(index).scrollIntoViewIfNeeded(); const box = await bar(index).boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 3 });
  };
  await beginDrag(6);
  await update(6, { [name]: 'Concurrent edit' });
  const newer = await current(6);
  const conflict = page.waitForResponse(response => response.url().endsWith('/schedule'));
  await page.mouse.up();
  assert.equal((await conflict).status(), 409);
  assert.deepEqual(await current(6), newer, 'A stale gesture cannot overwrite a newer record.');
  await row(6).getByRole('button', { name: 'Concurrent edit', exact: true }).waitFor();
  await beginDrag(7);
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    gantt: { startFieldId: at, timeZone: 'Asia/Shanghai', scale: 'day' } });
  const beforeConfig = await current(7), configConflict = page.waitForResponse(response => response.url().endsWith('/schedule'));
  await page.mouse.up(); assert.equal((await configConflict).status(), 409);
  assert.deepEqual(await current(7), beforeConfig, 'A gesture keeps its captured view version when the configured fields change.');
  await row(7).getByRole('button', { name: 'Set a start date', exact: true }).waitFor();
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    gantt: { startFieldId: start, endFieldId: end, timeZone: 'Asia/Shanghai', scale: 'day' } });
  await timeline.focus(); await bar(7).waitFor();

  let release, arrived, finished, pageFailure, intercepted = false;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const path = '**' + root + '/views/' + view.id + '/query';
  const slowPage = async route => {
    if (intercepted || route.request().postDataJSON().limit !== 50) return route.continue();
    intercepted = true;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    catch (error) { pageFailure = error; }
    finally { finished(); }
  };
  await page.route(path, slowPage);
  try {
    await update(8, { [name]: 'Remote task 008' }); await waitForResponse(ready, 'Gantt refresh page');
    await timeline.getByRole('button', { name: 'Next records', exact: true }).click();
    release(); await waitForResponse(settled, 'released Gantt page');
    await row(50).getByRole('button', { name: 'Task 050', exact: true }).waitFor();
    await timeline.getByText('51–56 of 56 records', { exact: true }).waitFor();
    assert.equal(await row(8).count(), 0, 'An obsolete refresh cannot replace the newly selected page.');
  } finally { release(); if (intercepted) await waitForResponse(settled, 'Gantt page cleanup'); await page.unroute(path, slowPage); }
  assert.equal(pageFailure, undefined);
  await timeline.focus();
  await call(root + '/records', 'DELETE', await Promise.all(records.slice(48).map(async record => {
    const current = await call(root + '/records/' + record.id); return { id: current.id, expectedVersion: current.version };
  })));
  await timeline.getByText('1–48 of 48 records', { exact: true }).waitFor();
  await row(8).getByRole('button', { name: 'Remote task 008', exact: true }).waitFor();
  assert.ok(reads.filter(read => read.limit === 50).every(read => read.fields.includes(start) && read.fields.includes(end) && !read.fields.includes(hidden)));
  assert.ok(reads.every(read => read.limit <= 100), 'Timeline reads stay bounded.');
  page.off('request', capture);

  await timeline.getByLabel('Timeline start', { exact: true }).focus();
  const saved = (await call(root + '/query', 'POST', { limit: 100 })).records;
  table = await call(root);
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Replacement start', type: 'date' });
  const replacement = table.fields.at(-1).id;
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    gantt: { startFieldId: replacement, endFieldId: end, timeZone: 'Asia/Shanghai', scale: 'day' } });
  table = await call(root + '/fields/' + start, 'DELETE', { expectedVersion: table.version });
  let releaseSchema, schemaArrived, schemaFinished, interceptedSchema = false;
  const heldSchema = new Promise(resolve => { releaseSchema = resolve; }), schemaReady = new Promise(resolve => { schemaArrived = resolve; });
  const schemaSettled = new Promise(resolve => { schemaFinished = resolve; });
  const slowSchema = async route => {
    if (interceptedSchema || route.request().method() !== 'GET') return route.continue();
    interceptedSchema = true;
    try { const response = await route.fetch(); schemaArrived(); await heldSchema; await route.fulfill({ response }); }
    finally { schemaFinished(); }
  };
  await page.route('**' + root, slowSchema);
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).click(); await waitForResponse(schemaReady, 'Gantt schema reload');
    assert.equal(await timeline.count(), 1); assert.equal(await timeline.getByLabel('Timeline start', { exact: true }).inputValue(), '2024-02-26');
    releaseSchema(); await waitForResponse(schemaSettled, 'released Gantt schema');
    await row(0).getByRole('button', { name: 'Set a start date', exact: true }).waitFor();
  } finally { releaseSchema(); await page.unroute('**' + root, slowSchema); }
  await call(root + '/records', 'PATCH', await Promise.all(saved.map(async record => {
    const current = await call(root + '/records/' + record.id);
    return { id: current.id, expectedVersion: current.version, values: { [replacement]: record.values[start] } };
  })));
  await timeline.focus(); await bar(0).waitFor();
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Timeline temporarily unavailable.' } }) });
  await page.route(path, unavailable);
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Timeline temporarily unavailable.' }).waitFor();
    assert.equal(await timeline.getByLabel('Timeline start', { exact: true }).inputValue(), '2024-02-26');
  } finally { await page.unroute(path, unavailable); }
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await bar(0).waitFor();
  console.log('Gantt external refresh, focus, composition drafts, stale gestures, paging and atomic schema reload passed.');
  return { ...fixture, table, view, start: replacement };
}
