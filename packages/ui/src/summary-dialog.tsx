import React, { useEffect, useState } from 'react';
import type { GridView, RecordSummary, SummaryMeasure, Table } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from '../../client/src/http-client.js';
import { cellDisplay } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';

export function SummaryDialog({ table, view, search, api, onClose }: {
  table: Table; view: GridView; search: string; api: WorkspaceApi; onClose(): void;
}) {
  const [groupBy, setGroupBy] = useState('');
  const [fieldId, setFieldId] = useState(table.fields.find(field => field.type === 'number')?.id ?? '');
  const [operation, setOperation] = useState<SummaryMeasure['operation']>('sum');
  const [page, setPage] = useState<{ offset: number; revision?: number }>({ offset: 0 });
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<RecordSummary>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const field = table.fields.find(field => field.id === fieldId);
  const measureName = { sum: 'Sum', average: 'Average', min: 'Minimum', max: 'Maximum' }[operation];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setResult(undefined);
    setError(undefined);
    void api.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version, search,
      ...(groupBy ? { groupBy } : {}), measures: fieldId ? [{ fieldId, operation }] : [],
      offset: page.offset, limit: 50, ...(page.revision === undefined ? {} : { expectedRevision: page.revision }) }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setResult(result); })
      .catch(error => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Could not summarize records.';
        setError(error instanceof ApiFailure && ['VIEW_CONFLICT', 'SCHEMA_CONFLICT', 'INVALID_SUMMARY'].includes(error.code)
          ? `${message} Close this dialog and reload the table to use the current view and fields.` : message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, table.id, view.id, view.version, search, groupBy, fieldId, operation, page, refresh]);
  const display = (value: number | null) => value === null ? '—' : cellDisplay(field!, value);
  return <Dialog title="Summarize records" onClose={onClose} wide>
    <p className="form-note">All saved records matching <strong>{view.name}</strong>{search ? ` and search “${search}”` : ''}. Empty numeric values are excluded from calculations.</p>
    <div className="form-row">
      <label className="form-field">Group by<select aria-label="Group by" value={groupBy} onChange={event => { setGroupBy(event.target.value); setPage({ offset: 0 }); }}>
        <option value="">No grouping</option>
        {table.fields.filter(field => !['multiSelect', 'relation', 'lookup'].includes(field.type)).map(field =>
          <option key={field.id} value={field.id}>{field.name}</option>)}
      </select></label>
      <label className="form-field">Measure field<select aria-label="Measure field" value={fieldId} onChange={event => { setFieldId(event.target.value); setPage({ offset: 0 }); }}>
        <option value="">Record count only</option>
        {table.fields.filter(field => field.type === 'number').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
      </select></label>
      <label className="form-field">Calculation<select aria-label="Calculation" value={operation} disabled={!fieldId} onChange={event => { setOperation(event.target.value as SummaryMeasure['operation']); setPage({ offset: 0 }); }}>
        <option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option>
      </select></label>
    </div>
    {loading && <p role="status">Calculating…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {result && <>
      <table className="summary-results" aria-label="Record summary"><thead><tr><th>Group</th><th>Records</th>{field && <th>{measureName} of {field.name}</th>}</tr></thead>
        <tbody><tr className="summary-total"><th scope="row">All matching records</th><td>{result.totals.count.toLocaleString()}</td>{field && <td>{display(result.totals.values[0]!)}</td>}</tr>
          {result.groups.map(group => <tr key={JSON.stringify(group.key)}><th scope="row">{group.key === null ? '(No value)' : group.key === '' ? '(Empty text)' : group.label}</th>
            <td>{group.count.toLocaleString()}</td>{field && <td>{display(group.values[0]!)}</td>}</tr>)}
        </tbody>
      </table>
      {result.totals.count === 0 && <p>No records match this view and search.</p>}
      {groupBy && result.groupCount > 0 && <div className="summary-pages">
        <button disabled={page.offset === 0} onClick={() => setPage({ offset: Math.max(0, page.offset - 50), revision: result.revision })}>Previous groups</button>
        <span>{page.offset + 1}–{page.offset + result.groups.length} of {result.groupCount.toLocaleString()} groups</span>
        <button disabled={page.offset + result.groups.length >= result.groupCount} onClick={() => setPage({ offset: page.offset + 50, revision: result.revision })}>Next groups</button>
      </div>}
    </>}
    <div className="dialog-actions"><button onClick={() => { setPage({ offset: 0 }); setRefresh(value => value + 1); }} disabled={loading}>Refresh summary</button>
      <button className="primary" onClick={onClose}>Done</button></div>
  </Dialog>;
}
