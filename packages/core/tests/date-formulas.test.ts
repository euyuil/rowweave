import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field, ScalarValue } from '../../contracts/src/index.js';
import { compileFormula } from '../src/formulas.js';

type ResultType = NonNullable<Field['formula']>['resultType'];
const calculate = (expression: string, resultType: ResultType = 'number') =>
  compileFormula({ id: 'result', name: 'Result', type: 'formula', formula: { expression, resultType } }).calculate({}, {});

test('date formulas construct, extract and normalize calendar values with explicit UTC semantics', () => {
  const cases: Array<[string, ResultType, ScalarValue]> = [
    ['DATE(2024, 2, 29)', 'date', '2024-02-29'],
    ['DATE(0, 2, 29)', 'date', '0000-02-29'],
    ['DATEVALUE("2024-03-01T00:15:00+08:00")', 'date', '2024-02-29'],
    ['DATETIMEVALUE("2024-02-29")', 'datetime', '2024-02-29T00:00:00.000Z'],
    ['DATETIMEVALUE("2024-03-01T00:15:00.12+08:00")', 'datetime', '2024-02-29T16:15:00.120Z'],
    ['YEAR("2024-01-01T00:00:00+01:00")', 'number', 2023],
    ['MONTH("2024-02-29")', 'number', 2],
    ['DAY("2024-02-29")', 'number', 29],
    ['WEEKDAY("2024-03-03")', 'number', 7],
    ['WEEKDAY("2024-03-04")', 'number', 1],
    ['HOUR("2024-03-01T00:15:16+08:00")', 'number', 16],
    ['MINUTE("2024-03-01T00:15:16+08:00")', 'number', 15],
    ['SECOND("2024-03-01T00:15:16+08:00")', 'number', 16],
    ['"2024-03-01T00:15:00+08:00"', 'datetime', '2024-02-29T16:15:00.000Z'],
  ];
  for (const [expression, type, expected] of cases) assert.deepEqual(calculate(expression, type), { value: expected }, expression);
});

test('date arithmetic clamps calendar additions and counts signed complete intervals', () => {
  const cases: Array<[string, ResultType, ScalarValue]> = [
    ['DATEADD("2024-01-31", 1, "month")', 'date', '2024-02-29'],
    ['DATEADD("2024-02-29", 1, "year")', 'date', '2025-02-28'],
    ['DATEADD("2024-03-01", -1, "day")', 'date', '2024-02-29'],
    ['DATEADD("2024-03-01", 2, "WEEK")', 'date', '2024-03-15'],
    ['DATEADD("2024-03-10T01:30:00-08:00", 1, "day")', 'datetime', '2024-03-11T09:30:00.000Z'],
    ['DATEADD(DATETIMEVALUE("2024-03-01"), 90, "minute")', 'datetime', '2024-03-01T01:30:00.000Z'],
    ['DATEDIFF("2024-01-31", "2024-02-29", "month")', 'number', 1],
    ['DATEDIFF("2024-02-29", "2024-01-31", "month")', 'number', -1],
    ['DATEDIFF("2024-01-15", "2024-02-14", "month")', 'number', 0],
    ['DATEDIFF("2024-03-10T00:00:00-08:00", "2024-03-11T00:00:00-07:00", "hour")', 'number', 23],
    ['DATEDIFF("2024-03-01", "2024-03-01T23:59:59Z", "day")', 'number', 0],
    ['DATEDIFF("2024-02-29", "2024-03-01", "day")', 'number', 1],
  ];
  for (const [expression, type, expected] of cases) assert.deepEqual(calculate(expression, type), { value: expected }, expression);
});

test('invalid dates, units, types and overflows remain visible while nulls and lazy branches retain their semantics', () => {
  for (const expression of [
    'DATE(2023, 2, 29)', 'DATE(2024, 13, 1)', 'DATE(2024.5, 1, 1)', 'DATE(-1, 1, 1)', 'DATE(10000, 1, 1)',
    'DATEVALUE("03/01/2024")', 'DATETIMEVALUE("2024-03-01T00:00:00")', 'YEAR(1)', 'HOUR("2024-03-01")',
    'DATEADD("2024-03-01", 1, "hour")', 'DATEADD("2024-03-01", 1.5, "day")',
    'DATEADD("2024-03-01", 9007199254740992, "day")', 'DATEADD("9999-12-31", 1, "day")',
    'DATEDIFF("2024-01-01", "2024-02-01", "__proto__")',
  ]) {
    const result = calculate(expression, 'text');
    assert.equal(result.value, null, expression); assert.ok(result.error, expression);
  }
  assert.match(calculate('"2023-02-29"', 'date').error!, /valid date result/);
  assert.match(calculate('"2024-02-29"', 'datetime').error!, /valid datetime result/);
  assert.match(calculate('"0000-01-01T00:00:00+01:00"', 'datetime').error!, /0000 and 9999/);
  assert.match(calculate('1', 'date').error!, /date result/);
  assert.deepEqual(calculate('DATE(NULL, 2, 29)', 'date'), { value: null });
  assert.deepEqual(calculate('IF(FALSE, DATE(2023, 2, 29), DATE(2024, 2, 29))', 'date'), { value: '2024-02-29' });
  assert.throws(() => calculate('DATE(2024, 2)'), { code: 'INVALID_FORMULA' });
});
