import React, { useEffect, useRef, useState } from 'react';
import type { CellValue, RowRecord, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { cellDisplay, sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
import { RecordHistoryPanel } from './record-history.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';

export interface RecordAction {
  kind: 'create' | 'edit' | 'duplicate' | 'delete';
  records: RowRecord[];
  initialValues?: Record<string, CellValue>;
}

export function RecordDialog({ action, table, api, setDirty, onClose, onSaved }: {
  action: RecordAction; table: Table; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(): void; onSaved(): void;
}) {
  const original = action.records[0];
  const [initialValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(table.fields.map(field =>
    [field.id, toFormValue(field, original ? original.values[field.id]
      : action.initialValues && Object.hasOwn(action.initialValues, field.id) ? action.initialValues[field.id] : field.defaultValue)])));
  const [values, setValues] = useState(initialValues);
  const [confirmClose, setConfirmClose] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const deleting = action.kind === 'delete';
  const changed = table.fields.some(field => !sameValue(values[field.id], initialValues[field.id]));
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  const label = original && (original.formulaErrors?.[primary.id] ? `#ERROR: ${original.formulaErrors[primary.id]}`
    : cellDisplay(primary, original.values[primary.id]));
  const title = action.kind === 'create' ? 'New record' : action.kind === 'duplicate' ? 'Duplicate record'
    : deleting ? `Delete ${action.records.length === 1 ? 'record' : `${action.records.length} records`}` : label || 'Untitled record';
  const requestClose = () => { if (changed) setConfirmClose(true); else onClose(); };
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={title} subtitle={`${table.name} · ${action.kind === 'edit' ? 'Record details' : 'Record'}`} onClose={requestClose} busy={busy} drawer={!deleting}>
    {action.kind === 'edit' && <nav className="record-sections" aria-label="Record sections">
      <button type="button" aria-pressed={!historyOpen} disabled={busy} onClick={() => setHistoryOpen(false)}>Details</button>
      <button type="button" aria-pressed={historyOpen} disabled={busy} onClick={() => setHistoryOpen(true)}>History</button>
    </nav>}
    {confirmClose && <section className="discard-confirmation" aria-label="Unsaved record changes">
      <p>Discard your unsaved changes to this record?</p>
      <div><button type="button" autoFocus onClick={() => {
        setConfirmClose(false);
        setHistoryOpen(false);
        requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('input, textarea, select')?.focus());
      }}>Keep editing</button><button type="button" onClick={onClose}>Discard changes</button></div>
    </section>}
    {action.kind === 'edit' && !historyOpen && <details className="form-note"><summary>Record identity</summary>
      <p>Record ID (primary key): <code>{original!.id}</code></p>
      <p>This UUID stays the same when values or display names change. Linked records refer to this ID.</p>
    </details>}
    {historyOpen && <RecordHistoryPanel table={table} record={original!} api={api} hasDraft={changed} busy={busy} onRestore={async input => {
      setBusy(true); setDirty(true);
      try { await api.restoreRecord(table.id, original!.id, input); setDirty(false); onSaved(); }
      finally { setBusy(false); setDirty(changed); }
    }} />}
    <form ref={form} hidden={historyOpen} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && !deleting) event.currentTarget.requestSubmit();
      }
    }} onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setConfirmClose(false);
      setBusy(true);
      setDirty(true);
      setError(undefined);
      void (async () => {
        if (deleting) {
          await api.deleteRecords(table.id, action.records.map(record => ({ id: record.id, expectedVersion: record.version })));
        } else {
          const parsed = Object.fromEntries(table.fields.filter(field => field.type !== 'lookup' && field.type !== 'formula').map(field => [field.id, fromFormValue(field, values[field.id]!)]));
          if (action.kind === 'edit') {
            const changed = Object.fromEntries(Object.entries(parsed).filter(([id, value]) => !sameValue(value, original!.values[id] ?? null)));
            if (Object.keys(changed).length) await api.updateRecords(table.id, [{ id: original!.id, expectedVersion: original!.version, values: changed }]);
          } else await api.createRecords(table.id, [{ values: parsed }]);
        }
        setDirty(false);
        onSaved();
      })().catch(error => {
        setError(error instanceof Error ? error.message : 'The operation failed.');
        setBusy(false);
      });
    }}>
      {deleting ? <p>Delete {action.records.length === 1 ? 'this record' : `these ${action.records.length} records`}? You can recover them from Trash.</p>
        : table.fields.map(field => <FieldInput key={field.id} field={field} value={values[field.id]!} disabled={busy} calculationError={original?.formulaErrors?.[field.id]}
          onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setDirty(true); }} />)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">{!deleting && <span className="record-save-status">{changed ? 'Unsaved changes' : action.kind === 'edit' ? 'Saved values' : 'Not created yet'}</span>}
        <button type="button" disabled={busy} title={changed ? 'Discard changes and close' : 'Close without saving'} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy}>
          {busy ? 'Working…' : deleting ? 'Delete record' : action.kind === 'edit' ? 'Save record' : 'Create record'}</button></div>
    </form>
  </Dialog>;
}
