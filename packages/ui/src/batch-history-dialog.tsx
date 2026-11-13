import React, { useEffect, useRef, useState } from 'react';
import { maxBatchRecords, type RecordBatchPage, type RecordBatchChanges, type RecordBatchChange, type RecordChangeDetail, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { historyValue } from './record-history.js';

export function BatchHistoryDialog({ table, api, initialBatchId, redo = false, setDirty, onClose, onApplied }: {
  table: Table; api: WorkspaceApi; initialBatchId?: string | undefined; redo?: boolean;
  setDirty(value: boolean): void; onClose(): void; onApplied(batchId: string, redone: boolean): void;
}) {
  const [before, setBefore] = useState<number>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [page, setPage] = useState<RecordBatchPage>();
  const [selected, setSelected] = useState(initialBatchId);
  const [changeBefore, setChangeBefore] = useState<number>();
  const [changePrevious, setChangePrevious] = useState<Array<number | undefined>>([]);
  const [details, setDetails] = useState<RecordBatchChanges>();
  const [inspecting, setInspecting] = useState<RecordBatchChange>();
  const [snapshot, setSnapshot] = useState<{ change: RecordChangeDetail; table: Table }>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState<string>();
  const errorElement = useRef<HTMLParagraphElement>(null);
  const confirmationElement = useRef<HTMLElement>(null);
  const detailElement = useRef<HTMLElement>(null);
  useEffect(() => { setDirty(busy); return () => setDirty(false); }, [busy, setDirty]);
  useEffect(() => { if (error) { errorElement.current?.scrollIntoView({ block: 'nearest' }); errorElement.current?.focus({ preventScroll: true }); } }, [error]);
  useEffect(() => { if (confirmation) confirmationElement.current?.scrollIntoView({ block: 'nearest' }); }, [confirmation]);
  useEffect(() => {
    let active = true;
    setLoading(true); setPage(undefined); setError(undefined);
    void api.recordBatches(table.id, { limit: 10, ...(before === undefined ? {} : { before }) }).then(page => {
      if (active) { setPage(page); setSelected(current => current ?? page.batches[0]?.id); }
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, table.id, before, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setLoadingChanges(true); setDetails(undefined); setInspecting(undefined); setSnapshot(undefined); setError(undefined); setConfirmation(false);
    void api.recordBatchChanges(table.id, selected, { limit: 10, ...(changeBefore === undefined ? {} : { before: changeBefore }) }).then(details => {
      if (active) { setDetails(details); setInspecting(details.changes[0]); }
    }).catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoadingChanges(false); });
    return () => { active = false; };
  }, [api, table.id, selected, changeBefore, refresh]);
  useEffect(() => {
    if (!inspecting) return;
    let active = true;
    setSnapshot(undefined);
    void Promise.all([api.recordChange(inspecting.tableId, inspecting.recordId, inspecting.id), api.getTable(inspecting.tableId)])
      .then(([change, table]) => { if (active) setSnapshot({ change, table }); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, inspecting]);
  const batch = details?.batch;
  const isRedo = redo && selected === initialBatchId;
  const action = isRedo ? 'Redo' : 'Undo';
  const reason = batch && (!batch.recordWrite ? 'This operation changed the schema. Individual saved record values can still be restored from record history.'
    : batch.recordCount !== batch.remainingCount ? 'Part of this operation was removed with a table. It cannot be undone as a complete operation.'
      : batch.recordCount > maxBatchRecords ? `This operation exceeds the ${maxBatchRecords.toLocaleString()}-record undo limit.` : undefined);
  const choose = (id: string) => { setSelected(id); setChangeBefore(undefined); setChangePrevious([]); setConfirmation(false); };
  const changePage = (cursor: number | undefined, history: Array<number | undefined>) => {
    setBefore(cursor); setPrevious(history); setSelected(undefined); setDetails(undefined); setSnapshot(undefined); setInspecting(undefined);
    setChangeBefore(undefined); setChangePrevious([]); setConfirmation(false);
  };
  const changed = snapshot ? [...new Set([...Object.keys(snapshot.change.before?.values ?? {}), ...Object.keys(snapshot.change.after?.values ?? {}),
    ...Object.keys(snapshot.change.before?.formulaErrors ?? {}), ...Object.keys(snapshot.change.after?.formulaErrors ?? {})])]
    .filter(id => !sameValue(snapshot.change.before?.values[id], snapshot.change.after?.values[id]) || snapshot.change.before?.formulaErrors?.[id] !== snapshot.change.after?.formulaErrors?.[id]) : [];
  return <Dialog title="Saved changes" subtitle={`${table.name} · Complete operations`} drawer busy={busy} onClose={onClose}>
    <div className="trash-toolbar"><span>{batch ? `${batch.recordCount} affected record${batch.recordCount === 1 ? '' : 's'}` : 'Operation history'}</span>
      <button type="button" disabled={busy || loading || loadingChanges} onClick={() => { setBefore(undefined); setPrevious([]); setChangeBefore(undefined); setChangePrevious([]); setRefresh(value => value + 1); }}>Refresh saved changes</button>
      <button type="button" className="primary" disabled={busy || loading || loadingChanges || !batch || !!reason} onClick={() => setConfirmation(true)}>{action} operation</button></div>
    <p className="form-note">Review an entire saved operation, including changes in linked tables. Unsaved drafts have their own Undo and Redo controls.</p>
    {confirmation && batch && <section ref={confirmationElement} className="history-confirmation" aria-label="Confirm saved operation">
      <h3>{action} this saved operation?</h3><p>This will reverse all {batch.recordCount} affected record{batch.recordCount === 1 ? '' : 's'}, including records on other pages and in other tables.</p>
      <p>Created records will be removed, edited values restored, and deleted records recreated with their original IDs. Current field rules apply. Any later change to an affected record stops the entire operation.</p>
      <div className="history-restore-actions"><button type="button" disabled={busy} onClick={() => setConfirmation(false)}>Cancel {action.toLowerCase()}</button>
        <button type="button" className="primary" disabled={busy || !!reason} onClick={() => {
          setBusy(true); setError(undefined);
          void api.undoRecordBatch(table.id, batch.id).then(result => { setDirty(false); onApplied(result.batchId, isRedo); })
            .catch(error => { setError(error.message); setBusy(false); });
        }}>{busy ? 'Working…' : `${action} all changes`}</button></div>
    </section>}
    {error && <p ref={errorElement} tabIndex={-1} className="form-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading saved operations…</p> : page?.batches.length === 0 ? <p>No saved operations yet. Complete operation history starts with changes saved after the workspace upgrade.</p>
      : <ol className="history-list" aria-label="Saved operations">{page?.batches.map(batch => <li key={batch.id}>
        <button type="button" aria-label={`Review operation ${batch.id}`} aria-pressed={selected === batch.id} disabled={busy} onClick={() => choose(batch.id)}>
          <span>{batch.undoOf ? 'Reversed operation' : batch.recordWrite ? 'Saved records' : 'Schema changes'} · {batch.recordCount} record{batch.recordCount === 1 ? '' : 's'}</span>
          <time dateTime={batch.changedAt}>{new Date(batch.changedAt).toLocaleString()}</time></button></li>)}</ol>}
    <div className="history-pagination"><button type="button" disabled={busy || loading || !previous.length} onClick={() => changePage(previous.at(-1), previous.slice(0, -1))}>Newer operations</button>
      <button type="button" disabled={busy || loading || page?.nextBefore === undefined} onClick={() => changePage(page!.nextBefore, [...previous, before])}>Older operations</button></div>
    {loadingChanges && <p role="status">Loading affected records…</p>}
    {batch && details && <section aria-label="Affected records"><h3>Records in this operation</h3>
      <p className="form-note">{new Date(batch.changedAt).toLocaleString()} · {batch.remainingCount} of {batch.recordCount} changes remain in history. Each page shows up to ten records.</p>
      {reason && <p className="history-draft-note" role="status">{reason}</p>}
      <ol className="history-list">{details.changes.map(change => <li key={change.id}>
        <button type="button" aria-label={`Inspect operation record ${change.recordId}`} aria-pressed={inspecting?.id === change.id} disabled={busy} onClick={() => {
          setInspecting(change); requestAnimationFrame(() => detailElement.current?.scrollIntoView({ block: 'start' }));
        }}><span>{change.afterVersion === null ? 'Deleted' : change.beforeVersion === null ? 'Created' : 'Updated'} · {change.recordId.slice(0, 8)}</span>
          <span>{change.beforeVersion ?? 'New'} → {change.afterVersion ?? 'Deleted'}</span></button></li>)}</ol>
      <div className="history-pagination"><button type="button" disabled={busy || loadingChanges || !changePrevious.length} onClick={() => { setChangeBefore(changePrevious.at(-1)); setChangePrevious(changePrevious.slice(0, -1)); }}>Newer record changes</button>
        <button type="button" disabled={busy || loadingChanges || details.nextBefore === undefined} onClick={() => { setChangePrevious([...changePrevious, changeBefore]); setChangeBefore(details.nextBefore); }}>Older record changes</button></div>
    </section>}
    {inspecting && !snapshot && !error && <p role="status">Loading saved values…</p>}
    {snapshot && <section ref={detailElement} className="trash-details" aria-label="Operation record details">
      <h3>{snapshot.table.name}</h3><p className="form-note">Record ID: <code>{snapshot.change.recordId}</code></p>
      {changed.length ? <div className="history-comparison"><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>
        {changed.map(id => { const field = snapshot.table.fields.find(field => field.id === id); return <tr key={id}><th scope="row">{field?.name ?? `Removed field (${id})`}</th>
          <td><pre>{historyValue(field, snapshot.change.before?.values[id], snapshot.change.before?.formulaErrors?.[id])}</pre></td>
          <td><pre>{historyValue(field, snapshot.change.after?.values[id], snapshot.change.after?.formulaErrors?.[id])}</pre></td></tr>; })}
      </tbody></table></div> : <p>The saved values did not change.</p>}
      <p className="form-note">Historical links use record IDs. Undo applies current schemas and recalculates formulas.</p>
    </section>}
  </Dialog>;
}
