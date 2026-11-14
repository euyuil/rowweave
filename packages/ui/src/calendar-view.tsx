import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { valueField, type CalendarBucket, type CalendarLayout, type CalendarPage, type CellValue, type GridView, type RowRecord, type Table } from '../../contracts/src/index.js';
import { Temporal } from '../../core/src/temporal.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { calendarBucketCount, calendarCardFields, calendarMonthRange, calendarPageSize, calendarProjection, prepareCalendarSnapshot,
  type CalendarSnapshot, type CalendarWindow } from '../../client/src/calendar-refresh.js';
import { calendarDateLabel, calendarInitialValues, calendarKeyboardDate, calendarMonthLabel, calendarToday } from '../../client/src/calendar-dates.js';
import { RecordValue, recordText } from './record-value.js';
import './calendar-view.css';

type SavedCalendar = Extract<GridView, { type: 'calendar' }>;
const sameBucket = (a: CalendarBucket | undefined, b: CalendarBucket | undefined) => JSON.stringify(a) === JSON.stringify(b);
const failureText = (failure: unknown) => failure instanceof Error ? failure.message : 'Could not load calendar records.';
// Keep every date in the six-week query inside the API's four-digit date range.
const firstMonth = '0001-01', lastMonth = '9999-11';

export function CalendarView({ table, view, search, generation, revision, dateContext, api, prepared, disabled, onWindow, onOpen, onCreate, onRefresh }: {
  table: Table; view: SavedCalendar; search: string; generation: number; revision: number; dateContext: string | undefined;
  api: WorkspaceApi; prepared: CalendarSnapshot | undefined; disabled: boolean;
  onWindow(window: CalendarWindow | undefined): void; onOpen(record: RowRecord): void;
  onCreate(values: Record<string, CellValue>): void; onRefresh(): void;
}) {
  const [today, setToday] = useState(() => calendarToday(view.calendar.timeZone));
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(today);
  const [bucket, setBucket] = useState<CalendarBucket>();
  const [position, setPosition] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; layout: CalendarLayout }>();
  const [layoutFailure, setLayoutFailure] = useState<{ key: string; message: string }>();
  const [loadedPage, setLoadedPage] = useState<{ key: string; offset: number; page: CalendarPage }>();
  const [pageFailure, setPageFailure] = useState<{ key: string; offset: number; message: string }>();
  const root = useRef<HTMLElement>(null), bucketHeading = useRef<HTMLHeadingElement>(null);
  const pendingDayFocus = useRef<string>(), pendingBucketFocus = useRef(false), pendingBucketScroll = useRef(false);
  const primary = table.fields.find(field => field.id === table.primaryFieldId)!;
  const start = table.fields.find(field => field.id === view.calendar.startFieldId)!;
  const end = view.calendar.endFieldId ? table.fields.find(field => field.id === view.calendar.endFieldId)! : undefined;
  const fields = useMemo(() => calendarCardFields(table, view), [table, view]);
  const projection = useMemo(() => calendarProjection(table, view), [table, view]);
  const key = JSON.stringify([view.id, view.version, table.version, generation, search, month]);
  const preparedMonth = prepared?.window.month === month ? prepared : undefined;
  const layout = preparedMonth?.layout ?? (loaded?.key === key ? loaded.layout : undefined);
  const layoutError = layoutFailure?.key === key ? layoutFailure.message : undefined;
  const count = layout && bucket ? calendarBucketCount(layout, bucket) : undefined;
  const offset = count === undefined ? position : Math.min(position, Math.max(0, Math.floor((count - 1) / calendarPageSize) * calendarPageSize));
  const pageKey = JSON.stringify([key, bucket]);
  const preparedPage = sameBucket(preparedMonth?.window.bucket, bucket) && preparedMonth?.window.offset === offset ? preparedMonth.page : undefined;
  const page = preparedPage ?? (loadedPage?.key === pageKey && loadedPage.offset === offset ? loadedPage.page : undefined);
  const pageError = pageFailure?.key === pageKey && pageFailure.offset === offset ? pageFailure.message : undefined;
  const dates = useMemo(() => {
    const first = Temporal.PlainDate.from(calendarMonthRange(month).from);
    return Array.from({ length: 42 }, (_, index) => first.add({ days: index }).toString());
  }, [month]);

  useEffect(() => {
    const update = () => setToday(calendarToday(view.calendar.timeZone));
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [view.calendar.timeZone]);
  useEffect(() => {
    if (preparedMonth) return;
    const controller = new AbortController();
    void prepareCalendarSnapshot(api, table, view, { revision, ...(dateContext ? { dateContext } : {}) }, search, { month, offset: 0 }, controller.signal)
      .then(snapshot => { if (!controller.signal.aborted) setLoaded({ key, layout: snapshot.layout }); })
      .catch(failure => { if (!controller.signal.aborted) setLayoutFailure({ key, message: failureText(failure) }); });
    return () => controller.abort();
  }, [api, key, preparedMonth]);
  useEffect(() => {
    if (!layout || !bucket || !count || preparedPage) return;
    const controller = new AbortController();
    void api.queryCalendarRecords(table.id, { viewId: view.id, expectedViewVersion: view.version, calendar: view.calendar,
      bucket, offset, limit: calendarPageSize, fields: projection, search, expectedRevision: layout.revision,
      ...(layout.dateContext ? { expectedDateContext: layout.dateContext } : {}) }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.schemaVersion !== table.version) throw new Error('The table schema changed. Reload the calendar.');
        setLoadedPage({ key: pageKey, offset, page: result });
      }).catch(failure => { if (!controller.signal.aborted) setPageFailure({ key: pageKey, offset, message: failureText(failure) }); });
    return () => controller.abort();
  }, [api, pageKey, offset, layout, preparedPage]);
  useLayoutEffect(() => {
    onWindow({ month, ...(bucket ? { bucket } : {}), offset });
    return () => onWindow(undefined);
  }, [onWindow, month, bucket, offset]);
  useLayoutEffect(() => {
    if (pendingBucketScroll.current && bucketHeading.current && (page || count === 0 || pageError)) {
      pendingBucketScroll.current = false;
      if (pendingBucketFocus.current) { pendingBucketFocus.current = false; bucketHeading.current.focus({ preventScroll: true }); }
      bucketHeading.current.closest('aside')!.scrollIntoView({ block: 'nearest' });
    }
    if (pendingDayFocus.current && layout) {
      const target = root.current?.querySelector<HTMLElement>('[data-calendar-day="' + pendingDayFocus.current + '"]');
      if (target) { pendingDayFocus.current = undefined; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
    }
  }, [layout, bucket, selectedDate, page, count, pageError]);

  const moveMonth = (next: string, focusDate?: string) => {
    if (next < firstMonth || next > lastMonth) return;
    setMonth(next); setSelectedDate(focusDate ?? next + '-01');
    if (bucket?.kind === 'day') { setBucket(undefined); setPosition(0); }
    if (focusDate) pendingDayFocus.current = focusDate;
  };
  const openBucket = (next: CalendarBucket, focus = false) => {
    setBucket(next); setPosition(0);
    if (next.kind === 'day') setSelectedDate(next.date);
    pendingBucketFocus.current = focus; pendingBucketScroll.current = true;
  };
  const closeBucket = () => {
    const previous = bucket;
    setBucket(undefined); setPosition(0);
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(previous?.kind === 'day'
        ? '[data-calendar-day="' + previous.date + '"]' : '[data-calendar-bucket="' + previous?.kind + '"]');
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'nearest' });
    });
  };
  const title = bucket?.kind === 'day' ? calendarDateLabel(bucket.date) : bucket?.kind === 'unscheduled' ? 'Unscheduled records' : 'Invalid date ranges';
  const creation = bucket?.kind === 'day' ? calendarInitialValues(table, view.calendar, bucket.date) : undefined;
  const dayLabel = (date: string, total: number | undefined) => calendarDateLabel(date) + (total === undefined ? ', loading' : ', ' + total + (total === 1 ? ' record' : ' records'));
  const timestamp = valueField(start).type === 'datetime';
  const time = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: view.calendar.timeZone, hour: 'numeric', minute: '2-digit' }), [view.calendar.timeZone]);
  const dateTime = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone: view.calendar.timeZone, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), [view.calendar.timeZone]);

  return <section className="calendar-view" tabIndex={-1} aria-label={view.name + ' calendar'} ref={root}>
    <header className="calendar-tools">
      <div className="calendar-month-controls">
        <button aria-label="Previous month" disabled={disabled || month === firstMonth} onClick={() => moveMonth(Temporal.PlainYearMonth.from(month).subtract({ months: 1 }).toString())}>‹</button>
        <h2>{calendarMonthLabel(month)}</h2>
        <button aria-label="Next month" disabled={disabled || month === lastMonth} onClick={() => moveMonth(Temporal.PlainYearMonth.from(month).add({ months: 1 }).toString())}>›</button>
        <button disabled={disabled} onClick={() => { moveMonth(today.slice(0, 7)); setSelectedDate(today); }}>Today</button>
        <label className="calendar-month-input">Month<input type="month" aria-label="Calendar month" min={firstMonth} max={lastMonth} value={month} disabled={disabled}
          onChange={event => { if (event.target.value && event.currentTarget.validity.valid) moveMonth(event.target.value); }} /></label>
      </div>
      <p>{start.name}{end ? ' → ' + end.name : ''} · {view.calendar.timeZone}</p>
      <div className="calendar-buckets">
        <button data-calendar-bucket="unscheduled" disabled={disabled || !layout} aria-expanded={bucket?.kind === 'unscheduled'}
          onClick={event => openBucket({ kind: 'unscheduled' }, event.detail === 0)}>Unscheduled ({layout?.unscheduled.count.toLocaleString() ?? '…'})</button>
        <button data-calendar-bucket="invalid" disabled={disabled || !layout} aria-expanded={bucket?.kind === 'invalid'}
          onClick={event => openBucket({ kind: 'invalid' }, event.detail === 0)}>Invalid dates ({layout?.invalid.count.toLocaleString() ?? '…'})</button>
        {layout && <span>{layout.scheduledRecords.toLocaleString()} {layout.scheduledRecords === 1 ? 'record' : 'records'} in this range · {layout.totalRecords.toLocaleString()} matching</span>}
      </div>
    </header>
    {layoutError && <p role="alert" className="form-error">{layoutError} <button disabled={disabled} onClick={onRefresh}>Reload calendar</button></p>}
    {!layout && !layoutError && <p role="status">Loading calendar…</p>}
    <div className={'calendar-content' + (bucket ? ' with-records' : '')}>
      <div className="calendar-month-scroll">
        <div role="grid" aria-label={calendarMonthLabel(month)} className="calendar-month" aria-busy={!layout && !layoutError}>
          <div role="row" className="calendar-weekdays">{['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day =>
            <span role="columnheader" key={day} title={day}>{day.slice(0, 3)}</span>)}</div>
          {Array.from({ length: 6 }, (_, week) => <div role="row" className="calendar-week" key={week}>
            {dates.slice(week * 7, week * 7 + 7).map((date, index) => {
              const day = layout?.days[week * 7 + index], selected = selectedDate === date;
              return <div role="gridcell" aria-selected={selected} data-calendar-date={date} key={date}
                className={'calendar-day' + (date.slice(0, 7) !== month ? ' adjacent-month' : '') + (selected ? ' selected-day' : '')}>
                <button className="calendar-day-heading" data-calendar-day={date} data-calendar-focus={'day:' + date}
                  aria-label={dayLabel(date, day?.count)} aria-current={date === today ? 'date' : undefined}
                  tabIndex={selected ? 0 : -1} disabled={disabled || !layout} onFocus={() => setSelectedDate(date)}
                  onClick={event => openBucket({ kind: 'day', date }, event.detail === 0)} onKeyDown={event => {
                    const next = calendarKeyboardDate(date, event.key);
                    if (!next) return;
                    event.preventDefault();
                    if (!dates.includes(next) || event.key === 'PageUp' || event.key === 'PageDown') moveMonth(next.slice(0, 7), next);
                    else { setSelectedDate(next); pendingDayFocus.current = next; }
                  }}>
                  <span>{Number(date.slice(-2))}</span><small>{day ? day.count || '' : '…'}</small>
                </button>
                <div className="calendar-previews">{day?.records.map(record => <button key={record.id} className="calendar-preview"
                  data-record-id={record.id} data-calendar-focus={'day:' + date + ':record:' + record.id}
                  title={recordText(primary, record) || '(Untitled record)'} tabIndex={selected ? 0 : -1} disabled={disabled}
                  onFocus={() => setSelectedDate(date)} onClick={() => onOpen(record)}>
                  {timestamp && <small>{Temporal.Instant.from(record.values[start.id] as string).toZonedDateTimeISO(view.calendar.timeZone).toPlainDate().toString() === date
                    ? time.format(new Date(record.values[start.id] as string)) : 'Continues'}</small>}
                  <span>{recordText(primary, record) ? <RecordValue field={primary} record={record} /> : '(Untitled record)'}</span>
                </button>)}</div>
                {!!day && day.count > day.records.length && <button className="calendar-more" tabIndex={selected ? 0 : -1} disabled={disabled}
                  onClick={event => openBucket({ kind: 'day', date }, event.detail === 0)}>+{(day.count - day.records.length).toLocaleString()} more</button>}
              </div>;
            })}
          </div>)}
        </div>
      </div>
      {bucket && <aside className="calendar-records" aria-label="Calendar records">
        <header><h3 ref={bucketHeading} tabIndex={-1}>{title}</h3><button aria-label="Close calendar records" onClick={closeBucket}>×</button></header>
        <p>{count === undefined ? 'Loading…' : count.toLocaleString() + (count === 1 ? ' record' : ' records')}</p>
        {creation && <><button disabled={disabled || !!creation.unavailable} onClick={() => { if (creation.values) onCreate(creation.values); }}>+ New record on this date</button>
          {creation.unavailable && <p className="form-note">{creation.unavailable}</p>}</>}
        {bucket.kind === 'unscheduled' && <p className="form-note">These records have no start date. Open a record to schedule it.</p>}
        {bucket.kind === 'invalid' && <p className="form-note">Check reversed date ranges or errors in calculated date fields.</p>}
        {pageError && <p role="alert" className="form-error">{pageError} <button disabled={disabled} onClick={onRefresh}>Reload calendar</button></p>}
        {count === 0 && <p>No matching records.</p>}
        {!!count && !page && !pageError && <p role="status">Loading records…</p>}
        {page?.records.map(record => <article className="calendar-record-card" key={record.id} data-record-id={record.id}>
          <button className="calendar-record-title" data-calendar-focus={'bucket:' + JSON.stringify(bucket) + ':record:' + record.id}
            disabled={disabled} onClick={() => onOpen(record)}>{recordText(primary, record) ? <RecordValue field={primary} record={record} /> : '(Untitled record)'}</button>
          <dl>{[start, ...(end && end.id !== start.id ? [end] : []), ...fields].map(field => <div key={field.id}>
            <dt>{field.name}</dt><dd>{(field.id === start.id || field.id === end?.id) && timestamp && record.values[field.id] && !record.formulaErrors?.[field.id]
              ? dateTime.format(new Date(record.values[field.id] as string)) : <RecordValue field={field} record={record} />}</dd></div>)}</dl>
        </article>)}
        {!!count && <nav aria-label="Calendar record pages" className="calendar-pagination">
          <button disabled={disabled || offset === 0} onClick={() => setPosition(Math.max(0, offset - calendarPageSize))}>Previous</button>
          <span>{offset + 1}–{Math.min(offset + calendarPageSize, count)} of {count}</span>
          <button disabled={disabled || offset + calendarPageSize >= count} onClick={() => setPosition(offset + calendarPageSize)}>Next</button>
        </nav>}
      </aside>}
    </div>
  </section>;
}
