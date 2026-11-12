import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connectionChoice, readConnectionSettings, writeConnectionSettings } from '../src/connection-settings.js';

test('connection preferences persist only encrypted credentials and preserve prior settings when encryption fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'connection.json');
  const token = randomBytes(32).toString('hex');
  const encrypted = randomBytes(48);
  const decrypt = async (value: Buffer) => { assert.deepEqual(value, encrypted); return token; };
  assert.deepEqual(await readConnectionSettings(path, decrypt), { mode: 'local' });
  const choice = connectionChoice({ mode: 'remote', url: 'https://tables.example.test/workspace/', token });
  await writeConnectionSettings(path, choice, async value => { assert.equal(value, token); return encrypted; });
  const stored = await readFile(path, 'utf8');
  assert.ok(!stored.includes(token));
  assert.deepEqual(JSON.parse(stored), { format: 1, mode: 'remote', url: 'https://tables.example.test/workspace', encryptedToken: encrypted.toString('base64') });
  assert.deepEqual(await readConnectionSettings(path, decrypt), choice);
  await assert.rejects(writeConnectionSettings(path, choice, async () => { throw new Error('Encryption unavailable'); }), /Encryption unavailable/);
  assert.equal(await readFile(path, 'utf8'), stored);
  await assert.rejects(readConnectionSettings(path, async () => { throw new Error('Cannot decrypt'); }), /Cannot decrypt/);
  assert.equal(await readFile(path, 'utf8'), stored);
  await writeConnectionSettings(path, { mode: 'local' }, async () => { throw new Error('Local mode must not encrypt'); });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { format: 1, mode: 'local' });
});

test('connection boundaries reject malformed settings without exposing entered credentials or silently opening a local workspace', async t => {
  const token = randomBytes(32).toString('hex');
  for (const input of [null, [], {}, { mode: 'other' }, { mode: 'remote' },
    { mode: 'remote', url: 'file:///workspace', token }, { mode: 'remote', url: 'http://user:private-value@example.test', token },
    { mode: 'remote', url: 'https://tables.example.test?token=private-value', token },
    { mode: 'remote', url: 'https://tables.example.test#private-value', token },
    { mode: 'remote', url: 'https://tables.example.test', token: token + '\n' },
  ]) assert.throws(() => connectionChoice(input), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(token) && !error.message.includes('private-value'));
    return true;
  });
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'connection.json');
  for (const contents of ['{', 'null', '{"format":2,"mode":"local"}', '{"format":1,"mode":"other"}', '{"format":1,"mode":"remote"}']) {
    await writeFile(path, contents);
    await assert.rejects(readConnectionSettings(path, async () => token));
    assert.equal(await readFile(path, 'utf8'), contents);
  }
});
