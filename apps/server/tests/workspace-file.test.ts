import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { SqliteRecordStore } from '../../../packages/storage-sqlite/src/record-store.js';

const run = promisify(execFile);

test('the workspace-file command creates restorable snapshots with JSON results and reports errors without success output', async t => {
  const data = fixture(t);
  const store = data.open();
  const command = resolve('dist/apps/server/src/workspace-file.js');
  const backup = join(dirname(data.path), 'backup with spaces.sqlite');
  const result = await run(process.execPath, [command, 'backup', data.path, backup]);
  assert.equal(JSON.parse(result.stdout).path, backup);
  assert.equal(JSON.parse(result.stdout).version, 9);
  assert.equal(result.stderr, '');
  const restored = join(dirname(data.path), 'restored.sqlite');
  assert.equal(JSON.parse((await run(process.execPath, [command, 'restore', backup, restored])).stdout).path, restored);
  const reopened = new SqliteRecordStore(restored);
  try { assert.deepEqual(reopened.readPage(0, 20), store.readPage(0, 20)); }
  finally { reopened.close(); }
  for (const args of [['backup', data.path, backup], ['restore', backup], ['unknown'], ['--unknown']]) {
    await assert.rejects(run(process.execPath, [command, ...args]), error => {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.equal(JSON.parse(failure.stderr).error.code, 'WORKSPACE_FILE_FAILED');
      return true;
    });
  }
  assert.match((await run(process.execPath, [command, '--help'])).stdout, /RowWeave workspace files/);
});
