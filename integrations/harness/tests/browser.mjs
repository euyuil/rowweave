import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SqliteRecordStore } from '../../../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../../../dist/packages/core/src/record-service.js';
import { startServer } from '../../../dist/apps/server/src/http-server.js';
import { verifyCrossInterfaceWorkflow } from '../../../tests/cross-interface.mjs';

const runFile = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'rowweave-harness-'));
const fixtureDirectory = resolve('.artifacts/harness-fixture');
await mkdir(fixtureDirectory, { recursive: true });
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run npm run test:harness.');
let application;
let serviceServer;
let web;
let store;
try {
  const cache = join(directory, 'cache');
  const packed = await runFile(process.execPath, [npm, 'pack', resolve('integrations/harness'), '--ignore-scripts', '--offline', '--json', '--pack-destination', directory, '--cache', cache]);
  const [archive] = JSON.parse(packed.stdout);
  assert.ok(archive.files.some(file => file.path === 'lib/client.js'));
  assert.ok(archive.files.some(file => file.path === 'lib/THIRD-PARTY-NOTICES.txt'));
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true}');
  await runFile(process.execPath, [npm, 'install', join(directory, archive.filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache], { cwd: consumer });
  const installed = join(consumer, 'node_modules/@rowweave/harness');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.engines.dsh, '0.2.2-rc.2');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.match(await readFile(join(installed, 'cordis.patch.yml'), 'utf8'), /name: '@rowweave\/harness'/);
  await runFile(process.execPath, ['--input-type=module', '-e', "const plugin = await import('@rowweave/harness'); plugin.apply();"], { cwd: consumer });
  await build({ entryPoints: ['integrations/harness/tests/fixture.jsx'], outfile: join(fixtureDirectory, 'seed.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' } });
  const routes = new Map([
    ['/seed.js', join(fixtureDirectory, 'seed.js')], ['/rowweave.js', join(installed, 'lib/client.js')],
    ['/modules.js', resolve('node_modules/@deepseek-ai/dsh-client-modules/lib/client.js')],
    ['/renderer.js', resolve('node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js')],
    ['/layout.js', resolve('node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js')],
  ]);
  web = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><body style="margin:0"><div id="root"></div>
        <script>window.__ModuleLoader__={mode:'queue',pendingQueue:[],load(entry){this.pendingQueue.push(entry)}};</script>
        <script src="/modules.js"></script><script type="module" src="/seed.js"></script></body></html>`);
    } else if (routes.has(path)) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(routes.get(path)));
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolveListen => web.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${web.address().port}`;
  store = new SqliteRecordStore(join(directory, 'workspace.sqlite'));
  const service = new RecordService(store);
  const token = randomBytes(32).toString('hex');
  serviceServer = await startServer({ service, token, allowedOrigins: [origin, 'null'] });
  await writeFile(join(fixtureDirectory, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.ROWWEAVE_TEST_PROFILE);
app.whenReady().then(() => { const window = new BrowserWindow({ width:1280,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true,offscreen:true} }); window.loadURL(process.env.ROWWEAVE_TEST_URL); });
app.on('window-all-closed', () => app.quit());`);
  application = await electron.launch({ executablePath: electronPath, args: [join(fixtureDirectory, 'main.cjs')],
    env: { ...process.env, ROWWEAVE_TEST_PROFILE: join(directory, 'profile'), ROWWEAVE_TEST_URL: origin }, timeout: 40_000 });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => window.harnessReady);
  assert.deepEqual(await page.evaluate(() => window.harnessTest.inspect()), { main: ['conversation', 'rowweave'], sidebar: ['rowweave'], active: null });
  await page.getByRole('navigation', { name: 'Harness panels' }).getByRole('button', { name: 'RowWeave', exact: true }).click();
  await page.getByLabel('Service URL', { exact: true }).fill(serviceServer.url);
  await page.getByLabel('Service token', { exact: true }).fill('wrong'.repeat(8));
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not connect' }).waitFor();
  await page.getByLabel('Service token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Make room for your ideas' }).waitFor();
  await page.getByRole('button', { name: 'Calculations', exact: true }).click();
  const calculations = page.getByRole('dialog', { name: 'Calculations', exact: true });
  await calculations.getByText('Manual updates on this service', { exact: true }).waitFor();
  await calculations.getByRole('button', { name: 'Update calculations', exact: true }).click();
  await calculations.getByRole('status').filter({ hasText: 'Calculations updated' }).waitFor();
  await calculations.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Harness projects');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness projects', exact: true }).waitFor();
  assert.equal(service.listTables().length, 1);
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Budget');
  await page.getByLabel('Field type', { exact: true }).selectOption('number');
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Original');
  await page.getByLabel('Budget', { exact: true }).fill('12.5');
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const [table] = service.listTables();
  const nameId = table.primaryFieldId;
  const budgetId = table.fields.find(field => field.name === 'Budget').id;
  const records = () => service.queryRecords(table.id, { offset: 0, limit: 10 }).records;
  assert.equal(records()[0].values[budgetId], 12.5);
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value', exact: true }).fill('Unsaved 汉字');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), true);
  const blockedNavigation = new Promise(resolveDialog => page.once('dialog', async dialog => {
    assert.equal(dialog.type(), 'alert');
    assert.match(dialog.message(), /Save or discard/);
    await dialog.accept();
    resolveDialog();
  }));
  await page.getByRole('navigation').getByRole('button', { name: 'Conversation', exact: true }).click();
  await blockedNavigation;
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.harnessTest.inspect().active), 'rowweave');
  assert.equal(records()[0].values[nameId], 'Original');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.equal(records()[0].values[nameId], 'Unsaved 汉字');
  await page.getByRole('navigation').getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness conversation', exact: true }).waitFor();
  await page.getByRole('navigation').getByRole('button', { name: 'RowWeave', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness projects', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'import.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Name,Budget\r\n"导入,项目",23.75\r\n') });
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  await page.getByRole('button', { name: 'Import 1 record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(records().length, 2);
  assert.equal(records()[1].values[nameId], '导入,项目');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const downloaded = join(directory, 'download.csv');
  const downloadPending = application.evaluate(({ session }, path) => new Promise(resolveDownload => {
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path);
      item.once('done', (_event, state) => resolveDownload({ state, filename: item.getFilename() }));
    });
  }), downloaded);
  await page.getByRole('button', { name: 'Save CSV', exact: true }).click();
  assert.deepEqual(await downloadPending, { state: 'completed', filename: 'Harness projects-All records.csv' });
  assert.equal(await readFile(downloaded, 'utf8'), '\ufeffName,Budget\r\nUnsaved 汉字,12.5\r\n"导入,项目",23.75\r\n');
  await page.getByText('CSV download started. Check your browser downloads for the file.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByLabel('Service token', { exact: true }).fill('incorrect'.repeat(8));
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not connect' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('2 records · 2 fields', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const hostDraft = page.getByRole('textbox', { name: 'Harness draft', exact: true });
  let catalogChecks = 0;
  page.on('request', request => {
    if (request.url().endsWith('/workspace/state') && Object.keys(request.postDataJSON()).length === 0) catalogChecks++;
  });
  await hostDraft.fill('Host draft 中文');
  for (const value of [17.25, 12.5]) {
    const current = records()[0];
    service.updateBatch([{ id: current.id, expectedVersion: current.version, values: { [budgetId]: value } }], table.id);
    await page.waitForFunction(value => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="2"]')?.textContent === String(value), value, { polling: 100 });
    assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
    assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  }
  let catalogTable = service.createTable({ name: 'Harness external table' });
  const tableNavigation = page.getByRole('navigation', { name: 'Tables', exact: true });
  await tableNavigation.getByRole('button', { name: catalogTable.name, exact: true }).waitFor();
  catalogTable = service.updateTable(catalogTable.id, { name: 'Harness renamed table', expectedVersion: catalogTable.version });
  await tableNavigation.getByRole('button', { name: catalogTable.name, exact: true }).waitFor();
  service.deleteTable(catalogTable.id, { expectedVersion: catalogTable.version });
  await tableNavigation.getByRole('button', { name: catalogTable.name, exact: true }).waitFor({ state: 'detached' });
  assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: '.artifacts/desktop-harness-workspace.png' });
  let groupedTable = service.getTable(table.id);
  groupedTable = service.createField(table.id, { expectedVersion: groupedTable.version, name: 'Done', type: 'checkbox' });
  const done = groupedTable.fields.at(-1).id;
  service.updateBatch(records().map((record, index) => ({ id: record.id, expectedVersion: record.version, values: { [done]: index === 1 } })), table.id);
  const groupedView = service.listViews(table.id)[0];
  service.updateView(table.id, groupedView.id, { expectedVersion: groupedView.version, groupBy: done });
  await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === '▾ Unchecked · 1 record', undefined, { polling: 100 });
  const moved = records()[0];
  service.updateBatch([{ id: moved.id, expectedVersion: moved.version, values: { [done]: true } }], table.id);
  await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === '▾ Unchecked · 0 records' &&
    document.querySelector('canvas [aria-rowindex="3"] [role="gridcell"][aria-colindex="1"]')?.textContent === '▾ Checked · 2 records', undefined, { polling: 100 });
  assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: '.artifacts/desktop-harness-group-refresh.png' });
  let currentGroupedView = service.listViews(table.id)[0];
  currentGroupedView = service.updateView(table.id, currentGroupedView.id, { expectedVersion: currentGroupedView.version, groupBy: budgetId });
  const budget = records()[0].values[budgetId];
  await page.waitForFunction(value => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent ===
    '▾ ' + value + ' · 1 record', String(budget), { polling: 100 });
  assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: '.artifacts/desktop-harness-scalar-groups.png' });
  currentGroupedView = service.updateView(table.id, currentGroupedView.id, { expectedVersion: currentGroupedView.version,
    groupMeasures: [{ fieldId: budgetId, operation: 'sum' }] });
  const measureHeading = '▾ ' + String(budget) + ' · 1 record · Sum ' + groupedTable.fields.find(field => field.id === budgetId).name + ': ' +
    budget.toLocaleString(undefined, { maximumSignificantDigits: 15 });
  await page.waitForFunction(text => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="1"]')?.textContent === text,
    measureHeading, { polling: 100 });
  assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: '.artifacts/desktop-harness-group-measures.png' });
  service.updateView(table.id, currentGroupedView.id, { expectedVersion: currentGroupedView.version, groupBy: null });
  service.deleteField(table.id, done, { expectedVersion: groupedTable.version });
  await page.getByRole('button', { name: 'Collapse all', exact: true }).waitFor({ state: 'detached' });
  let boardTable = service.getTable(table.id);
  boardTable = service.createField(table.id, { expectedVersion: boardTable.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }] });
  const status = boardTable.fields.at(-1).id;
  service.updateBatch(records().map((record, index) => ({ id: record.id, expectedVersion: record.version, values: { [status]: index ? 'second' : 'first' } })), table.id);
  const beforeBoard = service.listViews(table.id)[0];
  service.updateView(table.id, beforeBoard.id, { expectedVersion: beforeBoard.version, type: 'board', groupBy: status });
  const firstLane = page.getByRole('region', { name: 'First column', exact: true });
  const secondLane = page.getByRole('region', { name: 'Second column', exact: true });
  await firstLane.getByRole('button', { name: 'Unsaved 汉字', exact: true }).waitFor();
  const boardMoved = records()[0];
  service.updateBatch([{ id: boardMoved.id, expectedVersion: boardMoved.version, values: { [status]: 'second' } }], table.id);
  await secondLane.getByRole('button', { name: 'Unsaved 汉字', exact: true }).waitFor();
  await secondLane.getByLabel('2 records', { exact: true }).waitFor();
  assert.equal(await hostDraft.inputValue(), 'Host draft 中文');
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: '.artifacts/desktop-harness-board-refresh.png' });
  const currentBoard = service.listViews(table.id)[0];
  service.updateView(table.id, currentBoard.id, { expectedVersion: currentBoard.version, type: 'grid', groupBy: null });
  service.deleteField(table.id, status, { expectedVersion: boardTable.version });
  await page.getByRole('region', { name: 'First column', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await hostDraft.evaluate(element => element === document.activeElement), true);
  await verifyCrossInterfaceWorkflow({ url: serviceServer.url, token }, page, table.id, process.argv.includes('--packaged'));
  await page.evaluate(() => {
    window.originalUrlOpener = window.open;
    window.openedUrls = [];
    window.open = (...args) => { window.openedUrls.push(args); return null; };
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Harness links');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness links', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Website');
  await page.getByLabel('Field type', { exact: true }).selectOption('url');
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Website', { exact: true }).fill('javascript:alert(1)');
  assert.equal(await page.getByRole('button', { name: 'Open link ↗', exact: true }).count(), 0);
  const url = 'https://例子.测试/文档';
  await page.getByLabel('Website', { exact: true }).fill(url);
  assert.deepEqual(await page.evaluate(() => window.openedUrls), []);
  await page.getByRole('button', { name: 'Open link ↗', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.openedUrls), [[new URL(url).href, '_blank', 'noopener,noreferrer']]);
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const links = service.listTables().find(table => table.name === 'Harness links');
  assert.equal(service.queryRecords(links.id, {}).records[0].values[links.fields[1].id], url);
  assert.equal(await page.evaluate(() => window.openedUrls.length), 1);
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Files');
  await page.getByLabel('Field type', { exact: true }).selectOption('attachment');
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Attached file');
  const fileBytes = Buffer.from([0, 255, 13, 10, 128]);
  await page.getByLabel('Files', { exact: true }).setInputFiles({ name: 'harness-file.bin', mimeType: 'application/octet-stream', buffer: fileBytes });
  await page.getByText('Uploaded. Save the record to attach these files.', { exact: true }).waitFor();
  const fileDestination = join(directory, 'harness-file.bin');
  const fileDownload = application.evaluate(({ session }, path) => new Promise(resolveDownload => {
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path); item.once('done', (_event, state) => resolveDownload({ state, filename: item.getFilename() }));
    });
  }), fileDestination);
  await page.getByRole('button', { name: 'Download harness-file.bin', exact: true }).click();
  assert.deepEqual(await fileDownload, { state: 'completed', filename: 'harness-file.bin' });
  assert.deepEqual(await readFile(fileDestination), fileBytes);
  await page.getByText('Download started.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const fileField = service.getTable(links.id).fields.find(field => field.type === 'attachment');
  const attached = service.queryRecords(links.id, { search: 'Attached file' }).records[0];
  assert.equal(attached.attachments[fileField.id][0].filename, 'harness-file.bin');
  assert.deepEqual(Buffer.from(service.downloadAttachment(links.id, attached.values[fileField.id][0]).bytes), fileBytes);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.open = window.originalUrlOpener; delete window.originalUrlOpener; delete window.openedUrls; });
  assert.equal(await page.evaluate(value => document.body.innerText.includes(value) || Object.values(localStorage).some(item => item.includes(value)), token), false);
  await page.evaluate(() => window.harnessTest.redeclare());
  assert.deepEqual(await page.evaluate(() => window.harnessTest.inspect()), { main: ['conversation', 'rowweave'], sidebar: ['rowweave'], active: null });
  await page.evaluate(() => window.harnessTest.unload());
  assert.deepEqual(await page.evaluate(() => window.harnessTest.inspect()), { main: ['conversation'], sidebar: [], active: null });
  const stoppedChecks = catalogChecks;
  await page.waitForTimeout(2_500);
  assert.equal(catalogChecks, stoppedChecks, 'Unloading the workspace must stop catalog polling.');
  assert.equal(await page.locator('#portal').count(), 0);
  assert.equal(await page.locator('style[data-plugin="@rowweave/harness"]').count(), 0);
  await page.evaluate(() => {
    const portal = document.createElement('div');
    portal.id = 'portal';
    portal.dataset.owner = 'host';
    document.body.appendChild(portal);
    return window.harnessTest.reload();
  });
  await page.getByRole('navigation').getByRole('button', { name: 'RowWeave', exact: true }).click();
  await page.getByRole('heading', { name: 'Connect your RowWeave workspace', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Service token', { exact: true }).inputValue(), '');
  await page.evaluate(() => window.harnessTest.unload());
  assert.equal(await page.locator('#portal').getAttribute('data-owner'), 'host');
  assert.deepEqual(errors, []);
  console.log('Harness archive installation, official module/slot lifecycle, typed editing, draft navigation guard, CSV import and download passed.');
} catch (error) {
  if (application) {
    const page = await application.firstWindow();
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: '.artifacts/desktop-harness-failure.png' });
  }
  console.error(error);
  throw error;
} finally {
  if (application) {
    const exited = once(application.process(), 'exit');
    await application.evaluate(({ app }) => app.exit());
    await exited;
  }
  await serviceServer?.close();
  store?.close();
  if (web) await new Promise(resolveClose => web.close(resolveClose));
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
