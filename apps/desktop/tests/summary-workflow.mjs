export async function verifySummaryWorkflow(page) {
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Summary lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Summary lab', exact: true }).waitFor();
  const fixture = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const call = async (path, method = 'GET', input) => {
      const response = await fetch(connection.url + path, { method, headers, ...(input ? { body: JSON.stringify(input) } : {}) });
      if (!response.ok) throw new Error('Could not prepare summary fixture.');
      return response.json();
    };
    let table = (await call('/tables')).find(table => table.name === 'Summary lab');
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Amount', type: 'number' });
    table = await call(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
      options: [{ id: 'open', name: 'Open' }, { id: 'closed', name: 'Closed' }] });
    const [name, amount, status] = table.fields;
    await call(`/tables/${table.id}/records`, 'POST', Array.from({ length: 501 }, (_, i) => ({ values: {
      [name.id]: `Task ${i}`, [amount.id]: 2, [status.id]: i < 401 ? 'open' : 'closed',
    } })));
    await call(`/tables/${table.id}/views`, 'POST', { name: 'Open tasks', query: { filter: {
      conjunction: 'and', conditions: [{ fieldId: status.id, operator: 'eq', value: 'open' }],
    } } });
    return { status: status.id, tableId: table.id };
  });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('501 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await page.getByRole('row', { name: 'All matching records 501 1,002', exact: true }).waitFor();
  await page.getByLabel('Group by', { exact: true }).selectOption(fixture.status);
  await page.getByRole('row', { name: 'Open 401 802', exact: true }).waitFor();
  await page.getByRole('row', { name: 'Closed 100 200', exact: true }).waitFor();
  await page.screenshot({ path: '.artifacts/desktop-summary.png' });
  await page.getByLabel('Calculation', { exact: true }).selectOption('average');
  await page.getByRole('row', { name: 'Open 401 2', exact: true }).waitFor();
  await page.evaluate(async tableId => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const path = `${connection.url}/tables/${tableId}/views`;
    const views = await fetch(path, { headers }).then(response => response.json());
    const view = views.find(view => view.name === 'All records');
    const response = await fetch(`${path}/${view.id}`, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: view.version, name: 'All tasks' }) });
    if (!response.ok) throw new Error('Could not update the summary view fixture.');
  }, fixture.tableId);
  await page.getByRole('button', { name: 'Refresh summary', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Close this dialog and reload the table' }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByLabel('Current view', { exact: true }).selectOption({ label: 'Open tasks' });
  await page.getByText('401 records · 3 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Summarize', exact: true }).click();
  await page.getByRole('row', { name: 'All matching records 401 802', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}
