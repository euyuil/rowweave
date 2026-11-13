import React, { useState } from 'react';
import { maxFields, type Field, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';
import { FieldForm, fieldTypeNames } from './field-form.js';

export function FieldsDialog({ initial, api, setDirty, onClose, onSaved }: {
  initial: Table; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(): void; onSaved(): Promise<void>;
}) {
  const [table, setTable] = useState(initial);
  const [editing, setEditing] = useState<Field | 'new'>();
  const [removing, setRemoving] = useState<Field>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saved = async (next: Table) => {
    setBusy(true);
    setTable(next);
    setEditing(undefined);
    setRemoving(undefined);
    setError(undefined);
    try { await onSaved(); }
    finally { setBusy(false); }
  };
  const write = async (operation: () => Promise<Table>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try { await saved(await operation()); }
    catch (error) { setError(error instanceof Error ? error.message : 'The schema could not be changed.'); }
    finally { setBusy(false); }
  };
  const move = (index: number, delta: number) => {
    const order = table.fields.map(field => field.id);
    [order[index], order[index + delta]] = [order[index + delta]!, order[index]!];
    void write(() => api.updateTable(table.id, { expectedVersion: table.version, fieldOrder: order }));
  };
  if (editing) return <FieldForm table={table} field={editing === 'new' ? undefined : editing} api={api}
    setDirty={setDirty} onClose={() => setEditing(undefined)} onSaved={saved} />;
  if (removing) return <Dialog title="Delete field" onClose={() => setRemoving(undefined)} busy={busy}>
    <p>Delete <strong>{removing.name}</strong> and its values in every record? This cannot be undone. Saved views will remove this field and its filters.</p>
    {removing.relation?.inverseFieldId && <p>The opposite field and its values remain as one-way links. Future changes will no longer synchronize.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={() => setRemoving(undefined)}>Cancel</button>
      <button className="danger" disabled={busy} onClick={() => void write(() => api.deleteField(table.id, removing.id, table.version))}>Delete permanently</button></div>
  </Dialog>;
  return <Dialog title="Manage fields" onClose={onClose} busy={busy} wide>
    <p className="form-note">The primary display field labels records in linked tables. It is not a unique key; values may repeat or be empty unless the field requires a value.</p>
    <p className="form-note">Each record has an immutable record ID (UUID), its primary key. Each column has a separate field ID that stays the same when you rename or move it.</p>
    <div className="schema-fields">{table.fields.map((field, index) => <div className="schema-field" role="group" aria-label={field.name} key={field.id}>
      <div className="schema-field-name"><strong>{field.name}</strong><small>{fieldTypeNames[field.type]}{field.required ? ' · Required' : ''}{field.id === table.primaryFieldId ? ' · Primary display field' : ''}</small></div>
      <div className="schema-field-actions">
        <button disabled={busy || index === 0} aria-label={`Move ${field.name} up`} onClick={() => move(index, -1)}>↑</button>
        <button disabled={busy || index === table.fields.length - 1} aria-label={`Move ${field.name} down`} onClick={() => move(index, 1)}>↓</button>
        <button disabled={busy} onClick={() => setEditing(field)}>Configure</button>
        <button disabled={busy || field.id === table.primaryFieldId || ['relation', 'lookup'].includes(field.type)} onClick={() => void write(() => api.updateTable(table.id, {
          expectedVersion: table.version, primaryFieldId: field.id,
        }))}>Use as primary display field</button>
        <button disabled={busy || field.id === table.primaryFieldId} onClick={() => { setError(undefined); setRemoving(field); }}>Delete</button>
      </div>
    </div>)}</div>
    {error && <p className="form-error" role="alert">{error} Close this dialog and reload the table if its schema changed elsewhere.</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Done</button>
      <button className="primary" disabled={busy || table.fields.length >= maxFields} onClick={() => setEditing('new')}>Add field</button></div>
  </Dialog>;
}
