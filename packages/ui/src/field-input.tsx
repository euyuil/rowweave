import React, { useId } from 'react';
import { isLookupSummary, type Field, type RecordLink } from '../../contracts/src/index.js';
import type { FormValue } from './field-input-values.js';
import { RelationInput } from './relation-input.js';
import { cellDisplay } from '../../client/src/cell-values.js';

export function FieldInput({ field, value, onChange, disabled = false, calculationError }: {
  field: Field; value: FormValue; onChange(value: FormValue, links?: RecordLink[]): void; disabled?: boolean; calculationError?: string | undefined;
}) {
  const id = useId();
  const common = { id, disabled, required: !!field.required };
  const scalar = (value ?? '') as string;
  let input;
  if (calculationError) {
    input = <output id={id} className="form-error">#ERROR: {calculationError}</output>;
  } else if (field.type === 'formula') {
    input = <output id={id}>{value === null ? ''
      : cellDisplay(field, field.formula!.resultType === 'number' ? Number(value) : field.formula!.resultType === 'checkbox' ? value === 'true' : scalar)}</output>;
  } else if (field.type === 'lookup') {
    input = <output id={id}>{cellDisplay(field, value === null ? isLookupSummary(field) ? null : [] : JSON.parse(value as string))}</output>;
  } else if (field.type === 'relation') {
    input = <RelationInput key={field.relation!.tableId} id={id} field={field} value={value as string[] | null} disabled={disabled} onChange={onChange} />;
  } else if (field.type === 'singleSelect' || field.type === 'checkbox') {
    input = <select {...common} value={scalar} onChange={event => onChange(event.target.value || null)}>
      <option value="">Not set</option>
      {field.type === 'checkbox' ? <><option value="true">Checked</option><option value="false">Unchecked</option></>
        : field.options!.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  } else if (field.type === 'multiSelect') {
    input = <select {...common} multiple size={Math.min(5, Math.max(2, field.options!.length))}
      value={(value ?? []) as string[]} onChange={event => onChange(Array.from(event.target.selectedOptions, option => option.value))}>
      {field.options!.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>;
  } else if (field.type === 'multiline') {
    input = <textarea {...common} rows={3} value={scalar} onChange={event => onChange(event.target.value)} />;
  } else {
    input = <input {...common} value={scalar}
      type={field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      step={field.type === 'datetime' ? '0.001' : undefined}
      onChange={event => onChange(event.target.value)} />;
  }
  return <div className="form-field">
    <div className="field-label"><label htmlFor={id}>{field.name}{field.required ? ' *' : ''}{field.type === 'datetime' ? ' (UTC)' : ''}</label>
      {!field.required && field.type !== 'lookup' && field.type !== 'formula' && <button type="button" className="clear-value" disabled={disabled || value === null}
        aria-label={`Clear ${field.name}`} onClick={() => { onChange(null); document.getElementById(id)!.focus(); }}>Clear</button>}</div>
    {input}
    {field.type === 'lookup' && <small>Updates after saving linked records.</small>}
    {field.type === 'formula' && <small>Calculated after saving this record.</small>}
    {field.type === 'number' && field.numberFormat === 'percent' && <small>Enter a fraction: 0.5 displays as 50%.</small>}
    {value === null && !calculationError && <small>No value</small>}
  </div>;
}
