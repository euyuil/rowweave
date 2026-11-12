import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { TableModel } from '../../client/src/table-model.js';
import { TableApp, type TableHost } from './table-app.js';
import { Dialog } from './dialog.js';

type TableAction = { kind: 'create' } | { kind: 'rename' | 'delete'; table: Table };
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.';

export function WorkspaceApp({ api, host }: { api: WorkspaceApi; host: TableHost }) {
  const [tables, setTables] = useState<Table[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<TableAction>();
  const [offline, setOffline] = useState(false);
  const dirty = useRef({ table: false, form: false });
  const model = useMemo(() => selected ? new TableModel(api.table(selected)) : undefined, [api, selected]);
  const tableHost = useMemo<TableHost>(() => ({
    confirmDiscard: () => host.confirmDiscard(),
    onServiceExit: listener => host.onServiceExit(listener),
    setDirty: async value => {
      dirty.current.table = value;
      await host.setDirty(value || dirty.current.form);
    },
  }), [host]);
  const setFormDirty = useCallback((value: boolean) => {
    dirty.current.form = value;
    void host.setDirty(value || dirty.current.table).catch(error => setError(message(error)));
  }, [host]);

  const load = useCallback(async () => {
    const current = await api.listTables();
    setTables(current);
    setSelected(id => current.some(table => table.id === id) ? id : current[0]?.id);
    setLoaded(true);
    setError(undefined);
  }, [api]);
  useEffect(() => {
    void load().catch(error => setError(message(error)));
    return host.onServiceExit(() => {
      setOffline(true);
      setError('The data service stopped. Restart RowWeave to reconnect.');
    });
  }, [load, host]);

  const select = async (id: string) => {
    if (id === selected) return;
    if (model?.saving) { setError('Wait for the current save to finish before switching tables.'); return; }
    if (dirty.current.table && !await host.confirmDiscard()) return;
    await tableHost.setDirty(false);
    setSelected(id);
    setError(undefined);
  };
  const completed = async (result: Table | undefined) => {
    const previous = action!;
    setAction(undefined);
    setFormDirty(false);
    if (previous.kind === 'delete') {
      const remaining = tables.filter(table => table.id !== previous.table.id);
      setTables(remaining);
      await tableHost.setDirty(false);
      setSelected(remaining[0]?.id);
    } else if (result) {
      setTables(current => previous.kind === 'create' ? [...current, result]
        : current.map(table => table.id === result.id ? result : table));
      if (previous.kind === 'create') {
        try { await select(result.id); }
        catch (error) { setError(`Table created, but switching failed: ${message(error)}`); }
      } else {
        try { await model?.refresh(); }
        catch (error) { setError(`Table renamed, but refreshing failed: ${message(error)}`); }
      }
    }
  };

  return <main className="rowweave-app">
    <header className="app-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">▦</span> RowWeave</div>
      <span className="workspace-label">Local workspace</span>
    </header>
    <div className="workspace-body">
      <aside className="workspace-sidebar" aria-label="Workspace tables">
        <div className="sidebar-heading">TABLES</div>
        <nav aria-label="Tables">{tables.map(table => <button key={table.id}
          aria-current={selected === table.id ? 'page' : undefined} disabled={offline}
          onClick={() => void select(table.id).catch(error => setError(message(error)))}>
          <span aria-hidden="true">▦</span> <span className="table-name">{table.name}</span>
        </button>)}</nav>
        <button className="new-table" disabled={!loaded || offline}
          onClick={() => setAction({ kind: 'create' })}>+ New table</button>
      </aside>
      <div className="workspace-content">
        {error && <div className="error-banner" role="alert">{error}
          {!loaded && <button onClick={() => void load().catch(error => setError(message(error)))}>Retry</button>}
        </div>}
        {model ? <TableApp key={selected} model={model} host={tableHost}
          onManage={(kind, table) => setAction({ kind, table })} /> : <section className="empty-workspace">
          <span className="empty-mark" aria-hidden="true">▦</span>
          <h1>{loaded ? 'Make room for your ideas' : 'Opening your workspace…'}</h1>
          {loaded && <><p>Create a table to organize projects, track work, or build your own workflow.</p>
            <button className="primary" disabled={offline} onClick={() => setAction({ kind: 'create' })}>Create your first table</button></>}
        </section>}
      </div>
    </div>
    {action && <TableDialog action={action} api={api} setDirty={setFormDirty}
      onClose={() => setAction(undefined)} onComplete={completed} />}
  </main>;
}

function TableDialog({ action, api, onClose, onComplete, setDirty }: {
  action: TableAction; api: WorkspaceApi; onClose(): void;
  onComplete(table: Table | undefined): Promise<void>; setDirty(dirty: boolean): void;
}) {
  const [name, setName] = useState(action.kind === 'create' ? '' : action.table.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const removing = action.kind === 'delete';
  const title = action.kind === 'create' ? 'Create table' : removing ? 'Delete table' : 'Rename table';
  useEffect(() => () => setDirty(false), [setDirty]);
  return <Dialog title={title} onClose={onClose} busy={busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(undefined);
      void (async () => {
        let result: Table | undefined;
        if (action.kind === 'delete') await api.deleteTable(action.table.id, action.table.version);
        else if (action.kind === 'create') result = await api.createTable({ name });
        else result = await api.updateTable(action.table.id, { name, expectedVersion: action.table.version });
        await onComplete(result);
      })().catch(error => { setError(message(error)); setBusy(false); });
    }}>
      {removing ? <p>Delete <strong>{name}</strong> and all its records? This cannot be undone.</p>
        : <label className="form-field">Table name<input autoFocus required maxLength={200} value={name} disabled={busy}
          onChange={event => { setName(event.target.value); setDirty(true); }} /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={removing ? 'danger' : 'primary'} disabled={busy || (!removing && !name.trim())}>
          {busy ? 'Working…' : title}</button></div>
    </form>
  </Dialog>;
}
