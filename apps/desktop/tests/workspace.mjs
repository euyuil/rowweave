import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import extract from '@electron-internal/extract-zip';
import { verifySchemaWorkflow } from './schema-workflow.mjs';
import { verifyViewWorkflow } from './view-workflow.mjs';
import { verifyQueryWorkflow } from './query-workflow.mjs';
import { verifyGridWorkflow } from './grid-workflow.mjs';
import { verifyRelationWorkflow } from './relation-workflow.mjs';
import { verifyReciprocalWorkflow } from './reciprocal-workflow.mjs';
import { verifyLookupWorkflow } from './lookup-workflow.mjs';
import { verifyCsvWorkflow } from './csv-workflow.mjs';
import { verifySummaryWorkflow } from './summary-workflow.mjs';
import { verifyColumnWorkflow } from './column-workflow.mjs';
import { verifyDisplayWorkflow } from './display-workflow.mjs';
import { verifyBoardWorkflow } from './board-workflow.mjs';
import { verifyFormulaWorkflow } from './formula-workflow.mjs';
import { verifyDateFormulaWorkflow } from './date-formula-workflow.mjs';
import { verifyArrayFormulaWorkflow } from './array-formula-workflow.mjs';
import { verifyConnectedFormulaWorkflow } from './connected-formula-workflow.mjs';
import { verifyGroupedWorkflow } from './grouped-workflow.mjs';
import { verifyRelativeDateWorkflow } from './relative-date-workflow.mjs';
import { verifyNavigationWorkflow } from './navigation-workflow.mjs';
import { verifyRecordPanelWorkflow } from './record-panel-workflow.mjs';
import { verifyHistoryWorkflow } from './history-workflow.mjs';
import { verifyTrashWorkflow } from './trash-workflow.mjs';
import { verifyBatchHistoryWorkflow } from './batch-history-workflow.mjs';
import { verifyFieldPanelWorkflow } from './field-panel-workflow.mjs';
import { verifyUrlWorkflow } from './url-workflow.mjs';
import { verifyAutomaticNumberWorkflow } from './automatic-number-workflow.mjs';
import { verifyRecordTimesWorkflow } from './record-times-workflow.mjs';
import { verifySelectColorsWorkflow } from './select-colors-workflow.mjs';
import { verifyAttachmentWorkflow } from './attachment-workflow.mjs';

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
async function recordLifecycle() {
  const table = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    let table = (await fetch(`${connection.url}/tables`, { headers }).then(r => r.json())).find(table => table.name === 'Tasks');
    for (const field of [
      { name: 'Notes', type: 'multiline' }, { name: 'Cost', type: 'number', required: true, defaultValue: 0 },
      { name: 'Done', type: 'checkbox', required: true, defaultValue: false }, { name: 'Due', type: 'date' },
      { name: 'Time', type: 'datetime' },
      { name: 'Status', type: 'singleSelect', options: [{ name: 'In progress' }, { name: 'Complete' }] },
      { name: 'Tags', type: 'multiSelect', options: [{ name: '中文' }, { name: 'Review' }] },
    ]) {
      const response = await fetch(`${connection.url}/tables/${table.id}/fields`, {
        method: 'POST', headers, body: JSON.stringify({ ...field, expectedVersion: table.version }),
      });
      if (!response.ok) throw new Error('Could not prepare the typed record fixture.');
      table = await response.json();
    }
    return table;
  });
  const field = name => table.fields.find(field => field.name === name);
  const records = () => page.evaluate(async id => {
    const connection = await window.rowweave.connection();
    const result = await fetch(`${connection.url}/tables/${id}/records?offset=0&limit=10`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    }).then(r => r.json());
    return result.records;
  }, table.id);
  const externalChange = record => page.evaluate(async ({ id, record, fieldId }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}/tables/${id}/records`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: record.id, expectedVersion: record.version, values: { [fieldId]: 'External name' } }]),
    });
    if (!response.ok) throw new Error('Could not prepare the concurrent record update.');
  }, { id: table.id, record, fieldId: table.primaryFieldId });
  const reload = async () => {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Reload').disabled);
  };
  const selectAll = async () => {
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 15, bounds.y + 20);
    await page.getByText('2 selected', { exact: true }).waitFor();
  };
  const selectRow = async row => {
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 15, bounds.y + 58 + row * 36);
  };
  await choose('Tasks');
  await page.getByText('0 records · 8 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Ship the workspace 🌱');
  await page.getByLabel('Notes', { exact: true }).fill('Line one\n中文第二行');
  assert.equal(await page.getByLabel('Cost *', { exact: true }).inputValue(), '0');
  assert.equal(await page.getByLabel('Done *', { exact: true }).inputValue(), 'false');
  await page.getByLabel('Due', { exact: true }).fill('2026-11-30');
  await page.getByLabel('Time (UTC)', { exact: true }).fill('2026-11-12T09:30:45.123');
  await page.getByLabel('Status', { exact: true }).selectOption({ label: 'In progress' });
  await page.getByLabel('Tags', { exact: true }).selectOption([{ label: '中文' }, { label: 'Review' }]);
  await page.screenshot({ path: '.artifacts/desktop-record-form.png' });
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByText('1 record · 8 fields', { exact: true }).waitFor();
  const [created] = await records();
  assert.equal(created.values[field('Cost').id], 0);
  assert.equal(created.values[field('Done').id], false);
  assert.equal(created.values[field('Time').id], '2026-11-12T09:30:45.123Z');
  assert.deepEqual(created.values[field('Tags').id], field('Tags').options.map(option => option.id));
  await selectRow(0);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByText('Record identity', { exact: true }).click();
  await page.getByRole('dialog').getByText(created.id, { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), 'Line one\n中文第二行');
  await page.getByLabel('Cost *', { exact: true }).fill('not a number');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'decimal number' }).waitFor();
  assert.equal((await records())[0].values[field('Cost').id], 0);
  await page.getByLabel('Cost *', { exact: true }).fill('12.5');
  await page.getByRole('button', { name: 'Clear Notes', exact: true }).click();
  assert.equal(await page.getByLabel('Notes', { exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Control+s');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal((await records())[0].values[field('Notes').id], null);
  assert.equal((await records())[0].values[field('Cost').id], 12.5);
  await selectRow(0);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Copied task');
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByText('2 records · 8 fields', { exact: true }).waitFor();
  const copied = (await records())[1];
  assert.notEqual(copied.id, created.id);
  assert.deepEqual(copied.values[field('Tags').id], created.values[field('Tags').id]);
  await selectRow(0);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Keep conflict draft');
  await externalChange((await records())[0]);
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Keep conflict draft');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await reload();
  // Header checkbox selects both records; the delete preview retains their versions.
  await selectAll();
  await page.getByRole('button', { name: 'Delete records', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await records()).length, 2);
  await page.screenshot({ path: '.artifacts/desktop-records.png' });
  await page.getByRole('button', { name: 'Delete records', exact: true }).click();
  await externalChange((await records())[1]);
  await page.getByRole('dialog').getByText('You can recover them from Trash.', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete record', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'changed' }).waitFor();
  assert.equal((await records()).length, 2);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await reload();
  await selectAll();
  await page.getByRole('button', { name: 'Delete records', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete record', exact: true }).click();
  await page.getByText('0 records · 8 fields', { exact: true }).waitFor();
  assert.deepEqual(await records(), []);
}
try {
  if (packaged) {
    const manifest = JSON.parse(await readFile('release/latest.json', 'utf8'));
    const directory = join(dataDirectory, 'application');
    await mkdir(directory);
    await extract(manifest.zip, { dir: directory });
    assert.ok((await readdir(directory)).includes('rowweave-win32-x64'));
    assert.ok((await readdir(join(directory, 'rowweave-win32-x64'))).includes('rowweave.exe'));
    executablePath = join(directory, 'rowweave-win32-x64', 'rowweave.exe');
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
  await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
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
  await verifySchemaWorkflow(page);
  await recordLifecycle();
  await verifyRecordPanelWorkflow(page, application);
  await verifyHistoryWorkflow(page, application);
  await verifyTrashWorkflow(page, application);
  await verifyBatchHistoryWorkflow(page, application);
  await verifyViewWorkflow(page);
  await verifyNavigationWorkflow(page, application);
  await verifyQueryWorkflow(page, application);
  await verifyGridWorkflow(page);
  await verifyRelationWorkflow(page);
  await verifyReciprocalWorkflow(page, application);
  await verifyLookupWorkflow(page);
  await verifyCsvWorkflow(page, application, dataDirectory);
  await verifySummaryWorkflow(page);
  await verifyColumnWorkflow(page);
  await verifyFieldPanelWorkflow(page, application);
  await verifyUrlWorkflow(page, application);
  await verifyAutomaticNumberWorkflow(page, application);
  await verifyRecordTimesWorkflow(page);
  await verifySelectColorsWorkflow(page);
  await verifyAttachmentWorkflow(page, application);
  await verifyDisplayWorkflow(page);
  await verifyBoardWorkflow(page);
  await verifyFormulaWorkflow(page);
  await verifyDateFormulaWorkflow(page);
  await verifyArrayFormulaWorkflow(page);
  await verifyConnectedFormulaWorkflow(page);
  await verifyGroupedWorkflow(page, application);
  await verifyRelativeDateWorkflow(page, application);
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
  console.log('Workspace lifecycle passed: tables, typed records/grid editors, linked records/lookups, atomic clearing, schema configuration/conversion, views/queries, CSV import/export, conflicts, draft/form guards, confirmations, and persistence.');
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
