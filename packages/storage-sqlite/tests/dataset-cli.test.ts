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

test('typed pressure datasets include usable schemas and mixed values within service batch limits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-typed-dataset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile);
  const database = join(directory, 'typed.sqlite');
  await run(process.execPath, ['scripts/generate-dataset.mjs', database, '100', '20', '--typed']);
  const store = new SqliteRecordStore(database);
  try {
    const [table] = store.listTables();
    assert.ok(table);
    assert.equal(table.total, 100);
    assert.equal(table.fields.length, 20);
    assert.deepEqual(new Set(table.fields.map(field => field.type)), new Set([
      'text', 'multiline', 'number', 'checkbox', 'date', 'datetime', 'singleSelect', 'multiSelect',
    ]));
    const rows = store.readPage(0, 100, table.id).records;
    const field = (name: string) => table.fields.find(field => field.name === name)!;
    assert.equal(rows[0]!.values[table.primaryFieldId], null);
    assert.equal(rows[1]!.values[field('Amount').id], 1.1);
    assert.equal(rows[1]!.values[field('Done').id], false);
    assert.equal(rows[1]!.values[field('Due').id], '2026-02-02');
    assert.equal(rows[1]!.values[field('Status').id], field('Status').options![1]!.id);
    assert.deepEqual(rows[1]!.values[field('Tags').id], field('Tags').options!.slice(0, 2).map(option => option.id));
    assert.match(rows[1]!.values[field('Notes').id] as string, /\n.*中文 🌱/);
    const values = rows.flatMap(row => Object.values(row.values));
    assert.ok(values.includes(''));
    assert.ok(values.some(value => typeof value === 'string' && value.length > 500));
  } finally { store.close(); }
  const narrow = join(directory, 'narrow.sqlite');
  await run(process.execPath, ['scripts/generate-dataset.mjs', narrow, '2001', '1', '--typed']);
  const narrowStore = new SqliteRecordStore(narrow);
  try { assert.equal(narrowStore.listTables()[0]!.total, 2001); }
  finally { narrowStore.close(); }
});
