import React, { useEffect, useRef, useState } from 'react';
import type { ConversionPreview, Field, FieldCreate, FieldType, SelectOption, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { cellText } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';
import { rewriteFormulaReferences } from '../../core/src/formulas.js';

export const fieldTypeNames: Record<FieldType, string> = {
  text: 'Text', multiline: 'Multiline text', number: 'Number', checkbox: 'Checkbox', date: 'Date',
  datetime: 'Date and time', singleSelect: 'Single select', multiSelect: 'Multiple select', relation: 'Linked records', lookup: 'Lookup', formula: 'Formula',
};

export function FieldForm({ table, field, api, setDirty, onClose, onSaved }: {
  table: Table; field: Field | undefined; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(): void; onSaved(table: Table): Promise<void>;
}) {
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [required, setRequired] = useState(field?.required ?? false);
  const [options, setOptions] = useState<SelectOption[]>(field?.options ?? []);
  const [format, setFormat] = useState<NonNullable<Field['numberFormat']>>(field?.numberFormat ?? 'decimal');
  const [precision, setPrecision] = useState(field?.precision?.toString() ?? '');
  const [currency, setCurrency] = useState(field?.currency ?? 'USD');
  const [hasDefault, setHasDefault] = useState(field?.defaultValue !== undefined);
  const [defaultValue, setDefaultValue] = useState<FormValue>(field ? toFormValue(field, field.defaultValue) : null);
  const [preview, setPreview] = useState<ConversionPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<Table[]>([]);
  const [targetId, setTargetId] = useState(field?.relation?.tableId ?? table.id);
  const [multiple, setMultiple] = useState(field?.relation?.multiple ?? true);
  const [lookupRelation, setLookupRelation] = useState(field?.lookup?.relationFieldId ?? table.fields.find(field => field.type === 'relation')?.id ?? '');
  const [lookupField, setLookupField] = useState(field?.lookup?.fieldId ?? '');
  const [lookupTarget, setLookupTarget] = useState<Table>();
  const formulaFields = table.fields.filter(candidate => candidate.id !== field?.id && !['relation', 'lookup', 'multiSelect'].includes(candidate.type));
  const referenceName = (candidate: Field) => table.fields.filter(other => other.name === candidate.name).length > 1
    ? `${candidate.name} (${candidate.id})` : candidate.name;
  const [expression, setExpression] = useState(() => field?.formula
    ? rewriteFormulaReferences(field.formula.expression, id => referenceName(table.fields.find(candidate => candidate.id === id)!)) : '');
  const [resultType, setResultType] = useState<NonNullable<Field['formula']>['resultType']>(field?.formula?.resultType ?? 'number');
  const formulaInput = useRef<HTMLTextAreaElement>(null);
  const relation = table.fields.find(field => field.id === lookupRelation);
  useEffect(() => {
    if (type === 'relation') void api.listTables().then(setTargets).catch(error => setError(error.message));
  }, [api, type]);
  useEffect(() => {
    if (type !== 'lookup' || !relation) return;
    let active = true;
    setLookupTarget(undefined);
    void api.getTable(relation.relation!.tableId).then(target => {
      if (!active) return;
      setLookupTarget(target);
      const available = target.fields.filter(field => !['relation', 'lookup'].includes(field.type));
      setLookupField(current => available.some(field => field.id === current) ? current : available[0]!.id);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, type, relation]);
  const converting = !!field && type !== field.type;
  const selection = type === 'singleSelect' || type === 'multiSelect';
  const target: Field = { id: field?.id ?? 'new-field', name, type, required: type !== 'lookup' && type !== 'formula' && required,
    ...(type === 'relation' ? { relation: { tableId: targetId, multiple } } : {}),
    ...(type === 'lookup' ? { lookup: { relationFieldId: lookupRelation, fieldId: lookupField } } : {}),
    ...(type === 'formula' ? { formula: { expression, resultType } } : {}),
    ...(selection ? { options } : {}),
    ...((type === 'number' || (type === 'formula' && resultType === 'number')) ? { numberFormat: format, ...(precision ? { precision: Number(precision) } : {}),
      ...(format === 'currency' ? { currency } : {}) } : {}) };
  const changed = () => { setDirty(true); setPreview(undefined); };
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={field ? 'Configure field' : 'Add field'} onClose={onClose} busy={busy} wide>
    {field && <details className="form-note"><summary>Field identity</summary>
      <p>Field ID: <code>{field.id}</code></p>
      <p>This UUID identifies the column, not a record. Renaming or reordering keeps this ID.</p>
    </details>}
    <form onChange={changed} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && !preview?.invalid) event.currentTarget.requestSubmit();
      }
    }} onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void (async () => {
        const { id: _id, ...definition } = target;
        const config: Omit<FieldCreate, 'expectedVersion'> = {
          ...definition, defaultValue: hasDefault ? fromFormValue(target, defaultValue) : null,
        };
        if (type === 'formula') config.formula = { resultType, expression: rewriteFormulaReferences(expression, name => {
          const matches = formulaFields.filter(candidate => referenceName(candidate) === name);
          if (matches.length !== 1) throw new Error(`Choose a current field from Insert field: ${name}.`);
          return matches[0]!.id;
        }) };
        if (converting && !preview) {
          setPreview(await api.previewConversion(table.id, field.id, { expectedVersion: table.version, field: config }));
        } else {
          const result = converting
            ? await api.applyConversion(table.id, field.id, { expectedVersion: preview!.schemaVersion, field: preview!.field })
            : field ? await api.updateField(table.id, field.id, { ...config, expectedVersion: table.version,
              ...((type === 'number' || (type === 'formula' && resultType === 'number')) && !precision ? { precision: null } : {}) })
            : await api.createField(table.id, { ...config, expectedVersion: table.version });
          setDirty(false);
          await onSaved(result);
        }
      })().catch(error => setError(error instanceof Error ? error.message : 'The field could not be saved.'))
        .finally(() => setBusy(false));
    }}>
      <fieldset disabled={busy}>
        <label className="form-field">Field name<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="form-field">Field type<select aria-label="Field type" value={type} onChange={event => {
          setType(event.target.value as FieldType); setHasDefault(false); setDefaultValue(null);
        }}>{Object.entries(fieldTypeNames).map(([value, label]) => <option key={value} value={value}
          disabled={field ? ['relation', 'lookup', 'formula'].includes(field.type) ? value !== field.type : ['relation', 'lookup', 'formula'].includes(value)
            : value === 'lookup' && !table.fields.some(field => field.type === 'relation')}>{label}</option>)}</select></label>
        {type === 'formula' && <>
          <label className="form-field">Result type<select aria-label="Result type" value={resultType} onChange={event => setResultType(event.target.value as typeof resultType)}>
            <option value="number">Number</option><option value="text">Text</option><option value="checkbox">Checkbox</option>
          </select></label>
          <label className="form-field">Formula<textarea ref={formulaInput} aria-label="Formula" rows={4} required maxLength={4096} value={expression}
            placeholder={'["Quantity"] * ["Price"]'} onChange={event => setExpression(event.target.value)} /></label>
          <label className="form-field">Insert field<select aria-label="Insert field" value="" onChange={event => {
            const candidate = formulaFields.find(candidate => candidate.id === event.target.value)!;
            const input = formulaInput.current!;
            const token = `[${JSON.stringify(referenceName(candidate))}]`;
            const start = input.selectionStart, end = input.selectionEnd;
            setExpression(expression.slice(0, start) + token + expression.slice(end));
            changed();
            requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + token.length, start + token.length); });
          }}><option value="" disabled>Choose a field…</option>{formulaFields.map(candidate =>
            <option key={candidate.id} value={candidate.id}>{referenceName(candidate)}</option>)}</select></label>
          <p className="form-note">Calculated after saving. Field references survive renaming. Empty inputs stay empty unless you use COALESCE.</p>
          <details className="form-note"><summary>Formula help</summary>
            <p>Use + − * / %, comparisons == != &gt; &gt;= &lt; &lt;=, parentheses, numbers, double-quoted text, TRUE, FALSE and NULL.</p>
            <p>Functions: IF, COALESCE, CONCAT, LOWER, UPPER, TRIM, LEN, ROUND, ABS, AND, OR and NOT.</p>
            <p>Example: IF(["Quantity"] &gt; 0, ROUND(["Quantity"] * ["Price"], 2), 0). Linked and multiple-select values are unavailable in formulas.</p>
          </details>
        </>}
        {type === 'lookup' && <>
          <label className="form-field">Linked field<select required aria-label="Linked field" value={lookupRelation} onChange={event => setLookupRelation(event.target.value)}>
            {table.fields.filter(field => field.type === 'relation').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>
          <label className="form-field">Look up field<select required aria-label="Look up field" value={lookupField} disabled={!lookupTarget} onChange={event => setLookupField(event.target.value)}>
            {lookupTarget?.fields.filter(field => !['relation', 'lookup'].includes(field.type)).map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>
          <p className="form-note">Values follow the linked records and cannot be edited here. Add a linked-record field first to use a lookup.</p>
        </>}
        {type === 'relation' && <>
          <label className="form-field">Link to table<select required aria-label="Link to table" value={targetId} onChange={event => { setTargetId(event.target.value); setDefaultValue(null); }}>
            {targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select></label>
          <label className="check-field"><input type="checkbox" checked={multiple} onChange={event => setMultiple(event.target.checked)} />Allow multiple records</label>
        </>}
        {(type === 'number' || (type === 'formula' && resultType === 'number')) && <div className="form-row">
          <label className="form-field">Number format<select aria-label="Number format" value={format} onChange={event => setFormat(event.target.value as typeof format)}>
            <option value="decimal">Decimal</option><option value="currency">Currency</option><option value="percent">Percent</option>
          </select></label>
          <label className="form-field">Decimal places<select aria-label="Decimal places" value={precision} onChange={event => setPrecision(event.target.value)}>
            <option value="">Automatic</option>{Array.from({ length: 11 }, (_, index) => <option key={index} value={index}>{index}</option>)}
          </select></label>
          {format === 'currency' && <label className="form-field">Currency code<input required pattern="[A-Z]{3}" maxLength={3} value={currency}
            onChange={event => setCurrency(event.target.value.toUpperCase())} /></label>}
        </div>}
        {selection && <div className="field-options"><h3>Options</h3>
          {options.map((option, index) => <div className="option-row" key={option.id}>
            <input aria-label={`Option ${index + 1} name`} required maxLength={200} value={option.name}
              onChange={event => setOptions(current => current.map(item => item.id === option.id ? { ...item, name: event.target.value } : item))} />
            <input type="color" aria-label={`Option ${index + 1} color`} value={option.color ?? '#315cbe'}
              onChange={event => setOptions(current => current.map(item => item.id === option.id ? { ...item, color: event.target.value } : item))} />
            <button type="button" aria-label={`Remove option ${index + 1}`} onClick={() => {
              setOptions(current => current.filter(item => item.id !== option.id)); changed();
            }}>Remove</button>
          </div>)}
          <button type="button" disabled={options.length >= 200} onClick={() => {
            setOptions(current => [...current, { id: crypto.randomUUID(), name: `Option ${current.length + 1}` }]); changed();
          }}>Add option</button>
        </div>}
        {type !== 'lookup' && type !== 'formula' && <><label className="check-field"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />Require a value</label>
        <label className="check-field"><input type="checkbox" checked={hasDefault} onChange={event => setHasDefault(event.target.checked)} />Use a default for new records</label></>}
        {hasDefault && <FieldInput field={{ ...target, name: 'Default value', required: false }} value={defaultValue}
          onChange={value => { setDefaultValue(value); changed(); }} />}
      </fieldset>
      {converting && <p className="form-note">Changing the field type converts existing values. Preview the result before applying it. Defaults only affect new records.</p>}
      {preview && <section className="conversion-preview" aria-label="Conversion preview">
        <p><strong>{preview.changed.toLocaleString()} changed · {preview.invalid.toLocaleString()} invalid</strong> of {preview.total.toLocaleString()} records.</p>
        {preview.issues.length > 0 && <ul>{preview.issues.map(issue => <li key={issue.recordId}><code>{issue.recordId}</code>: {issue.message}</li>)}</ul>}
        {preview.samples.length > 0 && <table><thead><tr><th>Record</th><th>Before</th><th>After</th></tr></thead><tbody>
          {preview.samples.map(sample => <tr key={sample.recordId}><td><code>{sample.recordId}</code></td>
            <td>{sample.before === null ? '(No value)' : cellText(field!, sample.before)}</td>
            <td>{sample.after === null ? '(No value)' : cellText(preview.field, sample.after)}</td></tr>)}
        </tbody></table>}
        <small>Showing up to 10 changes and 20 errors. Nothing changes unless every record can be converted.</small>
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (type === 'lookup' && !lookupTarget) || (preview !== undefined && preview.invalid > 0)}>
          {busy ? 'Working…' : converting ? preview ? 'Apply conversion' : 'Preview conversion' : 'Save field'}</button></div>
    </form>
  </Dialog>;
}
