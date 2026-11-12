import { maxCsvBytes, maxCsvCells, maxCsvRows, maxFields, type CellValue, type Field, type Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { parseTextValue, validateValue } from './field-values.js';
import { fieldText } from './field-display.js';
import { schemaObject, schemaVersion } from './schema-validation.js';

export interface CsvCell { text: string; quoted: boolean }
export interface CsvRow { row: number; cells: CsvCell[] }
export interface CheckedCsvImport {
  columns: string[];
  mapping: Array<string | null>;
  rows: Iterable<CsvRow>;
  validated: boolean;
}

function invalid(message: string): never { throw new ServiceError('INVALID_CSV', message); }
export function csvLimit(message: string): never { throw new ServiceError('CSV_LIMIT', message, 413); }

export function* parseCsv(text: string): Generator<CsvRow> {
  if (Buffer.byteLength(text, 'utf8') > maxCsvBytes) csvLimit('CSV files may contain at most 32 MiB of UTF-8 text.');
  let position = text.startsWith('\uFEFF') ? 1 : 0;
  let row = 0;
  let cellCount = 0;
  while (position < text.length) {
    row++;
    if (row > maxCsvRows + 1) csvLimit(`CSV files may contain at most ${maxCsvRows} data rows and a header.`);
    const cells: CsvCell[] = [];
    while (true) {
      const quoted = text[position] === '"';
      let value: string;
      if (quoted) {
        const start = ++position;
        let next = start;
        let escaped = false;
        while (true) {
          const quote = text.indexOf('"', next);
          if (quote === -1) invalid(`Row ${row}: unclosed quoted cell.`);
          position = quote + 1;
          if (text[position] !== '"') break;
          escaped = true;
          next = ++position;
        }
        value = text.slice(start, position - 1);
        if (escaped) value = value.replaceAll('""', '"');
        if (position < text.length && ![',', '\r', '\n'].includes(text[position]!)) {
          invalid(`Row ${row}: only a comma or line ending may follow a closing quote.`);
        }
      } else {
        const start = position;
        while (position < text.length && text[position] !== ',' && text[position] !== '\r' && text[position] !== '\n') {
          if (text[position] === '"') invalid(`Row ${row}: quote the entire cell to include a double quote.`);
          position++;
        }
        value = text.slice(start, position);
      }
      cells.push({ text: value, quoted });
      if (cells.length > maxFields) csvLimit(`CSV files support up to ${maxFields} columns.`);
      if (++cellCount > maxCsvCells + maxFields) csvLimit(`CSV files support up to ${maxCsvCells} cells plus a header.`);
      if (text[position] !== ',') break;
      position++;
    }
    if (text[position] === '\r') position++;
    if (text[position] === '\n') position++;
    yield { row, cells };
  }
}

export function prepareCsvImport(table: Table, input: unknown): CheckedCsvImport {
  const item = schemaObject(input);
  if (schemaVersion(item['expectedVersion']) !== table.version) {
    throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before importing.', 409);
  }
  if (typeof item['csv'] !== 'string' || typeof item['hasHeader'] !== 'boolean') invalid('Provide CSV text and a boolean hasHeader.');
  const rows = parseCsv(item['csv']);
  const first = rows.next().value as CsvRow | undefined;
  if (!first) invalid('The CSV file is empty.');
  const columns = first.cells.map((cell, index) => item['hasHeader'] ? cell.text : `Column ${index + 1}`);
  const fields = table.fields.filter(field => field.type !== 'lookup');
  const mapping = item['mapping'] === undefined ? columns.map(name => {
    const matches = item['hasHeader'] ? fields.filter(field => field.name === name) : [];
    return matches.length === 1 && columns.filter(column => column === name).length === 1 ? matches[0]!.id : null;
  }) : item['mapping'];
  if (!Array.isArray(mapping) || mapping.length !== columns.length || mapping.some(id => id !== null && !fields.some(field => field.id === id)) ||
      new Set(mapping.filter(id => id !== null)).size !== mapping.filter(id => id !== null).length) {
    invalid('Map each CSV column to a unique writable field ID or null to skip it.');
  }
  function* dataRows(): Generator<CsvRow> {
    let total = 0;
    let cells = 0;
    function count(row: CsvRow): CsvRow {
      if (++total > maxCsvRows) csvLimit(`Import up to ${maxCsvRows} data rows at a time.`);
      cells += Math.max(row.cells.length, fields.length);
      if (cells > maxCsvCells) csvLimit(`Import up to ${maxCsvCells} cells, including unmapped fields, at a time.`);
      return row;
    }
    if (!item['hasHeader']) yield count(first!);
    for (const row of rows) yield count(row);
  }
  return { columns, mapping, rows: dataRows(), validated: mapping.some(id => id !== null) };
}

export function csvRecordValues(table: Table, plan: CheckedCsvImport, row: CsvRow): Record<string, CellValue> {
  if (row.cells.length !== plan.columns.length) invalid(`Expected ${plan.columns.length} cells, received ${row.cells.length}.`);
  const values: Record<string, CellValue> = {};
  for (const field of table.fields) {
    if (field.type === 'lookup') continue;
    const index = plan.mapping.indexOf(field.id);
    const cell = index === -1 ? undefined : row.cells[index]!;
    values[field.id] = !cell ? validateValue(field, field.defaultValue ?? null)
      : cell.text === '' && !cell.quoted ? validateValue(field, null) : parseTextValue(field, cell.text);
  }
  return values;
}

export function csvCell(value: string | null): string {
  if (value === null) return '';
  return value === '' || /[,"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvRecord(fields: Field[], values: Record<string, CellValue>): string {
  return fields.map(field => csvCell(values[field.id] === null || values[field.id] === undefined ? null : fieldText(field, values[field.id]))).join(',') + '\r\n';
}
