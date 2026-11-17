import React, { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isReadOnlyField, type RowRecord, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import type { LiveHistory } from '../../client/src/live-history.js';
import { cellDisplay, sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
import { AttachmentContext } from './attachment-context.js';
import { RecordHistoryPanel } from './record-history.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';

export function LiveRecordDialog({ original, table, api, history, setDirty, onClose, onSaved }: {
  original: RowRecord; table: Table; api: WorkspaceApi; history: LiveHistory; setDirty(value: boolean): void;
  onClose(): void; onSaved(records: RowRecord[]): void;
}) {
  useSyncExternalStore(history.subscribe, history.getSnapshot);
  const toForm = (record: RowRecord) => Object.fromEntries(table.fields.map(field => [field.id, toFormValue(field, record.values[field.id])]));
  const [base, setBase] = useState(original);
  const [values, setValues] = useState<Record<string, FormValue>>(() => toForm(original));
  const [editRevision, setEditRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [syncError, setSyncError] = useState<string>();
  const [composing, setComposing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const transferring = !!useContext(AttachmentContext)?.pending;
  const generation = useRef(0), writing = useRef(false);
  const lastInput = useRef<HTMLElement>();
  const retryPaused = useRef(false);
  const fieldVersions = useRef(Object.fromEntries(table.fields.map(field => [field.id, original.version])));
  const refresh = useRef<() => Promise<void>>();
  const latest = useRef({ base, values, composing }); latest.current = { base, values, composing };
  const changed = table.fields.some(field => !isReadOnlyField(field) && !sameValue(values[field.id], toFormValue(field, base.values[field.id])));
  useEffect(() => { setDirty(changed || history.busy || composing || restoring); }, [changed, history.busy, composing, restoring, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);
  const accept = (record: RowRecord, submitted?: Record<string, FormValue>) => {
    const current = latest.current;
    const next = toForm(record);
    const retained = { ...record.values };
    for (const field of table.fields) {
      const applied = submitted && Object.hasOwn(submitted, field.id);
      const previous = applied ? submitted[field.id] : toFormValue(field, current.base.values[field.id]);
      const dirty = !isReadOnlyField(field) && !sameValue(current.values[field.id], previous);
      if (dirty) next[field.id] = current.values[field.id]!;
      if (applied || !dirty) fieldVersions.current[field.id] = record.version;
      else retained[field.id] = current.base.values[field.id] ?? null;
    }
    setBase({ ...record, values: retained }); setValues(next);
  };
  refresh.current = async () => {
    if (writing.current || history.busy || latest.current.composing || showHistory) return;
    const version = ++generation.current;
    try {
      const schema = await api.getTable(table.id);
      if (version !== generation.current) return;
      if (schema.version !== table.version) { setError('The fields changed. Close this record and review the updated fields before continuing.'); return; }
      const record = await api.getRecord(table.id, original.id);
      if (version !== generation.current || writing.current || latest.current.composing) return;
      accept(record); setSyncError(undefined);
    } catch (failure) { if (version === generation.current) setSyncError(failure instanceof Error ? failure.message : 'Could not sync this record.'); }
  };
  useEffect(() => {
    const unsubscribe = api.watchWorkspace(() => void refresh.current!(), failure => setSyncError(failure.message));
    return () => { generation.current++; unsubscribe(); };
  }, [api]);
  const save = async () => {
    if (writing.current || history.busy || latest.current.composing || transferring) return;
    const submitted = latest.current.values, record = latest.current.base;
    writing.current = true; generation.current++;
    let submittedWrite = false;
    try {
      const changes = Object.fromEntries(table.fields.filter(field => !isReadOnlyField(field) &&
        !sameValue(submitted[field.id], toFormValue(field, record.values[field.id])))
        .map(field => [field.id, fromFormValue(field, submitted[field.id]!)]));
      if (!Object.keys(changes).length) return;
      setError(undefined);
      submittedWrite = true;
      const result = await history.commit(table, [{ record, values: changes,
        expectedFieldVersions: Object.fromEntries(Object.keys(changes).map(id => [id, fieldVersions.current[id]!])) }]);
      accept(result.records[0]!, Object.fromEntries(Object.keys(changes).map(id => [id, submitted[id]!]))); onSaved(result.records);
      retryPaused.current = false;
    } catch (failure) { retryPaused.current = submittedWrite; setError(failure instanceof Error ? failure.message : 'Could not save this record.'); }
    finally { writing.current = false; }
  };
  useEffect(() => {
    if (!changed || composing || transferring || history.busy || error || confirmClose) return;
    const timer = setTimeout(() => void save(), 300);
    return () => clearTimeout(timer);
  }, [editRevision, changed, composing, transferring, history.busy, error, confirmClose]);
  const move = async (redo: boolean) => {
    if (changed || writing.current || history.busy || composing) return;
    generation.current++;
    const before = latest.current.values;
    try {
      const result = await history.move(redo);
      if (result) {
        const record = result.records.find(record => record.id === base.id);
        const update = result.updates.find(update => update.id === base.id);
        if (record && update) accept(record, Object.fromEntries(Object.keys(update.values).map(id => [id, before[id]!])));
        onSaved(result.records);
      }
      setError(undefined);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change history.'); }
  };
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  return <Dialog title={cellDisplay(primary, base.values[primary.id]) || 'Untitled record'} subtitle={`${table.name} · Record details`}
    onClose={() => changed ? setConfirmClose(true) : onClose()} busy={history.busy || transferring || composing || restoring} drawer>
    <nav className="record-sections" aria-label="Record sections">
      <button type="button" disabled={composing || restoring} aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>Details</button>
      <button type="button" disabled={composing || restoring} aria-pressed={showHistory} onClick={() => setShowHistory(true)}>History</button>
    </nav>
    {confirmClose && <section className="discard-confirmation" aria-label="Unsaved record changes"><p>Discard changes that have not been saved?</p>
      <button autoFocus onClick={() => { setConfirmClose(false); setShowHistory(false); requestAnimationFrame(() => lastInput.current?.focus()); }}>Keep editing</button><button onClick={onClose}>Discard changes</button></section>}
    {showHistory && <RecordHistoryPanel table={table} record={base} api={api} hasDraft={changed} busy={history.busy || restoring} onRestore={async input => {
      setRestoring(true); generation.current++;
      try { const record = await api.restoreRecord(table.id, base.id, input); onSaved([record]); onClose(); }
      finally { setRestoring(false); }
    }} />}
    <form hidden={showHistory} onFocusCapture={event => { if (event.target instanceof HTMLElement) lastInput.current = event.target; }} onSubmit={event => { event.preventDefault(); void save(); }}
      onCompositionStart={() => { generation.current++; setComposing(true); }} onCompositionEnd={() => setComposing(false)}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!event.nativeEvent.isComposing) void save(); } }}>
      <details className="form-note"><summary>Record identity</summary><p>Record ID (primary key): <code>{base.id}</code></p></details>
      {table.fields.map(field => <FieldInput key={field.id} field={field} value={values[field.id]!} calculationError={base.formulaErrors?.[field.id]}
        onChange={value => { generation.current++; setEditRevision(value => value + 1); if (!retryPaused.current) setError(undefined); setValues(current => ({ ...current, [field.id]: value })); }} />)}
    </form>
    {error && <p className="form-error" role="alert">{error} Your unsaved changes are retained.</p>}
    {syncError && <p role="status">{syncError}</p>}
    <div className="dialog-actions"><span className="record-save-status" role="status">{history.busy ? 'Saving…' : changed ? error ? 'Not saved' : 'Waiting to save…' : 'All changes saved'}</span>
      <button disabled={changed || composing || !history.canUndo} onClick={() => void move(false)}>Undo</button>
      <button disabled={changed || composing || !history.canRedo} onClick={() => void move(true)}>Redo</button>
      {error && changed && <button disabled={history.busy || composing} onClick={() => void save()}>Retry saving</button>}
      <button disabled={history.busy || transferring || composing || restoring} onClick={() => changed ? setConfirmClose(true) : onClose()}>Close</button></div>
  </Dialog>;
}
