import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field } from '../../contracts/src/index.js';
import { selectedOptions, selectStyle } from '../src/select-colors.js';

test('select presentation uses current labels and colors without changing stable IDs or lookup order', () => {
  const field: Field = { id: 'status', name: 'Status', type: 'singleSelect', options: [
    { id: 'ready', name: 'Renamed 中文', color: '#0055aa' }, { id: 'done', name: '<Done>', color: '#ffee00' },
  ] };
  assert.deepEqual(selectedOptions(field, 'ready'), [field.options![0]]);
  assert.deepEqual(selectedOptions(field, null), []);
  field.type = 'multiSelect';
  assert.deepEqual(selectedOptions(field, ['done', 'ready']), [field.options![1], field.options![0]]);
  const lookup: Field = { id: 'lookup', name: 'Statuses', type: 'lookup', lookup: { relationFieldId: 'relation', fieldId: field.id }, lookupResult: field };
  assert.deepEqual(selectedOptions(lookup, ['done', null, 'ready', 'done']), [field.options![1], field.options![0], field.options![1]]);
  assert.deepEqual(selectedOptions(lookup, null), []);
  lookup.lookup!.operation = 'count';
  lookup.lookupResult = { id: 'number', name: 'Amount', type: 'number' };
  assert.equal(selectedOptions(lookup, 3), undefined);
  assert.equal(selectedOptions({ id: 'text', name: 'Text', type: 'text' }, 'ready'), undefined);
});

test('select labels use readable foregrounds for light, dark and unconfigured colors', () => {
  assert.deepEqual(selectStyle({ color: '#0055aa' }), { backgroundColor: '#0055aa', color: '#ffffff' });
  assert.deepEqual(selectStyle({ color: '#ffee00' }), { backgroundColor: '#ffee00', color: '#000000' });
  assert.deepEqual(selectStyle({}), { backgroundColor: '#e7edf8', color: '#000000' });
  assert.equal(selectStyle({ color: '#FFFFFF' }).color, '#000000');
  assert.equal(selectStyle({ color: '#000000' }).color, '#ffffff');
});
