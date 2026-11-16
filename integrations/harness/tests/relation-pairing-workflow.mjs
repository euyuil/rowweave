import assert from 'node:assert/strict';

export async function verifyHarnessRelationPairing(page, service) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Harness paired records');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Harness paired records', exact: true }).waitFor();
  let table = service.listTables().find(table => table.name === 'Harness paired records');
  for (const name of ['Related', 'Reverse']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'relation', relation: { tableId: table.id, multiple: true } });
  const [forward, reverse] = table.fields.slice(1);
  const records = service.createRecords(table.id, ['First', 'Second'].map(name => ({ values: { [table.primaryFieldId]: name } }))).records;
  service.updateBatch([{ id: records[0].id, expectedVersion: records[0].version, values: { [forward.id]: [records[1].id] } }], table.id);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('2 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  await manage.getByRole('group', { name: 'Related', exact: true }).getByRole('button', { name: 'Pair existing field', exact: true }).click();
  const pair = page.getByRole('dialog', { name: 'Pair existing linked fields', exact: true });
  await pair.getByLabel('Existing reverse field', { exact: true }).selectOption(reverse.id);
  await page.screenshot({ path: '.artifacts/desktop-harness-relation-pair.png' });
  await pair.getByRole('button', { name: 'Pair fields', exact: true }).click();
  await pair.waitFor({ state: 'detached' });
  assert.equal(service.getTable(table.id).fields.find(field => field.id === forward.id).relation.inverseFieldId, reverse.id);
  assert.deepEqual(service.getRecord(table.id, records[1].id).values[reverse.id], [records[0].id]);
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('Installed Harness existing relation pairing passed with preserved fields and reciprocal backfill.');
}
