import React, { useEffect, useState } from 'react';
import type { GridView, Table, ViewColumn } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';

export function ViewDialog({ kind, view, search, table, api, setDirty, onClose, onSaved }: {
  kind: 'create' | 'edit' | 'delete'; view: GridView; search: string; table: Table; api: WorkspaceApi;
  setDirty(value: boolean): void; onClose(): void; onSaved(view: GridView | undefined): void;
}) {
  const [name, setName] = useState(kind === 'create' ? 'New view' : view.name);
  const [savedSearch, setSavedSearch] = useState(search);
  const [columns, setColumns] = useState<ViewColumn[]>(view.columns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleting = kind === 'delete';
  const fields = new Map(table.fields.map(field => [field.id, field]));
  useEffect(() => () => setDirty(false), [setDirty]);
  const move = (index: number, delta: number) => {
    const next = [...columns];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    setColumns(next);
    setDirty(true);
  };
  return <Dialog title={kind === 'create' ? 'Create view' : deleting ? 'Delete view' : 'View settings'} onClose={onClose} busy={busy} wide={!deleting}>
    <form onChange={() => setDirty(true)} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        if (!busy && !deleting && columns.some(column => !column.hidden)) event.currentTarget.requestSubmit();
      }
    }} onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void (async () => {
        let result: GridView | undefined;
        const config = { name, columns, query: { ...view.query, search: savedSearch } };
        if (deleting) await api.deleteView(table.id, view.id, view.version);
        else if (kind === 'create') result = await api.createView(table.id, config);
        else result = await api.updateView(table.id, view.id, { ...config, expectedVersion: view.version });
        setDirty(false);
        onSaved(result);
      })().catch(error => { setError(error instanceof Error ? error.message : 'The view could not be saved.'); setBusy(false); });
    }}>
      {deleting ? <p>Delete <strong>{view.name}</strong>? Its records remain in the table.</p> : <fieldset disabled={busy}>
        <label className="form-field">View name<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="form-field">Saved search<input value={savedSearch} onChange={event => setSavedSearch(event.target.value)} /></label>
        <p className="form-note">Choose the fields and their order in this view. Hidden fields remain in each record.</p>
        <div>{columns.map((column, index) => {
          const field = fields.get(column.fieldId)!;
          return <div className="view-column" role="group" aria-label={field.name} key={field.id}>
            <label className="check-field"><input type="checkbox" checked={!column.hidden} aria-label={`Show ${field.name}`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, hidden: !event.target.checked } : item))} />{field.name}</label>
            <label className="column-width">Width<input type="number" min={50} max={1000} step={1} required value={column.width} aria-label={`${field.name} width`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, width: Number(event.target.value) } : item))} /></label>
            <button type="button" disabled={index === 0} aria-label={`Move ${field.name} up`} onClick={() => move(index, -1)}>↑</button>
            <button type="button" disabled={index === columns.length - 1} aria-label={`Move ${field.name} down`} onClick={() => move(index, 1)}>↓</button>
          </div>;
        })}</div>
        {columns.every(column => column.hidden) && <p className="form-error">Keep at least one field visible.</p>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy || (!deleting && columns.every(column => column.hidden))}>
          {busy ? 'Working…' : deleting ? 'Delete view' : kind === 'create' ? 'Create view' : 'Save view'}</button></div>
    </form>
  </Dialog>;
}
