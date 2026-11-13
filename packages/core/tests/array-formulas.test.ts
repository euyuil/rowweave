import test from 'node:test';
import assert from 'node:assert/strict';
import type { CellValue, Field, ScalarValue } from '../../contracts/src/index.js';
import { compileFormula } from '../src/formulas.js';
import { maxFormulaArrayItems } from '../src/array-formulas.js';

type ResultType = NonNullable<Field['formula']>['resultType'];
const calculate = (expression: string, resultType: ResultType = 'number', values: Record<string, CellValue> = {}) =>
  compileFormula({ id: 'result', name: 'Result', type: 'formula', formula: { expression, resultType } }).calculate(values, {});

test('array formulas preserve order, scalar types, nulls and explicit selection semantics', () => {
  const cases: Array<[string, ResultType, ScalarValue]> = [
    ['ARRAYLEN(ARRAY(1, NULL, FALSE, "", 1))', 'number', 5],
    ['ARRAYCOUNT(ARRAY(1, NULL, FALSE, "", 1))', 'number', 4],
    ['ARRAYCOUNT(ARRAYUNIQUE(ARRAY(1, "1", 1, NULL, FALSE)))', 'number', 3],
    ['ARRAYJOIN(ARRAYUNIQUE(ARRAY(1, "1", 1, NULL, FALSE)), "|")', 'text', '1|1||false'],
    ['ARRAYJOIN(ARRAY("a", NULL, "b"))', 'text', 'a, , b'],
    ['ARRAYLEN(ARRAYCOMPACT(ARRAY(NULL, FALSE, "", 0)))', 'number', 3],
    ['ARRAYGET(ARRAY("first", "second"), 2)', 'text', 'second'],
    ['ARRAYGET(ARRAY("first"), 2)', 'text', null],
    ['ARRAYCONTAINS(ARRAY(1), "1")', 'checkbox', false],
    ['ARRAYCONTAINS(ARRAY(NULL, 1), NULL)', 'checkbox', true],
    ['ARRAYLEN(IF(TRUE, ARRAY(1, 2), 1 / 0))', 'number', 2],
    ['ARRAYLEN(COALESCE(NULL, ARRAY(), 1 / 0))', 'number', 0],
    ['ARRAYGET(ARRAY(DATE(2024, 2, 29)), 1)', 'date', '2024-02-29'],
  ];
  for (const [expression, type, expected] of cases) assert.deepEqual(calculate(expression, type), { value: expected }, expression);
  assert.deepEqual(calculate('DATEADD(ARRAYGET([dates], 1), 1, "day")', 'date', { dates: ['2024-02-29'] }), { value: '2024-03-01' });
});

test('numeric array calculations skip only nulls and distinguish empty, zero and invalid values', () => {
  assert.deepEqual(calculate('ARRAYSUM(ARRAY(1, NULL, -1))'), { value: 0 });
  assert.deepEqual(calculate('ARRAYAVERAGE(ARRAY(1, NULL, 2))'), { value: 1.5 });
  assert.deepEqual(calculate('ARRAYMIN(ARRAY(2, NULL, -1))'), { value: -1 });
  assert.deepEqual(calculate('ARRAYMAX(ARRAY(-2, NULL, -1))'), { value: -1 });
  for (const name of ['ARRAYSUM', 'ARRAYAVERAGE', 'ARRAYMIN', 'ARRAYMAX']) {
    assert.deepEqual(calculate(name + '(ARRAY())'), { value: null });
    assert.deepEqual(calculate(name + '(ARRAY(NULL))'), { value: null });
    assert.deepEqual(calculate(name + '(NULL)'), { value: null });
    for (const value of ['FALSE', '""', '"1"']) assert.match(calculate(name + '(ARRAY(1, ' + value + '))').error!, /require numbers/);
  }
  assert.deepEqual(calculate('ARRAYCOUNT(ARRAY())'), { value: 0 });
  assert.deepEqual(calculate('ARRAYCOUNT(NULL)'), { value: null });
  assert.match(calculate('ARRAYSUM(ARRAY(1e308, 1e308))').error!, /finite/);
});

test('array evaluation rejects implicit coercion, nested arrays, invalid positions and oversized work', () => {
  for (const expression of [
    'ARRAY(1)', 'CONCAT(ARRAY(1))', 'ARRAY(1) == ARRAY(1)', 'ARRAY(1) + 2', 'IF(ARRAY(TRUE), 1, 0)',
    'ARRAYLEN("text")', 'ARRAYLEN(ARRAY(ARRAY(1)))', 'ARRAYGET(ARRAY(1), 0)', 'ARRAYGET(ARRAY(1), 1.5)',
    'ARRAYCONTAINS(ARRAY(1), ARRAY(1))', 'ARRAYJOIN(ARRAY(1), 1)',
  ]) { const result = calculate(expression); assert.equal(result.value, null, expression); assert.ok(result.error, expression); }
  assert.equal(calculate('ARRAYLEN([values])', 'number', { values: Array(maxFormulaArrayItems).fill(1) }).value, maxFormulaArrayItems);
  assert.match(calculate('ARRAYLEN([values])', 'number', { values: Array(maxFormulaArrayItems + 1).fill(1) }).error!, /40,000/);
  assert.match(calculate('ARRAYJOIN([values], "")', 'text', { values: ['x'.repeat(10_000), 'y'] }).error!, /10,000|10000/);
  assert.throws(() => calculate('ARRAYGET(ARRAY(1))'), { code: 'INVALID_FORMULA' });
});
