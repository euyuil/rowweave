import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeCsvFile } from '../src/csv-file.js';

test('CSV saving replaces a complete file and leaves existing content intact when replacement fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-csv-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'export.csv');
  await writeFile(path, 'old export');
  const csv = '\uFEFFName\r\n中文 🌱\r\n';
  await writeCsvFile(path, csv);
  assert.equal(await readFile(path, 'utf8'), csv);
  const occupied = join(directory, 'occupied.csv');
  await mkdir(occupied);
  await writeFile(join(occupied, 'keep.txt'), 'existing content');
  await assert.rejects(writeCsvFile(occupied, csv));
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'existing content');
  assert.equal(await readFile(path, 'utf8'), csv);
  assert.deepEqual((await readdir(directory)).sort(), ['export.csv', 'occupied.csv']);
});
