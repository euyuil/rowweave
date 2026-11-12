import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { httpRequest as fetch } from './http-request.js';

test('the standalone process applies environment configuration and preserves schema, views and records across restart', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-service-'));
  const token = randomBytes(32).toString('hex');
  async function launch() {
    const child = spawn(process.execPath, [resolve('dist/apps/server/src/cli.js')], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ROWWEAVE_DB: join(directory, 'workspace.sqlite'), ROWWEAVE_TOKEN: token,
        ROWWEAVE_PORT: '0', ROWWEAVE_HOST: '127.0.0.1', ROWWEAVE_ALLOWED_HOSTS: 'service.example.test, proxy.example.test',
        ROWWEAVE_ALLOWED_ORIGINS: 'null, https://app.example.test' } });
    let output = '';
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
    const stop = async () => { child.kill('SIGTERM'); return exited; };
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Standalone service did not become ready.')); }, 15_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Service startup failed: ' + errors)); });
      child.stdout.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        const ready = output.match(/RowWeave service listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (ready) { clearTimeout(timer); resolveUrl(ready[1]!); }
      });
    });
    assert.ok(!output.includes(token) && !errors.includes(token));
    return { url, stop };
  }
  let server: Awaited<ReturnType<typeof launch>> | undefined;
  t.after(async () => { await server?.stop(); await rm(directory, { recursive: true, force: true }); });
  server = await launch();
  const headers = { Host: 'service.example.test', Origin: 'null', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function request(path: string, body?: unknown) {
    const response = await fetch(server!.url + path, { headers, method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  }
  assert.equal((await fetch(server.url + '/tables', { headers: { Authorization: headers.Authorization } })).status, 403);
  assert.equal((await fetch(server.url + '/tables', { headers: { ...headers, Host: 'proxy.example.test', Origin: 'https://app.example.test' } })).status, 200);
  let table = await request('/tables', { name: 'Standalone projects' });
  table = await request(`/tables/${table.id}/fields`, { expectedVersion: table.version, name: 'Budget', type: 'number', defaultValue: 0 });
  const created = await request(`/tables/${table.id}/records`, [{ values: { [table.primaryFieldId]: '中文 🌱', [table.fields[1].id]: 123.45 } }]);
  const view = await request(`/tables/${table.id}/views`, { name: 'Planned', query: { search: '中文' } });
  const exitCode = await server.stop();
  if (process.platform !== 'win32') assert.equal(exitCode, 0);
  server = await launch();
  assert.deepEqual(await request(`/tables/${table.id}`), { ...table, total: 1, revision: table.revision + 1 });
  assert.deepEqual(await request(`/tables/${table.id}/records/${created.records[0].id}`), created.records[0]);
  assert.deepEqual(await request(`/tables/${table.id}/views/${view.id}`), view);
  const result = await request(`/tables/${table.id}/views/${view.id}/query`, {});
  assert.equal(result.total, 1);
  assert.equal(result.records[0].values[table.primaryFieldId], '中文 🌱');
});
