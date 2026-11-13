import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyGroupedRefresh(page) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const waitCell = (row, text) => page.waitForFunction(({ row, text }) =>
    document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === text,
  { row, text }, { polling: 100 });
  const cellText = row => page.locator('canvas').first().locator(`[aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`).textContent();
  const click = async row => {
    await ready(); const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 58 + row * 36, { delay: 50 });
  };
  const editor = page.getByRole('textbox', { name: 'Cell value', exact: true });
  const select = async row => {
    await click(row);
    if (await editor.count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Open record' && !button.disabled));
  };
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Grouped refresh');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Grouped refresh', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Grouped refresh');
  const root = '/tables/' + table.id;
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'planned', name: 'Planned' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] });
  const status = table.fields[1].id, name = table.primaryFieldId;
  const records = (await call(root + '/records', 'POST', Array.from({ length: 505 }, (_, index) => ({ values: {
    [name]: index < 501 ? 'Planned ' + index : ['Alpha', 'Beta', 'Gamma', 'Delta'][index - 501],
    [status]: index < 501 ? 'planned' : index < 503 ? 'doing' : 'done',
  } })))).records;
  let view = (await call(root + '/views'))[0];
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, name: 'Live groups', groupBy: status });
  await page.getByRole('tab', { name: 'Live groups', exact: true, selected: true }).waitFor();
  await waitCell(0, '▾ Planned · 501 records');
  await click(0); await waitCell(0, '▸ Planned · 501 records');
  await waitCell(2, 'Alpha'); await select(2);
  await page.locator('canvas').first().evaluate(element => { window.groupRefreshCanvas = element; });
  const update = async (record, values) => {
    const latest = await call(root + '/records/' + record.id);
    await call(root + '/records', 'PATCH', [{ id: latest.id, expectedVersion: latest.version, values }]);
  };
  await update(records[501], { [status]: 'done' });
  await waitCell(1, '▾ Doing · 1 record'); await waitCell(3, '▾ Done · 3 records'); await waitCell(4, 'Alpha');
  assert.equal(await cellText(0), '▸ Planned · 501 records');
  assert.equal(await page.evaluate(() => document.querySelector('canvas') === window.groupRefreshCanvas), true);
  assert.equal(await page.evaluate(() => document.querySelector('canvas')?.contains(document.activeElement)), true);
  await page.keyboard.press('Enter'); await editor.waitFor(); assert.equal(await editor.inputValue(), 'Alpha');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.evaluate(() => navigator.clipboard.writeText('pending copy'));
  await page.keyboard.press('Control+c');
  await page.waitForFunction(async () => await navigator.clipboard.readText() === 'Alpha', undefined, { polling: 100 });
  await call(root + '/records', 'POST', [{ values: { [name]: 'Hidden addition', [status]: 'planned' } }]);
  await waitCell(0, '▸ Planned · 502 records'); await waitCell(4, 'Alpha');
  await page.screenshot({ path: '.artifacts/desktop-group-refresh-current.png' });

  let release, arrived, finished, intercept = true;
  const held = new Promise(resolve => { release = resolve; });
  const responseReady = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const slowSummary = async route => {
    if (!intercept) return route.continue(); intercept = false;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    finally { finished(); }
  };
  await page.route('**' + root + '/summary', slowSummary);
  try {
    await update(records[503], { [name]: 'Remote Gamma' }); await waitForResponse(responseReady, 'group summary');
    await page.keyboard.press('Enter'); await editor.fill('保留分组输入');
    await editor.dispatchEvent('compositionstart');
    release(); await waitForResponse(settled, 'released group summary');
    await page.waitForRequest(request => request.url().endsWith('/workspace/state') && request.postDataJSON()?.viewId === view.id);
    assert.equal(await editor.inputValue(), '保留分组输入');
    assert.equal(await editor.evaluate(element => element === document.activeElement), true);
    assert.equal(await cellText(5), 'Gamma', 'A prepared summary must not replace the snapshot while editing.');
    assert.equal(await page.evaluate(() => document.querySelector('canvas') === window.groupRefreshCanvas), true);
    await page.screenshot({ path: '.artifacts/desktop-group-refresh-draft.png' });
    await editor.dispatchEvent('compositionend', { data: '保留分组输入' }); await page.keyboard.press('Escape');
    await waitCell(5, 'Remote Gamma');
  } finally {
    release();
    try { if (!intercept) await waitForResponse(settled, 'group summary cleanup'); }
    finally { await page.unroute('**' + root + '/summary', slowSummary); }
  }
  table = await call(root);
  table = await call(root + '/fields/' + status, 'PATCH', { expectedVersion: table.version,
    options: [{ id: 'planned', name: 'Backlog' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] });
  await waitCell(0, '▸ Backlog · 502 records'); await waitCell(4, 'Alpha');
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, groupBy: null });
  await waitCell(0, 'Planned 0');
  await page.getByText('Changes were loaded. The previous selection was cleared; select records again before editing.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('canvas') === window.groupRefreshCanvas), true);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, groupBy: status,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: status, operator: 'neq', value: 'planned' }] } } });
  await waitCell(0, '▸ Backlog · 0 records'); await waitCell(2, 'Beta');
  let outage = true;
  const failedSummary = route => outage ? route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SUMMARY_UNAVAILABLE', message: 'Synthetic group outage' } }) }) : route.continue();
  await page.route('**' + root + '/summary', failedSummary);
  try {
    await update(records[502], { [status]: 'done' });
    await page.getByText('Could not check for updates: Synthetic group outage', { exact: true }).waitFor();
    assert.equal(await cellText(1), '▾ Doing · 1 record'); assert.equal(await cellText(2), 'Beta');
    assert.equal(await page.evaluate(() => document.querySelector('canvas') === window.groupRefreshCanvas), true);
    outage = false; await waitCell(1, '▾ Doing · 0 records'); await waitCell(2, '▾ Done · 4 records');
  } finally { await page.unroute('**' + root + '/summary', failedSummary); }
  await page.evaluate(() => { delete window.groupRefreshCanvas; });
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
