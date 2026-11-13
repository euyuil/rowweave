import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import extract from '@electron-internal/extract-zip';
import { SqliteRecordStore } from '../../../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../../../dist/packages/core/src/record-service.js';
import { startServer } from '../../../dist/apps/server/src/http-server.js';

const directory = await mkdtemp(join(tmpdir(), 'rowweave-connections-'));
const profile = join(directory, 'profile');
await mkdir(profile);
await mkdir('.artifacts', { recursive: true });
const token = randomBytes(32).toString('hex');
const store = new SqliteRecordStore(join(directory, 'remote.sqlite'));
const service = new RecordService(store);
const table = service.createTable({ name: 'Shared projects' });
let remote = await startServer({ service, token });
const remoteUrl = remote.url;
const remotePort = Number(new URL(remoteUrl).port);
const forbidden = await startServer({ service, token, allowedOrigins: [] });
let executablePath = electronPath;
const packaged = process.argv.includes('--packaged');
let application;
let page;
const errors = [];
const settingsPath = join(profile, 'connection.json');

async function launch(heading) {
  application = await electron.launch({ executablePath, args: packaged ? [] : ['.'], cwd: packaged ? directory : process.cwd(),
    env: { ...process.env, ROWWEAVE_DATA_DIR: profile, ROWWEAVE_HEADLESS: '1' }, timeout: 40_000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
}
async function settings(url = remoteUrl, secret = token) {
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('Workspace', { exact: true }).selectOption('remote');
  await page.getByLabel('Service URL', { exact: true }).fill(url);
  await page.getByLabel('Access token', { exact: true }).fill(secret);
}
async function connect() {
  await page.getByRole('button', { name: 'Connect and save', exact: true }).click();
}
async function stopRemote() {
  const running = remote;
  remote = undefined;
  await running.close();
}
async function localProcesses() {
  return application.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === 'rowweave-data-service').length);
}
async function createRecord(name) {
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
}

try {
  if (packaged) {
    const manifest = JSON.parse(await readFile('release/latest.json', 'utf8'));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(manifest.zip)) hash.update(chunk);
    assert.equal(hash.digest('hex'), manifest.sha256);
    const extracted = join(directory, 'application');
    await mkdir(extracted);
    await extract(manifest.zip, { dir: extracted });
    executablePath = join(extracted, 'rowweave-win32-x64', 'rowweave.exe');
  }
  await launch('Make room for your ideas');
  const slowService = join(directory, 'slow-service.cjs');
  await writeFile(slowService, `
    setTimeout(() => process.parentPort.postMessage({ type: 'ready', url: 'http://127.0.0.1:1' }), 31_000);
    process.parentPort.on('message', ({ data }) => { if (data === 'shutdown') process.exit(0); });
  `);
  const delayed = await application.evaluate(async ({ app }, entry) => {
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const { startLocalService } = require('./dist/apps/desktop/src/local-service.js');
    let exits = 0;
    const started = performance.now();
    const service = await startLocalService(entry, ':memory:', () => { exits++; });
    try { return { url: service.connection.url, elapsedMs: performance.now() - started }; }
    finally {
      await service.stop();
      if (exits !== 1) throw new Error('The delayed service did not stop cleanly.');
    }
  }, slowService);
  assert.equal(delayed.url, 'http://127.0.0.1:1');
  assert.ok(delayed.elapsedMs >= 31_000);
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Local notes');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Local notes', exact: true }).waitFor();
  await createRecord('Local saved value');
  assert.equal(await localProcesses(), 1);

  const canvas = await page.locator('canvas').first().boundingBox();
  // Let controlled selection commit between the two physical clicks.
  await page.mouse.dblclick(canvas.x + 100, canvas.y + 58, { delay: 80 });
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Keep this draft');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByText('Save or discard your workspace edits before changing the connection.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();

  await settings(remoteUrl, 'incorrect'.repeat(8));
  await connect();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'valid access token' }).waitFor();
  assert.equal(await localProcesses(), 1);
  await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
  assert.equal((await page.evaluate(() => window.rowweave.connectionState())).mode, 'local');
  await page.getByLabel('Service URL', { exact: true }).fill(forbidden.url);
  await page.getByLabel('Access token', { exact: true }).fill(token);
  await connect();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'desktop origin' }).waitFor();
  await page.getByLabel('Service URL', { exact: true }).fill(remoteUrl);
  await application.evaluate(({ safeStorage }) => {
    globalThis.originalEncryptToken = safeStorage.encryptStringAsync;
    safeStorage.encryptStringAsync = async () => { throw new Error('Encryption unavailable for this check.'); };
  });
  await connect();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Encryption unavailable' }).waitFor();
  assert.equal((await page.evaluate(() => window.rowweave.connectionState())).mode, 'local');
  assert.equal(await localProcesses(), 1);
  await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
  await application.evaluate(({ safeStorage }) => { safeStorage.encryptStringAsync = globalThis.originalEncryptToken; });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings();
  await page.screenshot({ path: '.artifacts/desktop-connection-settings.png' });
  await connect();
  await page.getByRole('heading', { name: 'Shared projects', exact: true }).waitFor();
  assert.equal(await localProcesses(), 0);
  const saved = await readFile(settingsPath, 'utf8');
  assert.equal(JSON.parse(saved).mode, 'remote');
  assert.ok(JSON.parse(saved).encryptedToken.length > 0 && !saved.includes(token));
  await createRecord('Saved through the remote desktop 🌱');
  assert.equal(service.queryRecords(table.id, {}).records[0].values[table.primaryFieldId], 'Saved through the remote desktop 🌱');
  const blocked = await page.evaluate(async url => {
    try { await fetch(url + '/tables'); return false; } catch { return true; }
  }, forbidden.url);
  assert.equal(blocked, true);
  await page.screenshot({ path: '.artifacts/desktop-remote-workspace.png' });
  await application.close();
  application = undefined;
  assert.equal((await fetch(remoteUrl + '/tables', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  await launch('Shared projects');
  assert.equal(await localProcesses(), 0);
  assert.equal((await page.evaluate(() => window.rowweave.connection())).url, remoteUrl);
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();

  await stopRemote();
  await settings();
  await connect();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Could not reach this service' }).waitFor();
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  assert.equal((await page.evaluate(() => window.rowweave.connectionState())).mode, 'remote');
  assert.equal(await localProcesses(), 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const remoteCanvas = await page.locator('canvas').first().boundingBox();
  await page.mouse.dblclick(remoteCanvas.x + 100, remoteCanvas.y + 58, { delay: 80 });
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Retained during outage');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  assert.equal(service.queryRecords(table.id, {}).records[0].values[table.primaryFieldId], 'Saved through the remote desktop 🌱');
  remote = await startServer({ service, token, port: remotePort });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(service.queryRecords(table.id, {}).records[0].values[table.primaryFieldId], 'Retained during outage');

  await application.close();
  application = undefined;
  await stopRemote();
  await launch('Opening your workspace…');
  await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor();
  assert.equal(await localProcesses(), 0);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  remote = await startServer({ service, token, port: remotePort });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('heading', { name: 'Shared projects', exact: true }).waitFor();

  await settings();
  await page.getByLabel('Workspace', { exact: true }).selectOption('local');
  await connect();
  await page.getByRole('heading', { name: 'Local notes', exact: true }).waitFor();
  assert.equal(await localProcesses(), 1);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { format: 1, mode: 'local' });
  const localRows = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}` };
    const [table] = await fetch(connection.url + '/tables', { headers }).then(response => response.json());
    return fetch(`${connection.url}/tables/${table.id}/records`, { headers }).then(response => response.json());
  });
  assert.ok(Object.values(localRows.records[0].values).includes('Keep this draft'));
  assert.equal(service.queryRecords(table.id, {}).total, 1);
  for (const contents of ['{broken', JSON.stringify({ ...JSON.parse(saved), encryptedToken: Buffer.from('invalid encrypted data').toString('base64') })]) {
    await application.close();
    application = undefined;
    await writeFile(settingsPath, contents);
    await launch('Open your workspace');
    await page.getByRole('alert').filter({ hasText: 'Could not open the saved workspace connection' }).waitFor();
    assert.equal(await localProcesses(), 0);
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await connect();
    await page.getByRole('heading', { name: 'Local notes', exact: true }).waitFor();
    assert.equal(await localProcesses(), 1);
  }
  assert.deepEqual(errors, []);
  console.log('Desktop connection workflow passed.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.artifacts/desktop-connections-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(0, 3000));
  }
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await application.close();
  }
  await forbidden.close();
  if (remote) await remote.close();
  store.close();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rowweave-connections-')) throw new Error('Unexpected cleanup path.');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
