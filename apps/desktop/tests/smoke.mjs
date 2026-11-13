import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import extract from '@electron-internal/extract-zip';
import { SqliteRecordStore } from '../../../dist/packages/storage-sqlite/src/record-store.js';

const dataDirectory = await mkdtemp(join(tmpdir(), 'rowweave-desktop-'));
new SqliteRecordStore(join(dataDirectory, 'prototype.sqlite'), { rows: 10_000, columns: 20 }).close();
let packaged;
await mkdir('.artifacts', { recursive: true });
let application;
let page;
const errors = [];
const diagnostics = [];
let lastCellClick = 0;
async function launch() {
  application = await electron.launch({
    executablePath: packaged ?? electronPath, args: packaged ? [] : ['.'], cwd: packaged ? dataDirectory : process.cwd(),
    env: { ...process.env, ROWWEAVE_DATA_DIR: dataDirectory }, timeout: 40_000,
  });
  application.process().stderr.on('data', data => diagnostics.push(data.toString()));
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('10,000 records · 20 fields').waitFor();
  await page.locator('canvas').first().waitFor();
  console.log('Desktop window loaded.');
}
async function selectCell(row = 0, column = 0) {
  // These are independent selection clicks, not a double-click edit gesture.
  const remaining = 600 - (performance.now() - lastCellClick);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  const bounds = await page.locator('canvas').first().boundingBox();
  assert.ok(bounds);
  await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58 + row * 36);
  lastCellClick = performance.now();
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement) ||
    document.activeElement?.getAttribute('aria-label') === 'Cell value');
  if (await page.getByRole('textbox', { name: 'Cell value' }).count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
}
async function clipboardText() {
  return application.evaluate(({ clipboard }) => clipboard.readText());
}
async function copyCell() {
  await page.keyboard.press('Control+c');
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await clipboardText();
    if (value !== '__waiting__') return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Clipboard copy timed out.');
}
async function clearClipboard() {
  await application.evaluate(({ clipboard }) => clipboard.writeText('__waiting__'));
}
async function records(offset, limit) {
  return page.evaluate(async ({ offset, limit }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/prototype/records?offset=${offset}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    return (await response.json()).records;
  }, { offset, limit });
}
try {
  if (process.argv.includes('--packaged')) {
    const manifest = JSON.parse(await readFile('release/latest.json', 'utf8'));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(manifest.zip)) hash.update(chunk);
    assert.equal(hash.digest('hex'), manifest.sha256);
    const directory = join(dataDirectory, 'application');
    await mkdir(directory);
    await extract(manifest.zip, { dir: directory });
    packaged = join(directory, 'rowweave-win32-x64', 'rowweave.exe');
  }
  await launch();
  await page.screenshot({ path: '.artifacts/desktop-initial.png' });
  console.log('Initial screenshot captured.');
  await selectCell();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Desktop smoke 🌱');
  await page.getByText('Editing cell…', { exact: true }).waitFor();
  await application.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    BrowserWindow.getAllWindows()[0].close();
  });
  assert.equal(page.isClosed(), false);
  assert.equal(await page.getByRole('textbox', { name: 'Cell value' }).inputValue(), 'Desktop smoke 🌱');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await selectCell();
  await clearClipboard();
  assert.equal(await copyCell(), 'Desktop smoke 🌱');

  await page.keyboard.press('Control+z');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await clearClipboard();
  assert.equal(await copyCell(), '');
  await page.keyboard.press('Control+y');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await clearClipboard();
  assert.equal(await copyCell(), 'Desktop smoke 🌱');

  await application.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  assert.equal(page.isClosed(), false);

  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Cancel this edit');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Cell value' }).waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await clearClipboard();
  assert.equal(await copyCell(), 'Desktop smoke 🌱');

  await page.keyboard.press('ArrowRight');
  await clearClipboard();
  assert.equal(await copyCell(), 'Row 1 · 2');
  await selectCell();
  await page.keyboard.press('Shift+ArrowRight');
  await clearClipboard();
  assert.equal(await copyCell(), 'Desktop smoke 🌱\tRow 1 · 2');

  // Synthetic composition verifies the key guard, not a native Windows IME.
  await selectCell();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Cell value' });
  await editor.fill('组合输入');
  await editor.dispatchEvent('compositionstart');
  await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  assert.equal(await editor.count(), 1);
  await editor.dispatchEvent('compositionend', { data: '组合输入' });
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await records(0, 1))[0].values.field_1, '组合输入');

  await selectCell();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Save from the editor');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal((await records(0, 1))[0].values.field_1, 'Save from the editor');

  await selectCell();
  await page.keyboard.press('x');
  await page.getByText('Editing cell…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Cell value' }).inputValue(), 'x');
  await page.keyboard.press('y');
  assert.equal(await page.getByRole('textbox', { name: 'Cell value' }).inputValue(), 'xy');
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.getByText('All changes saved', { exact: true }).waitFor();

  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await clearClipboard();
  const beforeNonTextPaste = await copyCell();
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/html', '<b>No plain-text representation</b>');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await clearClipboard();
  assert.equal(await copyCell(), beforeNonTextPaste);

  const literalCells = '中文🌱\t"第一行\n第二行"\t"quoted ""value"""\n<b>literal & text</b>\t\t';
  await selectCell();
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), literalCells);
  await page.keyboard.press('Control+v');
  await page.getByText('6 unsaved cells', { exact: true }).waitFor();
  await selectCell(0, 3);
  await selectCell();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await clearClipboard();
  assert.equal((await copyCell()).replace(/\r\n/g, '\n'), literalCells);
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.has('text/html')), false);
  await page.keyboard.press('Control+z');
  await page.getByText('All changes saved', { exact: true }).waitFor();

  const pasted = Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => `Paste ${row}/${col} 🌱`).join('\t')).join('\n');
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasted);
  await selectCell();
  await page.keyboard.press('Control+v');
  await page.getByText('10,000 unsaved cells', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal((await records(999, 1))[0].values.field_10, 'Paste 999/9 🌱');

  await selectCell();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Preserve this draft');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const { records } = await fetch(`${connection.url}/tables/prototype/records?offset=0&limit=1`, { headers }).then(r => r.json());
    await fetch(`${connection.url}/tables/prototype/records`, {
      method: 'PATCH', headers,
      body: JSON.stringify([{ id: records[0].id, expectedVersion: records[0].version, values: { field_1: 'External change' } }]),
    });
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  await selectCell();
  await clearClipboard();
  assert.equal(await copyCell(), 'Preserve this draft');

  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-smoke.png' });
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;

  await launch();
  assert.equal((await records(0, 1))[0].values.field_1, 'External change');
  assert.equal((await records(999, 1))[0].values.field_10, 'Paste 999/9 🌱');
  await application.evaluate(({ app }) => {
    const service = app.getAppMetrics().find(metric => metric.name === 'rowweave-data-service');
    if (!service) throw new Error('Missing separate data service process.');
    process.kill(service.pid);
  });
  await page.getByRole('status').filter({ hasText: 'Service unavailable' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('Desktop smoke passed: editing, cancellation, keyboard selection, native clipboard, 1000×10 paste, composition guard, conflict feedback, restart persistence and service failure.');
} catch (error) {
  console.error('Renderer errors:', errors);
  console.error('Desktop process diagnostics:', diagnostics.join(''));
  if (page && !page.isClosed()) await page.screenshot({ path: '.artifacts/desktop-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }).catch(() => {});
    await application.close();
  }
  assert.equal(dirname(resolve(dataDirectory)), resolve(tmpdir()));
  assert.ok(basename(dataDirectory).startsWith('rowweave-desktop-'));
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
