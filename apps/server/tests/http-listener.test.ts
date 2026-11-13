import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenHttp } from '../src/http-listener.js';
import { networkPolicy } from '../src/network.js';

test('explicit restricted HTTP ports fail configuration while zero selects an automatic port', () => {
  for (const port of [1, 22, 1719, 5060, 6000, 6667, 10080]) {
    assert.throws(() => networkPolicy({ port }), /restricted by HTTP clients/);
  }
  for (const port of [0, 80, 443, 4317, 65535]) assert.equal(networkPolicy({ port }).port, port);
});

test('automatic HTTP startup replaces a restricted allocation before exposing a usable listener', async t => {
  const server = createServer((_request, response) => response.end('ready'));
  let closes = 0, allocations = 0;
  server.on('close', () => closes++);
  const address = server.address.bind(server);
  t.mock.method(server, 'address', () => {
    const allocated = address() as AddressInfo;
    // Simulate the OS reporting a restricted ephemeral port without reserving a fixed port on the host.
    return ++allocations === 1 ? { ...allocated, port: 6667 } : allocated;
  });
  const accepted = await listenHttp(server, '127.0.0.1', 0);
  assert.ok(allocations >= 2); assert.equal(closes, allocations - 1);
  try { assert.equal(await (await fetch(`http://127.0.0.1:${accepted.port}`)).text(), 'ready'); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  assert.equal(server.listening, false); assert.equal(closes, allocations);
});

test('a repeated restricted allocation fails with guidance and leaves no listening socket', async t => {
  const server = createServer();
  let closes = 0;
  server.on('close', () => closes++);
  const address = server.address.bind(server);
  t.mock.method(server, 'address', () => ({ ...address() as AddressInfo, port: 6667 }));
  await assert.rejects(listenHttp(server, '127.0.0.1', 0), /repeatedly returned restricted HTTP port 6667.*ROWWEAVE_PORT/);
  assert.equal(closes, 2); assert.equal(server.listening, false);
});

test('explicit bind failures propagate without choosing a different configured port', async () => {
  const occupied = createServer(), candidate = createServer();
  const address = await listenHttp(occupied, '127.0.0.1', 0);
  try {
    await assert.rejects(listenHttp(candidate, '127.0.0.1', address.port), { code: 'EADDRINUSE' });
    assert.equal(candidate.listening, false);
  } finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
});
