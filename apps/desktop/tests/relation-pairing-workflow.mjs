import assert from 'node:assert/strict';

function pairingApi(page) {
  return (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, body });
}

export async function verifyRelationPairing(page, application) {
  const call = pairingApi(page);
  const manage = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  const pair = page.getByRole('dialog', { name: 'Pair existing linked fields', exact: true });
  const picker = pair.getByLabel('Existing reverse field', { exact: true });
  const submit = pair.getByRole('button', { name: 'Pair fields', exact: true });
  const read = pair.getByRole('button', { name: 'Read current fields', exact: true });
  const reread = async () => {
    await read.click();
    await page.waitForFunction(() => {
      const picker = document.querySelector('select[aria-label="Existing reverse field"]');
      return picker && !picker.disabled;
    });
  };
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const create = async name => {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await ready();
    return (await call('/tables')).find(table => table.name === name);
  };
  let target = await create('Pairing projects');
  let source = await create('Pairing tasks');
  const sourcePath = '/tables/' + source.id, targetPath = '/tables/' + target.id;
  source = await call(sourcePath + '/fields', 'POST', { expectedVersion: source.version, name: 'Projects', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const field = source.fields.at(-1);
  await page.getByRole('button', { name: 'Reload', exact: true }).click(); await ready();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  const row = manage.getByRole('group', { name: 'Projects', exact: true });
  await row.getByRole('button', { name: 'Pair existing field', exact: true }).click();
  await pair.getByRole('status').filter({ hasText: 'No compatible reverse fields' }).waitFor();
  assert.equal(await submit.isDisabled(), true);
  await page.keyboard.press('Escape');
  await pair.waitFor({ state: 'detached' });
  assert.equal(await row.getByRole('button', { name: 'Pair existing field', exact: true }).evaluate(element => element === document.activeElement), true);
  target = await call(targetPath + '/fields', 'POST', { expectedVersion: target.version, name: 'Tasks', type: 'relation', relation: { tableId: source.id, multiple: false } });
  const inverse = target.fields.at(-1);
  const projects = (await call(targetPath + '/records', 'POST', ['Launch', 'Review'].map(name => ({ values: { [target.primaryFieldId]: name } })))).records;
  const tasks = (await call(sourcePath + '/records', 'POST', ['Plan', 'Build'].map(name => ({ values: { [source.primaryFieldId]: name, [field.id]: [projects[0].id] } })))).records;
  await call(targetPath + '/records', 'PATCH', [{ id: projects[1].id, expectedVersion: projects[1].version, values: { [inverse.id]: [tasks[0].id] } }]);
  await row.getByRole('button', { name: 'Pair existing field', exact: true }).click();
  await picker.selectOption(inverse.id);
  source = await call(sourcePath + '/fields', 'POST', { expectedVersion: source.version, name: 'Concurrent source note', type: 'text' });
  await submit.click();
  await pair.getByRole('alert').filter({ hasText: 'schema changed' }).waitFor();
  assert.equal(await picker.inputValue(), inverse.id);
  assert.equal(await submit.isDisabled(), true);
  await reread();
  target = await call(targetPath + '/fields', 'POST', { expectedVersion: target.version, name: 'Concurrent target note', type: 'text' });
  await submit.click();
  await pair.getByRole('alert').filter({ hasText: 'schema changed' }).waitFor();
  assert.equal(await picker.inputValue(), inverse.id);
  await reread();
  const before = await Promise.all([call(sourcePath), call(targetPath), call(sourcePath + '/records'), call(targetPath + '/records')]);
  await submit.click();
  await pair.getByRole('alert').waitFor();
  assert.equal(await picker.inputValue(), inverse.id);
  assert.deepEqual(await Promise.all([call(sourcePath), call(targetPath), call(sourcePath + '/records'), call(targetPath + '/records')]), before);
  target = await call(targetPath + '/fields/' + inverse.id, 'PATCH', { expectedVersion: target.version, relation: { ...inverse.relation, multiple: true } });
  await reread();
  const originalSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  for (const size of [[1440, 1100], [1024, 768]]) {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size);
    assert.equal(await pair.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `.artifacts/desktop-relation-pair-${size[0]}.png` });
  }
  await submit.focus(); await page.keyboard.press('Enter');
  await pair.waitFor({ state: 'detached' });
  assert.equal(await row.getByRole('button', { name: 'Configure', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await row.getByRole('button', { name: 'Pair existing field', exact: true }).count(), 0);
  assert.deepEqual((await call(sourcePath)).fields.map(field => field.id), source.fields.map(field => field.id));
  assert.deepEqual((await call(targetPath)).fields.map(field => field.id), target.fields.map(field => field.id));
  assert.deepEqual((await call(sourcePath + '/records/' + tasks[0].id)).values[field.id], projects.map(record => record.id));
  assert.deepEqual((await call(targetPath + '/records/' + projects[0].id)).values[inverse.id], tasks.map(record => record.id));
  await manage.getByRole('button', { name: 'Done', exact: true }).click(); await ready();
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), originalSize);
  await verifySelfPairingRecovery(page, call, create);
  console.log('Existing relation pairing passed empty choices, cancellation/focus, both schema conflicts, selection retention, capacity rollback, union and responsive layout.');
  return { source, target, field, inverse, tasks, projects };
}

async function verifySelfPairingRecovery(page, call, create) {
  let table = await create('Self pairing recovery');
  const root = '/tables/' + table.id;
  for (const name of ['Forward', 'Reverse', 'Reverse']) table = await call(root + '/fields', 'POST', {
    expectedVersion: table.version, name, type: 'relation', relation: { tableId: table.id, multiple: true },
  });
  const [forward, reverse, other] = table.fields.slice(1);
  const records = (await call(root + '/records', 'POST', ['First', 'Second'].map(name => ({ values: { [table.primaryFieldId]: name } })))).records;
  await call(root + '/records', 'PATCH', [{ id: records[0].id, expectedVersion: records[0].version, values: { [forward.id]: [records[1].id] } }]);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('2 records · 4 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  const manage = page.getByRole('dialog', { name: 'Manage fields', exact: true });
  const row = manage.getByRole('group', { name: 'Forward', exact: true });
  const pair = page.getByRole('dialog', { name: 'Pair existing linked fields', exact: true });
  const routePath = '**' + root;
  await page.route(routePath, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: 'Test schema read unavailable.' } }) }));
  await row.getByRole('button', { name: 'Pair existing field', exact: true }).click();
  await pair.getByRole('alert').filter({ hasText: 'Test schema read unavailable.' }).waitFor();
  assert.equal(await pair.getByRole('button', { name: 'Pair fields', exact: true }).isDisabled(), true);
  await page.unroute(routePath);
  await pair.getByRole('button', { name: 'Read current fields', exact: true }).click();
  const picker = pair.getByLabel('Existing reverse field', { exact: true });
  await picker.selectOption(reverse.id);
  assert.deepEqual(await picker.locator('option').evaluateAll(elements => elements.map(element => element.value)), ['', reverse.id, other.id]);
  assert.match(await picker.locator(`option[value="${reverse.id}"]`).innerText(), new RegExp(reverse.id));
  await picker.selectOption(other.id);
  await call(root + '/fields/' + other.id, 'DELETE', { expectedVersion: table.version });
  await pair.getByRole('button', { name: 'Read current fields', exact: true }).click();
  await picker.getByRole('option', { name: 'Previously selected field is unavailable', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await picker.inputValue(), other.id);
  assert.equal(await pair.getByRole('button', { name: 'Pair fields', exact: true }).isDisabled(), true);
  await picker.selectOption(reverse.id);
  let writes = 0;
  const pairPath = '**' + root + '/fields/' + forward.id + '/pair';
  await page.route(pairPath, async route => { writes++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed'); });
  await pair.getByRole('button', { name: 'Pair fields', exact: true }).click();
  await pair.getByRole('alert').waitFor();
  assert.equal(await picker.inputValue(), reverse.id);
  assert.equal(await pair.getByRole('button', { name: 'Pair fields', exact: true }).isDisabled(), true);
  await pair.getByRole('button', { name: 'Read current fields', exact: true }).click();
  await pair.getByRole('alert').filter({ hasText: 'already paired' }).waitFor();
  assert.equal(writes, 1, 'An uncertain pairing result must only be read back, never retried automatically.');
  assert.equal((await call(root)).fields.find(field => field.id === forward.id).relation.inverseFieldId, reverse.id);
  assert.deepEqual((await call(`${root}/records/${records[1].id}`)).values[reverse.id], [records[0].id]);
  await page.unroute(pairPath);
  await pair.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await row.getByRole('button', { name: 'Configure', exact: true }).evaluate(element => element === document.activeElement), true);
  await manage.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('Self-table pairing passed distinct UUID choices, read failure recovery and lost-response readback without retrying the write.');
}

export async function verifyRelationPairingAfterRestart(page, fixture) {
  const { source, target, field, inverse, tasks, projects } = fixture, call = pairingApi(page);
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: source.name, exact: true }).click();
  await page.getByRole('heading', { name: source.name, exact: true }).waitFor();
  assert.equal((await call('/tables/' + source.id)).fields.find(candidate => candidate.id === field.id).relation.inverseFieldId, inverse.id);
  assert.equal((await call('/tables/' + target.id)).fields.find(candidate => candidate.id === inverse.id).relation.inverseFieldId, field.id);
  assert.deepEqual((await call(`/tables/${source.id}/records/${tasks[0].id}`)).values[field.id], projects.map(record => record.id));
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: target.name, exact: true }).click();
  await page.getByRole('heading', { name: target.name, exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  await page.locator('canvas').first().waitFor({ state: 'visible' });
  const bounds = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(bounds.x + 100, bounds.y + 58);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByRole('button', { name: 'Unlink Plan', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual((await call(`/tables/${source.id}/records/${tasks[0].id}`)).values[field.id], [projects[1].id]);
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('dialog').getByRole('group', { name: 'Tasks', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  for (const table of [source, target]) {
    await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: table.name, exact: true }).click();
    await page.getByRole('heading', { name: table.name, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
}
