import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer, type ServerOptions } from '../src/http-server.js';
import { httpRequest as fetch } from './http-request.js';

test('remote binding requires exact hosts and origins while every operation still requires bearer authentication', async t => {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token, host: '0.0.0.0',
    allowedHosts: ['tables.example.test', 'tables.example.test:4317'], allowedOrigins: ['https://app.example.test', 'null'] });
  t.after(() => server.close());
  const endpoint = server.url.replace('0.0.0.0', '127.0.0.1') + '/tables';
  const headers = { Host: 'TABLES.EXAMPLE.TEST', Authorization: `Bearer ${token}`, Origin: 'https://app.example.test' };
  const read = await fetch(endpoint, { headers });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), []);
  assert.equal(read.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal(read.headers.get('vary'), 'Origin');
  for (const host of ['attacker.test', 'tables.example.test.attacker.test', 'tables.example.test:9999']) {
    const denied = await fetch(endpoint, { headers: { ...headers, Host: host } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'INVALID_HOST');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  const forwarded = await fetch(endpoint, { headers: { ...headers, Host: 'attacker.test', 'X-Forwarded-Host': 'tables.example.test' } });
  assert.equal(forwarded.status, 403);
  for (const origin of ['https://attacker.test', 'http://app.example.test', 'https://app.example.test:444', 'https://app.example.test/path']) {
    const denied = await fetch(endpoint, { headers: { ...headers, Origin: origin } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'INVALID_ORIGIN');
  }
  const unauthenticated = await fetch(endpoint, { headers: { Host: headers.Host, Origin: headers.Origin } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await fetch(endpoint, { headers: { Host: 'tables.example.test:4317', Authorization: headers.Authorization } })).status, 200);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: 'null' } })).status, 200);
  const created = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Remote tasks' }) });
  assert.equal(created.status, 201);
  assert.equal(service.listTables()[0]!.name, 'Remote tasks');
});

test('CORS preflight is unauthenticated but checks host, origin, method and requested headers', async t => {
  const service = new RecordService(fixture(t, null).open());
  const server = await startServer({ service, token: randomBytes(32).toString('hex'), allowedOrigins: ['https://app.example.test'] });
  t.after(() => server.close());
  const endpoint = server.url + '/tables';
  const headers = { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'Authorization, Content-Type' };
  const preflight = await fetch(endpoint, { method: 'OPTIONS', headers });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, content-type');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  for (const change of [
    { Origin: 'null' }, { Host: 'attacker.test' }, { 'Access-Control-Request-Method': 'PUT' },
    { 'Access-Control-Request-Headers': 'Authorization, X-Override-Host' },
  ]) assert.equal((await fetch(endpoint, { method: 'OPTIONS', headers: { ...headers, ...change } })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'OPTIONS' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: headers.Origin, 'Content-Type': 'application/json' }, body: '{"name":"Denied"}' })).status, 401);
  assert.deepEqual(service.listTables(), []);
});

test('non-loopback defaults deny browser origins and configuration cannot silently broaden network access', async t => {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const options: Partial<ServerOptions>[] = [
    { host: '0.0.0.0' }, { host: '::' }, { host: 'localhost' }, { port: -1 }, { port: 65536 }, { port: 1.5 }, { port: NaN },
    { allowedHosts: [] }, { allowedHosts: ['*'] }, { allowedHosts: ['http://example.test'] },
    { allowedHosts: ['example.test/path'] }, { allowedHosts: ['example.test:99999'] },
    { allowedHosts: ['user:password@example.test'] }, { allowedHosts: ['example.test\n'] },
    { allowedOrigins: ['*'] }, { allowedOrigins: ['https://*.example.test'] }, { allowedOrigins: ['https://example.test/path'] },
    { allowedOrigins: ['https://example.test/'] }, { allowedOrigins: ['file://'] },
    { token: 'short' }, { token: token + '\n' }, { token: ' '.repeat(32) },
  ];
  for (const option of options) await assert.rejects(startServer({ service, token, ...option }));
  const server = await startServer({ service, token, host: '0.0.0.0', allowedHosts: ['tables.example.test'] });
  t.after(() => server.close());
  const endpoint = server.url.replace('0.0.0.0', '127.0.0.1') + '/tables';
  const headers = { Host: 'tables.example.test', Authorization: `Bearer ${token}` };
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  assert.equal((await fetch(endpoint, { headers: { ...headers, Origin: 'null' } })).status, 403);
});

test('IPv6 loopback uses a bracketed authority and the desktop origin remains available by default', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t, null).open()), token, host: '::1' });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/\[::1\]:\d+$/);
  const response = await fetch(server.url + '/tables', { headers: { Authorization: `Bearer ${token}`, Origin: 'null' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
});
