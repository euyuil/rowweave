import { maxTextLength, type CellValue, type Field, type ScalarValue, type Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';

type Expression = { kind: 'literal'; value: ScalarValue } | { kind: 'reference'; id: string }
  | { kind: 'operation'; name: string; args: Expression[] };
interface Token { kind: string; text: string; start: number; end: number }
const fail = (message: string): never => { throw new ServiceError('INVALID_FORMULA', message); };

function tokenize(source: string): Token[] {
  if (!source.trim() || source.length > 4096) fail('Use a formula between 1 and 4,096 characters.');
  const tokens: Token[] = [];
  const pattern = /\s+|\[(?:"(?:[^"\\]|\\.)*"|[^\]\r\n]+)\]|"(?:[^"\\]|\\.)*"|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|>=|<=|!=|==|[+*/%(),<>\-]/gy;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) fail(`Unexpected character at position ${position + 1}.`);
    const text = match![0];
    const start = position;
    position = pattern.lastIndex;
    if (/^\s/.test(text)) continue;
    const kind = text[0] === '[' ? 'reference' : text[0] === '"' ? 'string'
      : /^[\d.]/.test(text) ? 'number' : /^[A-Za-z_]/.test(text) ? 'name' : text;
    tokens.push({ kind, text, start, end: position });
    if (tokens.length > 512) fail('Use at most 512 formula tokens.');
  }
  return tokens;
}

function reference(token: Token): string {
  const inner = token.text.slice(1, -1);
  try { return inner.startsWith('"') ? JSON.parse(inner) as string : inner; }
  catch { return fail('Use a valid JSON string inside a quoted field reference.'); }
}

export function rewriteFormulaReferences(source: string, resolve: (reference: string) => string): string {
  const tokens = tokenize(source).filter(token => token.kind === 'reference');
  let result = '', position = 0;
  for (const token of tokens) {
    result += source.slice(position, token.start) + `[${JSON.stringify(resolve(reference(token)))}]`;
    position = token.end;
  }
  return result + source.slice(position);
}

const arities: Record<string, [number, number]> = {
  IF: [3, 3], COALESCE: [2, 20], CONCAT: [1, 20], LOWER: [1, 1], UPPER: [1, 1],
  TRIM: [1, 1], LEN: [1, 1], ROUND: [1, 2], ABS: [1, 1], AND: [2, 20], OR: [2, 20], NOT: [1, 1],
};
const precedence: Record<string, number> = { '==': 1, '!=': 1, '>': 1, '>=': 1, '<': 1, '<=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '%': 3 };

function parse(source: string): { expression: Expression; references: Set<string> } {
  const tokens = tokenize(source);
  const references = new Set<string>();
  let position = 0;
  const take = (kind: string) => {
    if (tokens[position]?.kind !== kind) fail(`Expected ${kind} at token ${position + 1}.`);
    return tokens[position++]!;
  };
  function expression(minimum = 0, depth = 0): Expression {
    if (depth > 40) fail('Formula expressions may be nested up to 40 levels.');
    const token = tokens[position++];
    if (!token) return fail('The formula is incomplete.');
    let left: Expression;
    if (token.kind === 'number') {
      if (!Number.isFinite(Number(token.text))) fail('Formula numbers must be finite.');
      left = { kind: 'literal', value: Number(token.text) };
    } else if (token.kind === 'string') {
      try { left = { kind: 'literal', value: JSON.parse(token.text) as string }; }
      catch { return fail('Use valid JSON string literals.'); }
    } else if (token.kind === 'reference') {
      const id = reference(token);
      references.add(id);
      left = { kind: 'reference', id };
    } else if (token.kind === '+' || token.kind === '-') {
      left = { kind: 'operation', name: `unary${token.kind}`, args: [expression(4, depth + 1)] };
    } else if (token.kind === '(') {
      left = expression(0, depth + 1);
      take(')');
    } else if (token.kind === 'name') {
      const name = token.text.toUpperCase();
      if (['TRUE', 'FALSE', 'NULL'].includes(name)) left = { kind: 'literal', value: name === 'NULL' ? null : name === 'TRUE' };
      else {
        const arity = arities[name];
        if (!arity) return fail(`Unknown formula function: ${token.text}.`);
        take('(');
        const args: Expression[] = [];
        if (tokens[position]?.kind !== ')') {
          do {
            args.push(expression(0, depth + 1));
            if (tokens[position]?.kind !== ',') break;
            position++;
          } while (true);
        }
        take(')');
        if (args.length < arity[0] || args.length > arity[1]) fail(`${name} expects ${arity[0]}–${arity[1]} arguments.`);
        left = { kind: 'operation', name, args };
      }
    } else return fail(`Unexpected token: ${token.text}.`);
    while (position < tokens.length) {
      const operator = tokens[position]!.text;
      const rank = precedence[operator];
      if (rank === undefined || rank < minimum) break;
      position++;
      left = { kind: 'operation', name: operator, args: [left, expression(rank + 1, depth + 1)] };
    }
    return left;
  }
  const result = expression();
  if (position !== tokens.length) fail(`Unexpected token: ${tokens[position]!.text}.`);
  return { expression: result, references };
}

class CalculationError extends Error {}
const calculationError = (message: string): never => { throw new CalculationError(message); };
function number(value: ScalarValue): number {
  return typeof value === 'number' ? value : calculationError('Expected a number.');
}
function boolean(value: ScalarValue): boolean {
  return typeof value === 'boolean' ? value : calculationError('Expected true or false.');
}
function text(value: ScalarValue): string {
  return typeof value === 'string' ? value : calculationError('Expected text.');
}
function bounded(value: ScalarValue): ScalarValue {
  if (typeof value === 'number' && !Number.isFinite(value)) calculationError('The result is not a finite number.');
  if (typeof value === 'string' && value.length > maxTextLength) calculationError(`The result exceeds ${maxTextLength} characters.`);
  return value;
}

function evaluate(node: Expression, values: Record<string, CellValue>, errors: Record<string, string>): ScalarValue {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'reference') {
    if (errors[node.id]) calculationError('A referenced formula has an error.');
    return (values[node.id] ?? null) as ScalarValue;
  }
  const { name, args } = node;
  const arg = (index: number) => evaluate(args[index]!, values, errors);
  if (name === 'IF') {
    const condition = arg(0);
    return condition === null ? null : arg(boolean(condition) ? 1 : 2);
  }
  if (name === 'COALESCE') {
    for (let i = 0; i < args.length; i++) { const value = arg(i); if (value !== null) return value; }
    return null;
  }
  const inputs = args.map(child => evaluate(child, values, errors));
  const a = inputs[0]!, b = inputs[1]!;
  if (name === '==' || name === '!=') return name === '==' ? a === b : a !== b;
  if (name === 'CONCAT') return bounded(inputs.map(value => value === null ? '' : String(value)).join(''));
  if (inputs.some(value => value === null)) return null;
  switch (name) {
    case '+': return bounded(number(a) + number(b));
    case '-': return bounded(number(a) - number(b));
    case '*': return bounded(number(a) * number(b));
    case '/': case '%':
      if (number(b) === 0) return calculationError('Division by zero.');
      return bounded(name === '/' ? number(a) / number(b) : number(a) % number(b));
    case 'unary+': return number(a);
    case 'unary-': return -number(a);
    case '>': case '>=': case '<': case '<=': {
      if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) {
        return calculationError('Compare two numbers or two text values.');
      }
      return name === '>' ? a > b : name === '>=' ? a >= b : name === '<' ? a < b : a <= b;
    }
    case 'LOWER': return bounded(text(a).toLowerCase());
    case 'UPPER': return bounded(text(a).toUpperCase());
    case 'TRIM': return text(a).trim();
    case 'LEN': return [...text(a)].length;
    case 'ABS': return Math.abs(number(a));
    case 'ROUND': {
      const precision = inputs.length === 1 ? 0 : number(b);
      if (!Number.isInteger(precision) || precision < 0 || precision > 10) return calculationError('ROUND precision must be 0–10.');
      return bounded(Math.round(number(a) * 10 ** precision) / 10 ** precision);
    }
    case 'AND': return inputs.map(boolean).every(Boolean);
    case 'OR': return inputs.map(boolean).some(Boolean);
    case 'NOT': return !boolean(a);
    default: throw new Error(`Unchecked formula operation: ${name}`);
  }
}

export function compileFormulas(table: Pick<Table, 'fields'>): (values: Record<string, CellValue>) => { values: Record<string, CellValue>; formulaErrors?: Record<string, string> } {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const formulas = new Map(table.fields.filter(field => field.type === 'formula').map(field => [field.id, parse(field.formula!.expression)]));
  const ordered: Array<{ field: Field; expression: Expression }> = [];
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail('Formula fields cannot form a dependency cycle.');
    visiting.add(id);
    const formula = formulas.get(id)!;
    for (const reference of formula.references) {
      const field = fields.get(reference);
      if (!field) fail(`Formula references a missing field: ${reference}. Remove or update its dependent formulas first.`);
      if (['relation', 'lookup', 'multiSelect'].includes(field!.type)) fail(`${field!.name}: formulas require same-record scalar fields.`);
      if (formulas.has(reference)) visit(reference);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push({ field: fields.get(id)!, expression: formula.expression });
  }
  for (const id of formulas.keys()) visit(id);
  return values => {
    const errors: Record<string, string> = {};
    for (const { field, expression } of ordered) {
      try {
        const result = bounded(evaluate(expression, values, errors));
        const expected = { text: 'string', number: 'number', checkbox: 'boolean' }[field.formula!.resultType];
        if (result !== null && typeof result !== expected) calculationError(`Expected a ${field.formula!.resultType} result.`);
        values[field.id] = result;
      } catch (error) {
        if (!(error instanceof CalculationError)) throw error;
        values[field.id] = null;
        errors[field.id] = error.message;
      }
    }
    return { values, ...(Object.keys(errors).length ? { formulaErrors: errors } : {}) };
  };
}
