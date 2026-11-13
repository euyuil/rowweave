import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Field, GridView, RecordSummary, RowRecord, Table, ViewPage } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { cellDisplay } from '../../client/src/cell-values.js';
import { selectedOptions, selectStyle } from './select-colors.js';
import { SelectValues } from './select-values.js';

function recordText(field: Field, record: RowRecord): string {
  if (record.formulaErrors?.[field.id]) return `#ERROR: ${record.formulaErrors[field.id]}`;
  const value = record.values[field.id] ?? null;
  return field.type === 'relation' ? ((value ?? []) as string[]).map(id => record.links?.[field.id]?.find(link => link.id === id)?.label || id).join(', ')
    : cellDisplay(field, value);
}

function RecordValue({ field, record }: { field: Field; record: RowRecord }) {
  const options = record.formulaErrors?.[field.id] ? undefined : selectedOptions(field, record.values[field.id]);
  return options?.length ? <SelectValues options={options} /> : <>{recordText(field, record) || '—'}</>;
}

export function BoardView({ table, view, search, generation, api, disabled, onOpen, onCreate, onMove, onRefresh }: {
  table: Table; view: GridView; search: string; generation: number; api: WorkspaceApi; disabled: boolean;
  onOpen(record: RowRecord): void; onCreate(lane: string | null): void;
  onMove(record: RowRecord, lane: string | null): Promise<void>; onRefresh(): void;
}) {
  const group = table.fields.find(field => field.id === view.groupBy)!;
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  const fields = useMemo(() => view.columns.filter(column => !column.hidden).map(column => table.fields.find(field => field.id === column.fieldId)!)
    .filter(field => field.id !== primary.id && field.id !== group.id).slice(0, 3), [table, view, primary.id, group.id]);
  const [summary, setSummary] = useState<RecordSummary>();
  const [error, setError] = useState<string>();
  const [moveError, setMoveError] = useState<string>();
  const [moving, setMoving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dragged = useRef<RowRecord>();
  const scrollLeft = useRef(0);
  const currentView = useRef(view.id);
  useEffect(() => {
    const controller = new AbortController();
    scrollLeft.current = currentView.current === view.id ? root.current!.scrollLeft : 0;
    currentView.current = view.id;
    setSummary(undefined); setError(undefined); setMoveError(undefined);
    void api.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version, groupBy: group.id, search, limit: 500 }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.schemaVersion !== table.version) throw new Error('The table schema changed. Reload to see the current fields.');
        setSummary(result);
      }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load the board.'); });
    return () => controller.abort();
  }, [api, table.id, table.version, view.id, view.version, group.id, search, generation]);
  useLayoutEffect(() => { if (summary) root.current!.scrollLeft = scrollLeft.current; }, [summary]);
  const move = async (record: RowRecord, lane: string | null) => {
    if ((record.values[group.id] ?? null) === lane) return;
    setMoving(true);
    try { await onMove(record, lane); }
    catch (failure) { setMoveError(`${failure instanceof Error ? failure.message : 'The move could not be confirmed.'} Refresh the board before moving another record.`); }
    finally { setMoving(false); }
  };
  const locked = disabled || moving || !!moveError;
  const lanes = [...group.options!.map(option => ({ id: option.id as string | null, label: option.name })), { id: null, label: 'No value' }];
  return <section className="board-view" aria-label={`${view.name} board`}>
    <div className="board-tools"><span>Grouped by {group.name}</span><button disabled={disabled || moving} onClick={onRefresh}>Refresh board</button></div>
    {(error || moveError) && <p role="alert" className="board-error">{error ?? moveError} {error && 'Reload the table to use the latest view and fields.'}</p>}
    {!summary && !error && <p role="status">Loading board…</p>}
    <div className="board-scroll" ref={root}>
      {summary && lanes.map(lane => <BoardLane key={`${generation}:${summary.revision}:${summary.dateContext}:${JSON.stringify(lane.id)}`} lane={lane} dateContext={summary.dateContext}
        count={summary.groups.find(result => result.key === lane.id)?.count ?? 0} revision={summary.revision}
        root={root} table={table} view={view} search={search} api={api} fields={fields} primary={primary} group={group} disabled={locked}
        onOpen={onOpen} onCreate={() => onCreate(lane.id)} onMove={move}
        onDrag={record => { dragged.current = record; }} onDrop={() => {
          const record = dragged.current; dragged.current = undefined;
          if (record && !locked) void move(record, lane.id);
        }} canDrop={() => !!dragged.current && !locked} />)}
    </div>
  </section>;
}

function BoardLane({ lane, count, revision, dateContext, root, table, view, search, api, fields, primary, group, disabled, onOpen, onCreate, onMove, onDrag, onDrop, canDrop }: {
  lane: { id: string | null; label: string }; count: number; revision: number; root: RefObject<HTMLDivElement>;
  dateContext: string | undefined;
  table: Table; view: GridView; search: string; api: WorkspaceApi; fields: Field[]; primary: Field; group: Field; disabled: boolean;
  onOpen(record: RowRecord): void; onCreate(): void; onMove(record: RowRecord, lane: string | null): Promise<void>;
  onDrag(record: RowRecord | undefined): void; onDrop(): void; canDrop(): boolean;
}) {
  const element = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ViewPage>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setNear(entry!.isIntersecting), { root: root.current, rootMargin: '0px 280px' });
    observer.observe(element.current!);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    setPage(undefined); setError(undefined);
    if (!near || count === 0) return;
    const controller = new AbortController();
    void api.queryView(table.id, view.id, { lane: lane.id, search, offset, limit: 25, expectedRevision: revision,
      ...(dateContext ? { expectedDateContext: dateContext } : {}),
      expectedViewVersion: view.version, fields: [...new Set([primary.id, group.id, ...fields.map(field => field.id)])] }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.schemaVersion !== table.version) throw new Error('The table schema changed. Reload the table.');
        setPage(result);
      }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load records.'); });
    return () => controller.abort();
  }, [api, table.id, table.version, view.id, view.version, lane.id, search, offset, revision, dateContext, near, count, fields, primary.id, group.id]);
  return <section ref={element} className="board-lane" aria-label={`${lane.label} column`}
    onDragOver={event => { if (canDrop() && !(lane.id === null && group.required)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
    onDrop={event => { event.preventDefault(); if (!(lane.id === null && group.required)) onDrop(); }}>
    <header><h3>{lane.id === null ? lane.label : <SelectValues options={selectedOptions(group, lane.id)!} />}</h3><span aria-label={`${count} records`}>{count.toLocaleString()}</span></header>
    <button className="board-add" disabled={disabled || (lane.id === null && group.required)} onClick={onCreate}>+ New record</button>
    {count === 0 && <p className="board-empty">No matching records</p>}
    {near && count > 0 && !page && !error && <p role="status">Loading records…</p>}
    {error && <p role="alert" className="form-error">{error} Refresh the board to continue.</p>}
    <div className="board-cards">{page?.records.map(record => {
      const title = recordText(primary, record) || '(Untitled record)';
      return <article className="board-card" key={record.id} draggable={!disabled}
        onDragStart={event => { if (disabled) { event.preventDefault(); return; } onDrag(record); event.dataTransfer.setData('text/plain', record.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => onDrag(undefined)}>
        <button className="board-card-title" disabled={disabled} onClick={() => onOpen(record)}>{selectedOptions(primary, record.values[primary.id])?.length ? <RecordValue field={primary} record={record} /> : title}</button>
        <dl>{fields.map(field => <div key={field.id}><dt>{field.name}</dt><dd><RecordValue field={field} record={record} /></dd></div>)}</dl>
        <label className="board-move">Move to<select aria-label={`Move ${title} to`} disabled={disabled} value={lane.id ?? ''}
          onChange={event => void onMove(record, event.target.value || null)}>
          <option value="" disabled={group.required}>No value</option>
          {group.options!.map(option => <option value={option.id} key={option.id} style={selectStyle(option)}>{option.name}</option>)}
        </select></label>
      </article>;
    })}</div>
    {near && page && count > 25 && <div className="board-pages">
      <button aria-label={`Previous records in ${lane.label}`} disabled={disabled || offset === 0} onClick={() => setOffset(offset - 25)}>Previous</button>
      <span>{offset + 1}–{offset + page.records.length}</span>
      <button aria-label={`Next records in ${lane.label}`} disabled={disabled || offset + page.records.length >= count} onClick={() => setOffset(offset + 25)}>Next</button>
    </div>}
  </section>;
}
