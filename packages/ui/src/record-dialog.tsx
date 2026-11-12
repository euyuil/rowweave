import React, { useEffect, useState } from 'react';
import type { CellValue, RowRecord, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { sameValue } from '../../client/src/cell-values.js';
import { Dialog } from './dialog.js';
import { FieldInput } from './field-input.js';
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
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(table.fields.map(field =>
    [field.id, toFormValue(field, original ? original.values[field.id]
      : action.initialValues && Object.hasOwn(action.initialValues, field.id) ? action.initialValues[field.id] : field.defaultValue)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleting = action.kind === 'delete';
  const title = action.kind === 'create' ? 'New record' : action.kind === 'duplicate' ? 'Duplicate record'
    : deleting ? `Delete ${action.records.length === 1 ? 'record' : `${action.records.length} records`}` : 'Record details';
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={title} onClose={onClose} busy={busy}>
    {action.kind === 'edit' && <details className="form-note"><summary>Record identity</summary>
      <p>Record ID (primary key): <code>{original!.id}</code></p>
      <p>This UUID stays the same when values or display names change. Linked records refer to this ID.</p>
    </details>}
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
      {deleting ? <p>Delete {action.records.length === 1 ? 'this record' : `these ${action.records.length} records`} permanently? This cannot be undone.</p>
        : table.fields.map(field => <FieldInput key={field.id} field={field} value={values[field.id]!} disabled={busy} calculationError={original?.formulaErrors?.[field.id]}
          onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setDirty(true); }} />)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy}>
          {busy ? 'Working…' : deleting ? 'Delete permanently' : action.kind === 'edit' ? 'Save record' : 'Create record'}</button></div>
    </form>
  </Dialog>;
}
