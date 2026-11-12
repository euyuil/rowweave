import assert from 'node:assert/strict';

export async function verifyRelationWorkflow(page) {
  const createTable = async name => {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page.getByText('0 records · 1 field', { exact: true }).waitFor();
  };
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(`${connection.url}${path}`, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const select = async (column = 0) => {
    await page.waitForTimeout(650);
    await ready();
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100 + column * 180, bounds.y + 58);
    if (await page.locator('.rowweave-cell-editor').count()) await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
  };
  await createTable('Linked projects');
  const projects = (await call('/tables')).find(table => table.name === 'Linked projects');
  const targets = (await call(`/tables/${projects.id}/records`, 'POST', Array.from({ length: 55 }, (_, index) => ({
    values: { [projects.primaryFieldId]: index === 54 ? '中文项目' : `Project ${String(index + 1).padStart(2, '0')}` },
  })))).records;
  await createTable('Linked tasks');
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Field name', { exact: true }).fill('Project');
  await page.getByLabel('Field type', { exact: true }).selectOption('relation');
  await page.getByLabel('Link to table', { exact: true }).selectOption({ label: 'Linked projects' });
  await page.getByLabel('Allow multiple records', { exact: true }).uncheck();
  await page.getByLabel('Use a default for new records', { exact: true }).check();
  await page.getByRole('checkbox', { name: 'Project 01', exact: true }).check();
  await page.getByRole('button', { name: 'Save field', exact: true }).click();
  await page.getByRole('dialog', { name: 'Manage fields', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const tasks = (await call('/tables')).find(table => table.name === 'Linked tasks');
  const link = tasks.fields.find(field => field.type === 'relation');
  assert.deepEqual(link.defaultValue, [targets[0].id]);
  assert.equal(link.relation.multiple, false);

  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Linked task');
  assert.equal(await page.getByRole('checkbox', { name: 'Project 01', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('checkbox', { name: '中文项目', exact: true }).check();
  await page.getByRole('button', { name: '中文项目', exact: true }).click();
  await page.getByRole('region', { name: 'Linked record details', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-linked-records.png' });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Create record', exact: true }).click();
  await page.getByText('1 record · 2 fields', { exact: true }).waitFor();
  let record = (await call(`/tables/${tasks.id}/records?offset=0&limit=10`)).records[0];
  assert.deepEqual(record.values[link.id], [targets[54].id]);

  await select(1);
  await page.keyboard.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Cell value', exact: true });
  await search.fill('Project 02');
  await page.getByRole('checkbox', { name: 'Project 02', exact: true }).check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByText('1 unsaved cell', { exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-linked-grid.png' });
  await page.keyboard.press('Control+s');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  record = (await call(`/tables/${tasks.id}/records?offset=0&limit=10`)).records[0];
  assert.deepEqual(record.values[link.id], [targets[1].id]);
  await call(`/tables/${projects.id}/records`, 'PATCH', [{ id: targets[1].id, expectedVersion: 1, values: { [projects.primaryFieldId]: 'Renamed project' } }]);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await select();
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByRole('button', { name: 'Renamed project', exact: true }).waitFor();
  await call(`/tables/${projects.id}/fields`, 'POST', { expectedVersion: projects.version, name: 'Concurrent field', type: 'text' });
  await page.getByRole('searchbox', { name: 'Project', exact: true }).fill('Project 52');
  await page.getByRole('alert').filter({ hasText: 'target schema changed' }).waitFor();
  await page.getByRole('button', { name: 'Reload records', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Project 52', exact: true }).check();
  await call(`/tables/${projects.id}/records`, 'DELETE', [{ id: targets[51].id, expectedVersion: 1 }]);
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'does not exist' }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Linked task');
  await page.getByRole('searchbox', { name: 'Project', exact: true }).fill('Project 03');
  await page.getByRole('checkbox', { name: 'Project 03', exact: true }).check();
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual((await call(`/tables/${tasks.id}/records/${record.id}`)).values[link.id], [targets[2].id]);

  const choose = name => page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
  await choose('Linked projects');
  await ready();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'linked fields' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const name of ['Linked tasks', 'Linked projects']) {
    await choose(name);
    await ready();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
}
