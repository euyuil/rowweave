import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SqliteRecordStore } from '../../../dist/packages/storage-sqlite/src/record-store.js';
import { createWorkspaceClient } from '../../../dist/packages/client/src/http-client.js';
import { closeApplication } from './close-application.mjs';

const directory = await mkdtemp(join(tmpdir(), 'rowweave-live-'));
new SqliteRecordStore(join(directory, 'prototype.sqlite'), { rows: 3, columns: 3 }).close();
let application, page;
const errors = [];
try {
  application = await electron.launch({ executablePath: electronPath, args: ['.'],
    env: { ...process.env, ROWWEAVE_DATA_DIR: directory, ROWWEAVE_HEADLESS: '1' }, timeout: 40_000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('3 records · 3 fields', { exact: true }).waitFor();
  const api = createWorkspaceClient(await page.evaluate(() => window.rowweave.connection()));
  const read = () => api.getRecord('prototype', 'record_1');
  const waitValue = async (field, value) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.stringify((await read()).values[field]) === JSON.stringify(value)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal((await read()).values[field], value);
  };
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const select = async (column = 0, row = 0) => {
    await ready();
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58 + row * 36);
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement) || document.activeElement?.getAttribute('aria-label') === 'Cell value');
  };
  const edit = async value => {
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill(value);
    await page.keyboard.press('Enter');
  };
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).count(), 0);
  await select(); await edit('Automatic'); await waitValue('field_1', 'Automatic');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitValue('field_1', null);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await waitValue('field_1', 'Automatic');
  console.log('Grid autosave, undo and redo passed.');
  await select();
  if (await page.getByRole('textbox', { name: 'Cell value', exact: true }).count()) await page.keyboard.press('Escape');
  await page.evaluate(() => navigator.clipboard.writeText('Pasted 中文\tPasted second\nPasted row two\tPasted second row'));
  await page.keyboard.press('Control+v');
  await waitValue('field_1', 'Pasted 中文');
  assert.equal((await api.getRecord('prototype', 'record_2')).values.field_2, 'Pasted second row');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitValue('field_1', 'Automatic');
  assert.equal((await api.getRecord('prototype', 'record_2')).values.field_1, 'Row 2 · 1');
  let attempts = 0;
  const rejectWrite = route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    attempts++;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_OUTAGE', message: 'Test connection unavailable' } }) });
  };
  await page.route('**/tables/prototype/records', rejectWrite);
  await select();
  if (!await page.getByRole('textbox', { name: 'Cell value', exact: true }).count()) await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Retry draft'); await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Test connection unavailable' }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(attempts, 1);
  assert.equal((await read()).values.field_1, 'Automatic');
  await page.unroute('**/tables/prototype/records', rejectWrite);
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click(); await waitValue('field_1', 'Retry draft');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await waitValue('field_1', 'Automatic');
  console.log('Atomic clipboard undo and retained failed writes passed.');
  await select();
  if (!await page.getByRole('textbox', { name: 'Cell value', exact: true }).count()) await page.keyboard.press('Enter');
  const cell = page.getByRole('textbox', { name: 'Cell value', exact: true });
  await cell.dispatchEvent('compositionstart'); await cell.fill('中文组合');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await read()).values.field_1, 'Automatic');
  await cell.dispatchEvent('compositionend'); await page.keyboard.press('Enter'); await waitValue('field_1', '中文组合');
  await ready();
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 15, bounds.y + 58);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const table = await api.getTable('prototype');
  const first = dialog.getByLabel(table.fields[0].name, { exact: true });
  const second = dialog.getByLabel(table.fields[1].name, { exact: true });
  await first.fill('Details automatic'); await waitValue('field_1', 'Details automatic');
  assert.equal(await first.evaluate(element => element === document.activeElement), true);
  const record = await read();
  await api.updateRecords('prototype', [{ id: record.id, expectedVersion: record.version, values: { field_2: 'Other client' } }]);
  await page.waitForFunction(({ name, value }) => [...document.querySelectorAll('label')].some(label => label.textContent === name && document.getElementById(label.htmlFor)?.value === value),
    { name: table.fields[1].name, value: 'Other client' });
  assert.equal(await second.inputValue(), 'Other client');
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click(); await waitValue('field_1', '中文组合');
  assert.equal((await read()).values.field_2, 'Other client');
  await dialog.getByRole('button', { name: 'Redo', exact: true }).click(); await waitValue('field_1', 'Details automatic');
  let releaseWrite, arrived, hold = true;
  const held = new Promise(resolve => { releaseWrite = resolve; });
  const arrival = new Promise(resolve => { arrived = resolve; });
  const holdWrite = async route => {
    if (!hold || route.request().method() !== 'PATCH') return route.continue();
    hold = false; arrived(); await held; await route.continue();
  };
  await page.route('**/tables/prototype/records', holdWrite);
  try {
    await first.fill('Submitted first field');
    await Promise.race([arrival, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('The first field write did not arrive.')), 10_000); timer.unref(); })]);
    await second.fill('Concurrent local draft');
    const concurrent = await read();
    await api.updateRecords('prototype', [{ id: concurrent.id, expectedVersion: concurrent.version, values: { field_2: 'Concurrent external winner' } }]);
    releaseWrite();
    await waitValue('field_1', 'Submitted first field');
    await dialog.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  } finally { releaseWrite(); await page.unroute('**/tables/prototype/records', holdWrite); }
  assert.equal(await second.inputValue(), 'Concurrent local draft');
  assert.equal((await read()).values.field_2, 'Concurrent external winner');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await first.waitFor();
  console.log('In-flight saves retain the original baseline of newly edited fields.');
  await first.dispatchEvent('compositionstart'); await first.fill('Retained conflict');
  const before = await read();
  await api.updateRecords('prototype', [{ id: before.id, expectedVersion: before.version, values: { field_1: 'External winner' } }]);
  await first.dispatchEvent('compositionend');
  await dialog.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await first.inputValue(), 'Retained conflict');
  assert.equal((await read()).values.field_1, 'External winner');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await read()).version, before.version + 1);
  await mkdir('.artifacts', { recursive: true });
  await page.screenshot({ path: '.artifacts/desktop-live-sync.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(errors, []);
  console.log('Record autosave, live external edits, composition protection and conflict retention passed.');
} catch (error) {
  if (page) { await mkdir('.artifacts', { recursive: true }); await page.screenshot({ path: '.artifacts/desktop-live-failure.png' }).catch(() => {}); }
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await closeApplication(application);
  }
  await rm(directory, { recursive: true, force: true });
}
