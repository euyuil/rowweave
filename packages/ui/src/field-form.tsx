import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversionPreview, Field, FieldCreate, FieldType, SelectOption, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { cellText } from '../../client/src/cell-values.js';
import { Dialog, type DialogAnchor } from './dialog.js';
import { FieldInput } from './field-input.js';
import { FormulaPreviewPanel } from './formula-preview.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';
import { rewriteFormulaReferences } from '../../core/src/formulas.js';
import { isReadOnlyField, valueField } from '../../contracts/src/index.js';

export const fieldTypeNames: Record<FieldType, string> = {
  text: 'Text', multiline: 'Multiline text', url: 'URL', number: 'Number', autoNumber: 'Automatic number', checkbox: 'Checkbox', date: 'Date',
  createdTime: 'Created time', updatedTime: 'Last edited time', attachment: 'Attachment',
  datetime: 'Date and time', singleSelect: 'Single select', multiSelect: 'Multiple select', relation: 'Linked records', lookup: 'Lookup', formula: 'Formula',
};

export function FieldForm({ table, field, api, setDirty, onClose, onSaved, anchor, restoreFocus }: {
  table: Table; field: Field | undefined; api: WorkspaceApi; setDirty(value: boolean): void;
  anchor?: DialogAnchor | undefined;
  restoreFocus?: (() => void) | undefined;
  onClose(): void; onSaved(table: Table): Promise<void>;
}) {
  const [name, setName] = useState(field?.name ?? '');
  const [description, setDescription] = useState(field?.description ?? '');
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
  const [reverse, setReverse] = useState(false);
  const [reverseName, setReverseName] = useState(table.name);
  const [reverseMultiple, setReverseMultiple] = useState(true);
  const [lookupRelation, setLookupRelation] = useState(field?.lookup?.relationFieldId ?? table.fields.find(field => field.type === 'relation')?.id ?? '');
  const [lookupField, setLookupField] = useState(field?.lookup?.fieldId ?? '');
  const [lookupTarget, setLookupTarget] = useState<Table>();
  const [lookupOperation, setLookupOperation] = useState<NonNullable<NonNullable<Field['lookup']>['operation']>>(field?.lookup?.operation ?? 'values');
  const lookupFields = lookupTarget?.fields.filter(candidate => !['relation', 'lookup'].includes(candidate.type) &&
    (lookupOperation === 'values' || valueField(candidate).type === 'number')) ?? [];
  useEffect(() => {
    if (!lookupTarget) return;
    setLookupField(current => lookupFields.some(candidate => candidate.id === current) ? current : lookupFields[0]?.id ?? '');
  }, [lookupTarget, lookupOperation]);
  const formulaFields = table.fields.filter(candidate => candidate.id !== field?.id);
  const referenceName = (candidate: Field) => table.fields.filter(other => other.name === candidate.name).length > 1
    ? `${candidate.name} (${candidate.id})` : candidate.name;
  const [expression, setExpression] = useState(() => field?.formula
    ? rewriteFormulaReferences(field.formula.expression, id => referenceName(table.fields.find(candidate => candidate.id === id)!)) : '');
  const [resultType, setResultType] = useState<NonNullable<Field['formula']>['resultType']>(field?.formula?.resultType ?? 'number');
  const formulaInput = useRef<HTMLTextAreaElement>(null);
  const insertedPosition = useRef<number>();
  useLayoutEffect(() => {
    if (insertedPosition.current === undefined) return;
    const input = formulaInput.current!;
    input.focus();
    input.setSelectionRange(insertedPosition.current, insertedPosition.current);
    insertedPosition.current = undefined;
  }, [expression]);
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
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, type, relation]);
  const converting = !!field && type !== field.type;
  const selection = type === 'singleSelect' || type === 'multiSelect';
  const target: Field = { id: field?.id ?? 'new-field', name, description, type, required: !isReadOnlyField({ type }) && required,
    ...(type === 'relation' ? { relation: { tableId: targetId, multiple } } : {}),
    ...(type === 'lookup' ? { lookup: { relationFieldId: lookupRelation, fieldId: lookupField, operation: lookupOperation } } : {}),
    ...(type === 'formula' ? { formula: { expression, resultType } } : {}),
    ...(selection ? { options } : {}),
    ...((type === 'number' || (type === 'formula' && resultType === 'number')) ? { numberFormat: format, ...(precision ? { precision: Number(precision) } : {}),
      ...(format === 'currency' ? { currency } : {}) } : {}) };
  const changed = () => { setDirty(true); setPreview(undefined); };
  const currentFormula = () => ({ resultType, expression: rewriteFormulaReferences(expression, name => {
    const matches = formulaFields.filter(candidate => referenceName(candidate) === name);
    if (matches.length !== 1) throw new Error(`Choose a current field from Insert field: ${name}.`);
    return matches[0]!.id;
  }) });
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={field ? 'Configure field' : 'Add field'} onClose={onClose} busy={busy} wide={!anchor} anchor={anchor} restoreFocus={restoreFocus}>
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
        if (!field && type === 'relation' && reverse) config.reverseField = {
          name: reverseName, multiple: reverseMultiple, expectedVersion: targets.find(target => target.id === targetId)!.version,
        };
        if (type === 'formula') config.formula = currentFormula();
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
        <label className="form-field">Field description<textarea aria-label="Field description" rows={2} maxLength={2000} value={description}
          placeholder="Explain what belongs in this field…" onChange={event => setDescription(event.target.value)} /></label>
        <label className="form-field">Field type<select aria-label="Field type" value={type} onChange={event => {
          setType(event.target.value as FieldType); setHasDefault(false); setDefaultValue(null);
        }}>{Object.entries(fieldTypeNames).map(([value, label]) => <option key={value} value={value}
          disabled={field ? ['relation', 'attachment'].includes(field.type) || isReadOnlyField(field) ? value !== field.type : ['relation', 'attachment'].includes(value) || isReadOnlyField({ type: value as FieldType })
            : value === 'lookup' && !table.fields.some(field => field.type === 'relation')}>{label}</option>)}</select></label>
        {type === 'formula' && <>
          <label className="form-field">Result type<select aria-label="Result type" value={resultType} onChange={event => setResultType(event.target.value as typeof resultType)}>
            <option value="number">Number</option><option value="text">Text</option><option value="checkbox">Checkbox</option>
            <option value="date">Date</option><option value="datetime">Date and time (UTC)</option>
          </select></label>
          <label className="form-field">Formula<textarea ref={formulaInput} aria-label="Formula" rows={4} required maxLength={4096} value={expression}
            placeholder={'["Quantity"] * ["Price"]'} onChange={event => setExpression(event.target.value)} /></label>
          <label className="form-field">Insert field<select aria-label="Insert field" value="" onChange={event => {
            const candidate = formulaFields.find(candidate => candidate.id === event.target.value)!;
            const input = formulaInput.current!;
            const token = `[${JSON.stringify(referenceName(candidate))}]`;
            const start = input.selectionStart, end = input.selectionEnd;
            insertedPosition.current = start + token.length;
            setExpression(expression.slice(0, start) + token + expression.slice(end));
            changed();
          }}><option value="" disabled>Choose a field…</option>{formulaFields.map(candidate =>
            <option key={candidate.id} value={candidate.id}>{referenceName(candidate)}</option>)}</select></label>
          <p className="form-note">Calculated after saving, including changes to linked summary inputs. Field references survive renaming. Empty inputs stay empty unless you use COALESCE.</p>
          <FormulaPreviewPanel table={table} fieldId={field?.id} draft={target} api={api} getFormula={currentFormula} busy={busy} setBusy={setBusy} />
          <details className="form-note"><summary>Formula help</summary>
            <p>Use + − * / %, comparisons == != &gt; &gt;= &lt; &lt;=, parentheses, numbers, double-quoted text, TRUE, FALSE and NULL.</p>
            <p>Functions: IF, COALESCE, CONCAT, LOWER, UPPER, TRIM, LEN, ROUND, ABS, AND, OR and NOT.</p>
            <p>Dates: DATE(year, month, day), DATEVALUE, DATETIMEVALUE, YEAR, MONTH, DAY, WEEKDAY, HOUR, MINUTE, SECOND, DATEADD(value, amount, unit) and DATEDIFF(start, end, unit). Timestamps use UTC. Units: "year", "month", "week", "day", "hour", "minute", "second".</p>
            <p>Example: DATEADD(["Start date"], 7, "day") with a Date result. DATETIMEVALUE converts a date to UTC midnight. Month/year additions clamp to the last valid day; WEEKDAY uses Monday = 1.</p>
            <p>Arrays: ARRAY, ARRAYLEN, ARRAYCOUNT, ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT, ARRAYGET, ARRAYCONTAINS, ARRAYSUM, ARRAYAVERAGE, ARRAYMIN and ARRAYMAX. Use these with linked records, lookup values, multiple-select values or attachment IDs. ARRAYGET positions start at 1.</p>
            <p>Examples: ROUND(["Subtotal"] * (1 + ["Tax rate"]), 2); ARRAYLEN(["Related records"]); ARRAYJOIN(ARRAYUNIQUE(["Linked names"]), ", "). Empty numeric summaries stay empty; ARRAYCOUNT counts non-null items. Final formula results must be one value of the selected result type.</p>
          </details>
        </>}
        {type === 'lookup' && <>
          <label className="form-field">Show<select aria-label="Lookup operation" value={lookupOperation} onChange={event => setLookupOperation(event.target.value as typeof lookupOperation)}>
            <option value="values">Linked values</option><option value="sum">Sum</option><option value="average">Average</option>
            <option value="count">Count numeric values</option><option value="min">Minimum</option><option value="max">Maximum</option>
          </select></label>
          <label className="form-field">Linked field<select required aria-label="Linked field" value={lookupRelation} onChange={event => setLookupRelation(event.target.value)}>
            {table.fields.filter(field => field.type === 'relation').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>
          <label className="form-field">Look up field<select required aria-label="Look up field" value={lookupField} disabled={!lookupTarget} onChange={event => setLookupField(event.target.value)}>
            {!lookupFields.length && <option value="">No compatible fields</option>}
            {lookupFields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>
          <p className="form-note">Values follow the linked records and cannot be edited here. Add a linked-record field first to use a lookup.</p>
          {lookupOperation !== 'values' && <p className="form-note">Uses numeric values, including numeric formulas. Empty values are skipped; count returns 0 when none exist, while other summaries stay empty.</p>}
        </>}
        {type === 'relation' && <>
          <label className="form-field">Link to table<select required disabled={!!field?.relation?.inverseFieldId} aria-label="Link to table" value={targetId} onChange={event => { setTargetId(event.target.value); setDefaultValue(null); }}>
            {targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select></label>
          <label className="check-field"><input type="checkbox" checked={multiple} onChange={event => setMultiple(event.target.checked)} />Allow multiple records</label>
          {!field && <><label className="check-field"><input type="checkbox" checked={reverse} onChange={event => setReverse(event.target.checked)} />Create a reverse field in the linked table</label>
            {reverse && <><label className="form-field">Reverse field name<input required maxLength={200} value={reverseName} onChange={event => setReverseName(event.target.value)} /></label>
              <label className="check-field"><input type="checkbox" checked={reverseMultiple} onChange={event => setReverseMultiple(event.target.checked)} />Allow multiple records in the reverse field</label>
              <p className="form-note">Both fields are created together. Adding or removing a link from either table updates the other side when saved.</p></>}
          </>}
          {field?.relation?.inverseFieldId && <p className="form-note">Two-way link: changes update the opposite field when saved. Configure that field in the linked table to change its name or record limit.</p>}
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
        {type === 'autoNumber' && <p className="form-note">Assigns a new number from 1 when each record is created. Existing records receive numbers in their current order. Numbers cannot be edited or reused; restoring a deleted record keeps its number.</p>}
        {type === 'createdTime' && <p className="form-note">Records the original creation time in UTC. Restoring a record preserves its creation time. Older records without a known creation time remain empty.</p>}
        {type === 'updatedTime' && <p className="form-note">Records the latest record save or linked-record edit in UTC. Schema changes and calculation refreshes leave it unchanged. Existing records use their latest known saved change.</p>}
        {!isReadOnlyField({ type }) && <><label className="check-field"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />Require a value</label>
        {type !== 'attachment' && <label className="check-field"><input type="checkbox" checked={hasDefault} onChange={event => setHasDefault(event.target.checked)} />Use a default for new records</label>}</>}
        {type === 'attachment' && <p className="form-note">Attach up to 20 uploaded files per record, each up to 8 MiB. Saved files remain available for record history and recovery.</p>}
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
        <button className="primary" disabled={busy || (type === 'relation' && !targets.some(target => target.id === targetId)) || (type === 'lookup' && !lookupFields.some(field => field.id === lookupField)) || (preview !== undefined && preview.invalid > 0)}>
          {busy ? 'Working…' : converting ? preview ? 'Apply conversion' : 'Preview conversion' : 'Save field'}</button></div>
    </form>
  </Dialog>;
}
