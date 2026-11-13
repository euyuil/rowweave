import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field, FilterGroup } from '../../contracts/src/index.js';
import { filterCount, filterDraft, filterValue } from '../src/filter-draft.js';

test('filter forms retain nested groups and typed zero, false, option IDs and UTC values', () => {
  const fields: Field[] = [
    { id: 'amount', name: 'Amount', type: 'number', required: true },
    { id: 'done', name: 'Done', type: 'checkbox' },
    { id: 'tags', name: 'Tags', type: 'multiSelect', options: [{ id: 'stable', name: 'Renamed' }] },
    { id: 'time', name: 'Time', type: 'datetime' },
  ];
  const filter: FilterGroup = { conjunction: 'and', conditions: [
    { fieldId: 'amount', operator: 'gte', value: 0 },
    { conjunction: 'or', conditions: [{ fieldId: 'done', operator: 'eq', value: false }, { fieldId: 'tags', operator: 'hasAny', value: ['stable'] }] },
    { fieldId: 'time', operator: 'lt', value: '2026-11-12T09:30:00.000Z' },
  ] };
  const draft = filterDraft(filter, fields);
  assert.equal(filterCount(draft), 5);
  assert.deepEqual(filterValue(draft, fields), filter);
  assert.deepEqual(filterValue(filterDraft({ conjunction: 'or', conditions: [] }, fields), fields), { conjunction: 'or', conditions: [] });
  assert.deepEqual(filterValue({ conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'eq', value: null }] }, fields),
    { conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'eq', value: null }] });
});

test('relative filter drafts round-trip dynamic settings without converting them to fixed dates', () => {
  const fields: Field[] = [{ id: 'due', name: 'Due', type: 'date' }, { id: 'at', name: 'At', type: 'datetime' }];
  const filter: FilterGroup = { conjunction: 'or', conditions: [
    { fieldId: 'due', operator: 'relativeDate', relative: { period: 'pastDays', days: 7, timeZone: 'Asia/Shanghai' } },
    { fieldId: 'at', operator: 'relativeDate', relative: { period: 'thisWeek', timeZone: 'America/New_York' } },
  ] };
  assert.deepEqual(filterValue(filterDraft(filter, fields), fields), filter);
});
