import React, { useEffect, useState } from 'react';
import type { RowRecord, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
import { fromFormValue, toFormValue, type FormValue } from './field-input-values.js';

export interface RecordAction {
  kind: 'create' | 'edit' | 'duplicate' | 'delete';
  records: RowRecord[];
}

export function RecordDialog({ action, table, api, setDirty, onClose, onSaved }: {
  action: RecordAction; table: Table; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(): void; onSaved(): void;
}) {
  const original = action.records[0];
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(table.fields.map(field =>
    [field.id, toFormValue(field, original ? original.values[field.id] : field.defaultValue)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleting = action.kind === 'delete';
  const title = action.kind === 'create' ? 'New record' : action.kind === 'duplicate' ? 'Duplicate record'
    : deleting ? `Delete ${action.records.length === 1 ? 'record' : `${action.records.length} records`}` : 'Record details';
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={title} onClose={onClose} busy={busy}>
    <form onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && !deleting) event.currentTarget.requestSubmit();
      }
    }} onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setDirty(true);
      setError(undefined);
      void (async () => {
        if (deleting) {
          await api.deleteRecords(table.id, action.records.map(record => ({ id: record.id, expectedVersion: record.version })));
        } else {
          const parsed = Object.fromEntries(table.fields.filter(field => field.type !== 'lookup').map(field => [field.id, fromFormValue(field, values[field.id]!)]));
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
      {deleting ? <p>Delete {action.records.length === 1 ? 'this record' : `these ${action.records.length} records`} permanently? This cannot be undone.</p>
        : table.fields.map(field => <FieldInput key={field.id} field={field} value={values[field.id]!} disabled={busy}
          onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setDirty(true); }} />)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy}>
          {busy ? 'Working…' : deleting ? 'Delete permanently' : action.kind === 'edit' ? 'Save record' : 'Create record'}</button></div>
    </form>
  </Dialog>;
}
