import assert from 'node:assert/strict';

export async function verifyReciprocalWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize(); window.setSize(1024, 768); return size;
  });
  const call = (path, method = 'GET', input) => page.evaluate(async ({ path, method, input }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, { path, method, input });
  const ready = () => page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
  const create = async name => {
    await page.getByRole('button', { name: '+ New table', exact: true }).click();
    await page.getByLabel('Table name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await ready();
    return (await call('/tables')).find(table => table.name === name);
  };
  let projects = await create('Two-way projects');
  const project = (await call(`/tables/${projects.id}/records`, 'POST', [{ values: { [projects.primaryFieldId]: 'Launch' } }])).records[0];
  const tasks = await create('Two-way tasks');
  const dialog = page.getByRole('dialog');
  const add = async () => {
    await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add field', exact: true }).click();
    await page.getByLabel('Field name', { exact: true }).fill('Project');
    await page.getByLabel('Field type', { exact: true }).selectOption('relation');
    await page.getByLabel('Link to table', { exact: true }).selectOption({ label: 'Two-way projects' });
    await page.getByLabel('Allow multiple records', { exact: true }).uncheck();
    await page.getByLabel('Create a reverse field in the linked table', { exact: true }).check();
    await page.getByLabel('Reverse field name', { exact: true }).fill('Tasks');
  };
  await add();
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: '.artifacts/desktop-reciprocal-fields.png' });
  projects = await call(`/tables/${projects.id}/fields`, 'POST', { expectedVersion: projects.version, name: 'Concurrent note', type: 'text' });
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: 'schema changed' }).waitFor();
  assert.equal(await page.getByLabel('Reverse field name', { exact: true }).inputValue(), 'Tasks');
  assert.equal((await call(`/tables/${tasks.id}`)).fields.length, 1);
  assert.equal((await call(`/tables/${projects.id}`)).fields.length, 2);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await add();
  await dialog.getByRole('button', { name: 'Save field', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await ready();
  const source = await call(`/tables/${tasks.id}`);
  const target = await call(`/tables/${projects.id}`);
  const link = source.fields.find(field => field.name === 'Project');
  const inverse = target.fields.find(field => field.name === 'Tasks');
  assert.equal(link.relation.inverseFieldId, inverse.id);
  await page.getByRole('button', { name: '+ New record', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Prepare release');
  await page.getByRole('checkbox', { name: 'Launch', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const task = (await call(`/tables/${tasks.id}/records?offset=0&limit=1`)).records[0];
  assert.deepEqual((await call(`/tables/${projects.id}/records/${project.id}`)).values[inverse.id], [task.id]);
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Two-way projects', exact: true }).click();
  await page.getByRole('heading', { name: 'Two-way projects', exact: true }).waitFor();
  await page.getByText('1 record · 3 fields', { exact: true }).waitFor();
  await ready();
  const canvas = await page.locator('canvas').first().boundingBox();
  await page.mouse.click(canvas.x + 100, canvas.y + 58);
  await page.getByRole('button', { name: 'Open record', exact: true }).click();
  await page.getByRole('button', { name: 'Unlink Prepare release', exact: true }).waitFor();
  await page.getByRole('checkbox', { name: 'Prepare release', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-reciprocal-record.png' });
  await page.getByRole('button', { name: 'Unlink Prepare release', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual((await call(`/tables/${tasks.id}/records/${task.id}`)).values[link.id], []);
  await ready();
  await page.getByRole('button', { name: 'Manage fields', exact: true }).click();
  await dialog.getByRole('group', { name: 'Tasks', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByText('The opposite field and its values remain as one-way links. Future changes will no longer synchronize.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal((await call(`/tables/${tasks.id}`)).fields.find(field => field.id === link.id).relation.inverseFieldId, undefined);
  for (const name of ['Two-way tasks', 'Two-way projects']) {
    await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name, exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await ready();
    await page.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  }
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
