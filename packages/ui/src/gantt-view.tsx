import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GanttConfig, GridView, RecordSchedule, RowRecord, Table } from '../../contracts/src/index.js';
import { Temporal } from '../../core/src/temporal.js';
import { parseCalendar } from '../../core/src/calendar-query.js';
import { rescheduledValues } from '../../core/src/record-scheduling.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { calendarDateLabel, calendarToday } from '../../client/src/calendar-dates.js';
import { firstGanttDate, ganttActions, ganttBar, ganttInterval, ganttRange, ganttStart, lastGanttDate } from '../../client/src/gantt-dates.js';
import { ganttCardFields, ganttPageSize, prepareGanttSnapshot, type GanttSnapshot, type GanttWindow } from '../../client/src/gantt-refresh.js';
import { RecordValue, recordText } from './record-value.js';
import './gantt-view.css';

type SavedGantt = Extract<GridView, { type: 'gantt' }>;
type Action = RecordSchedule['action'];
interface Drag { record: RowRecord; view: Pick<GridView, 'id' | 'version'>; action: Action; startX: number; days: number; pointerId: number; target: HTMLElement }
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not update the schedule.';

export function GanttView({ table, view, search, generation, revision, dateContext, total, api, prepared, disabled,
  onWindow, onDragChange, onOpen, onSchedule, onScale, onRefresh }: {
  table: Table; view: SavedGantt; search: string; generation: number; revision: number; dateContext: string | undefined; total: number;
  api: WorkspaceApi; prepared: GanttSnapshot | undefined; disabled: boolean;
  onWindow(window: GanttWindow | undefined): void; onDragChange(active: boolean): void; onOpen(record: RowRecord): void;
  onSchedule(record: RowRecord, action: Action, days: number, view: Pick<GridView, 'id' | 'version'>): Promise<void>; onScale(scale: GanttConfig['scale']): Promise<void>; onRefresh(): void;
}) {
  const [anchor, setAnchor] = useState(() => calendarToday(view.gantt.timeZone));
  const from = ganttStart(anchor, view.gantt.scale), range = useMemo(() => ganttRange(from, view.gantt.scale), [from, view.gantt.scale]);
  const dates = useMemo(() => Array.from({ length: range.dayCount }, (_, index) => Temporal.PlainDate.from(from).add({ days: index })), [range]);
  const [position, setPosition] = useState(0);
  const offset = Math.min(position, Math.max(0, Math.floor((total - 1) / ganttPageSize) * ganttPageSize));
  const key = JSON.stringify([view.id, view.version, table.version, generation, search, offset]);
  const [loaded, setLoaded] = useState<{ key: string; snapshot: GanttSnapshot }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const page = prepared?.window.offset === offset ? prepared.page : loaded?.key === key ? loaded.snapshot.page : undefined;
  const loadError = failure?.key === key ? failure.message : undefined;
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  const rows = useMemo(() => (page?.records ?? []).map(record => {
    const interval = ganttInterval(table, view.gantt, record);
    return { record, interval, title: recordText(primary, record) || '(Untitled record)', can: ganttActions(table, view.gantt, record),
      bar: interval.kind === 'scheduled' ? ganttBar(range, interval) : undefined };
  }), [page, table, view.gantt, primary, range]);
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRow = rows.find(row => row.record.id === selectedId), selected = selectedRow?.record;
  const [action, setAction] = useState<Action>('move'), [days, setDays] = useState('1');
  const [saving, setSaving] = useState(false), [error, setError] = useState<string>();
  const [drag, setDrag] = useState<Drag>(), dragging = useRef<Drag>();
  const viewport = useRef<HTMLDivElement>(null);
  const savedFocus = useRef<{ element: HTMLElement; key: string | null; recordId: string | undefined }>();
  const fields = useMemo(() => ganttCardFields(table, view), [table, view]);
  const calendar = useMemo(() => parseCalendar(table, view.gantt), [table, view.gantt]);
  const capabilities = selectedRow?.can;
  const locked = disabled || saving;
  useLayoutEffect(() => {
    if (locked || !savedFocus.current) return;
    const { element, key, recordId } = savedFocus.current; savedFocus.current = undefined;
    const target = element.isConnected && element.getAttribute('data-gantt-focus') === key ? element
      : recordId ? viewport.current?.querySelector<HTMLElement>('[data-gantt-focus="title:' + CSS.escape(recordId) + '"]') : undefined;
    if (document.activeElement === document.body) target?.focus({ preventScroll: true });
  }, [locked]);
  const moveRange = (date: string) => { setAnchor(ganttStart(date, view.gantt.scale)); if (viewport.current) viewport.current.scrollLeft = 0; };
  const changePage = (next: number) => { setPosition(next); setSelectedId(undefined); if (viewport.current) viewport.current.scrollTop = 0; };
  useEffect(() => {
    if (prepared?.window.offset === offset) return;
    const controller = new AbortController();
    void prepareGanttSnapshot(api, table, view, { revision, total, ...(dateContext ? { dateContext } : {}) }, search, { offset }, controller.signal)
      .then(snapshot => { if (!controller.signal.aborted) setLoaded({ key, snapshot }); })
      .catch(error => { if (!controller.signal.aborted) setFailure({ key, message: message(error) }); });
    return () => controller.abort();
  }, [api, key, prepared]);
  useLayoutEffect(() => { onWindow({ offset }); return () => onWindow(undefined); }, [onWindow, offset]);
  useEffect(() => () => onDragChange(false), [onDragChange]);
  const schedule = async (record: RowRecord, action: Action, days: number, target = { id: view.id, version: view.version }) => {
    if (locked) return;
    if (document.activeElement instanceof HTMLElement) savedFocus.current = { element: document.activeElement,
      key: document.activeElement.getAttribute('data-gantt-focus'), recordId: record.id };
    setError(undefined); setSaving(true);
    try { await onSchedule(record, action, days, target); }
    catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  };
  const stopDrag = (commit: boolean) => {
    const current = dragging.current;
    if (!current) return;
    dragging.current = undefined; setDrag(undefined); onDragChange(false);
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    if (commit && current.days) void schedule(current.record, current.action, current.days, current.view);
  };
  const startDrag = (event: React.PointerEvent<HTMLElement>, record: RowRecord, action: Action) => {
    if (locked || event.button !== 0 || !ganttActions(table, view.gantt, record)[action]) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    target.closest('button')!.focus({ preventScroll: true }); target.setPointerCapture(event.pointerId);
    const next = { record, view: { id: view.id, version: view.version }, action, days: 0, startX: event.clientX, pointerId: event.pointerId, target };
    setSelectedId(record.id); dragging.current = next; setDrag(next); onDragChange(true); setError(undefined);
  };
  const preview = useMemo(() => {
    if (!drag?.days) return undefined;
    try { return { record: { ...drag.record, values: { ...drag.record.values, ...rescheduledValues(calendar, drag.record, drag) } } }; }
    catch (error) { return { error: message(error) }; }
  }, [calendar, drag]);
  return <section className="gantt-view" aria-label={view.name + ' timeline'} tabIndex={-1} onKeyDown={event => {
    if (event.key === 'Escape' && dragging.current) { event.preventDefault(); stopDrag(false); }
  }} onPointerMove={event => {
    const current = dragging.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const days = Math.round((event.clientX - current.startX) / range.dayWidth);
    if (days !== current.days) { const next = { ...current, days }; dragging.current = next; setDrag(next); }
  }} onPointerUp={() => stopDrag(true)} onPointerCancel={() => stopDrag(false)} onLostPointerCapture={() => stopDrag(false)}>
    <header className="gantt-tools">
      <button aria-label="Earlier timeline" disabled={locked || from === firstGanttDate} onClick={() => moveRange(ganttStart(from, view.gantt.scale, -Math.floor(range.dayCount / 2)))}>‹</button>
      <label>Timeline start<input type="date" aria-label="Timeline start" value={from} min={firstGanttDate} max={lastGanttDate(view.gantt.scale)} disabled={locked}
        onChange={event => { if (event.target.value && event.currentTarget.validity.valid) moveRange(event.target.value); }} /></label>
      <button aria-label="Later timeline" disabled={locked || from === lastGanttDate(view.gantt.scale)} onClick={() => moveRange(ganttStart(from, view.gantt.scale, Math.floor(range.dayCount / 2)))}>›</button>
      <button disabled={locked} onClick={() => moveRange(calendarToday(view.gantt.timeZone))}>Today</button>
      <label>Scale<select aria-label="Timeline scale" value={view.gantt.scale} disabled={locked} onChange={event => {
        savedFocus.current = { element: event.currentTarget, key: null, recordId: undefined };
        setSaving(true); setError(undefined);
        void onScale(event.target.value as GanttConfig['scale']).catch(error => setError(message(error))).finally(() => setSaving(false));
      }}><option value="day">Days</option><option value="week">Weeks</option></select></label>
      <span>{calendar.startField.name}{calendar.endField ? ' → ' + calendar.endField.name : ''} · {view.gantt.timeZone}</span>
    </header>
    <form className="gantt-selection" aria-label="Adjust selected schedule" onSubmit={event => {
      event.preventDefault(); if (selected && capabilities?.[action] && Number.isSafeInteger(Number(days)) && Number(days)) void schedule(selected, action, Number(days));
    }}>
      <span title={selected ? recordText(primary, selected) : undefined}>{selected ? recordText(primary, selected) || '(Untitled record)' : 'Select a time bar to adjust dates'}</span>
      <label>Action<select aria-label="Schedule action" value={action} disabled={locked || !selected} onChange={event => setAction(event.target.value as Action)}>
        <option value="move" disabled={!capabilities?.move}>Move</option><option value="resizeStart" disabled={!capabilities?.resizeStart}>Adjust start</option>
        <option value="resizeEnd" disabled={!capabilities?.resizeEnd}>Adjust end</option></select></label>
      <label>Days<input type="number" aria-label="Schedule days" step={1} required value={days} disabled={locked || !selected} onChange={event => setDays(event.target.value)} /></label>
      <button disabled={locked || !capabilities?.[action] || !Number.isSafeInteger(Number(days)) || Number(days) === 0}>Apply date change</button>
      <button type="button" disabled={locked || !selected} onClick={() => { if (selected) onOpen(selected); }}>Open record</button>
    </form>
    <p className={'gantt-status' + (error || preview?.error ? ' form-error' : '')} role={error || preview?.error ? 'alert' : 'status'}
      title={error || preview?.error}>{error || preview?.error || (drag?.days ? `${drag.action === 'move' ? 'Move' : 'Adjust date'}: ${drag.days} days`
        : capabilities && !Object.values(capabilities).some(Boolean) ? 'The configured dates cannot be changed directly. Open the record to edit its inputs.' : '\u00a0')}</p>
    {loadError && <p className="form-error" role="alert">{loadError} <button onClick={onRefresh} disabled={locked}>Reload timeline</button></p>}
    {!page && !loadError && <p role="status">Loading timeline…</p>}
    <div className="gantt-viewport" ref={viewport}>
      <div className="gantt-table" style={{ width: 240 + range.dayCount * range.dayWidth }} role="table" aria-label="Scheduled records" aria-busy={!page && !loadError}>
        <div className="gantt-header" role="row"><div className="gantt-label" role="columnheader">{primary.name}</div>
          <div className="gantt-axis" role="columnheader" aria-label="Calendar dates" style={{ width: range.dayCount * range.dayWidth }}>
            {dates.map(date => <span key={date.toString()} title={calendarDateLabel(date.toString())} style={{ width: range.dayWidth }}
              className={(date.dayOfWeek >= 6 ? 'weekend ' : '') + (date.day === 1 ? 'month-start' : '')}>
              {(view.gantt.scale === 'day' || date.dayOfWeek === 1) && <><small>{date.toLocaleString('en-US', { month: 'short' })}</small>{date.day}</>}
            </span>)}
          </div>
        </div>
        {rows.map(({ record, title, can, interval: originalInterval, bar: originalBar }) => {
          const interval = drag?.record.id === record.id && preview?.record ? ganttInterval(table, view.gantt, preview.record) : originalInterval;
          const projected = interval === originalInterval ? originalBar : interval.kind === 'scheduled' ? ganttBar(range, interval) : undefined;
          const bar = drag?.record.id === record.id && projected && projected.kind !== 'visible'
            ? { kind: 'visible' as const, left: projected.kind === 'before' ? 0 : range.dayCount * range.dayWidth - 8,
              width: 8, clippedStart: true, clippedEnd: true } : projected;
          return <div role="row" className={'gantt-row' + (selectedId === record.id ? ' selected' : '')} key={record.id} data-gantt-record={record.id}
            style={{ height: Math.max(view.rowHeight, fields.length ? 64 : 40) }}>
            <div className="gantt-label" role="cell"><button className="gantt-record-title" data-gantt-focus={'title:' + record.id} disabled={locked}
              onFocus={() => setSelectedId(record.id)} onClick={() => onOpen(record)}>{title}</button>
              <div className="gantt-card-fields">{fields.map(field => <span key={field.id} title={field.name + ': ' + recordText(field, record)}>
                <small>{field.name}: </small><RecordValue field={field} record={record} /></span>)}</div>
            </div>
            <div className="gantt-track" role="cell" style={{ backgroundSize: range.dayWidth + 'px 100%' }}>
              {bar?.kind === 'visible' ? <button className={'gantt-bar' + (interval.kind === 'scheduled' && interval.point ? ' point' : '')
                + (bar.clippedStart ? ' clipped-start' : '') + (bar.clippedEnd ? ' clipped-end' : '')}
                style={{ left: bar.left + 2, width: Math.max(8, bar.width - 4) }} data-gantt-focus={'bar:' + record.id} aria-pressed={selectedId === record.id}
                aria-label={title + ', ' + (interval.kind === 'scheduled' ? interval.from + ' to ' + interval.to : '')} disabled={locked}
                onFocus={() => setSelectedId(record.id)} onClick={() => setSelectedId(record.id)} onDoubleClick={() => onOpen(record)}
                onPointerDown={event => startDrag(event, record, 'move')} onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); onOpen(record); return; }
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault(); const action = event.altKey ? 'resizeStart' : event.shiftKey ? 'resizeEnd' : 'move';
                  if (can[action]) void schedule(record, action, event.key === 'ArrowLeft' ? -1 : 1);
                }}>
                {can.resizeStart && <span className="gantt-grip start" aria-label="Drag start date" onPointerDown={event => startDrag(event, record, 'resizeStart')} />}
                <span className="gantt-bar-text">{title}</span>
                {can.resizeEnd && <span className="gantt-grip end" aria-label="Drag end date" onPointerDown={event => startDrag(event, record, 'resizeEnd')} />}
              </button> : interval.kind === 'scheduled' ? <button className="gantt-outside" disabled={locked} onClick={() => moveRange(interval.from)}>
                {bar?.kind === 'before' ? 'Before range' : 'After range'} · Show date</button>
                : <button className={'gantt-exception ' + interval.kind} disabled={locked} onClick={() => onOpen(record)}>
                  {interval.kind === 'unscheduled' ? 'Set a start date' : 'Check date range'}</button>}
            </div>
          </div>;
        })}
      </div>
      {page && !page.total && <p className="gantt-empty">No matching records.</p>}
    </div>
    <footer className="gantt-pages">
      <button disabled={locked || offset === 0} onClick={() => changePage(Math.max(0, offset - ganttPageSize))}>Previous records</button>
      <span>{total ? offset + 1 : 0}–{Math.min(offset + ganttPageSize, total)} of {total.toLocaleString()} {total === 1 ? 'record' : 'records'}</span>
      <button disabled={locked || offset + ganttPageSize >= total} onClick={() => changePage(offset + ganttPageSize)}>Next records</button>
      <small>Drag a bar or its ends · Arrow keys move · Shift adjusts end · Alt adjusts start · Enter opens details</small>
    </footer>
  </section>;
}
