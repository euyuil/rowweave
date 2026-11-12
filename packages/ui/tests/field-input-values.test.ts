import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellValue, Field } from '../../contracts/src/index.js';
import { fromFormValue, toFormValue } from '../src/field-input-values.js';
import { cellDisplay, cellText } from '../../client/src/cell-values.js';

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

test('lookups display target formatting and copy type-preserving values or select labels', () => {
  const field: Field = { id: 'lookup', name: 'Budget', type: 'lookup',
    lookup: { relationFieldId: 'relation', fieldId: 'target' },
    lookupResult: { id: 'target', name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD' } };
  assert.equal(cellDisplay(field, [0, 25]), '$0.00, $25.00');
  assert.equal(cellText(field, [0, 25]), '[0,25]');
  assert.equal(toFormValue(field, [0, 25]), '[0,25]');
  field.lookup!.operation = 'sum';
  assert.equal(cellDisplay(field, 25), '$25.00');
  assert.equal(cellText(field, 25), '25');
  assert.equal(toFormValue(field, 25), '25');
  field.lookup!.operation = 'count';
  assert.equal(cellDisplay(field, 2), '2');
  field.lookup!.operation = 'values';
  field.lookupResult = { id: 'target', name: 'Tags', type: 'multiSelect', options: [{ id: 'blue', name: '蓝色' }] };
  assert.equal(cellDisplay(field, ['blue', 'blue']), '蓝色, 蓝色');
  assert.equal(cellText(field, ['blue', 'blue']), '["蓝色","蓝色"]');
  assert.throws(() => fromFormValue(field, null), /read-only/);
});
