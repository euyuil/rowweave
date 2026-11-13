import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { TableModel } from '../../client/src/table-model.js';
import { TableApp, type TableHost } from './table-app.js';
import { Dialog } from './dialog.js';
import { WorkspaceContext } from './workspace-context.js';
import { ExternalLinkContext } from './external-link.js';
import { CalculationPanel } from './calculation-panel.js';

type TableAction = { kind: 'create' } | { kind: 'rename' | 'delete'; table: Table };
const message = (error: unknown) => error instanceof Error ? error.message : 'The operation failed.';

export function WorkspaceApp({ api, host, workspaceLabel = 'Local workspace', onConnectionSettings, children }: {
  api: WorkspaceApi; host: TableHost; workspaceLabel?: string; onConnectionSettings?(): void; children?: ReactNode;
}) {
  const [tables, setTables] = useState<Table[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loadedApi, setLoadedApi] = useState<WorkspaceApi>();
  const loaded = loadedApi === api;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogError, setCatalogError] = useState<string>();
  const catalogRevision = useRef<number>();
  const catalogMutation = useRef(0);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<TableAction>();
  const [offline, setOffline] = useState(false);
  const dirty = useRef({ table: false, form: false });
  const model = useMemo(() => selected ? new TableModel(api.table(selected)) : undefined, [api, selected]);
  const tableHost = useMemo<TableHost>(() => ({
    openUrl: url => host.openUrl(url),
    confirmDiscard: () => host.confirmDiscard(),
    onServiceExit: listener => host.onServiceExit(listener),
    saveCsv: (name, csv) => host.saveCsv(name, csv),
    saveFile: (filename, bytes) => host.saveFile(filename, bytes),
    setDirty: async value => {
      dirty.current.table = value;
      await host.setDirty(value || dirty.current.form);
    },
  }), [host]);
  const setFormDirty = useCallback((value: boolean) => {
    dirty.current.form = value;
    void host.setDirty(value || dirty.current.table).catch(error => setError(message(error)));
  }, [host]);

  const load = useCallback(async (signal: AbortSignal) => {
    const state = await api.workspaceState({}, signal);
    const current = await api.listTables(signal);
    if (signal.aborted) return;
    catalogRevision.current = state.catalogRevision;
    setTables(current);
    setSelected(id => current.some(table => table.id === id) ? id : current[0]?.id);
    setLoadedApi(api);
    setError(undefined);
    setCatalogError(undefined);
  }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    const unsubscribe = host.onServiceExit(() => {
      setOffline(true);
      setError('The data service stopped. Restart RowWeave to reconnect.');
    });
    return () => { controller.abort(); unsubscribe(); };
  }, [load, host, loadAttempt]);

  useEffect(() => {
    if (!loaded || offline) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 2_000;
      const mutation = catalogMutation.current;
      try {
        const state = await api.workspaceState({}, controller.signal);
        if (state.catalogRevision !== catalogRevision.current) {
          const current = await api.listTables(controller.signal);
          if (controller.signal.aborted || mutation !== catalogMutation.current) return;
          catalogRevision.current = state.catalogRevision;
          setTables(current);
        }
        if (!controller.signal.aborted) setCatalogError(undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalogError(message(error)); delay = 5_000;
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay); }
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, loaded, offline]);

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
    catalogMutation.current++;
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

  return <WorkspaceContext.Provider value={api}><ExternalLinkContext.Provider value={tableHost.openUrl}><main className="rowweave-app">
    <header className="app-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">▦</span> RowWeave</div>
      <div className="workspace-label"><CalculationPanel api={api} offline={offline} />{workspaceLabel}{onConnectionSettings && <button onClick={() => {
        if (model?.saving) { setError('Wait for the current save to finish before changing the connection.'); return; }
        if (dirty.current.table || dirty.current.form) { setError('Save or discard your workspace edits before changing the connection.'); return; }
        setError(undefined);
        onConnectionSettings();
      }}>Connection</button>}</div>
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
        {catalogError && !offline && <p role="status" className="catalog-status">Could not update the table list: {catalogError}</p>}
      </aside>
      <div className="workspace-content">
        {error && <div className="error-banner" role="alert">{error}
          {!loaded && <button onClick={() => { setError(undefined); setLoadAttempt(value => value + 1); }}>Retry</button>}
        </div>}
        {model ? <TableApp key={selected} tableId={selected!} model={model} api={api} host={tableHost}
          onManage={(kind, table) => setAction({ kind, table })} /> : <section className="empty-workspace">
          <span className="empty-mark" aria-hidden="true">▦</span>
          <h1>{loaded ? tables.length ? 'Choose a table' : 'Make room for your ideas' : 'Opening your workspace…'}</h1>
          {loaded && <><p>{tables.length ? 'Open a table from the sidebar to continue your work.'
            : 'Create a table to organize projects, track work, or build your own workflow.'}</p>
            <button className="primary" disabled={offline} onClick={() => setAction({ kind: 'create' })}>{tables.length ? 'Create another table' : 'Create your first table'}</button></>}
        </section>}
      </div>
    </div>
    {action && <TableDialog action={action} api={api} setDirty={setFormDirty}
      onClose={() => setAction(undefined)} onComplete={completed} />}
    {children}
  </main></ExternalLinkContext.Provider></WorkspaceContext.Provider>;
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
