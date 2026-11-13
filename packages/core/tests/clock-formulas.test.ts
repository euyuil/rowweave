import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFormula, compileFormulas } from '../src/formulas.js';
import type { Field } from '../../contracts/src/index.js';

const field = (expression: string, resultType: NonNullable<Field['formula']>['resultType'] = 'text'): Field =>
  ({ id: 'result', name: 'Result', type: 'formula', formula: { expression, resultType } });
const calculate = (expression: string, at = '2024-03-10T04:59:59.999Z', type: NonNullable<Field['formula']>['resultType'] = 'text') =>
  compileFormula(field(expression, type)).calculate({}, {}, new Date(at));

test('clock formulas use an injected minute snapshot and explicit named calendar zones', () => {
  assert.deepEqual(calculate('NOW()', undefined, 'datetime'), { value: '2024-03-10T04:59:00.000Z' });
  assert.deepEqual(calculate('TODAY()', undefined, 'date'), { value: '2024-03-10' });
  assert.equal(calculate('TODAY("America/New_York")').value, '2024-03-09');
  assert.equal(calculate('TODAY("America/New_York")', '2024-03-10T05:00:00Z').value, '2024-03-10');
  assert.equal(calculate('TODAY("America/New_York")', '2024-11-03T06:30:00Z').value, '2024-11-03');
  assert.equal(calculate('TODAY("Asia/Shanghai")', '2024-02-29T16:00:00Z').value, '2024-03-01');
  assert.equal(calculate('NOW()', '1969-12-31T23:59:59.999Z').value, '1969-12-31T23:59:00.000Z');
  assert.equal(calculate('DATEDIFF(NOW(), DATEADD(NOW(), 5, "minute"), "minute")', undefined, 'number').value, 5);
  assert.equal(calculate('ARRAYJOIN(ARRAY(NOW(), NOW()), "|")').value, '2024-03-10T04:59:00.000Z|2024-03-10T04:59:00.000Z');
  assert.equal(calculate('TODAY(NULL)').value, null);
  const result = compileFormulas({ fields: [field('NOW()', 'datetime')] }, { now: new Date('2024-02-29T12:00:44Z') })({});
  assert.equal(result.values['result'], '2024-02-29T12:00:00.000Z');
});

test('clock metadata, validation and errors preserve deterministic and lazy formula behavior', () => {
  assert.equal(compileFormula(field('"NOW()"')).clockDependent, false);
  assert.equal(compileFormula(field('IF(FALSE, NOW(), "value")')).clockDependent, true);
  assert.deepEqual(compileFormula(field('IF(FALSE, NOW(), "value")')).calculate({}, {}), { value: 'value' });
  assert.throws(() => compileFormula(field('NOW()')).calculate({}, {}), /service calculation time/);
  for (const expression of ['NOW(1)', 'TODAY("UTC", "UTC")']) assert.throws(() => compileFormula(field(expression)), { code: 'INVALID_FORMULA' });
  for (const expression of ['TODAY(3)', 'TODAY("")', 'TODAY("+08:00")', 'TODAY("Not/AZone")']) {
    const result = calculate(expression); assert.equal(result.value, null); assert.match(result.error!, /named time zone/);
  }
  assert.match(calculate('NOW()', undefined, 'number').error!, /number result/);
  assert.match(calculate('NOW()', '+010000-01-01T00:00:00Z').error!, /0000 and 9999/);
});
