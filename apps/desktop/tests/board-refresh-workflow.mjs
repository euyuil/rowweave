import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyBoardRefresh(page) {
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Live board');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Live board', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Live board');
  const root = '/tables/' + table.id, name = table.primaryFieldId;
  const options = [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' },
    ...Array.from({ length: 6 }, (_, index) => ({ id: 'other' + index, name: 'Other ' + index }))];
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect', options });
  const status = table.fields[1].id;
  const records = (await call(root + '/records', 'POST', Array.from({ length: 73 }, (_, index) => ({ values: {
    [name]: index < 65 ? 'Task ' + String(index).padStart(3, '0') : index < 70 ? 'Doing ' + (index - 65) : index < 72 ? 'Done ' + (index - 70) : 'No group',
    [status]: index < 65 ? 'todo' : index < 70 ? 'doing' : index < 72 ? 'done' : null,
  } })))).records;
  let view = (await call(root + '/views'))[0];
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, name: 'Live status', type: 'board', groupBy: status });
  const board = page.getByRole('region', { name: 'Live status board', exact: true });
  const todo = page.getByRole('region', { name: 'To do column', exact: true });
  const doing = page.getByRole('region', { name: 'Doing column', exact: true });
  const done = page.getByRole('region', { name: 'Done column', exact: true });
  await todo.getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  await todo.getByRole('button', { name: 'Next records in To do', exact: true }).click();
  await todo.getByRole('button', { name: 'Task 025', exact: true }).waitFor();
  await todo.evaluate(element => { window.liveBoardLane = element; element.scrollTop = 170; });
  await board.focus();
  const top = await todo.evaluate(element => element.scrollTop);
  const update = async (record, values) => {
    const current = await call(root + '/records/' + record.id);
    await call(root + '/records', 'PATCH', [{ id: current.id, expectedVersion: current.version, values }]);
  };
  await update(records[30], { [name]: 'Remote 030' });
  await todo.getByRole('button', { name: 'Remote 030', exact: true }).waitFor();
  assert.equal(await todo.evaluate(element => element === window.liveBoardLane), true);
  assert.equal(await todo.evaluate(element => element.scrollTop), top);
  await todo.getByText('26–50', { exact: true }).waitFor();
  await todo.getByRole('button', { name: 'Task 025', exact: true }).focus();
  await update(records[25], { [status]: 'done' });
  const moved = done.getByRole('button', { name: 'Task 025', exact: true });
  await moved.waitFor();
  assert.equal(await moved.evaluate(element => element === document.activeElement), true);
  await done.getByLabel('3 records', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-board-refresh-moved.png' });
  await page.keyboard.press('Enter');
  const input = dialog.getByLabel('Name', { exact: true });
  await input.fill('看板草稿'); await input.dispatchEvent('compositionstart');
  await update(records[65], { [name]: 'Remote Doing' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '看板草稿');
  assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await input.dispatchEvent('compositionend', { data: '看板草稿' });
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await doing.getByRole('button', { name: 'Remote Doing', exact: true }).waitFor();
  await todo.getByRole('button', { name: 'Next records in To do', exact: true }).click();
  await todo.getByText('26–50', { exact: true }).waitFor();
  await board.focus();

  let release, arrived, finished, intercept = true;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const queryPath = '**' + root + '/views/' + view.id + '/query';
  const slowLane = async route => {
    if (!intercept || route.request().postDataJSON().lane !== 'todo') return route.continue();
    intercept = false;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    finally { finished(); }
  };
  await page.route(queryPath, slowLane);
  try {
    await update(records[60], { [name]: 'Remote 060' }); await waitForResponse(ready, 'board lane');
    await todo.getByRole('button', { name: 'Next records in To do', exact: true }).click();
    await todo.evaluate(element => {
      window.boardRanges = [];
      window.boardObserver = new MutationObserver(() => { const text = element.querySelector('.board-pages span')?.textContent; if (text) window.boardRanges.push(text); });
      window.boardObserver.observe(element, { subtree: true, childList: true, characterData: true });
    });
    release(); await waitForResponse(settled, 'released board lane');
    await todo.getByRole('button', { name: 'Remote 060', exact: true }).waitFor();
    await todo.getByText('51–64', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.boardRanges.includes('26–50')), false);
  } finally {
    release();
    try { if (!intercept) await waitForResponse(settled, 'board lane cleanup'); }
    finally {
      await page.unroute(queryPath, slowLane);
      await page.evaluate(() => { window.boardObserver?.disconnect(); delete window.boardObserver; delete window.boardRanges; });
    }
  }

  const moveInput = done.getByLabel('Move Done 0 to', { exact: true });
  await moveInput.focus(); await update(records[70], { [name]: 'Remote focused' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await moveInput.evaluate(element => element === document.activeElement), true);
  await board.focus(); await done.getByRole('button', { name: 'Remote focused', exact: true }).waitFor();
  const dragged = done.getByRole('button', { name: 'Done 1', exact: true }).locator('..');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await dragged.dispatchEvent('dragstart', { dataTransfer: transfer });
  await update(records[71], { [name]: 'Remote drag' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await done.getByRole('button', { name: 'Done 1', exact: true }).count(), 1);
  await dragged.dispatchEvent('dragend', { dataTransfer: transfer }); await transfer.dispose();
  await done.getByRole('button', { name: 'Remote drag', exact: true }).waitFor();

  let outage = true;
  const failedLane = route => outage && route.request().postDataJSON().lane === 'doing'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'LANE_UNAVAILABLE', message: 'Synthetic board outage' } }) }) : route.continue();
  await page.route(queryPath, failedLane);
  try {
    await update(records[65], { [name]: 'Recovered Doing' });
    await page.getByText('Could not check for updates: Synthetic board outage', { exact: true }).waitFor();
    assert.equal(await doing.getByRole('button', { name: 'Remote Doing', exact: true }).count(), 1);
    await todo.getByText('51–64', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/desktop-board-refresh-outage.png' });
    outage = false; await doing.getByRole('button', { name: 'Recovered Doing', exact: true }).waitFor();
  } finally { await page.unroute(queryPath, failedLane); }
  await doing.getByRole('button', { name: 'Doing 1', exact: true }).focus();
  await update(records[66], { [status]: 'other5' });
  await page.getByText('Changes were loaded. The focused record is outside the visible view.', { exact: true }).waitFor();
  assert.equal(await board.evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  const empty = page.getByRole('region', { name: 'No value column', exact: true });
  await empty.scrollIntoViewIfNeeded(); await empty.getByRole('button', { name: 'No group', exact: true }).waitFor();
  await board.focus(); const left = await page.locator('.board-scroll').evaluate(element => element.scrollLeft);
  assert.ok(left > 1000);
  await call(root + '/records', 'POST', [{ values: { [name]: 'External ungrouped', [status]: null } }]);
  await empty.getByRole('button', { name: 'External ungrouped', exact: true }).waitFor();
  assert.equal(await page.locator('.board-scroll').evaluate(element => element.scrollLeft), left);
  await page.screenshot({ path: '.artifacts/desktop-board-refresh-scrolled.png' });
  table = await call(root);
  await call(root + '/fields/' + status, 'PATCH', { expectedVersion: table.version, options: options.map(option => option.id === 'done' ? { ...option, name: 'Completed' } : option) });
  await page.getByRole('region', { name: 'Completed column', exact: true }).waitFor();
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, type: 'grid', groupBy: null });
  await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === 'Task 000', undefined, { polling: 100 });
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version, type: 'board', groupBy: status });
  await todo.getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  await page.evaluate(() => { delete window.liveBoardLane; });
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
}
