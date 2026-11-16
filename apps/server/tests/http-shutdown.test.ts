import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

for (const [name, headers] of [
  ['an unused connection', ''],
  ['incomplete request headers', 'POST /tables HTTP/1.1\r\nHost: '],
]) {
  test(`HTTP shutdown closes ${name} without waiting for a request`, async t => {
    const service = new RecordService(fixture(t, null).open());
    const server = await startServer({ service, token: 'a'.repeat(32) });
    const url = new URL(server.url);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const errors: string[] = [];
    socket.on('error', (error: NodeJS.ErrnoException) => errors.push(error.code ?? error.message));
    const disconnected = new Promise<void>(resolve => { socket.once('close', () => resolve()); });
    socket.resume();
    let closing: Promise<void> | undefined;
    const timer = new AbortController();
    try {
      await once(socket, 'connect');
      if (headers) await new Promise<void>(resolve => { socket.write(headers, () => resolve()); });
      closing = server.close();
      assert.equal(await Promise.race([
        Promise.all([closing, disconnected]).then(() => true), setTimeout(2_000, false, { signal: timer.signal }),
      ]), true, 'An unaccepted request must not hold the workspace open.');
      assert.deepEqual(service.listTables(), []);
      assert.ok(errors.every(code => code === 'ECONNRESET'));
    } finally {
      timer.abort();
      socket.destroy();
      await (closing ?? server.close());
    }
  });
}
