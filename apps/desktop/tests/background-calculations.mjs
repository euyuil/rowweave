import assert from 'node:assert/strict';

export async function verifyBackgroundCalculations(page) {
  const result = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    async function request(path, method = 'GET', body) {
      const response = await fetch(connection.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    }
    let table = await request('/tables', 'POST', { name: 'Background calculation verification' });
    table = await request(`/tables/${table.id}/fields`, 'POST', { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
    const row = (await request(`/tables/${table.id}/records`, 'POST', [{ values: {} }])).records[0];
    const refresh = await request('/calculations/refresh', 'POST', {});
    const status = await request('/calculations/status');
    const saved = await request(`/tables/${table.id}/records/${row.id}`);
    await request(`/tables/${table.id}`, 'DELETE', { expectedVersion: table.version });
    return { refresh, status, value: saved.values[table.fields[1].id] };
  });
  assert.equal(result.status.automatic, true);
  assert.equal(result.status.running, false);
  assert.equal(result.status.lastError, undefined);
  assert.deepEqual(result.status.lastResult, result.refresh);
  assert.equal(result.value, result.refresh.evaluatedAt);
}
