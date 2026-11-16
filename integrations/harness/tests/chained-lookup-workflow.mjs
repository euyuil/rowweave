import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyHarnessChainedLookups(page, application, service, directory) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Harness chained records');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness chained records', exact: true }).waitFor();
  const table = service.listTables().find(table => table.name === 'Harness chained records');
  const add = input => service.createField(table.id, { ...input, expectedVersion: service.getTable(table.id).version }).fields.at(-1);
  const amount = add({ name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD' });
  const files = add({ name: 'Files', type: 'attachment' });
  const link = add({ name: 'Related', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const first = add({ name: 'First amounts', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: amount.id } });
  const firstFiles = add({ name: 'First files', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: files.id } });
  const bytes = Buffer.from('Nested Harness file\n中文 🌱');
  const file = service.uploadAttachment(table.id, { filename: 'nested-harness.txt', mediaType: 'text/plain', data: bytes.toString('base64') });
  const leaf = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Item', [amount.id]: 8.5, [files.id]: [file.id] } }]).records[0];
  const middle = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Collection', [link.id]: [leaf.id] } }]).records[0];
  const root = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Portfolio', [link.id]: [middle.id] } }]).records[0];
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('3 records · 6 fields', { exact: true }).waitFor();
  const manage = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  for (const [name, target, operation] of [['Nested total', first, 'sum'], ['Nested files', firstFiles, 'values']]) {
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await manage.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).fill(name);
    await page.getByLabel('Field type', { exact: true }).selectOption('lookup');
    await page.getByLabel('Lookup operation', { exact: true }).selectOption(operation);
    await page.getByLabel('Look up field', { exact: true }).selectOption(target.id);
    await page.getByRole('button', { name: 'Save field', exact: true }).click();
    await manage.waitFor(); await manage.getByRole('button', { name: 'Done', exact: true }).click();
  }
  const fields = service.getTable(table.id).fields;
  const total = fields.find(field => field.name === 'Nested total');
  assert.equal(service.getRecord(table.id, root.id).values[total.id], 8.5);
  service.createView(table.id, { name: 'Portfolio only', query: { filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'eq', value: 'Portfolio' }] } } });
  await page.getByRole('tab', { name: 'Portfolio only', exact: true }).click();
  await page.getByText('1 record · 8 fields', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const canvas = page.locator('canvas').first(); await canvas.waitFor({ state: 'visible' });
  const bounds = await canvas.boundingBox(); await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  const panel = page.getByRole('dialog');
  assert.equal(await panel.getByLabel('Nested total', { exact: true }).textContent(), '$8.50');
  const destination = join(directory, 'chained-lookup.txt');
  const downloaded = application.evaluate(({ session }, path) => new Promise(resolveDownload => {
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path); item.once('done', (_event, state) => resolveDownload({ state, filename: item.getFilename() }));
    });
  }), destination);
  await panel.getByRole('button', { name: 'Download nested-harness.txt', exact: true }).click();
  assert.deepEqual(await downloaded, { state: 'completed', filename: 'nested-harness.txt' });
  assert.deepEqual(await readFile(destination), bytes);
  await panel.getByLabel('Nested total', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.artifacts/desktop-harness-chained-lookups.png' });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.dvn-scroller').evaluate(element => { element.scrollLeft = element.scrollWidth; });
  service.updateBatch([{ id: leaf.id, expectedVersion: leaf.version, values: { [amount.id]: 12.5 } }], table.id);
  await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="7"]')?.textContent === '12.5');
  assert.equal(service.getRecord(table.id, root.id).values[total.id], 12.5);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('Installed Harness chained lookup configuration, numeric summaries, attachment downloads and external refresh passed.');
}
