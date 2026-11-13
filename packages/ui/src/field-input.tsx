import React, { useId } from 'react';
import { isReadOnlyField, isLookupSummary, maxUrlLength, type Field, type RecordLink } from '../../contracts/src/index.js';
import type { FormValue } from './field-input-values.js';
import { RelationInput } from './relation-input.js';
import { cellDisplay } from '../../client/src/cell-values.js';
import { ExternalLink } from './external-link.js';
import { selectedOptions, selectStyle } from './select-colors.js';
import { SelectValues } from './select-values.js';

export function FieldInput({ field, value, onChange, disabled = false, calculationError }: {
  field: Field; value: FormValue; onChange(value: FormValue, links?: RecordLink[]): void; disabled?: boolean; calculationError?: string | undefined;
}) {
  const id = useId();
  const descriptionId = field.description ? `${id}-description` : undefined;
  const common = { id, disabled, required: !!field.required, 'aria-describedby': descriptionId };
  const scalar = (value ?? '') as string;
  let input;
  if (calculationError) {
    input = <output id={id} aria-describedby={descriptionId} className="form-error">#ERROR: {calculationError}</output>;
  } else if (['autoNumber', 'createdTime', 'updatedTime'].includes(field.type)) {
    input = <output id={id} aria-describedby={descriptionId}>{scalar}</output>;
  } else if (field.type === 'formula') {
    input = <output id={id} aria-describedby={descriptionId}>{value === null ? ''
      : cellDisplay(field, field.formula!.resultType === 'number' ? Number(value) : field.formula!.resultType === 'checkbox' ? value === 'true' : scalar)}</output>;
  } else if (field.type === 'lookup') {
    const values = value === null ? isLookupSummary(field) ? null : [] : JSON.parse(value as string);
    const options = selectedOptions(field, values);
    input = <output id={id} aria-describedby={descriptionId}>{options ? <SelectValues options={options} /> : cellDisplay(field, values)}</output>;
  } else if (field.type === 'relation') {
    input = <RelationInput key={field.relation!.tableId} id={id} descriptionId={descriptionId} field={field} value={value as string[] | null} disabled={disabled} onChange={onChange} />;
  } else if (field.type === 'singleSelect' || field.type === 'checkbox') {
    const selected = field.type === 'singleSelect' ? field.options!.find(option => option.id === scalar) : undefined;
    input = <select {...common} style={selected ? selectStyle(selected) : undefined} value={scalar} onChange={event => onChange(event.target.value || null)}>
      <option value="">Not set</option>
      {field.type === 'checkbox' ? <><option value="true">Checked</option><option value="false">Unchecked</option></>
        : field.options!.map(option => <option key={option.id} value={option.id} style={selectStyle(option)}>{option.name}</option>)}
    </select>;
  } else if (field.type === 'multiSelect') {
    input = <select {...common} multiple size={Math.min(5, Math.max(2, field.options!.length))}
      value={(value ?? []) as string[]} onChange={event => onChange(Array.from(event.target.selectedOptions, option => option.value))}>
      {field.options!.map(option => <option key={option.id} value={option.id} style={selectStyle(option)}>{option.name}</option>)}
    </select>;
  } else if (field.type === 'multiline') {
    input = <textarea {...common} rows={3} value={scalar} onChange={event => onChange(event.target.value)} />;
  } else {
    input = <input {...common} value={scalar}
      type={field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      autoCapitalize={field.type === 'url' ? 'none' : undefined} spellCheck={field.type === 'url' ? false : undefined}
      maxLength={field.type === 'url' ? maxUrlLength : undefined} placeholder={field.type === 'url' ? 'https://example.com' : undefined}
      step={field.type === 'datetime' ? '0.001' : undefined}
      onChange={event => onChange(event.target.value)} />;
  }
  return <div className="form-field">
    <div className="field-label"><label htmlFor={id}>{field.name}{field.required ? ' *' : ''}{['datetime', 'createdTime', 'updatedTime'].includes(field.type) ? ' (UTC)' : ''}</label>
      {!field.required && !isReadOnlyField(field) && <button type="button" className="clear-value" disabled={disabled || value === null}
        aria-label={`Clear ${field.name}`} onClick={() => { onChange(null); document.getElementById(id)!.focus(); }}>Clear</button>}</div>
    {input}
    {field.type === 'multiSelect' && <SelectValues options={selectedOptions(field, value)!} />}
    {field.type === 'url' && <ExternalLink value={value} />}
    {field.description && <small id={descriptionId} className="field-description">{field.description}</small>}
    {field.type === 'url' && <small>HTTP and HTTPS links only. Open links in your browser.</small>}
    {field.type === 'lookup' && <small>Updates after saving linked records.</small>}
    {field.type === 'formula' && <small>Updates when changes to its inputs are saved.</small>}
    {field.type === 'autoNumber' && <small>Assigned automatically when the record is created.</small>}
    {field.type === 'createdTime' && <small>Original creation time, retained when the record is restored.</small>}
    {field.type === 'updatedTime' && <small>Latest record save or linked-record edit.</small>}
    {field.type === 'number' && field.numberFormat === 'percent' && <small>Enter a fraction: 0.5 displays as 50%.</small>}
    {value === null && !calculationError && <small>No value</small>}
  </div>;
}
