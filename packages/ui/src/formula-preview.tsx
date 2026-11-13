import React, { useEffect, useState } from 'react';
import type { Field, FormulaPreview, QueryPage, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { cellText } from '../../client/src/cell-values.js';

export function FormulaPreviewPanel({ table, fieldId, draft, api, getFormula, busy, setBusy }: {
  table: Table; fieldId: string | undefined; draft: Field; api: WorkspaceApi;
  getFormula(): NonNullable<Field['formula']>; busy: boolean; setBusy(value: boolean): void;
}) {
  const [preview, setPreview] = useState<FormulaPreview>();
  const [error, setError] = useState<string>();
  const [recordId, setRecordId] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QueryPage>();
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<string>();
  const [reload, setReload] = useState(0);
  useEffect(() => { setPreview(undefined); setError(undefined); }, [draft.formula!.expression, draft.formula!.resultType, recordId]);
  useEffect(() => {
    if (!choosing || composing) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void api.queryRecords(table.id, { search, offset, limit: 50, fields: [table.primaryFieldId],
        ...(offset && page ? { expectedRevision: page.revision } : {}) }, controller.signal).then(result => {
        if (result.schemaVersion !== table.version) throw new Error('The table schema changed. Reopen field configuration to use its current fields.');
        setPage(result); setQueryError(undefined);
      }).catch(error => { if (!controller.signal.aborted) setQueryError(error.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, table, choosing, search, offset, composing, reload]);
  const label = (record: QueryPage['records'][number]) => record.formulaErrors?.[table.primaryFieldId]
    ? '#ERROR: ' + record.formulaErrors[table.primaryFieldId]
    : cellText(table.fields.find(field => field.id === table.primaryFieldId)!, record.values[table.primaryFieldId]) || '(Untitled)';
  return <section className="formula-preview" aria-label="Formula preview" onChange={event => event.stopPropagation()}>
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError(undefined); setPreview(undefined);
      void (async () => setPreview(await api.previewFormula(table.id, { expectedVersion: table.version, formula: getFormula(),
        ...(fieldId ? { fieldId } : {}), ...(recordId ? { recordId } : {}) })))()
        .catch(error => setError(error.message)).finally(() => setBusy(false));
    }}>Preview formula</button>
    <p className="form-note">Uses one saved record. Previewing does not save the field or change any records.</p>
    <details onToggle={event => setChoosing(event.currentTarget.open)}><summary>Choose a sample record</summary>
      <button type="button" onClick={() => setRecordId(undefined)}>Use first saved record</button>
      <label className="form-field">Find sample records<input type="search" value={search}
        onChange={event => { setSearch(event.target.value); setOffset(0); setPage(undefined); }}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} /></label>
      <div className="relation-results" aria-label="Sample records" aria-busy={loading}>
        {page?.records.map(record => <label key={record.id} title={record.id}>
          <input type="radio" name="formula-sample" disabled={loading} checked={record.id === recordId} onChange={() => setRecordId(record.id)} />{label(record)}
        </label>)}
      </div>
      <div className="relation-pages"><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous samples</button>
        <small>{loading ? 'Loading…' : (page?.total ?? 0) + ' matching records'}</small>
        <button type="button" disabled={loading || !page || offset + 50 >= page.total} onClick={() => setOffset(offset + 50)}>Next samples</button></div>
      {queryError && <p role="alert">{queryError} <button type="button" onClick={() => {
        setOffset(0); setPage(undefined); setReload(current => current + 1);
      }}>Reload samples</button></p>}
    </details>
    {error && <p role="alert">{error}</p>}
    {preview && <div role="status">
      {preview.sample ? <>
        <p>Sample: <strong>{preview.sample.label}</strong> · record version {preview.sample.version}</p>
        {preview.sample.error ? <p role="alert">Calculation error: {preview.sample.error}</p>
          : <p>Result: <output aria-label="Preview result">{preview.sample.value === null ? '(Empty)' : cellText(draft, preview.sample.value)}</output></p>}
      </> : <p>The formula is valid. Add a record to preview its result; this table is empty.</p>}
    </div>}
  </section>;
}
