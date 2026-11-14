import React from 'react';
import type { Field, RowRecord } from '../../contracts/src/index.js';
import { cellDisplay } from '../../client/src/cell-values.js';
import { selectedOptions } from './select-colors.js';
import { SelectValues } from './select-values.js';

export function recordText(field: Field, record: RowRecord): string {
  if (record.formulaErrors?.[field.id]) return `#ERROR: ${record.formulaErrors[field.id]}`;
  const value = record.values[field.id] ?? null;
  if (record.attachments?.[field.id]) return record.attachments[field.id]!.map(file => file.filename).join(', ');
  return field.type === 'relation' ? ((value ?? []) as string[]).map(id => record.links?.[field.id]?.find(link => link.id === id)?.label || id).join(', ')
    : cellDisplay(field, value);
}

export function RecordValue({ field, record }: { field: Field; record: RowRecord }) {
  const options = record.formulaErrors?.[field.id] ? undefined : selectedOptions(field, record.values[field.id]);
  return options?.length ? <SelectValues options={options} /> : <>{recordText(field, record) || '—'}</>;
}
