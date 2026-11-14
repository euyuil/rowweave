import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { calendarDateLabel, calendarInitialValues, calendarKeyboardDate, calendarMonthLabel, calendarToday } from '../src/calendar-dates.js';

test('calendar navigation uses calendar dates across month ends and leap years', () => {
  assert.equal(calendarKeyboardDate('2024-02-29', 'ArrowRight'), '2024-03-01');
  assert.equal(calendarKeyboardDate('2024-02-29', 'ArrowUp'), '2024-02-22');
  assert.equal(calendarKeyboardDate('2024-02-29', 'Home'), '2024-02-26');
  assert.equal(calendarKeyboardDate('2024-02-29', 'End'), '2024-03-03');
  assert.equal(calendarKeyboardDate('2024-03-31', 'PageUp'), '2024-02-29');
  assert.equal(calendarKeyboardDate('2024-01-31', 'PageDown'), '2024-02-29');
  assert.equal(calendarKeyboardDate('2024-01-31', 'Enter'), undefined);
  assert.equal(calendarToday('Asia/Shanghai', Date.parse('2024-02-29T18:00:00Z')), '2024-03-01');
  assert.equal(calendarToday('America/Los_Angeles', Date.parse('2024-02-29T02:00:00Z')), '2024-02-28');
  assert.equal(calendarDateLabel('2024-02-29'), 'Thursday, February 29, 2024');
  assert.equal(calendarMonthLabel('2024-02'), 'February 2024');
});

test('date-seeded creation respects the saved zone, DST, skipped dates and read-only fields', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Creation dates' });
  for (const field of [{ name: 'Start', type: 'datetime' }, { name: 'End', type: 'datetime' },
    { name: 'Day', type: 'date' }, { name: 'Created', type: 'createdTime' }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const [, start, end, day, created] = table.fields.map(field => field.id) as [string, string, string, string, string];
  const config = { startFieldId: start, endFieldId: end, timeZone: 'America/New_York' };
  assert.deepEqual(calendarInitialValues(table, config, '2024-03-10').values, { [start]: '2024-03-10T05:00:00.000Z', [end]: '2024-03-10T05:00:00.000Z' });
  assert.deepEqual(calendarInitialValues(table, config, '2024-03-11').values, { [start]: '2024-03-11T04:00:00.000Z', [end]: '2024-03-11T04:00:00.000Z' });
  assert.deepEqual(calendarInitialValues(table, { ...config, timeZone: 'America/Sao_Paulo' }, '2018-11-04').values,
    { [start]: '2018-11-04T03:00:00.000Z', [end]: '2018-11-04T03:00:00.000Z' });
  assert.match(calendarInitialValues(table, { ...config, timeZone: 'Pacific/Apia' }, '2011-12-30').unavailable!, /does not occur/);
  assert.deepEqual(calendarInitialValues(table, { startFieldId: day, timeZone: 'Pacific/Apia' }, '2011-12-30').values, { [day]: '2011-12-30' });
  assert.match(calendarInitialValues(table, { startFieldId: created, timeZone: 'UTC' }, '2024-02-29').unavailable!, /read-only/);
  assert.deepEqual(calendarInitialValues(table, { ...config, endFieldId: created }, '2024-03-10').values, { [start]: '2024-03-10T05:00:00.000Z' });
});
