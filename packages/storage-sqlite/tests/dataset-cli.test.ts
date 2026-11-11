import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../src/record-store.js';

test('dataset generation preserves deterministic values and refuses to overwrite an existing database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-dataset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'prototype.sqlite');
  const run = promisify(execFile);
  await run(process.execPath, ['scripts/generate-dataset.mjs', database, '12', '4']);
  const store = new SqliteRecordStore(database);
  try { assert.equal(store.getTable().total, 12); assert.equal(store.getTable().fields.length, 4); }
  finally { store.close(); }
  const original = await readFile(database);
  await assert.rejects(run(process.execPath, ['scripts/generate-dataset.mjs', database, '20', '6']));
  assert.deepEqual(await readFile(database), original);
});
