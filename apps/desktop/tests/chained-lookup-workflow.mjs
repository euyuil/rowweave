import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

function chainApi(page) {
  return (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, input });
}

async function chooseChainTable(page, table) {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: table.name, exact: true }).click();
  await page.getByRole('heading', { name: table.name, exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
}

async function openChainRecord(page) {
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const canvas = page.locator('canvas').first(); await canvas.waitFor({ state: 'visible' });
  const bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
}

export async function verifyChainedLookups(page, application) {
  const call = chainApi(page), rootPath = id => '/tables/' + id;
  const leaf = await call('/tables', 'POST', { name: 'Chained items' });
  const middle = await call('/tables', 'POST', { name: 'Chained collections' });
  const root = await call('/tables', 'POST', { name: 'Chained portfolios' });
  const add = async (table, input) => {
    const current = await call(rootPath(table.id));
    return (await call(rootPath(table.id) + '/fields', 'POST', { ...input, expectedVersion: current.version })).fields.at(-1);
  };
  const amount = await add(leaf, { name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD' });
  const tags = await add(leaf, { name: 'Tags', type: 'multiSelect', options: [{ id: 'blue', name: 'Blue', color: '#315CBE' }, { id: 'red', name: 'Red', color: '#BE3131' }] });
  const files = await add(leaf, { name: 'Files', type: 'attachment' });
  const innerLink = await add(middle, { name: 'Items', type: 'relation', relation: { tableId: leaf.id, multiple: true } });
  const lookup = (relation, field, operation = 'values') => ({ relationFieldId: relation.id, fieldId: field.id, operation });
  const inner = await add(middle, { name: 'Item amounts', type: 'lookup', lookup: lookup(innerLink, amount) });
  const duplicate = await add(middle, { name: 'Item amounts', type: 'text' });
  const innerSum = await add(middle, { name: 'Total', type: 'lookup', lookup: lookup(innerLink, amount, 'sum') });
  const innerCount = await add(middle, { name: 'Count', type: 'lookup', lookup: lookup(innerLink, amount, 'count') });
  const innerTags = await add(middle, { name: 'Item tags', type: 'lookup', lookup: lookup(innerLink, tags) });
  const innerFiles = await add(middle, { name: 'Item files', type: 'lookup', lookup: lookup(innerLink, files) });
  const outerLink = await add(root, { name: 'Collections', type: 'relation', relation: { tableId: middle.id, multiple: true } });
  const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
  const file = await call(rootPath(leaf.id) + '/attachments', 'POST', { filename: 'nested.bin', mediaType: 'application/octet-stream', data: bytes.toString('base64') });
  const items = (await call(rootPath(leaf.id) + '/records', 'POST', [0, 25].map((value, index) => ({ values: {
    [leaf.primaryFieldId]: `Item ${index + 1}`, [amount.id]: value, [tags.id]: [index ? 'red' : 'blue'], ...(index ? { [files.id]: [file.id] } : {}),
  } })))).records;
  const collection = (await call(rootPath(middle.id) + '/records', 'POST', [{ values: { [middle.primaryFieldId]: 'Collection', [innerLink.id]: items.map(item => item.id) } }])).records[0];
  const record = (await call(rootPath(root.id) + '/records', 'POST', [{ values: { [root.primaryFieldId]: 'Portfolio', [outerLink.id]: [collection.id] } }])).records[0];
  await chooseChainTable(page, root);
  const manage = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  const form = page.getByRole('dialog', { name: 'Add field', exact: true });
  const picker = page.getByLabel('Look up field', { exact: true });
  const begin = async name => {
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await manage.getByRole('button', { name: 'Add field', exact: true }).click();
    await form.getByLabel('Field name', { exact: true }).fill(name);
    await form.getByLabel('Field type', { exact: true }).selectOption('lookup');
  };
  const ready = () => page.waitForFunction(() => {
    const select = document.querySelector('select[aria-label="Look up field"]'); return select && !select.disabled;
  });
  const finish = async name => {
    await page.getByRole('button', { name: 'Save field', exact: true }).click();
    await manage.waitFor(); await manage.getByRole('button', { name: 'Done', exact: true }).click();
    return (await call(rootPath(root.id))).fields.find(field => field.name === name);
  };
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-chained-ui-'));
  const originalSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  try {
    const outage = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Synthetic lookup target outage' } }) });
    await page.route('**' + rootPath(middle.id), outage);
    try {
      await begin('Retained field draft');
      await form.getByRole('alert').filter({ hasText: 'Synthetic lookup target outage' }).waitFor();
      assert.equal(await form.getByLabel('Field name', { exact: true }).inputValue(), 'Retained field draft');
      assert.equal(await form.getByRole('button', { name: 'Save field', exact: true }).isDisabled(), true);
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      await manage.getByRole('button', { name: 'Done', exact: true }).click();
    } finally { await page.unroute('**' + rootPath(middle.id), outage); }
    await begin('All amounts'); await ready();
    const choices = await picker.locator('option').evaluateAll(options => options.map(option => ({ id: option.value, name: option.textContent })));
    assert.ok(choices.some(choice => choice.id === inner.id));
    assert.ok(!choices.some(choice => choice.id === innerLink.id));
    for (const field of [inner, duplicate]) assert.ok(choices.find(choice => choice.id === field.id).name.includes(field.id));
    assert.match(choices.find(choice => choice.id === inner.id).name, /Lookup/);
    await picker.selectOption(inner.id);
    for (const size of [[1440, 1100], [1024, 768]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
      await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size);
      assert.equal(await form.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.screenshot({ path: `.artifacts/desktop-chained-chooser-${size[0]}.png` });
    }
    const values = await finish('All amounts');
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
    await begin('Total'); await ready();
    await picker.selectOption(inner.id);
    await form.getByLabel('Lookup operation', { exact: true }).selectOption('sum');
    assert.deepEqual((await picker.locator('option').evaluateAll(options => options.map(option => option.value))).sort(), [inner.id, innerSum.id, innerCount.id].sort());
    assert.equal(await picker.inputValue(), inner.id);
    const total = await finish('Total');
    for (const [name, target, operation] of [['Count', inner, 'count'], ['All tags', innerTags, 'values'], ['All files', innerFiles, 'values']]) {
      await begin(name); await ready();
      await form.getByLabel('Lookup operation', { exact: true }).selectOption(operation);
      await picker.selectOption(target.id); await finish(name);
    }
    await page.getByText('1 record · 7 fields', { exact: true }).waitFor();
    await openChainRecord(page);
    const panel = page.getByRole('dialog');
    assert.equal(await panel.getByLabel('All amounts', { exact: true }).textContent(), '$0.00, $25.00');
    assert.equal(await panel.getByLabel('Total', { exact: true }).textContent(), '$25.00');
    assert.equal(await panel.getByLabel('Count', { exact: true }).textContent(), '2');
    assert.deepEqual(await panel.getByLabel('All tags', { exact: true }).locator('.select-value').evaluateAll(elements => elements.map(element => [element.textContent, getComputedStyle(element).backgroundColor])),
      [['Blue', 'rgb(49, 92, 190)'], ['Red', 'rgb(190, 49, 49)']]);
    const destination = join(directory, 'nested.bin');
    await application.evaluate(({ dialog }, destination) => {
      globalThis.chainOriginalSaveDialog = dialog.showSaveDialog;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, destination);
    try {
      await panel.getByRole('button', { name: 'Download nested.bin', exact: true }).click();
      await panel.getByText('File saved.', { exact: true }).waitFor();
      assert.deepEqual(await readFile(destination), bytes);
    } finally { await application.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.chainOriginalSaveDialog; }); }
    assert.equal(await panel.getByRole('button', { name: 'Remove nested.bin', exact: true }).count(), 0);
    await panel.getByLabel('Name', { exact: true }).fill('Draft stays');
    await call(rootPath(leaf.id) + '/records', 'PATCH', [{ id: items[1].id, expectedVersion: items[1].version, values: { [amount.id]: 30 } }]);
    await page.waitForRequest(request => request.url().endsWith('/workspace/state') && request.postDataJSON()?.tableId === root.id && !!request.postDataJSON()?.viewId);
    assert.equal(await panel.getByLabel('Name', { exact: true }).inputValue(), 'Draft stays');
    assert.equal(await panel.getByLabel('All amounts', { exact: true }).textContent(), '$0.00, $25.00');
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('canvas [aria-rowindex="2"] [role="gridcell"][aria-colindex="3"]')?.textContent === '[0,30]');
    await openChainRecord(page);
    assert.equal(await panel.getByLabel('All amounts', { exact: true }).textContent(), '$0.00, $30.00');
    assert.equal(await panel.getByLabel('Total', { exact: true }).textContent(), '$30.00');
    assert.equal(await panel.getByLabel('Name', { exact: true }).inputValue(), 'Portfolio');
    await panel.getByText('1 matching records', { exact: true }).waitFor();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 1100));
    await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 1100);
    await panel.getByRole('button', { name: 'Download nested.bin', exact: true }).waitFor();
    await page.screenshot({ path: '.artifacts/desktop-chained-record.png' });
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await manage.getByRole('group', { name: 'Total', exact: true }).getByRole('button', { name: 'Configure', exact: true }).click();
    await ready(); assert.equal(await picker.inputValue(), inner.id);
    await picker.selectOption(innerSum.id); await finish('Total');
    assert.equal((await call(rootPath(root.id) + '/records/' + record.id)).values[total.id], 30);
    const self = await add(root, { name: 'Self', type: 'relation', relation: { tableId: root.id, multiple: true } });
    const back = await add(root, { name: 'Further values', type: 'lookup', lookup: lookup(self, values) });
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await manage.getByRole('group', { name: 'All amounts', exact: true }).getByRole('button', { name: 'Configure', exact: true }).click();
    await page.getByLabel('Linked field', { exact: true }).selectOption(self.id); await ready();
    assert.equal(await picker.locator(`option[value="${values.id}"]`).count(), 0);
    await picker.selectOption(back.id);
    const before = await call(rootPath(root.id));
    await page.getByRole('button', { name: 'Save field', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'dependency cycle' }).waitFor();
    assert.equal(await picker.inputValue(), back.id);
    assert.equal(await page.getByLabel('Field name', { exact: true }).inputValue(), 'All amounts');
    assert.deepEqual(await call(rootPath(root.id)), before);
    await page.getByRole('dialog', { name: 'Configure field', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await manage.getByRole('button', { name: 'Done', exact: true }).click();
    for (const field of [back, self]) await call(rootPath(root.id) + '/fields/' + field.id, 'DELETE', { expectedVersion: (await call(rootPath(root.id))).version });
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.getByText('1 record · 7 fields', { exact: true }).waitFor();
    await openChainRecord(page); await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter'); assert.equal(await page.locator('.rowweave-cell-editor').count(), 0);
    await page.keyboard.press('Control+c');
    await page.waitForFunction(async () => await navigator.clipboard.readText() === '[0,30]');
    console.log('Chained lookup configuration passed numeric/scalar choices, duplicate names, target-read failure, typed display/download, draft refresh, cycle rollback and readonly clipboard.');
    return { leaf, middle, root, record, values, total, innerSum };
  } finally {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('rowweave-chained-ui-'));
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyChainedLookupsAfterRestart(page, fixture) {
  const call = chainApi(page), { root, record, values, total, innerSum } = fixture;
  await chooseChainTable(page, root);
  const table = await call('/tables/' + root.id), saved = await call('/tables/' + root.id + '/records/' + record.id);
  assert.equal(table.fields.find(field => field.id === total.id).lookup.fieldId, innerSum.id);
  assert.deepEqual(saved.values[values.id], [0, 30]); assert.equal(saved.values[total.id], 30);
  await openChainRecord(page);
  const panel = page.getByRole('dialog');
  assert.equal(await panel.getByLabel('All amounts', { exact: true }).textContent(), '$0.00, $30.00');
  assert.equal(await panel.getByLabel('Total', { exact: true }).textContent(), '$30.00');
  await panel.getByRole('button', { name: 'Download nested.bin', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const table of [fixture.root, fixture.middle, fixture.leaf]) {
    await chooseChainTable(page, table);
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  console.log('Chained lookup configuration, results and attachment ownership survived restart.');
}
