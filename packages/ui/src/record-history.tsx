import React, { useEffect, useRef, useState } from 'react';
import { isReadOnlyField, type CellValue, type Field, type RecordChangeDetail, type RecordHistoryPage, type RecordRestore, type RowRecord, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { sameValue } from '../../client/src/cell-values.js';

export function historyValue(field: Field | undefined, value: CellValue | undefined, error?: string): string {
  if (error) return `#ERROR: ${error}`;
  if (value === undefined) return 'Not present';
  if (value === null) return 'Empty';
  if (value === '') return 'Empty text';
  const option = (id: string) => field?.options?.find(option => option.id === id)?.name ?? id;
  if (field?.type === 'singleSelect' && typeof value === 'string') return option(value);
  if (field?.type === 'multiSelect' && Array.isArray(value)) return value.map(value => typeof value === 'string' ? option(value) : String(value)).join(', ') || 'No options';
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

export function RecordHistoryPanel({ table, record, api, hasDraft, busy, onRestore }: {
  table: Table; record: RowRecord; api: WorkspaceApi; hasDraft: boolean; busy: boolean;
  onRestore(input: RecordRestore): Promise<void>;
}) {
  const [before, setBefore] = useState<number>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<RecordHistoryPage>();
  const [selected, setSelected] = useState<number>();
  const [detail, setDetail] = useState<RecordChangeDetail>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [restoreSide, setRestoreSide] = useState<'before' | 'after'>();
  const errorMessage = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) { errorMessage.current?.scrollIntoView({ block: 'nearest' }); errorMessage.current?.focus({ preventScroll: true }); } }, [error]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(undefined); setPage(undefined); setRestoreSide(undefined); setSelected(undefined); setDetail(undefined); setDetailLoading(false);
    void api.recordHistory(table.id, record.id, { limit: 10, ...(before === undefined ? {} : { before }) }).then(page => {
      if (active) { setPage(page); setSelected(page.changes[0]?.id); }
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, table.id, record.id, before, refresh]);
  useEffect(() => {
    if (selected === undefined) return;
    let active = true;
    setDetail(undefined); setDetailLoading(true); setError(undefined); setRestoreSide(undefined);
    void api.recordChange(table.id, record.id, selected).then(detail => { if (active) setDetail(detail); })
      .catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [api, table.id, record.id, selected]);
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const changed = detail ? [...new Set([...Object.keys(detail.before?.values ?? {}), ...Object.keys(detail.after?.values ?? {}),
    ...Object.keys(detail.before?.formulaErrors ?? {}), ...Object.keys(detail.after?.formulaErrors ?? {})])]
    .filter(id => !sameValue(detail.before?.values[id], detail.after?.values[id]) || detail.before?.formulaErrors?.[id] !== detail.after?.formulaErrors?.[id]) : [];
  const snapshot = restoreSide && detail?.[restoreSide];
  const restoring = snapshot ? table.fields.filter(field => !isReadOnlyField(field) && Object.hasOwn(snapshot.values, field.id)
    && !sameValue(record.values[field.id], snapshot.values[field.id])) : [];
  const name = (id: string) => fields.get(id)?.name ?? `Removed field (${id})`;
  return <section className="record-history" aria-label="Record history">
    <div className="history-toolbar"><p>Saved changes</p><button type="button" disabled={busy || loading} onClick={() => {
      setBefore(undefined); setPrevious([]); setRefresh(value => value + 1);
    }}>Refresh history</button></div>
    <p className="form-note">View saved values before and after each change. Restoring creates a new saved version.</p>
    {hasDraft && <p className="history-draft-note" role="status">Your unsaved changes are kept. Save or discard them before restoring a snapshot.</p>}
    {loading ? <p role="status">Loading history…</p> : page?.changes.length === 0 ? <p>No saved changes yet. History starts with changes saved after the workspace upgrade.</p>
      : <ol className="history-list">{page?.changes.map(change => <li key={change.id}>
        <button type="button" aria-label={`View change ${change.id}`} aria-pressed={selected === change.id} disabled={busy} onClick={() => setSelected(change.id)}>
          <span>{change.restoredFrom ? 'Restored' : change.beforeVersion === null ? 'Created' : change.afterVersion === null ? 'Deleted' : 'Saved'}
            {change.afterVersion !== null && ` · Version ${change.afterVersion}`}</span>
          <time dateTime={change.changedAt} title={change.changedAt}>{new Date(change.changedAt).toLocaleString()}</time>
        </button></li>)}</ol>}
    <div className="history-pagination"><button type="button" disabled={busy || loading || !previous.length} onClick={() => {
      setBefore(previous.at(-1)); setPrevious(previous.slice(0, -1));
    }}>Newer changes</button><button type="button" disabled={busy || loading || page?.nextBefore === undefined} onClick={() => {
      setPrevious([...previous, before]); setBefore(page!.nextBefore);
    }}>Older changes</button></div>
    {detailLoading && <p role="status">Loading saved values…</p>}
    {detail && <section aria-label="Saved change details">
      <h3>{detail.beforeVersion === null ? 'Record created' : `Version ${detail.beforeVersion}`} → {detail.afterVersion === null ? 'Record deleted' : `Version ${detail.afterVersion}`}</h3>
      {changed.length ? <div className="history-comparison"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
        <tbody>{changed.map(id => <tr key={id}><th scope="row" title={id}>{name(id)}</th>
          <td><pre>{historyValue(fields.get(id), detail.before?.values[id], detail.before?.formulaErrors?.[id])}</pre></td>
          <td><pre>{historyValue(fields.get(id), detail.after?.values[id], detail.after?.formulaErrors?.[id])}</pre></td></tr>)}</tbody></table></div>
        : <p>The saved values did not change.</p>}
      <p className="form-note">Historical links use record IDs. Removed fields remain visible here.</p>
      <div className="history-restore-actions"><button type="button" disabled={busy || hasDraft || !detail.before} onClick={() => setRestoreSide('before')}>Restore before change</button>
        <button type="button" disabled={busy || hasDraft || !detail.after} onClick={() => setRestoreSide('after')}>Restore after change</button></div>
    </section>}
    {snapshot && detail && restoreSide && <section className="history-confirmation" aria-label="Restore saved values">
      <h3>Restore version {snapshot.version}?</h3>
      <p>{restoring.length} current field value{restoring.length === 1 ? '' : 's'} will change. Newer fields stay as they are; formulas recalculate using current definitions.</p>
      {restoring.length > 0 && <div className="history-comparison"><table><thead><tr><th>Field</th><th>Current</th><th>Restore to</th></tr></thead>
        <tbody>{restoring.map(field => <tr key={field.id}><th scope="row">{field.name}</th><td><pre>{historyValue(field, record.values[field.id])}</pre></td>
          <td><pre>{historyValue(field, snapshot.values[field.id])}</pre></td></tr>)}</tbody></table></div>}
      <div className="history-restore-actions"><button type="button" disabled={busy} onClick={() => setRestoreSide(undefined)}>Cancel restoration</button>
        <button type="button" className="primary" disabled={busy || hasDraft} onClick={() => {
          setError(undefined);
          void onRestore({ changeId: detail.id, snapshot: restoreSide, expectedVersion: record.version }).catch(error => {
            setError(`${error.message} Close and reopen the record to review its latest saved values.`);
          });
        }}>{busy ? 'Restoring…' : 'Restore values'}</button></div>
    </section>}
    {error && <p ref={errorMessage} className="form-error" role="alert" tabIndex={-1}>{error}</p>}
  </section>;
}
