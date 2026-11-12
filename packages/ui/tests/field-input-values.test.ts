import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellValue, Field } from '../../contracts/src/index.js';
import { fromFormValue, toFormValue } from '../src/field-input-values.js';

test('record forms preserve nulls, empty text, false, zero and stable select IDs', () => {
  const cases: Array<[Field, CellValue]> = [
    [{ id: 'a', name: 'Text', type: 'text' }, ''],
    [{ id: 'a', name: 'Text', type: 'text' }, null],
    [{ id: 'a', name: 'Number', type: 'number' }, 0],
    [{ id: 'a', name: 'Checked', type: 'checkbox', required: true }, false],
    [{ id: 'a', name: 'Status', type: 'singleSelect', options: [{ id: 'stable', name: 'Renamed' }] }, 'stable'],
    [{ id: 'a', name: 'Tags', type: 'multiSelect', options: [{ id: 'stable', name: 'Renamed' }] }, ['stable']],
    [{ id: 'a', name: 'Tags', type: 'multiSelect', options: [] }, []],
  ];
  for (const [field, value] of cases) assert.deepEqual(fromFormValue(field, toFormValue(field, value)), value);
});

test('UTC date-time form values retain milliseconds and accept minute-resolution input', () => {
  const field: Field = { id: 'a', name: 'Time', type: 'datetime' };
  assert.equal(toFormValue(field, '2026-11-12T09:30:45.123Z'), '2026-11-12T09:30:45.123');
  assert.equal(fromFormValue(field, '2026-11-12T09:30:45.123'), '2026-11-12T09:30:45.123Z');
  assert.equal(fromFormValue(field, '2026-11-12T09:30'), '2026-11-12T09:30:00.000Z');
  assert.throws(() => fromFormValue(field, '2026-02-30T09:30'));
});
