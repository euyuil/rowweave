import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DataEditor, {
  CompactSelection, GridCellKind, type DataEditorRef, type GridCell, type GridSelection, type Rectangle,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { maxBatchCells, maxBatchRecords, type Field, type RowRecord } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import { cellDisplay, cellText } from '../../client/src/cell-values.js';
import { parseTextValue } from '../../core/src/field-values.js';
import { EditorContext, TextCellEditor, type FinishEditor } from './text-cell-editor.js';
import { parseClipboard } from './clipboard.js';
import './table-app.css';

export interface TableHost {
  confirmDiscard(): Promise<boolean>;
  setDirty(value: boolean): Promise<void>;
  onServiceExit(listener: () => void): () => void;
}

function textCell(record: RowRecord | undefined, field: Field | undefined, readonly: boolean): GridCell {
  if (!record || !field) return { kind: GridCellKind.Loading, allowOverlay: false };
  const value = record.values[field.id];
  const text = cellText(field, value);
  return { kind: GridCellKind.Text, data: text, copyData: text, displayData: cellDisplay(field, value),
    allowOverlay: !readonly, readonly };
}

export function TableApp({ model, host }: { model: TableModel; host: TableHost }) {
  const revision = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const queryVersion = model.queryVersion;
  const fields = model.fields;
  const columns = useMemo(() => fields.map(field => ({ id: field.id, title: field.name, width: 180 })), [fields]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const activeEditor = useRef<FinishEditor>();
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

  useEffect(() => {
    let active = true;
    void model.initialize().then(() => { if (active) setReady(true); }).catch(error => { if (active) report(error); });
    const unsubscribe = host.onServiceExit(() => {
      setOffline(true);
      setError('The data service stopped. Keep your unsaved values visible and restart when ready.');
    });
    return () => { active = false; unsubscribe(); model.dispose(); };
  }, [model, host, report]);

  useEffect(() => { void host.setDirty(pending > 0 || editorDirty).catch(report); }, [pending, editorDirty, host, report]);

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
        if (!activeEditor.current(true)) return;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await model.save();
    } catch (failure) { report(failure); }
  }, [model, offline, report]);
  const editorBridge = useMemo(() => ({
    save: () => { void save(); }, setDirty: setEditorDirty,
    register: (finish: FinishEditor | undefined) => { activeEditor.current = finish; },
  }), [save]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !rootHost.current?.contains(event.target)) return;
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

  const discard = async () => {
    if (locked || ((pending > 0 || editorDirty) && !await host.confirmDiscard())) return;
    activeEditor.current?.(false);
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await model.discardAndReload();
      await model.readRange(visible.y, Math.min(visible.height + 5, maxBatchRecords));
      setReady(true);
    } catch (failure) { report(failure); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const table = model.table;
  const getCellContent = useCallback(([column, row]: readonly [number, number]): GridCell => {
    const field = fields[column];
    return textCell(model.getRecord(row), field, locked || model.stale);
  }, [model, fields, locked, revision]);

  const getCellsForSelection = (rectangle: Rectangle, signal: AbortSignal) => async () => {
    if (rectangle.height > maxBatchRecords || rectangle.width * rectangle.height > maxBatchCells) {
      setError('Copy up to 20,000 cells and 2,000 rows at a time.');
      return [];
    }
    try {
      const records = await model.readRange(rectangle.y, rectangle.height);
      if (signal.aborted) return [];
      return records.map(record => Array.from({ length: rectangle.width }, (_, x) =>
        textCell(record, fields[rectangle.x + x], locked)));
    } catch (failure) { report(failure); return []; }
  };

  const status = offline ? 'Service unavailable' : !ready ? 'Loading table…' : model.saving ? 'Saving…' : busy ? 'Loading rows…'
    : editorDirty ? 'Editing cell…'
    : pending ? `${pending.toLocaleString()} unsaved ${pending === 1 ? 'cell' : 'cells'}` : 'All changes saved';
  const message = error ?? model.error;
  return <main className="rowweave-app" ref={rootHost}>
    <header className="app-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">▦</span> RowWeave</div>
      <span className="workspace-label">Local workspace <span className="prototype-tag">Prototype</span></span>
    </header>
    <section className="table-heading">
      <div><p className="eyebrow">YOUR DATA, ON YOUR DEVICE</p><h1>Prototype workspace</h1>
        <p className="subtitle">A shared foundation for your team, your apps, and your agents.</p></div>
      <div className="actions">
        <button onClick={() => model.undo()} disabled={locked || !model.canUndo}>Undo</button>
        <button onClick={() => model.redo()} disabled={locked || !model.canRedo}>Redo</button>
        <button onClick={() => void discard()} disabled={locked}>{pending || editorDirty ? 'Discard edits' : 'Reload'}</button>
        <button className="primary" onClick={() => void save()} disabled={locked || (!pending && !editorDirty)}>Save changes</button>
      </div>
    </section>
    {message && <div role="alert" className="error-banner">{message}
      {model.conflicted && <span> Your edits are still here. Copy them before discarding and reloading the current records.</span>}
    </div>}
    <section className="table-panel" aria-label="Prototype data table">
      <div className="table-toolbar"><strong>▦ &nbsp; All records</strong>
        <span>{table ? `${model.rowCount.toLocaleString()} records · ${fields.length} fields` : 'Loading records…'}</span></div>
      <div className="grid-host" ref={gridHost} onPasteCapture={event => {
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
          provideEditor={cell => cell.kind === GridCellKind.Text ? TextCellEditor : undefined}
          onVisibleRegionChanged={region => setVisible(previous =>
            previous.y === region.y && previous.height === region.height ? previous : { y: region.y, height: region.height })}
          gridSelection={selection} onGridSelectionChange={setSelection}
          rowMarkers="number" rowHeight={36} headerHeight={40} rangeSelect="rect"
          cellActivationBehavior="double-click"
          keybindings={{ paste: false }}
          smoothScrollX smoothScrollY
          onCellsEdited={edits => {
            if (locked) return true;
            try {
              model.applyEdits(edits.filter(edit => edit.value.kind === GridCellKind.Text).map(edit => ({
                row: edit.location[1], fieldId: fields[edit.location[0]]!.id,
                value: parseTextValue(fields[edit.location[0]]!, edit.value.kind === GridCellKind.Text ? edit.value.data : ''),
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
  </main>;
}
