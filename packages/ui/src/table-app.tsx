import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DataEditor, {
  CompactSelection, GridCellKind, type DataEditorRef, type GridCell, type GridSelection, type Rectangle,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { flushSync } from 'react-dom';
import { isReadOnlyField, maxBatchCells, maxBatchRecords, type CellValue, type Field, type GroupCollapse, type GridView, type QueryPage, type RecordLink, type RowRecord, type Table, type ViewUpdate } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import { ApiFailure, queryForView, type WorkspaceApi } from '../../client/src/http-client.js';
import { cellDisplay, cellText } from '../../client/src/cell-values.js';
import { prepareBoardSnapshot, type BoardSnapshot, type BoardWindow } from '../../client/src/board-refresh.js';
import { parseTextValue } from '../../core/src/field-values.js';
import { CellEditor, EditorContext, type EditableCell, type EditorHandle } from './cell-editor.js';
import { drawSelectCell } from './select-values.js';
import { AttachmentContext } from './attachment-context.js';
import { parseClipboard, serializeClipboard } from './clipboard.js';
import { RecordDialog, type RecordAction } from './record-dialog.js';
import { TrashDialog } from './trash-dialog.js';
import { BatchHistoryDialog } from './batch-history-dialog.js';
import { FieldsDialog } from './fields-dialog.js';
import { ViewDialog } from './view-dialog.js';
import { CsvImportDialog } from './csv-import-dialog.js';
import { CsvExportDialog } from './csv-export-dialog.js';
import { SummaryDialog } from './summary-dialog.js';
import { FieldForm } from './field-form.js';
import { ColumnActions, type ColumnAction } from './column-actions.js';
import { BoardView } from './board-view.js';
import { captureBoardFocus } from './board-focus.js';
import { ViewTabs } from './view-tabs.js';
import { useGroupedRows } from './use-grouped-rows.js';
import { refreshSelection } from './refresh-selection.js';
import { selectionRanges } from './selection-ranges.js';
import type { GroupReader } from '../../client/src/group-reader.js';
import type { GroupRow } from '../../client/src/group-rows.js';
import type { DialogAnchor } from './dialog.js';
import './table-app.css';

export interface TableHost {
  openUrl(url: string): Promise<void>;
  confirmDiscard(): Promise<boolean>;
  setDirty(value: boolean): Promise<void>;
  onServiceExit(listener: () => void): () => void;
  saveCsv(name: string, csv: string): Promise<boolean | 'download-started'>;
  saveFile(filename: string, bytes: Uint8Array): Promise<boolean | 'download-started'>;
}

function gridCell(record: RowRecord | undefined, field: Field | undefined, readonly: boolean, row: number, gridRow: number): GridCell {
  if (!record || !field) return { kind: GridCellKind.Loading, allowOverlay: false };
  readonly ||= isReadOnlyField(field);
  if (record.formulaErrors?.[field.id]) return { kind: GridCellKind.Text, data: '#ERROR: ' + record.formulaErrors[field.id],
    displayData: '#ERROR: ' + record.formulaErrors[field.id], allowOverlay: false, readonly: true };
  const value = record.values[field.id] ?? null;
  const text = cellText(field, value);
  if (field.type === 'checkbox') return { kind: GridCellKind.Boolean, data: value as boolean | null, allowOverlay: false, readonly, copyData: text };
  const display = record.attachments?.[field.id] ? ((value ?? []) as string[]).map(id => record.attachments![field.id]!.find(file => file.id === id)?.filename ?? 'File').join(', ')
    : field.type === 'relation' ? ((value ?? []) as string[]).map(id => record.links?.[field.id]?.find(link => link.id === id)?.label || id).join(', ') : cellDisplay(field, value);
  return { kind: GridCellKind.Text, data: text, copyData: text, displayData: display,
    allowOverlay: !readonly, readonly, field, rawValue: value, row, gridRow } as EditableCell;
}

function groupHeadingCell(group: GroupRow, column: number, end: number): GridCell {
  const label = `${group.collapsed ? '▸' : '▾'} ${group.label} · ${group.count.toLocaleString()} ${group.count === 1 ? 'record' : 'records'}`;
  return { kind: GridCellKind.Text, data: column <= end ? label : '', copyData: '', displayData: column <= end ? label : '', allowOverlay: false, readonly: true,
    ...(column <= end ? { span: [0, end] as const } : {}) };
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
  const [viewAction, setViewAction] = useState<'create' | 'edit' | 'delete' | 'filter' | 'sort' | 'display' | 'group'>();
  const [queryAnchor, setQueryAnchor] = useState<DialogAnchor>();
  const currentView = useRef<GridView>();
  const appliedSearch = useRef('');
  const viewRequest = useRef(0);
  const columns = useMemo(() => {
    const widths = new Map(view?.columns.map(column => [column.fieldId, column.width]));
    return fields.map(field => ({ id: field.id, title: field.name, width: widths.get(field.id) ?? 180, hasMenu: true }));
  }, [fields, view]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [transfers, setTransfers] = useState(0);
  const transfer = useCallback((delta: number) => setTransfers(value => value + delta), []);
  const [offline, setOffline] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [recordAction, setRecordAction] = useState<RecordAction>();
  const [trashOpen, setTrashOpen] = useState(false);
  const [batchHistory, setBatchHistory] = useState<{ batchId?: string; redo?: boolean }>();
  const [savedAction, setSavedAction] = useState<{ batchId: string; redo: boolean }>();
  const [managingFields, setManagingFields] = useState(false);
  const [editingField, setEditingField] = useState<{ field: Field; bounds: DialogAnchor }>();
  const [columnAction, setColumnAction] = useState<{ field: Field; bounds: Rectangle }>();
  const [csvAction, setCsvAction] = useState<'import' | 'export'>();
  const [summarizing, setSummarizing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [externalUpdate, setExternalUpdate] = useState<'pending' | 'missing'>();
  const [preparedBoard, setPreparedBoard] = useState<{ generation: number; snapshot: BoardSnapshot }>();
  const boardWindows = useRef(new Map<string | null, BoardWindow>());
  const boardWindowRevision = useRef(0);
  const boardDragging = useRef(false);
  const boardWindowChanged = useCallback((lane: string | null, window: BoardWindow | undefined) => {
    const previous = boardWindows.current.get(lane);
    if (previous?.offset === window?.offset && previous?.near === window?.near) return;
    if (window) boardWindows.current.set(lane, window); else boardWindows.current.delete(lane);
    boardWindowRevision.current++;
  }, []);
  const boardDragChanged = useCallback((active: boolean) => { boardDragging.current = active; }, []);
  const [refreshFailure, setRefreshFailure] = useState<string>();
  const knownViewsRevision = useRef<number>();
  const interaction = useRef(0);
  const pointerActive = useRef(false);
  const selectionReads = useRef(0);
  const canRefresh = useRef<() => boolean>(() => false);
  const checkExternal = useRef<(signal: AbortSignal) => Promise<void>>();
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
  const locked = busy || model.saving || offline || transfers > 0;
  const pending = model.pendingCells;
  const grouping = useGroupedRows(model, api, view, appliedSearch.current, visible);
  canRefresh.current = () => {
    const workspace = rootHost.current?.closest('.rowweave-app'), active = document.activeElement;
    return ready && !locked && !grouping.pending && !busyRef.current && !activeEditor.current && !selectionReads.current && !pointerActive.current && !boardDragging.current &&
      !model.saving && !model.pendingCells && !model.canUndo && !model.canRedo && !formDirty && !searchComposing && search === appliedSearch.current &&
      !workspace?.querySelector('dialog[open]') &&
      !(active instanceof Element && workspace?.contains(active) && active.closest('input, textarea, select, [contenteditable="true"]'));
  };
  const gridRowCount = grouping.enabled ? grouping.rows?.rowCount ?? 0 : model.rowCount;
  const recordIndex = (row: number) => {
    if (!grouping.enabled) return row;
    const mapped = grouping.rows?.at(row);
    return mapped?.kind === 'record' ? mapped.index : undefined;
  };
  const selectionCount = (selected: GridSelection) => {
    let total = 0;
    for (const range of selectionRanges(selected, gridRowCount)) {
      const count = grouping.enabled ? grouping.rows?.count(range.start, range.count) : range.count;
      if (count === undefined) return undefined;
      total += count;
    }
    return total;
  };
  const selectionPlan = async (selected: GridSelection, includeColumns = false) => {
    const ranges = selectionRanges(selected, gridRowCount, includeColumns);
    if (!grouping.enabled) return { count: ranges.reduce((sum, range) => sum + range.count, 0),
      indices: async () => ranges.flatMap(range => Array.from({ length: range.count }, (_, index) => range.start + index)) };
    const reader = grouping.reader;
    if (!reader || grouping.pending) throw new Error('Wait for the groups to load.');
    const signal = new AbortController().signal;
    const expanded = await reader.ranges(ranges, signal);
    return { count: expanded.reduce((sum, range) => sum + range.count, 0), indices: () => reader.indices(expanded, signal) };
  };
  const readIndices = async (indices: number[]) => {
    const records: RowRecord[] = [];
    for (let index = 0; index < indices.length;) {
      const start = indices[index]!;
      let count = 1;
      while (indices[index + count] === start + count) count++;
      records.push(...await model.readRange(start, count));
      index += count;
    }
    return records;
  };
  const collapseGroups = (choice: GroupCollapse) => {
    if (locked || activeEditor.current || grouping.pending) return;
    grouping.collapse(choice);
    setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
  };
  const toggleGroup = (row: number) => {
    const mapped = grouping.rows?.at(row);
    if (mapped?.kind !== 'group') return;
    const keys = new Map(grouping.choice.exceptions.map(value => [JSON.stringify(value), value]));
    if (keys.has(mapped.group.key)) keys.delete(mapped.group.key); else keys.set(mapped.group.key, mapped.group.value);
    collapseGroups({ defaultCollapsed: grouping.choice.defaultCollapsed, exceptions: [...keys.values()] });
  };

  const report = useCallback((failure: unknown) => {
    setError(failure instanceof Error ? failure.message : 'The operation failed. Please try again.');
  }, []);

  const cachedSelectedCount = selectionCount(selection);
  const [resolvedSelection, setResolvedSelection] = useState<{ selection: GridSelection; reader: GroupReader; count: number }>();
  const selectedCount = cachedSelectedCount ?? (resolvedSelection?.selection === selection && resolvedSelection.reader === grouping.reader ? resolvedSelection.count : undefined);
  useEffect(() => {
    const reader = grouping.reader;
    if (cachedSelectedCount !== undefined || !reader || grouping.pending) return;
    const controller = new AbortController();
    void reader.ranges(selectionRanges(selection, gridRowCount), controller.signal).then(ranges => {
      if (!controller.signal.aborted) setResolvedSelection({ selection, reader, count: ranges.reduce((sum, range) => sum + range.count, 0) });
    }).catch(failure => { if (!controller.signal.aborted) report(failure); });
    return () => controller.abort();
  }, [selection, gridRowCount, grouping.reader, grouping.pending, cachedSelectedCount, report]);

  const loadView = useCallback(async (discard = false) => {
    const state = await api.workspaceState({ tableId });
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
    knownViewsRevision.current = state.table?.viewsRevision;
    setExternalUpdate(undefined);
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

  checkExternal.current = async signal => {
    const previousView = currentView.current;
    if (!previousView) return;
    const generation = model.queryVersion, activity = interaction.current;
    const state = await api.workspaceState({ tableId, viewId: previousView.id }, signal);
    if (signal.aborted || generation !== model.queryVersion || previousView !== currentView.current) return;
    setRefreshFailure(undefined);
    if (!state.table) { setExternalUpdate('missing'); return; }
    const changed = state.table.schemaVersion !== model.table?.version || state.table.dataRevision !== model.dataRevision ||
      state.table.viewsRevision !== knownViewsRevision.current || state.table.view?.version !== previousView.version ||
      state.table.view?.dateContext !== model.dateContext;
    if (!changed) { setExternalUpdate(undefined); return; }
    setExternalUpdate('pending');
    if (!canRefresh.current()) return;
    const loaded = state.table.viewsRevision === knownViewsRevision.current ? views : await api.listViews(tableId, signal);
    const selected = loaded.find(view => view.id === previousView.id) ?? loaded[0]!;
    const text = selected.id === previousView.id && appliedSearch.current !== (previousView.query.search ?? '')
      ? appliedSearch.current : selected.query.search ?? '';
    if (generation !== model.queryVersion || activity !== interaction.current || !canRefresh.current()) return;
    let groupRefresh: Awaited<ReturnType<typeof grouping.prepareRefresh>> | undefined;
    let boardRefresh: BoardSnapshot | undefined;
    const windowRevision = boardWindowRevision.current;
    const snapshot = await model.prepareRefresh(queryForView(selected, text), { start: visible.y, count: visible.height + 5, signal,
      ...(selected.groupBy ? { selectRows: async (table: Table, first: QueryPage, signal: AbortSignal) => {
        if (selected.type === 'board') {
          const windows = previousView.type === 'board' && previousView.id === selected.id && previousView.groupBy === selected.groupBy
            ? [...boardWindows.current.values()] : [];
          boardRefresh = await prepareBoardSnapshot(api, table, selected, first, text, windows, signal);
          return [];
        }
        groupRefresh = await grouping.prepareRefresh(table, selected, first, text, signal, visible.y, Math.min(visible.height + 5, maxBatchRecords));
        return groupRefresh.rows.indices(visible.y, Math.min(visible.height + 5, maxBatchRecords));
      } } : {}),
    });
    if (signal.aborted || generation !== model.queryVersion || activity !== interaction.current || previousView !== currentView.current || !canRefresh.current()) return;
    if (previousView.type === 'board' && windowRevision !== boardWindowRevision.current) return;
    const retained = previousView.type === 'grid' && selected.type === 'grid'
      ? refreshSelection(selection, model, snapshot, grouping.rows, groupRefresh?.rows)
      : { selection: { columns: CompactSelection.empty(), rows: CompactSelection.empty() }, cleared: false };
    const wasStale = model.stale;
    const restoreBoardFocus = captureBoardFocus(rootHost.current!);
    // External-store notifications and view state must render together to keep the content mounted.
    flushSync(() => {
      if (!model.commitRefresh(snapshot)) return;
      if (groupRefresh) grouping.commitRefresh(groupRefresh, selected, text);
      setPreparedBoard(boardRefresh ? { generation: model.queryVersion, snapshot: boardRefresh } : undefined);
      currentView.current = selected;
      appliedSearch.current = text;
      knownViewsRevision.current = state.table!.viewsRevision;
      setViews(loaded); setView(selected); setSearch(text); setSelection(retained.selection);
      setExternalUpdate(undefined);
      if (wasStale) setError(undefined);
      if (retained.cleared) setNotice('Changes were loaded. The previous selection was cleared; select records again before editing.');
      localStorage.setItem(`rowweave.view.${tableId}`, selected.id);
    });
    if (restoreBoardFocus?.()) setNotice('Changes were loaded. The focused record is outside the visible view.');
    if (restoreBoardFocus && selected.type === 'grid') grid.current?.focus();
  };

  useEffect(() => {
    if (!ready || offline) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 2_000;
      try { await checkExternal.current!(controller.signal); }
      catch (failure) {
        if (controller.signal.aborted || failure instanceof DOMException && failure.name === 'AbortError') return;
        if (failure instanceof ApiFailure && ['DATA_CHANGED', 'SCHEMA_CONFLICT', 'VIEW_CONFLICT'].includes(failure.code)) setExternalUpdate('pending');
        else { setRefreshFailure(failure instanceof Error ? failure.message : 'Could not check for updates.'); delay = 5_000; }
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, model, tableId, ready, offline]);

  useEffect(() => {
    const workspace = rootHost.current!.closest('.rowweave-app')!;
    const touch = () => { interaction.current++; };
    const start = () => { touch(); pointerActive.current = true; };
    const finish = () => { pointerActive.current = false; };
    const events = ['keydown', 'input', 'paste', 'copy', 'compositionstart', 'compositionend', 'wheel', 'scroll'];
    for (const event of events) workspace.addEventListener(event, touch, true);
    workspace.addEventListener('pointerdown', start, true); workspace.addEventListener('dragstart', start, true);
    const endings = ['pointerup', 'pointercancel', 'dragend', 'drop'];
    for (const event of endings) window.addEventListener(event, finish, true);
    window.addEventListener('blur', finish);
    return () => {
      for (const event of events) workspace.removeEventListener(event, touch, true);
      workspace.removeEventListener('pointerdown', start, true); workspace.removeEventListener('dragstart', start, true);
      for (const event of endings) window.removeEventListener(event, finish, true);
      window.removeEventListener('blur', finish);
    };
  }, []);

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

  useEffect(() => { void host.setDirty(pending > 0 || editorDirty || formDirty || transfers > 0).catch(report); }, [pending, editorDirty, formDirty, transfers, host, report]);

  useEffect(() => {
    if (!ready || !gridHost.current) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect;
      if (bounds) setSize({ width: Math.floor(bounds.width), height: Math.floor(bounds.height) });
    });
    observer.observe(gridHost.current);
    return () => observer.disconnect();
  }, [ready, view?.type]);

  useEffect(() => {
    if (!ready || offline || view?.type === 'board' || (grouping.enabled && (!grouping.reader || grouping.pending))) return;
    const controller = new AbortController(), reader = grouping.reader, generation = model.queryVersion;
    const timer = setTimeout(() => {
      void (async () => {
        const count = Math.min(visible.height + 5, maxBatchRecords);
        const rows = reader ? await reader.readWindow(visible.y, count, controller.signal) : undefined;
        if (controller.signal.aborted || generation !== model.queryVersion) return;
        await model.readViewport(rows ? rows.indices(visible.y, count) : Array.from({ length: count }, (_, index) => visible.y + index));
        if (!controller.signal.aborted && generation === model.queryVersion && reader && rows) grouping.commitWindow(reader, rows);
      })().catch(failure => { if (!controller.signal.aborted) report(failure); });
    }, 30);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ready, offline, visible, model, report, queryVersion, view?.type, grouping.reader, grouping.pending, grouping.enabled]);

  const save = useCallback(async () => {
    if (busyRef.current || offline || model.saving) return;
    setError(undefined);
    try {
      if (activeEditor.current) {
        if (!activeEditor.current.finish(true)) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const previousBatch = model.lastSavedBatchId;
      const previousQuery = model.queryVersion;
      await model.save();
      if (model.queryVersion !== previousQuery) {
        setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
        setNotice('Changes saved. The selection was cleared; select records again before editing.');
      }
      if (model.lastSavedBatchId !== previousBatch) setSavedAction(model.lastSavedBatchId ? { batchId: model.lastSavedBatchId, redo: false } : undefined);
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
    try {
      if (cells.length > maxBatchRecords) throw new Error('Paste up to 2,000 records at a time.');
      if (grouping.enabled) {
        if (!grouping.reader || grouping.pending) throw new Error('Wait for the groups to load.');
        await model.pasteRows(await grouping.reader.pasteIndices(target[1], cells.length, new AbortController().signal), target[0], cells);
      } else await model.paste(target[1], target[0], cells);
    }
    catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  }, [model, offline, report, grouping.reader, grouping.pending, grouping.enabled]);

  const clearSelection = async (selected: GridSelection) => {
    if (busyRef.current || model.saving || offline || model.stale || grouping.pending || grouping.stale) return;
    const range = selected.current?.range;
    const columnCount = selected.rows.length ? fields.length : selected.columns.length || range?.width || 0;
    if (!columnCount) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const plan = await selectionPlan(selected, true);
      if (!plan.count) return;
      if (plan.count > maxBatchRecords || plan.count * columnCount > maxBatchCells) throw new Error('Clear up to 20,000 cells and 2,000 rows at a time.');
      const columns = selected.rows.length ? fields.map(field => field.id)
        : selected.columns.length ? selected.columns.toArray().map(index => fields[index]!.id)
          : fields.slice(range!.x, range!.x + columnCount).map(field => field.id);
      await model.clearCells(await plan.indices(), columns);
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
      setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() });
      setReady(true);
    } catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const table = model.table;
  const recordActionsLocked = locked || !ready || model.stale || pending > 0 || editorDirty || (grouping.enabled && (!grouping.rows || grouping.pending || grouping.stale));
  const openColumnActions = (column: number, bounds: Rectangle) => {
    if (column < 0) return;
    if (recordActionsLocked || busyRef.current || !view) {
      if (pending > 0 || editorDirty) setNotice('Save or discard grid edits before changing columns.');
      return;
    }
    setColumnAction({ field: fields[column]!, bounds });
  };
  const changeColumn = async (action: ColumnAction) => {
    if (recordActionsLocked || busyRef.current) throw new Error('The table is not ready for column changes.');
    const field = columnAction!.field;
    if (action === 'configure') { setEditingField(columnAction); setColumnAction(undefined); return; }
    const update: ViewUpdate = { expectedVersion: view!.version };
    if (action === 'asc' || action === 'desc' || action === 'clearSort') {
      const others = (view!.query.sort ?? []).filter(rule => rule.fieldId !== field.id);
      update.query = { ...view!.query, sort: action === 'clearSort' ? others : [{ fieldId: field.id, direction: action }, ...others] };
    } else {
      update.columns = view!.columns.map(column => ({ ...column }));
      const index = update.columns.findIndex(column => column.fieldId === field.id);
      if (action === 'hide') update.columns[index]!.hidden = true;
      else {
        const visible = update.columns.filter(column => !column.hidden);
        const position = visible.findIndex(column => column.fieldId === field.id);
        const neighbor = visible[position + (action === 'left' ? -1 : 1)]!;
        const destination = update.columns.findIndex(column => column.fieldId === neighbor.fieldId);
        [update.columns[index], update.columns[destination]] = [update.columns[destination]!, update.columns[index]!];
      }
    }
    const saved = await api.updateView(tableId, view!.id, update);
    setViews(current => current.map(item => item.id === saved.id ? saved : item));
    await applyView(saved, appliedSearch.current);
    setColumnAction(undefined);
  };
  const readCurrentRecord = async (record: RowRecord) => {
    const result = await api.queryRecords(table!.id, { recordIds: [record.id], limit: 1 });
    if (result.schemaVersion !== table!.version) throw new Error('The table schema changed. Reload before opening this record.');
    if (!result.records.length) throw new Error('This record was deleted. Reload the table.');
    return result.records[0]!;
  };
  const openBoardRecord = async (record: RowRecord) => {
    if (recordActionsLocked || busyRef.current) return;
    setBusy(true); busyRef.current = true; setError(undefined);
    try { setRecordAction({ kind: 'edit', records: [await readCurrentRecord(record)] }); }
    catch (failure) { report(failure); }
    finally { setBusy(false); busyRef.current = false; }
  };
  const moveBoardRecord = async (record: RowRecord, lane: string | null) => {
    if (recordActionsLocked || busyRef.current) throw new Error('Wait for the current operation to finish.');
    setBusy(true); busyRef.current = true; setError(undefined);
    try {
      await api.updateRecords(tableId, [{ id: record.id, expectedVersion: record.version, values: { [view!.groupBy!]: lane } }]);
      await refreshAfterWrite('Record');
    } finally { setBusy(false); busyRef.current = false; }
  };
  const openRecord = async (kind: RecordAction['kind']) => {
    if (recordActionsLocked || busyRef.current) return;
    if (kind === 'create') { setError(undefined); setRecordAction({ kind, records: [] }); return; }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const generation = model.queryVersion;
      const plan = await selectionPlan(selection);
      if (!plan.count) return;
      if (plan.count > maxBatchRecords) throw new Error('Select up to 2,000 records at a time.');
      const records = await readIndices(await plan.indices());
      if (generation !== model.queryVersion) throw new Error('The view changed. Select the records again.');
      if (kind !== 'delete') records[0] = await readCurrentRecord(records[0]!);
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
    const mapped = grouping.rows?.at(row);
    if (mapped?.kind === 'group') return groupHeadingCell(mapped.group, column, (view!.frozenColumns || fields.length) - 1);
    const index = recordIndex(row);
    return gridCell(index === undefined ? undefined : model.getRecord(index), fields[column],
      locked || model.stale || grouping.pending || grouping.stale, index ?? row, row);
  }, [model, fields, locked, revision, grouping.rows, grouping.enabled, grouping.pending, grouping.stale, view]);

  const getCellsForSelection = (rectangle: Rectangle, signal: AbortSignal) => async () => {
    if (rectangle.height > maxBatchRecords || rectangle.width * rectangle.height > maxBatchCells) {
      setError('Copy up to 20,000 cells and 2,000 rows at a time.');
      return [];
    }
    selectionReads.current++;
    const generation = model.queryVersion;
    try {
      const rows = grouping.enabled ? await grouping.reader!.readWindow(rectangle.y, rectangle.height, signal) : undefined;
      const indices = rows ? rows.indices(rectangle.y, rectangle.height)
        : Array.from({ length: rectangle.height }, (_, index) => rectangle.y + index);
      const records = await readIndices(indices);
      if (signal.aborted || generation !== model.queryVersion) return [];
      const byIndex = new Map(indices.map((index, position) => [index, records[position]!]));
      return Array.from({ length: rectangle.height }, (_, index) => Array.from({ length: rectangle.width }, (_, x) => {
        const row = rectangle.y + index, column = rectangle.x + x, mapped = rows?.at(row);
        if (mapped?.kind === 'group') return groupHeadingCell(mapped.group, column, (view!.frozenColumns || fields.length) - 1);
        const record = mapped?.kind === 'record' ? mapped.index : row;
        return gridCell(byIndex.get(record), fields[column], true, record, row);
      }));
    } catch (failure) { if (!signal.aborted && generation === model.queryVersion) report(failure); return []; }
    finally { selectionReads.current--; }
  };

  const copySelection = async () => {
    const range = selection.current?.range;
    const columnCount = selection.rows.length ? fields.length : selection.columns.length || range?.width || 0;
    if (!columnCount) return;
    selectionReads.current++;
    const generation = model.queryVersion;
    try {
      const plan = await selectionPlan(selection, true);
      if (!plan.count) return;
      if (plan.count > maxBatchRecords || plan.count * columnCount > maxBatchCells) throw new Error('Copy up to 20,000 cells and 2,000 rows at a time.');
      const columns = selection.rows.length ? fields
        : selection.columns.length ? selection.columns.toArray().map(index => fields[index]!)
          : fields.slice(range!.x, range!.x + columnCount);
      const records = await readIndices(await plan.indices());
      if (generation !== model.queryVersion) return;
      // Excel collapses line breaks in the grid library's HTML representation.
      // Quoted TSV preserves literal cell contents without an HTML interpretation.
      await navigator.clipboard.writeText(serializeClipboard(records.map(record =>
        columns.map(field => record.formulaErrors?.[field.id] ? `#ERROR: ${record.formulaErrors[field.id]}` : cellText(field, record.values[field.id] ?? null)))));
    } catch (failure) { if (generation === model.queryVersion) report(failure); }
    finally { selectionReads.current--; }
  };

  const status = offline ? 'Service unavailable' : !ready ? 'Loading table…' : model.saving ? 'Saving…' : busy ? 'Loading rows…'
    : editorDirty ? 'Editing cell…'
    : pending ? `${pending.toLocaleString()} unsaved ${pending === 1 ? 'cell' : 'cells'}` : 'All changes saved';
  const message = error ?? model.error ?? grouping.error;
  return <AttachmentContext.Provider value={{ table, pending: transfers > 0, transfer, saveFile: host.saveFile }}><section className="table-workspace" ref={rootHost}>
    <section className="table-heading">
      <div className="table-title"><h1>{table?.name ?? 'Loading table…'}</h1>
        <div className="table-management"><button disabled={recordActionsLocked} onClick={() => setManagingFields(true)}>Manage fields</button>
          <button disabled={!table || locked} onClick={() => onManage('rename', table!)}>Rename table</button>
          <button disabled={!table || locked || pending > 0 || editorDirty} onClick={() => onManage('delete', table!)}>Delete table</button></div></div>
      <div className="actions">
        <button onClick={() => model.undo()} disabled={locked || !model.canUndo}>Undo</button>
        <button onClick={() => model.redo()} disabled={locked || !model.canRedo}>Redo</button>
        {(pending > 0 || model.stale || externalUpdate === 'pending') && <button onClick={() => void reload(false)} disabled={locked || editorDirty}
          title="Refresh saved data and view settings while keeping drafts. Undo history resets.">Refresh view</button>}
        <button onClick={() => void reload()} disabled={locked}>{pending || editorDirty ? 'Discard edits' : 'Reload'}</button>
        <button className="primary" onClick={() => void save()} disabled={locked || (!pending && !editorDirty)}>Save changes</button>
      </div>
    </section>
    {message && <div role="alert" className="error-banner">{message}
      {model.conflicted && <span> Your edits are still here. Copy them before discarding and reloading the current records.</span>}
    </div>}
    {notice && <div role="status" className="notice-banner"><span>{notice}</span><button onClick={() => setNotice(undefined)}>Dismiss</button></div>}
    {externalUpdate && <div role="status" className="notice-banner">{externalUpdate === 'missing'
      ? 'This table was deleted elsewhere. Visible edits are retained. Choose another table when ready.'
      : 'Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.'}</div>}
    {!offline && refreshFailure && <div role="status" className="notice-banner">Could not check for updates: {refreshFailure}</div>}
    <ViewTabs views={views} selected={view?.id} disabled={!ready || locked} panelId={`table-view-${tableId}`}
      onSelect={selected => void applyView(selected)} onCreate={() => setViewAction('create')} />
    <section className="table-panel" id={`table-view-${tableId}`} role="tabpanel" aria-label={view?.name ?? 'Loading view'}>
    <div className="record-toolbar">
      <button className="primary" disabled={recordActionsLocked} onClick={() => void openRecord('create')}>+ New record</button>
      {view?.type !== 'board' && <><button disabled={recordActionsLocked || selectedCount !== 1} onClick={() => void openRecord('edit')}>Open record</button>
      <button disabled={recordActionsLocked || selectedCount !== 1} onClick={() => void openRecord('duplicate')}>Duplicate</button>
      <button disabled={recordActionsLocked || !selectedCount} onClick={() => void openRecord('delete')}>Delete records</button></>}
      <button disabled={recordActionsLocked} onClick={() => setCsvAction('import')}>Import CSV</button>
      <button disabled={recordActionsLocked} onClick={() => setTrashOpen(true)}>Trash</button>
      <button disabled={recordActionsLocked} onClick={() => setBatchHistory({})}>Saved changes</button>
      {savedAction && <button disabled={recordActionsLocked} onClick={() => setBatchHistory(savedAction)}>{savedAction.redo ? 'Redo saved change' : 'Undo saved change'}</button>}
      <button disabled={recordActionsLocked || !view || searchComposing} onClick={() => setCsvAction('export')}>Export CSV</button>
      <span>{pending > 0 || editorDirty ? 'Save or discard grid edits to manage records.'
        : view?.type === 'board' ? 'Open a card to edit, or move it to another group.'
          : selectedCount === undefined ? 'Loading selection…' : selectedCount ? `${selectedCount.toLocaleString()} selected` : 'Select a row or cell to open a record.'}</span>
    </div>
      <div className="view-toolbar">
        <button disabled={!view || locked} onClick={() => setViewAction('edit')}>View settings</button>
        <button aria-label="Filters" aria-haspopup="dialog" aria-expanded={viewAction === 'filter'}
          disabled={!view || locked || searchComposing} onClick={event => { setQueryAnchor(event.currentTarget.getBoundingClientRect()); setViewAction('filter'); }}>
          Filters{view?.query.filter && (view.query.filter.conditions.length > 0 || view.query.filter.conjunction === 'or') && <span className="query-badge" aria-hidden="true">On</span>}</button>
        <button aria-label="Sort" aria-haspopup="dialog" aria-expanded={viewAction === 'sort'}
          disabled={!view || locked || searchComposing} onClick={event => { setQueryAnchor(event.currentTarget.getBoundingClientRect()); setViewAction('sort'); }}>
          Sort{!!view?.query.sort?.length && <span className="query-badge" aria-hidden="true">{view.query.sort.length}</span>}</button>
        <button disabled={!view || locked} onClick={() => setViewAction('display')}>Display</button>
        {view?.type === 'grid' && <button aria-label="Groups" aria-haspopup="dialog" aria-expanded={viewAction === 'group'} disabled={locked}
          onClick={event => { setQueryAnchor(event.currentTarget.getBoundingClientRect()); setViewAction('group'); }}>
          Groups{view.groupBy && <span className="query-badge" aria-hidden="true">1</span>}</button>}
        <button disabled={!view || recordActionsLocked || searchComposing} onClick={() => setSummarizing(true)}>Summarize</button>
        <button disabled={!view || locked || views.length < 2} onClick={() => setViewAction('delete')}>Delete view</button>
        <input type="search" aria-label="Search records" placeholder="Search records…" value={search}
          disabled={!ready || model.saving || offline} onChange={event => setSearch(event.target.value)}
          onCompositionStart={() => setSearchComposing(true)} onCompositionEnd={() => setSearchComposing(false)} />
      </div>
      {grouping.enabled && <div className="group-tools" aria-label="Record groups">
        <span>Grouped by {model.table?.fields.find(field => field.id === view!.groupBy)?.name}</span>
        <button disabled={locked || editorDirty || grouping.pending || !grouping.rows} onClick={() => collapseGroups({ defaultCollapsed: true, exceptions: [] })}>Collapse all</button>
        <button disabled={locked || editorDirty || grouping.pending || !grouping.rows} onClick={() => collapseGroups({ defaultCollapsed: false, exceptions: [] })}>Expand all</button>
        <small>Click a group heading or press Enter to expand or collapse.</small>
      </div>}
      {ready && table && view?.type === 'board' ? <BoardView table={table} view={view} search={appliedSearch.current} generation={queryVersion} api={api}
        revision={model.dataRevision!} dateContext={model.dateContext} onWindow={boardWindowChanged} onDragChange={boardDragChanged}
        prepared={preparedBoard?.generation === queryVersion ? preparedBoard.snapshot : undefined}
        disabled={recordActionsLocked} onOpen={record => void openBoardRecord(record)} onRefresh={() => void reload()}
        onCreate={lane => setRecordAction({ kind: 'create', records: [], initialValues: { [view.groupBy!]: lane } })} onMove={moveBoardRecord} />
        : <div className="grid-host" aria-busy={locked || !ready || grouping.pending} ref={gridHost} onCopyCapture={event => {
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
        {ready && table && (!grouping.enabled || grouping.rows) ? <EditorContext.Provider value={editorBridge}><DataEditor
          ref={grid} onCellClicked={([, row], event) => {
            if (grouping.rows?.at(row)?.kind === 'group') { event.preventDefault(); toggleGroup(row); }
            grid.current?.focus();
          }}
          width={size.width} height={size.height} rows={gridRowCount}
          columns={columns}
          onHeaderMenuClick={openColumnActions}
          onHeaderContextMenu={(column, event) => { event.preventDefault(); openColumnActions(column, event.bounds); }}
          onKeyDown={event => {
            if ((event.key === 'Enter' || event.key === ' ') && selection.current && grouping.rows?.at(selection.current.cell[1])?.kind === 'group') {
              event.cancel(); event.preventDefault(); toggleGroup(selection.current.cell[1]); return;
            }
            if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selection.current && event.bounds) {
              event.cancel();
              event.preventDefault();
              openColumnActions(selection.current.cell[0], event.bounds);
            }
          }}
          getCellContent={getCellContent} getCellsForSelection={getCellsForSelection}
          drawCell={drawSelectCell}
          provideEditor={cell => {
            if (cell.kind !== GridCellKind.Text) return undefined;
            const editable = cell as EditableCell;
            const bounds = grid.current?.getBounds(fields.findIndex(field => field.id === editable.field.id), editable.gridRow);
            return { editor: CellEditor, ...(bounds ? { styleOverride: { left: bounds.x - 1, top: bounds.y - 1 } } : {}) };
          }}
          isOutsideClick={event => {
            const editor = activeEditor.current;
            if (!editor || !(event.target instanceof Node) || editor.contains(event.target)) return false;
            if (!editor.finish(true)) { event.preventDefault(); event.stopImmediatePropagation(); }
            return false;
          }}
          onVisibleRegionChanged={region => setVisible(previous =>
            previous.y === region.y && previous.height === region.height ? previous : { y: region.y, height: region.height })}
          gridSelection={selection} onGridSelectionChange={setSelection}
          rowMarkers={grouping.enabled ? 'checkbox' : 'both'} rowHeight={view!.rowHeight} freezeColumns={view!.frozenColumns} headerHeight={40} rangeSelect="rect" rowSelectionMode="multi"
          getRowThemeOverride={row => grouping.rows?.at(row)?.kind === 'group' ? { bgCell: '#edf2fa', textDark: '#244570' } : undefined}
          cellActivationBehavior="double-click"
          keybindings={{ paste: false, copy: false }}
          onDelete={selected => { void clearSelection(selected); return false; }}
          smoothScrollX smoothScrollY
          onCellsEdited={edits => {
            if (locked || grouping.pending || grouping.stale) return true;
            try {
              model.applyEdits(edits.filter(edit => recordIndex(edit.location[1]) !== undefined &&
                (edit.value.kind === GridCellKind.Text || edit.value.kind === GridCellKind.Boolean)).map(edit => ({
                row: recordIndex(edit.location[1])!, fieldId: fields[edit.location[0]]!.id,
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
        /></EditorContext.Provider> : <div className="loading-state" role="status">{message ? 'Could not load the table. Try Reload.' : grouping.enabled ? 'Loading groups…' : 'Opening your workspace…'}</div>}
      </div>}
    </section>
    <footer><span role="status" className={pending ? 'pending-status' : ''}>{status}</span>
      <span>{table ? `${model.rowCount.toLocaleString()} ${model.rowCount === 1 ? 'record' : 'records'} · ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}` : 'Loading records…'}</span>
      <span>{view?.type === 'board' ? 'Move records by dragging or choosing a status' : 'Enter to edit · Esc to cancel · Ctrl+C / Ctrl+V · Ctrl+S to save'}</span></footer>
    {recordAction && table && <RecordDialog action={recordAction} table={table} api={api} setDirty={setFormDirty}
      onClose={() => setRecordAction(undefined)} onSaved={() => { setRecordAction(undefined); void refreshAfterWrite('Records'); }} />}
    {trashOpen && table && <TrashDialog table={table} api={api} setDirty={setFormDirty} onClose={() => setTrashOpen(false)}
      onRestored={count => { setTrashOpen(false); setNotice(`${count} record${count === 1 ? '' : 's'} restored.`); void refreshAfterWrite('Restored records'); }} />}
    {batchHistory && table && <BatchHistoryDialog table={table} api={api} initialBatchId={batchHistory.batchId} redo={!!batchHistory.redo} setDirty={setFormDirty}
      onClose={() => setBatchHistory(undefined)} onApplied={(batchId, redone) => {
        setBatchHistory(undefined); setSavedAction({ batchId, redo: !redone }); setNotice(`Saved operation ${redone ? 'redone' : 'undone'}.`); void refreshAfterWrite('Saved operation');
      }} />}
    {summarizing && table && view && <SummaryDialog table={table} view={view} search={search} api={api} onClose={() => setSummarizing(false)} />}
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
    {columnAction && view && <ColumnActions field={columnAction.field} view={view} bounds={columnAction.bounds}
      disabled={recordActionsLocked} onAction={changeColumn} onClose={() => { setColumnAction(undefined); grid.current?.focus(); }} />}
    {editingField && table && <FieldForm table={table} field={editingField.field} anchor={editingField.bounds} api={api} setDirty={setFormDirty}
      restoreFocus={() => grid.current?.focus()} onClose={() => setEditingField(undefined)}
      onSaved={async () => { setEditingField(undefined); await refreshAfterWrite('Schema'); grid.current?.focus(); }} />}
    {viewAction && view && table && <ViewDialog kind={viewAction} view={view} search={search} table={table} api={api} setDirty={setFormDirty} anchor={queryAnchor}
      onClose={() => setViewAction(undefined)} onSaved={saved => {
        setViewAction(undefined);
        currentView.current = saved;
        if (viewAction !== 'filter' && viewAction !== 'sort') appliedSearch.current = saved?.query.search ?? '';
        void refreshAfterWrite('View');
      }} />}
  </section></AttachmentContext.Provider>;
}
