import React, { useRef, useState } from 'react';
import { maxFields, type Field, type Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';
import { FieldForm, fieldTypeNames } from './field-form.js';
import { RelationPairDialog } from './relation-pair-dialog.js';

export function FieldsDialog({ initial, api, setDirty, onClose, onSaved }: {
  initial: Table; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(schemaChanged: boolean): void; onSaved(): Promise<void>;
}) {
  const [table, setTable] = useState(initial);
  const [editing, setEditing] = useState<Field | 'new'>();
  const [removing, setRemoving] = useState<Field>();
  const [pairing, setPairing] = useState<{ field: Field; trigger: HTMLButtonElement }>();
  const fields = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => onClose(table.version !== initial.version);
  const saved = async (next: Table) => {
    setBusy(true);
    setTable(next);
    setEditing(undefined);
    setRemoving(undefined);
    setError(undefined);
    try { await onSaved(); }
    finally { setPairing(undefined); setBusy(false); }
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
  return <><Dialog title="Manage fields" onClose={close} busy={busy || !!pairing} wide>
    <p className="form-note">The primary display field labels records in linked tables. It is not a unique key; values may repeat or be empty unless the field requires a value.</p>
    <p className="form-note">The immutable record ID is its primary key. Each column has a separate field ID that follows it when you rename or move it.</p>
    <div ref={fields} className="schema-fields">{table.fields.map((field, index) => <div className="schema-field" role="group" aria-label={field.name} data-field-id={field.id} key={field.id}>
      <div className="schema-field-name"><strong>{field.name}</strong><small>{fieldTypeNames[field.type]}{field.required ? ' · Required' : ''}{field.id === table.primaryFieldId ? ' · Primary display field' : ''}{field.relation?.inverseFieldId ? ' · Two-way' : ''}</small></div>
      {field.description && <p className="form-note field-description">{field.description}</p>}
      <div className="schema-field-actions">
        <button disabled={busy || index === 0} aria-label={`Move ${field.name} up`} onClick={() => move(index, -1)}>↑</button>
        <button disabled={busy || index === table.fields.length - 1} aria-label={`Move ${field.name} down`} onClick={() => move(index, 1)}>↓</button>
        <button data-configure disabled={busy} onClick={() => setEditing(field)}>Configure</button>
        {field.type === 'relation' && !field.relation!.inverseFieldId && <button disabled={busy}
          onClick={event => setPairing({ field, trigger: event.currentTarget })}>Pair existing field</button>}
        <button disabled={busy || field.id === table.primaryFieldId || ['relation', 'lookup', 'attachment'].includes(field.type)} onClick={() => void write(() => api.updateTable(table.id, {
          expectedVersion: table.version, primaryFieldId: field.id,
        }))}>Use as primary display field</button>
        <button disabled={busy || field.id === table.primaryFieldId} onClick={() => { setError(undefined); setRemoving(field); }}>Delete</button>
      </div>
    </div>)}</div>
    {error && <p className="form-error" role="alert">{error} Close this dialog and reload the table if its schema changed elsewhere.</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={close}>Done</button>
      <button className="primary" disabled={busy || table.fields.length >= maxFields} onClick={() => setEditing('new')}>Add field</button></div>
  </Dialog>{pairing && <RelationPairDialog tableId={table.id} fieldId={pairing.field.id} api={api} setDirty={setDirty}
    onRead={setTable} onClose={() => setPairing(undefined)} onSaved={saved} restoreFocus={() => {
      if (pairing.trigger.isConnected) pairing.trigger.focus({ preventScroll: true });
      else fields.current?.querySelector<HTMLButtonElement>(`[data-field-id="${pairing.field.id}"] [data-configure]`)?.focus({ preventScroll: true });
    }} />}</>;
}
