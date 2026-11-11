import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';

test('pages preserve stable identities and persisted schema across restarts', t => {
  const data = fixture(t);
  const store = data.open();
  const first = store.readPage(0, 5);
  const second = store.readPage(5, 5);
  assert.equal(store.getTable().total, 12);
  assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 10);
  assert.equal(first.records[0]?.values['field_1'], null);
  store.close();
  const reopened = data.open();
  assert.deepEqual(reopened.readPage(0, 5), first);
  assert.equal(reopened.getTable().fields[0]?.id, 'field_1');
  assert.deepEqual(reopened.readPage(100, 5).records, []);
});

test('the service rejects invalid or unbounded pagination', t => {
  const service = new RecordService(fixture(t).open());
  for (const [offset, limit] of [[-1, 10], [0, 0], [0, 501], [0.5, 10], [NaN, 10], [0, Infinity]] as const) {
    assert.throws(() => service.readPage(offset, limit), ServiceError);
  }
  assert.equal(service.readPage(10, 5).records.length, 2);
});
