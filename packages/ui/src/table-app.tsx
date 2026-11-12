import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DataEditor, {
  CompactSelection, GridCellKind, type DataEditorRef, type GridCell, type GridSelection, type Rectangle,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { maxBatchCells, maxBatchRecords, type CellValue, type Field, type GridView, type RecordLink, type RowRecord, type Table } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import { queryForView, type WorkspaceApi } from '../../client/src/http-client.js';
import { cellDisplay, cellText } from '../../client/src/cell-values.js';
import { parseTextValue } from '../../core/src/field-values.js';
import { CellEditor, EditorContext, type EditableCell, type EditorHandle } from './cell-editor.js';
import { parseClipboard, serializeClipboard } from './clipboard.js';
import { RecordDialog, type RecordAction } from './record-dialog.js';
import { FieldsDialog } from './fields-dialog.js';
import { ViewDialog } from './view-dialog.js';
import { CsvImportDialog } from './csv-import-dialog.js';
import { CsvExportDialog } from './csv-export-dialog.js';
import './table-app.css';

export interface TableHost {
  confirmDiscard(): Promise<boolean>;
  setDirty(value: boolean): Promise<void>;
  onServiceExit(listener: () => void): () => void;
  saveCsv(name: string, csv: string): Promise<boolean | 'download-started'>;
}

function gridCell(record: RowRecord | undefined, field: Field | undefined, readonly: boolean, row: number): GridCell {
  if (!record || !field) return { kind: GridCellKind.Loading, allowOverlay: false };
  readonly ||= field.type === 'lookup';
  const value = record.values[field.id] ?? null;
  const text = cellText(field, value);
  if (field.type === 'checkbox') return { kind: GridCellKind.Boolean, data: value as boolean | null, allowOverlay: false, readonly, copyData: text };
  const display = field.type === 'relation' ? ((value ?? []) as string[]).map(id => record.links?.[field.id]?.find(link => link.id === id)?.label || id).join(', ') : cellDisplay(field, value);
  return { kind: GridCellKind.Text, data: text, copyData: text, displayData: display,
    allowOverlay: !readonly, readonly, field, rawValue: value, row } as EditableCell;
}

export function TableApp({ tableId, model, api, host, onManage }: {
  tableId: string; model: TableModel; api: WorkspaceApi; host: TableHost; onManage(kind: 'rename' | 'delete', table: Table): void;
}) {
  const revision = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const queryVersion = model.queryVersion;
  const fields = model.fields;
  const [views, setViews] = useState<GridView[]>([]);
  const [view, setView] = useState<GridView>();
  const [search, setSearch] = useState('');
  const [searchComposing, setSearchComposing] = useState(false);
  const [viewAction, setViewAction] = useState<'create' | 'edit' | 'delete'>();
  const currentView = useRef<GridView>();
  const appliedSearch = useRef('');
  const viewRequest = useRef(0);
  const columns = useMemo(() => {
    const widths = new Map(view?.columns.map(column => [column.fieldId, column.width]));
    return fields.map(field => ({ id: field.id, title: field.name, width: widths.get(field.id) ?? 180 }));
  }, [fields, view]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [recordAction, setRecordAction] = useState<RecordAction>();
  const [managingFields, setManagingFields] = useState(false);
  const [csvAction, setCsvAction] = useState<'import' | 'export'>();
  const [notice, setNotice] = useState<string>();
  const activeEditor = useRef<EditorHandle>();
  const [size, setSize] = useState({ width: 900, height: 500 });
  const [visible, setVisible] = useState({ y: 0, height: 50 });
  const [selection, setSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(), rows: CompactSelection.empty(),
  });
  const gridHost = useRef<HTMLDivElement>(null);
  const rootHost = useRef<HTMLElement>(null);
  const grid = useRef<DataEditorRef>(null);
  const busyRef = useRef(false);
  const locked = busy || model.saving || offline;
  const pending = model.pendingCells;

  const report = useCallback((failure: unknown) => {
    setError(failure instanceof Error ? failure.message : 'The operation failed. Please try again.');
  }, []);

  const loadView = useCallback(async (discard = false) => {
    const loaded = await api.listViews(tableId);
    const preferred = currentView.current?.id ?? localStorage.getItem(`rowweave.view.${tableId}`);
    const selected = loaded.find(item => item.id === preferred) ?? loaded[0]!;
    const text = currentView.current?.id === selected.id ? appliedSearch.current : selected.query.search ?? '';
    currentView.current = selected;
    appliedSearch.current = text;
    setViews(loaded);
    setView(selected);
    setSearch(text);
    const query = queryForView(selected, text);
    if (discard) await model.discardAndReload(query);
    else await model.refresh(query);
    localStorage.setItem(`rowweave.view.${tableId}`, selected.id);
  }, [api, model, tableId]);

  const applyView = useCallback(async (selected: GridView, text = selected.query.search ?? '') => {
    if (model.saving) return;
    if (activeEditor.current) {
      if (!activeEditor.current.finish(true)) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const request = ++viewRequest.current;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    currentView.current = selected;
    appliedSearch.current = text;
    setView(selected);
    setSearch(text);
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    try {
      await model.setQuery(queryForView(selected, text));
      localStorage.setItem(`rowweave.view.${selected.tableId}`, selected.id);
    } catch (failure) { if (request === viewRequest.current) report(failure); }
    finally { if (request === viewRequest.current) { busyRef.current = false; setBusy(false); } }
  }, [model, report]);

  useEffect(() => {
    if (!ready || offline || model.saving || searchComposing || search === appliedSearch.current || !currentView.current) return;
    const timer = setTimeout(() => { void applyView(currentView.current!, search); }, 200);
    return () => clearTimeout(timer);
  }, [search, searchComposing, ready, offline, model.saving, applyView]);

  useEffect(() => {
    let active = true;
    void loadView().then(() => { if (active) setReady(true); }).catch(error => { if (active) report(error); });
    const unsubscribe = host.onServiceExit(() => {
      setOffline(true);
      setError('The data service stopped. Keep your unsaved values visible and restart when ready.');
    });
    return () => { active = false; unsubscribe(); model.dispose(); };
  }, [model, host, report, loadView]);

  useEffect(() => { void host.setDirty(pending > 0 || editorDirty || formDirty).catch(report); }, [pending, editorDirty, formDirty, host, report]);

  useEffect(() => {
    if (!ready || !gridHost.current) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setSize({ width: Math.floor(bounds.width), height: Math.floor(bounds.height) });
    });
    observer.observe(gridHost.current);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!ready || offline) return;
    let active = true;
    const timer = setTimeout(() => {
      void model.readRange(visible.y, Math.min(visible.height + 5, maxBatchRecords))
        .catch(failure => { if (active) report(failure); });
    }, 30);
    return () => { active = false; clearTimeout(timer); };
  }, [ready, offline, visible, model, report, queryVersion]);

  const save = useCallback(async () => {
    if (busyRef.current || offline || model.saving) return;
    setError(undefined);
    try {
      if (activeEditor.current) {
        if (!activeEditor.current.finish(true)) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await model.save();
    } catch (failure) { report(failure); }
  }, [model, offline, report]);
  const editorBridge = useMemo(() => ({
    save: () => { void save(); }, setDirty: setEditorDirty,
    register: (handle: EditorHandle | undefined) => { activeEditor.current = handle; },
    commit: (row: number, field: Field, value: CellValue, links?: RecordLink[]) => {
      try { model.applyEdits([{ row, fieldId: field.id, value, ...(links ? { links } : {}) }]); return undefined; }
      catch (failure) { return failure instanceof Error ? failure.message : 'The cell could not be changed.'; }
    },
  }), [save, model]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !rootHost.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('dialog')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) {
        event.preventDefault();
        void save();
      } else if ((event.ctrlKey || event.metaKey) && !activeEditor.current && !event.isComposing &&
          !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) &&
          (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        if (event.shiftKey || event.key.toLowerCase() === 'y') model.redo();
        else model.undo();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [save, model]);

  const runPaste = useCallback(async (target: readonly [number, number], cells: readonly (readonly string[])[]) => {
    if (busyRef.current || model.saving || offline) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try { await model.paste(target[1], target[0], cells); }
    catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  }, [model, offline, report]);

  const clearSelection = async (selected: GridSelection) => {
    if (busyRef.current || model.saving || offline || model.stale) return;
    const range = selected.current?.range;
    const rowCount = selected.rows.length || (selected.columns.length ? model.rowCount : range?.height ?? 0);
    const columnCount = selected.rows.length ? fields.length : selected.columns.length || range?.width || 0;
    if (!rowCount || !columnCount) return;
    if (rowCount > maxBatchRecords || rowCount * columnCount > maxBatchCells) {
      setError('Clear up to 20,000 cells and 2,000 rows at a time.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const rows = selected.rows.length ? selected.rows.toArray()
        : Array.from({ length: rowCount }, (_, index) => (selected.columns.length ? 0 : range!.y) + index);
      const columns = selected.rows.length ? fields.map(field => field.id)
        : selected.columns.length ? selected.columns.toArray().map(index => fields[index]!.id)
          : fields.slice(range!.x, range!.x + columnCount).map(field => field.id);
      await model.clearCells(rows, columns);
    } catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const reload = async (discardDrafts = true) => {
    if (locked || (!discardDrafts && editorDirty) || (discardDrafts && (pending > 0 || editorDirty) && !await host.confirmDiscard())) return;
    activeEditor.current?.finish(false);
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await loadView(discardDrafts);
      await model.readRange(visible.y, Math.min(visible.height + 5, maxBatchRecords));
      setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
      setReady(true);
    } catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const table = model.table;
  const selectedCount = selection.rows.length || selection.current?.range.height || 0;
  const recordActionsLocked = locked || !ready || model.stale || pending > 0 || editorDirty;
  const openRecord = async (kind: RecordAction['kind']) => {
    if (recordActionsLocked || busyRef.current) return;
    if (kind === 'create') { setError(undefined); setRecordAction({ kind, records: [] }); return; }
    if (selectedCount > maxBatchRecords) { setError('Select up to 2,000 records at a time.'); return; }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const generation = model.queryVersion;
      const indices = selection.rows.length ? selection.rows.toArray()
        : Array.from({ length: selectedCount }, (_, index) => selection.current!.range.y + index);
      const records: RowRecord[] = [];
      for (let index = 0; index < indices.length;) {
        const start = indices[index]!;
        let count = 1;
        while (indices[index + count] === start + count) count++;
        records.push(...await model.readRange(start, count));
        index += count;
      }
      if (generation !== model.queryVersion) throw new Error('The view changed. Select the records again.');
      if (kind !== 'delete') {
        const result = await api.queryRecords(table!.id, { recordIds: [records[0]!.id], limit: 1 });
        if (result.schemaVersion !== table!.version) throw new Error('The table schema changed. Reload before opening this record.');
        if (!result.records.length) throw new Error('This record was deleted. Reload the table.');
        records[0] = result.records[0]!;
      }
      setRecordAction({ kind, records });
    } catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const refreshAfterWrite = async (kind: string) => {
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
    setBusy(true);
    busyRef.current = true;
    try { await loadView(); }
    catch (failure) { report(new Error(`${kind} saved, but refreshing failed: ${failure instanceof Error ? failure.message : 'connection unavailable'}`)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const getCellContent = useCallback(([column, row]: readonly [number, number]): GridCell => {
    const field = fields[column];
    return gridCell(model.getRecord(row), field, locked || model.stale, row);
  }, [model, fields, locked, revision]);

  const getCellsForSelection = (rectangle: Rectangle, signal: AbortSignal) => async () => {
    if (rectangle.height > maxBatchRecords || rectangle.width * rectangle.height > maxBatchCells) {
      setError('Copy up to 20,000 cells and 2,000 rows at a time.');
      return [];
    }
    try {
      const records = await model.readRange(rectangle.y, rectangle.height);
      if (signal.aborted) return [];
      return records.map((record, index) => Array.from({ length: rectangle.width }, (_, x) =>
        gridCell(record, fields[rectangle.x + x], locked, rectangle.y + index)));
    } catch (failure) { report(failure); return []; }
  };

  const copySelection = async () => {
    const range = selection.current?.range;
    const rowCount = selection.rows.length || (selection.columns.length ? model.rowCount : range?.height ?? 0);
    const columnCount = selection.rows.length ? fields.length : selection.columns.length || range?.width || 0;
    if (!rowCount || !columnCount) return;
    if (rowCount > maxBatchRecords || rowCount * columnCount > maxBatchCells) {
      setError('Copy up to 20,000 cells and 2,000 rows at a time.');
      return;
    }
    try {
      const generation = model.queryVersion;
      const rows = selection.rows.length ? selection.rows.toArray()
        : Array.from({ length: rowCount }, (_, index) => (selection.columns.length ? 0 : range!.y) + index);
      const columns = selection.rows.length ? fields
        : selection.columns.length ? selection.columns.toArray().map(index => fields[index]!)
          : fields.slice(range!.x, range!.x + columnCount);
      const records: RowRecord[] = [];
      for (let index = 0; index < rows.length;) {
        const start = rows[index]!;
        let count = 1;
        while (rows[index + count] === start + count) count++;
        records.push(...await model.readRange(start, count));
        if (generation !== model.queryVersion) return;
        index += count;
      }
      // Excel collapses line breaks in the grid library's HTML representation.
      // Quoted TSV preserves literal cell contents without an HTML interpretation.
      await navigator.clipboard.writeText(serializeClipboard(records.map(record =>
        columns.map(field => cellText(field, record.values[field.id] ?? null)))));
    } catch (failure) { report(failure); }
  };

  const status = offline ? 'Service unavailable' : !ready ? 'Loading table…' : model.saving ? 'Saving…' : busy ? 'Loading rows…'
    : editorDirty ? 'Editing cell…'
    : pending ? `${pending.toLocaleString()} unsaved ${pending === 1 ? 'cell' : 'cells'}` : 'All changes saved';
  const message = error ?? model.error;
  return <section className="table-workspace" ref={rootHost}>
    <section className="table-heading">
      <div className="table-title"><h1>{table?.name ?? 'Loading table…'}</h1>
        <div className="table-management"><button disabled={recordActionsLocked} onClick={() => setManagingFields(true)}>Manage fields</button>
          <button disabled={!table || locked} onClick={() => onManage('rename', table!)}>Rename table</button>
          <button disabled={!table || locked || pending > 0 || editorDirty} onClick={() => onManage('delete', table!)}>Delete table</button></div></div>
      <div className="actions">
        <button onClick={() => model.undo()} disabled={locked || !model.canUndo}>Undo</button>
        <button onClick={() => model.redo()} disabled={locked || !model.canRedo}>Redo</button>
        {(pending > 0 || model.stale) && <button onClick={() => void reload(false)} disabled={locked || editorDirty}
          title="Refresh saved data and view settings while keeping drafts. Undo history resets.">Refresh view</button>}
        <button onClick={() => void reload()} disabled={locked}>{pending || editorDirty ? 'Discard edits' : 'Reload'}</button>
        <button className="primary" onClick={() => void save()} disabled={locked || (!pending && !editorDirty)}>Save changes</button>
      </div>
    </section>
    {message && <div role="alert" className="error-banner">{message}
      {model.conflicted && <span> Your edits are still here. Copy them before discarding and reloading the current records.</span>}
    </div>}
    {notice && <div role="status" className="notice-banner"><span>{notice}</span><button onClick={() => setNotice(undefined)}>Dismiss</button></div>}
    <div className="record-toolbar">
      <button className="primary" disabled={recordActionsLocked} onClick={() => void openRecord('create')}>+ New record</button>
      <button disabled={recordActionsLocked || selectedCount !== 1} onClick={() => void openRecord('edit')}>Open record</button>
      <button disabled={recordActionsLocked || selectedCount !== 1} onClick={() => void openRecord('duplicate')}>Duplicate</button>
      <button disabled={recordActionsLocked || !selectedCount} onClick={() => void openRecord('delete')}>Delete records</button>
      <button disabled={recordActionsLocked} onClick={() => setCsvAction('import')}>Import CSV</button>
      <button disabled={recordActionsLocked || !view || searchComposing} onClick={() => setCsvAction('export')}>Export CSV</button>
      <span>{pending > 0 || editorDirty ? 'Save or discard grid edits to manage records.'
        : selectedCount ? `${selectedCount.toLocaleString()} selected` : 'Select a row or cell to open a record.'}</span>
    </div>
    <section className="table-panel" aria-label="Data table">
      <div className="view-toolbar">
        <select aria-label="Current view" value={view?.id ?? ''} disabled={!ready || locked}
          onChange={event => void applyView(views.find(item => item.id === event.target.value)!)}>
          {views.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button disabled={!view || locked} onClick={() => setViewAction('create')}>New view</button>
        <button disabled={!view || locked} onClick={() => setViewAction('edit')}>View settings</button>
        <button disabled={!view || locked || views.length < 2} onClick={() => setViewAction('delete')}>Delete view</button>
        <input type="search" aria-label="Search records" placeholder="Search records…" value={search}
          disabled={!ready || model.saving || offline} onChange={event => setSearch(event.target.value)}
          onCompositionStart={() => setSearchComposing(true)} onCompositionEnd={() => setSearchComposing(false)} />
      </div>
      <div className="table-toolbar"><strong>▦ &nbsp; {view?.name ?? 'Loading view…'}</strong>
        <span>{table ? `${model.rowCount.toLocaleString()} ${model.rowCount === 1 ? 'record' : 'records'} · ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}` : 'Loading records…'}</span></div>
      <div className="grid-host" aria-busy={locked || !ready} ref={gridHost} onCopyCapture={event => {
        if (!gridHost.current?.querySelector('canvas')?.contains(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        void copySelection();
      }} onPasteCapture={event => {
        if (!gridHost.current?.querySelector('canvas')?.contains(document.activeElement) || !selection.current) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.clipboardData.types.includes('text/plain')) return;
        if (locked) return;
        try {
          const { x, y } = selection.current.range;
          void runPaste([x, y], parseClipboard(event.clipboardData.getData('text/plain')));
        } catch (failure) { report(failure); }
      }}>
        {ready && table ? <EditorContext.Provider value={editorBridge}><DataEditor
          ref={grid} onCellClicked={() => grid.current?.focus()}
          width={size.width} height={size.height} rows={model.rowCount}
          columns={columns}
          getCellContent={getCellContent} getCellsForSelection={getCellsForSelection}
          provideEditor={cell => cell.kind === GridCellKind.Text ? CellEditor : undefined}
          isOutsideClick={event => {
            const editor = activeEditor.current;
            if (!editor || !(event.target instanceof Node) || editor.contains(event.target)) return false;
            if (!editor.finish(true)) { event.preventDefault(); event.stopImmediatePropagation(); }
            return false;
          }}
          onVisibleRegionChanged={region => setVisible(previous =>
            previous.y === region.y && previous.height === region.height ? previous : { y: region.y, height: region.height })}
          gridSelection={selection} onGridSelectionChange={setSelection}
          rowMarkers="both" rowHeight={36} headerHeight={40} rangeSelect="rect" rowSelectionMode="multi"
          cellActivationBehavior="double-click"
          keybindings={{ paste: false, copy: false }}
          onDelete={selected => { void clearSelection(selected); return false; }}
          smoothScrollX smoothScrollY
          onCellsEdited={edits => {
            if (locked) return true;
            try {
              model.applyEdits(edits.filter(edit => edit.value.kind === GridCellKind.Text || edit.value.kind === GridCellKind.Boolean).map(edit => ({
                row: edit.location[1], fieldId: fields[edit.location[0]]!.id,
                value: edit.value.kind === GridCellKind.Boolean ? edit.value.data ?? null
                  : parseTextValue(fields[edit.location[0]]!, edit.value.kind === GridCellKind.Text ? edit.value.data : ''),
              })));
            } catch (failure) { report(failure); }
            return true;
          }}
          onPaste={false}
          theme={{ accentColor: '#315cbe', accentLight: '#eef3ff', bgHeader: '#f5f7fb',
            bgCell: '#ffffff', textDark: '#17243b', borderColor: '#e5eaf1', baseFontStyle: '14px',
            fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' }}
        /></EditorContext.Provider> : <div className="loading-state" role="status">{message ? 'Could not load the table. Try Reload.' : 'Opening your workspace…'}</div>}
      </div>
    </section>
    <footer><span role="status" className={pending ? 'pending-status' : ''}>{status}</span>
      <span>Enter to edit · Esc to cancel · Ctrl+C / Ctrl+V · Ctrl+S to save</span></footer>
    {recordAction && table && <RecordDialog action={recordAction} table={table} api={api} setDirty={setFormDirty}
      onClose={() => setRecordAction(undefined)} onSaved={() => { setRecordAction(undefined); void refreshAfterWrite('Records'); }} />}
    {csvAction === 'import' && table && <CsvImportDialog initial={table} api={api} setDirty={setFormDirty}
      onClose={() => { setCsvAction(undefined); void reload(false); }} onImported={count => {
        setCsvAction(undefined);
        setNotice(`Imported ${count.toLocaleString()} ${count === 1 ? 'record' : 'records'}.`);
        void refreshAfterWrite('Imported records');
      }} />}
    {csvAction === 'export' && table && view && <CsvExportDialog table={table} view={view} search={search} api={api} host={host}
      onClose={() => setCsvAction(undefined)} />}
    {managingFields && table && <FieldsDialog initial={table} api={api} setDirty={setFormDirty}
      onClose={() => setManagingFields(false)} onSaved={() => refreshAfterWrite('Schema')} />}
    {viewAction && view && table && <ViewDialog kind={viewAction} view={view} search={search} table={table} api={api} setDirty={setFormDirty}
      onClose={() => setViewAction(undefined)} onSaved={saved => {
        setViewAction(undefined);
        currentView.current = saved;
        appliedSearch.current = saved?.query.search ?? '';
        void refreshAfterWrite('View');
      }} />}
  </section>;
}
