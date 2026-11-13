import { maxTextLength, type CellValue, type ScalarValue } from '../../contracts/src/index.js';
import { calculationError } from './calculation-error.js';

export const maxFormulaArrayItems = 40_000;
export const arrayFunctionArities: Record<string, [number, number]> = {
  ARRAY: [0, 20], ARRAYLEN: [1, 1], ARRAYCOUNT: [1, 1], ARRAYJOIN: [1, 2],
  ARRAYUNIQUE: [1, 1], ARRAYCOMPACT: [1, 1], ARRAYGET: [2, 2], ARRAYCONTAINS: [2, 2],
  ARRAYSUM: [1, 1], ARRAYAVERAGE: [1, 1], ARRAYMIN: [1, 1], ARRAYMAX: [1, 1],
};

export function scalarFormulaValue(value: CellValue): ScalarValue {
  return Array.isArray(value) ? calculationError('Expected a single value. Use an array function to read or summarize a collection.') : value;
}

export function calculateArrayFunction(name: string, inputs: CellValue[]): CellValue {
  if (name === 'ARRAY') return inputs.map(scalarFormulaValue);
  const source = inputs[0]!;
  if (source === null) return null;
  if (!Array.isArray(source)) return calculationError('Expected an array of values.');
  if (source.length > maxFormulaArrayItems) return calculationError('Use arrays of at most 40,000 items.');
  switch (name) {
    case 'ARRAYLEN': return source.length;
    case 'ARRAYCOUNT': return source.filter(value => value !== null).length;
    case 'ARRAYUNIQUE': return [...new Set(source)];
    case 'ARRAYCOMPACT': return source.filter(value => value !== null);
    case 'ARRAYGET': {
      const index = inputs[1]!;
      if (index === null) return null;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1) return calculationError('ARRAYGET needs a positive whole-number position, starting at 1.');
      return source[index - 1] ?? null;
    }
    case 'ARRAYCONTAINS': return source.includes(scalarFormulaValue(inputs[1]!));
    case 'ARRAYJOIN': {
      const separator = inputs.length === 1 ? ', ' : inputs[1];
      if (separator === null) return null;
      if (typeof separator !== 'string') return calculationError('ARRAYJOIN needs a text separator.');
      const parts: string[] = [];
      let length = 0;
      for (const value of source) {
        const part = value === null ? '' : String(value);
        length += part.length + (parts.length ? separator.length : 0);
        if (length > maxTextLength) return calculationError('The joined result exceeds ' + maxTextLength + ' characters.');
        parts.push(part);
      }
      return parts.join(separator);
    }
    case 'ARRAYSUM': case 'ARRAYAVERAGE': case 'ARRAYMIN': case 'ARRAYMAX': {
      let count = 0, result = 0;
      for (const value of source) {
        if (value === null) continue;
        if (typeof value !== 'number') return calculationError('Numeric array calculations require numbers; only null values are skipped.');
        result = name === 'ARRAYMIN' ? count ? Math.min(result, value) : value
          : name === 'ARRAYMAX' ? count ? Math.max(result, value) : value : result + value;
        count++;
      }
      if (!count) return null;
      if (name === 'ARRAYAVERAGE') result /= count;
      if (!Number.isFinite(result)) return calculationError('The array result is not a finite number.');
      return result;
    }
    default: throw new Error('Unchecked array formula operation: ' + name);
  }
}
