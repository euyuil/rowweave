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
  await page.screenshot({ path: '.artifacts/desktop-harness-workspace.png' });
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
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.open = window.originalUrlOpener; delete window.originalUrlOpener; delete window.openedUrls; });
  assert.equal(await page.evaluate(value => document.body.innerText.includes(value) || Object.values(localStorage).some(item => item.includes(value)), token), false);
  await page.evaluate(() => window.harnessTest.redeclare());
  assert.deepEqual(await page.evaluate(() => window.harnessTest.inspect()), { main: ['conversation', 'rowweave'], sidebar: ['rowweave'], active: null });
  await page.evaluate(() => window.harnessTest.unload());
  assert.deepEqual(await page.evaluate(() => window.harnessTest.inspect()), { main: ['conversation'], sidebar: [], active: null });
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
