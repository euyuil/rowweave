import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function verifyAttachmentWorkflow(page, application) {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-attachment-ui-')), destination = join(directory, 'download.bin');
  const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
  const dialog = page.getByRole('dialog');
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, input });
  await application.evaluate(({ dialog }, path) => {
    globalThis.originalAttachmentSaveDialog = dialog.showSaveDialog;
    globalThis.attachmentDialogs = [];
    dialog.showSaveDialog = async (_, options) => { globalThis.attachmentDialogs.push(options); return { canceled: false, filePath: path }; };
  }, destination);
  try {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill('File workflow');
    await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name: 'File workflow', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).fill('Documents');
    await page.getByLabel('Field type', { exact: true }).selectOption('attachment');
    assert.equal(await dialog.getByLabel('Use a default for new records', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: '+ New record', exact: true }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Release files');
    let guarded = false;
    let guardError;
    const route = async route => {
      try {
        await page.waitForFunction(() => document.querySelector('dialog form .dialog-actions button.primary')?.disabled &&
          [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Cancel')?.disabled, undefined, { timeout: 5000 });
        guarded = true;
      } catch (error) { guardError = error; }
      finally { await route.continue(); }
    };
    await page.route('**/tables/*/attachments', route);
    await dialog.getByLabel('Documents', { exact: true }).setInputFiles({ name: '设计.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await dialog.getByText('Uploaded. Save the record to attach these files.', { exact: true }).waitFor();
    assert.equal(guardError, undefined);
    assert.equal(guarded, true);
    await page.unroute('**/tables/*/attachments', route);
    await dialog.getByRole('button', { name: 'Download 设计.bin', exact: true }).click();
    await dialog.getByText('File saved.', { exact: true }).waitFor();
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await application.evaluate(() => globalThis.attachmentDialogs.map(item => [item.title, item.defaultPath])), [['Download file', '设计.bin']]);
    await page.screenshot({ path: '.artifacts/desktop-attachments-form.png' });
    await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); await ready();
    let table = (await call('/tables')).find(table => table.name === 'File workflow');
    const field = table.fields[1].id;
    const record = (await call(`/tables/${table.id}/query`, 'POST', {})).records[0];
    const id = record.values[field][0];
    assert.equal(record.attachments[field][0].filename, '设计.bin');
    await page.locator('.dvn-scroller').click({ position: { x: 280, y: 58 } });
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.keyboard.press('Control+c');
    await page.waitForFunction(async id => await navigator.clipboard.readText() === JSON.stringify([id]), id);
    await page.keyboard.press('Enter');
    const editor = page.locator('.rowweave-cell-editor');
    await editor.getByRole('button', { name: 'Remove 设计.bin', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.deepEqual((await call(`/tables/${table.id}/records/${record.id}`)).values[field], [id]);
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.keyboard.press('Enter');
    await editor.getByLabel('Cell value', { exact: true }).setInputFiles({ name: 'grid-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
    await editor.getByText('Uploaded. Save the record to attach these files.', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByText('All changes saved', { exact: true }).waitFor();
    const draftFile = (await call(`/tables/${table.id}/attachments/query`, 'POST', {})).attachments.find(file => file.filename === 'grid-draft.txt');
    await call(`/tables/${table.id}/attachments/${draftFile.id}`, 'DELETE');
    assert.deepEqual((await call(`/tables/${table.id}/records/${record.id}`)).values[field], [id]);
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove 设计.bin', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); await ready();
    assert.deepEqual((await call(`/tables/${table.id}/records/${record.id}`)).values[field], []);
    await page.locator('.dvn-scroller').click({ position: { x: 100, y: 58 } });
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await editor.getByRole('button', { name: 'Choose uploaded files', exact: true }).click();
    await editor.getByRole('checkbox', { name: /^设计\.bin/ }).check();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('All changes saved', { exact: true }).waitFor();
    assert.deepEqual((await call(`/tables/${table.id}/records/${record.id}`)).values[field], [id]);
    await page.screenshot({ path: '.artifacts/desktop-attachments-grid.png' });
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add condition to group 1', exact: true }).click();
    await dialog.getByLabel('Filter field', { exact: true }).selectOption(field);
    await dialog.getByLabel('Filter operator', { exact: true }).selectOption('hasAny');
    assert.equal(await dialog.locator('input[type="file"]').count(), 0);
    await dialog.getByRole('button', { name: 'Choose uploaded files', exact: true }).click();
    await dialog.getByRole('checkbox', { name: /^设计\.bin/ }).check();
    await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); await ready();
    assert.equal((await call(`/tables/${table.id}/views`))[0].query.filter.conditions[0].value[0], id);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); await ready();
    const more = [];
    for (let index = 0; index < 20; index++) more.push(await call(`/tables/${table.id}/attachments`, 'POST', { filename: `extra-${index}.txt`, mediaType: 'text/plain', data: 'eA==' }));
    const other = (await call(`/tables/${table.id}/records`, 'POST', [{ values: { [field]: more.map(file => file.id) } }])).records[0];
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Related', type: 'relation', relation: { tableId: table.id, multiple: true } });
    const relation = table.fields.at(-1).id;
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Related files', type: 'lookup', lookup: { relationFieldId: relation, fieldId: field } });
    const current = await call(`/tables/${table.id}/records/${record.id}`);
    await call(`/tables/${table.id}/records`, 'PATCH', [{ id: record.id, expectedVersion: current.version, values: { [relation]: [record.id, other.id] } }]);
    await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
    await page.getByText('2 records · 4 fields', { exact: true }).waitFor();
    await page.locator('.dvn-scroller').click({ position: { x: 100, y: 58 } });
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    const lookup = dialog.getByLabel('Related files', { exact: true });
    await lookup.getByRole('button', { name: 'Download 设计.bin', exact: true }).waitFor();
    assert.equal(await lookup.getByRole('button', { name: /^Download / }).count(), 20);
    assert.equal(await lookup.getByRole('button', { name: /^Remove / }).count(), 0);
    await lookup.getByRole('button', { name: 'Next attachments', exact: true }).click();
    await lookup.getByRole('button', { name: 'Download extra-19.txt', exact: true }).waitFor();
    assert.equal(await lookup.getByRole('button', { name: /^Download / }).count(), 1);
    await lookup.getByText('21–21 of 21 files', { exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/desktop-attachments-lookup.png' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete table', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  } finally {
    await application.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.originalAttachmentSaveDialog; delete globalThis.originalAttachmentSaveDialog; delete globalThis.attachmentDialogs; });
    await rm(directory, { recursive: true, force: true });
  }
}
