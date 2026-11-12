import assert from 'node:assert/strict';

export async function verifySchemaWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Schema lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Schema lab', exact: true }).waitFor();
  const read = () => page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}` };
    const table = (await fetch(`${connection.url}/tables`, { headers }).then(r => r.json())).find(table => table.name === 'Schema lab');
    const { records } = await fetch(`${connection.url}/tables/${table.id}/records?offset=0&limit=10`, { headers }).then(r => r.json());
    return { table, records };
  });
  const original = (await read()).table;
  const group = name => page.getByRole('group', { name, exact: true });
  const manage = () => page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  const done = () => page.getByRole('button', { name: 'Done', exact: true }).click();
  const add = async (name, type) => {
    await page.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).fill(name);
    await page.getByLabel('Field type', { exact: true }).selectOption(type);
  };
  const save = async name => {
    await page.getByRole('button', { name: 'Save field', exact: true }).click();
    await group(name).waitFor();
  };
  const configure = name => group(name).getByRole('button', { name: 'Configure', exact: true }).click();
  await manage();
  await page.getByText('Each record has an immutable record ID (UUID), its primary key.', { exact: false }).waitFor();
  await add('Budget', 'number');
  await page.getByLabel('Number format', { exact: true }).selectOption('currency');
  await page.getByLabel('Currency code', { exact: true }).fill('CNY');
  await page.getByLabel('Decimal places', { exact: true }).selectOption('2');
  await page.getByLabel('Require a value', { exact: true }).check();
  await page.getByLabel('Use a default for new records', { exact: true }).check();
  await page.getByLabel('Default value', { exact: true }).fill('0');
  await save('Budget');
  await add('Status', 'singleSelect');
  for (const [index, name] of ['Ready', 'Done'].entries()) {
    await page.getByRole('button', { name: 'Add option', exact: true }).click();
    await page.getByLabel(`Option ${index + 1} name`, { exact: true }).fill(name);
  }
  await page.getByLabel('Use a default for new records', { exact: true }).check();
  await page.getByLabel('Default value', { exact: true }).selectOption({ label: 'Ready' });
  await save('Status');
  await add('Notes', 'multiline');
  await save('Notes');
  await configure('Name');
  await page.getByText('Field identity', { exact: true }).click();
  await page.getByRole('dialog').getByText(original.primaryFieldId, { exact: true }).waitFor();
  await page.getByLabel('Field name', { exact: true }).fill('Title');
  await save('Title');
  await group('Budget').getByRole('button', { name: 'Use as primary display field', exact: true }).click();
  await group('Budget').getByText('Number · Required · Primary display field', { exact: true }).waitFor();
  await group('Title').getByRole('button', { name: 'Use as primary display field', exact: true }).click();
  await group('Title').getByText('Text · Primary display field', { exact: true }).waitFor();
  assert.equal(await group('Title').getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Move Budget up', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.schema-field-name strong')?.textContent === 'Budget');
  await done();
  const configured = await read();
  assert.equal(configured.table.primaryFieldId, original.primaryFieldId);
  const budget = configured.table.fields.find(field => field.name === 'Budget');
  const status = configured.table.fields.find(field => field.name === 'Status');
  assert.equal(configured.table.fields[0].id, budget.id);
  for (const title of ['41', 'invalid']) {
    await page.getByRole('button', { name: '+ New record', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(title);
    assert.equal(await page.getByLabel('Budget *', { exact: true }).inputValue(), '0');
    assert.equal(await page.getByLabel('Status', { exact: true }).inputValue(), status.options[0].id);
    await page.getByRole('button', { name: 'Create record', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await manage();
  await configure('Status');
  await page.getByLabel('Option 1 name', { exact: true }).fill('Queued');
  await save('Status');
  assert.equal((await read()).table.fields.find(field => field.id === status.id).options[0].id, status.options[0].id);
  await configure('Status');
  await page.getByLabel('Use a default for new records', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Remove option 1', exact: true }).click();
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'existing option' }).waitFor();
  assert.equal((await read()).table.fields.find(field => field.id === status.id).options.length, 2);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await configure('Notes');
  await page.getByLabel('Require a value', { exact: true }).check();
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'value is required' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await configure('Title');
  await page.getByLabel('Field type', { exact: true }).selectOption('number');
  await page.getByRole('button', { name: 'Preview conversion', exact: true }).click();
  await page.getByText('1 changed · 1 invalid', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Apply conversion', exact: true }).isDisabled(), true);
  const before = await read();
  assert.equal(before.table.fields.find(field => field.id === original.primaryFieldId).type, 'text');
  await page.screenshot({ path: '.artifacts/desktop-conversion-errors.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await done();
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 15, bounds.y + 94);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('42');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await manage();
  await configure('Title');
  await page.getByLabel('Field type', { exact: true }).selectOption('number');
  await page.getByRole('button', { name: 'Preview conversion', exact: true }).click();
  await page.getByText('2 changed · 0 invalid', { exact: true }).waitFor();
  const change = async value => {
    const { records } = await read();
    await page.evaluate(async ({ table, record, value }) => {
      const connection = await window.rowweave.connection();
      const response = await fetch(`${connection.url}/tables/${table.id}/records`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: record.id, expectedVersion: record.version, values: { [table.primaryFieldId]: value } }]),
      });
      if (!response.ok) throw new Error('Could not prepare the concurrent conversion update.');
    }, { table: original, record: records[0], value });
  };
  await change('changed after preview');
  await page.getByRole('button', { name: 'Apply conversion', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'could not be converted' }).waitFor();
  const rejected = await read();
  assert.equal(rejected.table.fields.find(field => field.id === original.primaryFieldId).type, 'text');
  assert.equal(rejected.records[1].values[original.primaryFieldId], '42');
  await change('41');
  await page.getByRole('button', { name: 'Apply conversion', exact: true }).click();
  await group('Title').getByText('Number · Primary display field', { exact: true }).waitFor();
  const converted = await read();
  assert.deepEqual(converted.records.map(record => record.values[original.primaryFieldId]), [41, 42]);
  await configure('Budget');
  await page.getByLabel('Decimal places', { exact: true }).selectOption('');
  await save('Budget');
  assert.equal((await read()).table.fields.find(field => field.id === budget.id).precision, undefined);
  await group('Notes').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await group('Notes').waitFor();
  await group('Notes').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await group('Notes').waitFor({ state: 'detached' });
  await page.screenshot({ path: '.artifacts/desktop-schema.png' });
  await done();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
