import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import extract from '@electron-internal/extract-zip';

const dataDirectory = await mkdtemp(join(tmpdir(), 'rowweave-workspace-'));
await mkdir('.artifacts', { recursive: true });
let executablePath = electronPath;
let application;
let page;
const errors = [];
const packaged = process.argv.includes('--packaged');
async function launch() {
  application = await electron.launch({ executablePath, args: packaged ? [] : ['.'],
    cwd: packaged ? dataDirectory : process.cwd(),
    env: { ...process.env, ROWWEAVE_DATA_DIR: dataDirectory, ROWWEAVE_HEADLESS: '1' }, timeout: 40_000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Make room for your ideas' }).waitFor();
}
async function tables() {
  return page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    return fetch(`${connection.url}/tables`, { headers: { Authorization: `Bearer ${connection.token}` } }).then(r => r.json());
  });
}
async function create(name) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByText('0 records · 1 field', { exact: true }).waitFor();
}
async function choose(name) {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
}
try {
  if (packaged) {
    const manifest = JSON.parse(await readFile('release/latest.json', 'utf8'));
    const directory = join(dataDirectory, 'application');
    await mkdir(directory);
    await extract(manifest.zip, { dir: directory });
    executablePath = join(directory, 'RowWeave-win32-x64', 'RowWeave.exe');
  }
  await launch();
  assert.deepEqual(await tables(), []);
  await page.screenshot({ path: '.artifacts/desktop-empty-workspace.png' });
  await create('Projects');
  const original = (await tables())[0];
  await page.getByRole('button', { name: 'Rename table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Projects 项目');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename table', exact: true }).click();
  await page.getByRole('heading', { name: 'Projects 项目', exact: true }).waitFor();
  assert.equal((await tables())[0].id, original.id);
  await create('Tasks');
  await choose('Projects 项目');
  await page.getByRole('heading', { name: 'Projects 项目', exact: true }).waitFor();
  await page.evaluate(async table => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${table.id}/records`, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ values: { [table.primaryFieldId]: 'Launch the workspace' } }]),
    });
    if (!response.ok) throw new Error('Could not prepare the navigation fixture.');
  }, original);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('1 record · 1 field', { exact: true }).waitFor();
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Cell value' }).fill('Keep this draft');
  await page.keyboard.press('Enter');
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await choose('Tasks');
  await page.getByRole('heading', { name: 'Projects 项目', exact: true }).waitFor();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await choose('Tasks');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await choose('Projects 项目');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-workspace.png' });

  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Unsaved table');
  await application.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    BrowserWindow.getAllWindows()[0].close();
  });
  assert.equal(page.isClosed(), false);
  assert.equal(await page.getByLabel('Table name', { exact: true }).inputValue(), 'Unsaved table');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await tables()).length, 2);
  await application.close();
  application = undefined;
  application = await electron.launch({ executablePath, args: packaged ? [] : ['.'],
    cwd: packaged ? dataDirectory : process.cwd(),
    env: { ...process.env, ROWWEAVE_DATA_DIR: dataDirectory, ROWWEAVE_HEADLESS: '1' }, timeout: 40_000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await choose('Projects 项目');
  await page.getByRole('heading', { name: 'Projects 项目', exact: true }).waitFor();
  assert.equal((await tables()).find(table => table.id === original.id).name, 'Projects 项目');
  for (const name of ['Projects 项目', 'Tasks']) {
    await choose(name);
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await page.getByRole('heading', { name: 'Make room for your ideas' }).waitFor();
  assert.deepEqual(await tables(), []);
  await application.close();
  application = undefined;
  await launch();
  assert.deepEqual(await tables(), []);
  assert.deepEqual(errors, []);
  console.log('Workspace lifecycle passed: fresh empty workspace, create/rename/switch, draft and form guards, deletion confirmation, and restart persistence.');
} catch (error) {
  console.error('Renderer errors:', errors);
  if (page && !page.isClosed()) await page.screenshot({ path: '.artifacts/desktop-workspace-failure.png' });
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await application.close();
  }
  assert.equal(dirname(resolve(dataDirectory)), resolve(tmpdir()));
  assert.ok(basename(dataDirectory).startsWith('rowweave-workspace-'));
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
