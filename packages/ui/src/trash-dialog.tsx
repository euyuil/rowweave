import React, { useContext, useEffect, useRef, useState } from 'react';
import { isReadOnlyField, maxBatchCells, maxBatchRecords, type DeletedRecord, type RecordTrashPage, type RowRecord, type Table } from '../../contracts/src/index.js';
import { validateValue } from '../../core/src/field-values.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';
import { historyValue } from './record-history.js';
import { AttachmentContext } from './attachment-context.js';

export function TrashDialog({ table: initialTable, api, setDirty, onClose, onRestored }: {
  table: Table; api: WorkspaceApi; setDirty(value: boolean): void; onClose(): void; onRestored(count: number): void;
}) {
  const [table, setTable] = useState(initialTable);
  const [page, setPage] = useState<RecordTrashPage>();
  const [before, setBefore] = useState<number>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(new Map<string, DeletedRecord>());
  const [inspecting, setInspecting] = useState<DeletedRecord>();
  const [snapshot, setSnapshot] = useState<RowRecord>();
  const [repairs, setRepairs] = useState<Record<string, Record<string, FormValue>>>({});
  const [loading, setLoading] = useState(true);
  const [writing, setBusy] = useState(false);
  const busy = writing || !!useContext(AttachmentContext)?.pending;
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState<'close' | 'refresh'>();
  const [error, setError] = useState<string>();
  const errorElement = useRef<HTMLParagraphElement>(null);
  const detailElement = useRef<HTMLElement>(null);
  const confirmation = useRef<HTMLElement>(null);
  const dirty = Object.keys(repairs).length > 0;
  const fields = table.fields.filter(field => !isReadOnlyField(field));
  const limit = Math.min(maxBatchRecords, Math.floor(maxBatchCells / fields.length));
  const label = (record: DeletedRecord) => historyValue(table.fields.find(field => field.id === table.primaryFieldId), record.displayValue);
  useEffect(() => { setDirty(dirty || busy); return () => setDirty(false); }, [dirty, busy, setDirty]);
  useEffect(() => { if (error) { errorElement.current?.scrollIntoView({ block: 'nearest' }); errorElement.current?.focus({ preventScroll: true }); } }, [error]);
  useEffect(() => { if (confirm) confirmation.current?.scrollIntoView({ block: 'nearest' }); }, [confirm]);
  useEffect(() => {
    let active = true;
    setLoading(true); setPage(undefined); setInspecting(undefined); setSnapshot(undefined); setError(undefined); setConfirm(false);
    void Promise.all([api.getTable(table.id), api.recordTrash(table.id, { limit: 10, ...(before === undefined ? {} : { before }) })])
      .then(([current, page]) => { if (active) { setTable(current); setPage(page); } })
      .catch(error => { if (active) setError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, table.id, before, refresh]);
  useEffect(() => {
    if (!inspecting) return;
    let active = true;
    setSnapshot(undefined); setError(undefined);
    void api.recordChange(table.id, inspecting.id, inspecting.deletionId).then(change => {
      if (active) { setSnapshot(change.before!); requestAnimationFrame(() => detailElement.current?.scrollIntoView({ block: 'start' })); }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, table.id, inspecting]);
  const reset = () => { setSelected(new Map()); setRepairs({}); setBefore(undefined); setPrevious([]); setRefresh(value => value + 1); };
  const request = (action: 'close' | 'refresh') => { if (dirty) setDiscard(action); else if (action === 'close') onClose(); else reset(); };
  const restore = async () => {
    setError(undefined); setBusy(true);
    try {
      const records = [...selected.values()].map(record => ({ id: record.id, deletionId: record.deletionId,
        values: Object.fromEntries(Object.entries(repairs[record.id] ?? {}).map(([id, value]) => {
          const field = fields.find(field => field.id === id);
          if (!field) throw new Error('A repaired field changed. Refresh trash and review the current fields.');
          return [id, fromFormValue(field, value)];
        })) }));
      await api.restoreDeletedRecords(table.id, records);
      setDirty(false); onRestored(records.length);
    } catch (error) { setError(error instanceof Error ? error.message : 'Restoration failed.'); setBusy(false); }
  };
  return <Dialog title="Trash" subtitle={`${table.name} · Deleted records`} drawer busy={busy} onClose={() => request('close')}>
    <div className="trash-toolbar"><span>{selected.size} selected</span>
      <button type="button" disabled={loading || busy} onClick={() => request('refresh')}>Refresh trash</button>
      <button type="button" className="primary" disabled={loading || busy || !selected.size || selected.size > limit} onClick={() => setConfirm(true)}>Restore selected</button></div>
    <p className="form-note">Recover deleted records with their original IDs. Select across pages to restore linked records together.</p>
    {discard && <section className="discard-confirmation" aria-label="Unsaved restoration changes"><p>Discard your adjustments to restored values?</p>
      <button type="button" onClick={() => setDiscard(undefined)}>Keep reviewing</button>
      <button type="button" onClick={() => { const action = discard; setDiscard(undefined); if (action === 'close') onClose(); else reset(); }}>Discard adjustments</button></section>}
    {confirm && <section ref={confirmation} className="history-confirmation" aria-label="Confirm record restoration">
      <h3>Restore {selected.size} record{selected.size === 1 ? '' : 's'}?</h3>
      <p>Records will be appended with newer versions. Current field rules apply; formulas recalculate. If any record cannot be restored, none will be changed.</p>
      <ul>{[...selected.values()].slice(0, 10).map(record => <li key={record.id}>{label(record)}{repairs[record.id] ? ' · Adjusted values' : ''}</li>)}</ul>
      {selected.size > 10 && <p>And {selected.size - 10} more selected records.</p>}
      <div className="history-restore-actions"><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel restoration</button>
        <button type="button" className="primary" disabled={busy || !selected.size || selected.size > limit} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore records'}</button></div>
    </section>}
    {error && <p ref={errorElement} tabIndex={-1} className="form-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading trash…</p> : page?.records.length === 0 ? <p>No deleted records on this page.</p> : <>
      <div className="trash-selection"><button type="button" disabled={busy || !page || new Set([...selected.keys(), ...page.records.map(record => record.id)]).size > limit}
        onClick={() => { setSelected(current => new Map([...current, ...page!.records.map(record => [record.id, record] as const)])); setConfirm(false); }}>Select page</button>
        <button type="button" disabled={busy || !selected.size} onClick={() => { setSelected(new Map()); setConfirm(false); }}>Clear selection</button>
        <small>Up to {limit.toLocaleString()} records for this table</small></div>
      <ul className="trash-list">{page?.records.map(record => <li key={record.deletionId}>
        <input type="checkbox" aria-label={`Select deleted record ${record.id}`} checked={selected.has(record.id)} disabled={busy || (!selected.has(record.id) && selected.size >= limit)} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => { const next = new Map(current); if (checked) next.set(record.id, record); else next.delete(record.id); return next; }); setConfirm(false);
        }} />
        <button type="button" aria-label={`Inspect deleted record ${record.id}`} aria-pressed={inspecting?.id === record.id} disabled={busy} onClick={() => setInspecting(record)}>
          <strong>{label(record)}</strong><span>Version {record.version} · Deleted {new Date(record.deletedAt).toLocaleString()}{repairs[record.id] ? ' · Adjusted' : ''}</span></button>
      </li>)}</ul>
    </>}
    <div className="history-pagination"><button type="button" disabled={busy || loading || !previous.length} onClick={() => { setBefore(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>Newer deletions</button>
      <button type="button" disabled={busy || loading || page?.nextBefore === undefined} onClick={() => { setPrevious([...previous, before]); setBefore(page!.nextBefore); }}>Older deletions</button></div>
    {inspecting && !snapshot && !error && <p role="status">Loading deleted values…</p>}
    {snapshot && inspecting && <section ref={detailElement} className="trash-details" aria-label="Deleted record details">
      <h3>Review deleted values</h3><p className="form-note">Record ID: <code>{snapshot.id}</code></p>
      <div className="history-comparison"><table><thead><tr><th>Field</th><th>Saved value</th></tr></thead><tbody>
        {Object.entries(snapshot.values).map(([id, value]) => { const field = table.fields.find(field => field.id === id); return <tr key={id}>
          <th scope="row">{field?.name ?? `Removed field (${id})`}</th><td><pre>{historyValue(field, value, snapshot.formulaErrors?.[id])}</pre></td></tr>; })}
      </tbody></table></div>
      <details><summary>Adjust values for restoration</summary><p className="form-note">Adjust only the fields you need to repair. New fields use current defaults; removed fields stay removed. Select this record above to include it in restoration.</p>
        {fields.map(field => {
          const stored = Object.hasOwn(snapshot.values, field.id) ? snapshot.values[field.id] : field.defaultValue ?? null;
          let initial: FormValue = null, incompatible = false;
          try { initial = toFormValue(field, validateValue(field, stored)); } catch { incompatible = true; }
          const edits = repairs[snapshot.id] ?? {};
          const change = (value: FormValue) => { setRepairs(current => { const next = { ...current }, values = { ...next[snapshot.id] };
              if (!incompatible && sameValue(initial, value)) delete values[field.id]; else values[field.id] = value;
              if (Object.keys(values).length) next[snapshot.id] = values; else delete next[snapshot.id]; return next;
            }); setConfirm(false); };
          return <div key={field.id}><FieldInput field={field} value={Object.hasOwn(edits, field.id) ? edits[field.id]! : initial} disabled={busy} onChange={change} />
            {incompatible && !Object.hasOwn(edits, field.id) && <p className="form-note">The saved value is incompatible with {field.name}. Enter a replacement to restore it.
              {!field.required && <button type="button" disabled={busy} onClick={() => change(null)}>Restore {field.name} empty</button>}</p>}</div>;
        })}
      </details>
    </section>}
  </Dialog>;
}
