import React, { useEffect, useState } from 'react';
import { groupFieldIds, maxGroupLevels, supportsScalarGrouping, valueField, type GridView, type RowHeight, type SortRule, type SummaryMeasure, type Table, type ViewColumn } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog, type DialogAnchor } from './dialog.js';
import { QueryEditor } from './query-editor.js';
import { filterDraft, filterValue } from './filter-draft.js';

export function ViewDialog({ kind, view, search, table, api, setDirty, onClose, onSaved, anchor }: {
  kind: 'create' | 'edit' | 'delete' | 'filter' | 'sort' | 'display' | 'group'; view: GridView; search: string; table: Table; api: WorkspaceApi;
  anchor?: DialogAnchor | undefined;
  setDirty(value: boolean): void; onClose(): void; onSaved(view: GridView | undefined): void;
}) {
  const [name, setName] = useState(kind === 'create' ? 'New view' : view.name);
  const [savedSearch, setSavedSearch] = useState(search);
  const [columns, setColumns] = useState<ViewColumn[]>(view.columns);
  const [rowHeight, setRowHeight] = useState<RowHeight>(view.rowHeight);
  const [frozenColumns, setFrozenColumns] = useState(view.frozenColumns);
  const [type, setType] = useState(view.type);
  const calendarFields = table.fields.filter(field => ['date', 'datetime'].includes(valueField(field).type));
  const [calendarStart, setCalendarStart] = useState(view.calendar?.startFieldId ?? calendarFields[0]?.id ?? '');
  const [calendarEnd, setCalendarEnd] = useState(view.calendar?.endFieldId ?? '');
  const [calendarZone, setCalendarZone] = useState(view.calendar?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const startType = calendarFields.find(field => field.id === calendarStart);
  const endFields = calendarFields.filter(field => startType && valueField(field).type === valueField(startType).type);
  const [groupBy, setGroupBy] = useState([...groupFieldIds(view.groupBy)]);
  const [groupMeasures, setGroupMeasures] = useState<SummaryMeasure[]>(view.groupMeasures ?? []);
  const [filter, setFilter] = useState(() => filterDraft(view.query.filter, table.fields));
  const [sort, setSort] = useState<SortRule[]>(view.query.sort ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleting = kind === 'delete';
  const queryOnly = kind === 'filter' || kind === 'sort';
  const displayOnly = kind === 'display';
  const groupOnly = kind === 'group';
  const visibleCount = columns.filter(column => !column.hidden).length;
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const numericFields = table.fields.filter(field => valueField(field).type === 'number');
  const groupFields = table.fields.filter(supportsScalarGrouping);
  const nextGroup = groupFields.find(field => !groupBy.includes(field.id));
  useEffect(() => () => setDirty(false), [setDirty]);
  const move = (index: number, delta: number) => {
    const next = [...columns];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    setColumns(next);
    setDirty(true);
  };
  return <Dialog title={kind === 'create' ? 'Create view' : deleting ? 'Delete view' : kind === 'filter' ? 'Filters' : kind === 'sort' ? 'Sort' : groupOnly ? 'Groups' : displayOnly ? 'Display settings' : 'View settings'} onClose={onClose} busy={busy} wide={!deleting} anchor={queryOnly || groupOnly ? anchor : undefined}>
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
        const display = { columns, rowHeight, frozenColumns: Math.min(frozenColumns, visibleCount) };
        const groups = { groupBy: groupBy.length > 1 ? groupBy : groupBy[0] ?? null,
          groupMeasures: type === 'grid' && groupBy.length ? groupMeasures : [] };
        const config = { name, ...display, type, ...groups,
          ...(type === 'calendar' ? { calendar: { startFieldId: calendarStart, ...(calendarEnd ? { endFieldId: calendarEnd } : {}), timeZone: calendarZone } } : {}),
          query: { filter: filterValue(filter, table.fields), sort, search: savedSearch } };
        if (deleting) await api.deleteView(table.id, view.id, view.version);
        else if (kind === 'create') result = await api.createView(table.id, config);
        else result = await api.updateView(table.id, view.id, { ...(queryOnly ? { query: { ...view.query,
          ...(kind === 'filter' ? { filter: config.query.filter } : { sort }) } } : groupOnly ? groups : displayOnly ? display : config), expectedVersion: view.version });
        setDirty(false);
        onSaved(result);
      })().catch(error => { setError(error instanceof Error ? error.message : 'The view could not be saved.'); setBusy(false); });
    }}>
      {deleting ? <p>Delete <strong>{view.name}</strong>? Its records remain in the table.</p> : <fieldset disabled={busy}>
        {!queryOnly && !displayOnly && !groupOnly && <><label className="form-field">View name<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
          <div className="form-row"><label className="form-field">View type<select aria-label="View type" value={type} onChange={event => {
            setType(event.target.value as GridView['type']);
            const boardGroup = table.fields.find(field => field.type === 'singleSelect');
            setGroupBy(event.target.value === 'board' && boardGroup ? [boardGroup.id] : []);
          }}>
            <option value="grid">Grid</option><option value="board">Board</option><option value="calendar">Calendar</option>
          </select></label>
          {type === 'board' && <label className="form-field">Group by<select aria-label="Board group field" required value={groupBy[0] ?? ''} onChange={event => setGroupBy([event.target.value])}>
            <option value="" disabled>Choose a single-select field</option>{table.fields.filter(field => field.type === 'singleSelect').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>}</div>
          {type === 'board' && !groupBy.length && <p className="form-note">Add a single-select field to use a board view.</p>}
          {type === 'calendar' && <><h3>Calendar dates</h3><div className="form-row">
            <label className="form-field">Start field<select aria-label="Calendar start field" required value={calendarStart} onChange={event => {
              const next = calendarFields.find(field => field.id === event.target.value)!;
              setCalendarStart(next.id);
              if (calendarEnd && valueField(calendarFields.find(field => field.id === calendarEnd)!).type !== valueField(next).type) setCalendarEnd('');
            }}><option value="" disabled>Choose a date or timestamp field</option>{calendarFields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label>
            <label className="form-field">End field<select aria-label="Calendar end field" value={calendarEnd} onChange={event => setCalendarEnd(event.target.value)}>
              <option value="">No end field</option>{endFields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label>
          </div><label className="form-field">Time zone<input aria-label="Calendar time zone" required value={calendarZone} onChange={event => setCalendarZone(event.target.value)} placeholder="Asia/Shanghai" /></label>
          <p className="form-note">Dates include the end day. Timestamp ranges exclude the end instant; empty or equal ends are points. Records without a start date or with invalid ranges have separate lists.</p>
          {!calendarFields.length && <p className="form-note">Add a date or timestamp field in Manage fields before creating a calendar.</p>}</>}
        </>}
        {type === 'grid' && (groupOnly || (!queryOnly && !displayOnly)) && <>
          {(groupBy.length ? groupBy : ['']).map((id, index) => <div className="form-row group-level-row" key={index}>
            <label className="form-field">{index ? 'Then by' : 'Group by'}<select aria-label={index ? `Grid group field ${index + 1}` : 'Grid group field'} value={id}
              onChange={event => setGroupBy(event.target.value ? index === groupBy.length ? [...groupBy, event.target.value]
                : groupBy.map((current, position) => position === index ? event.target.value : current) : [])}>
              {index === 0 && <option value="">No grouping</option>}{groupFields.filter(field => field.id === id || !groupBy.includes(field.id)).map(field =>
                <option key={field.id} value={field.id}>{field.name}</option>)}
            </select></label>
            {groupBy.length > 1 && <>
              <button type="button" disabled={index === 0} aria-label={`Move group ${index + 1} up`} onClick={() => {
                setGroupBy(current => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; }); setDirty(true);
              }}>↑</button>
              <button type="button" aria-label={`Remove group ${index + 1}`} onClick={() => {
                setGroupBy(current => current.filter((_, position) => position !== index)); setDirty(true);
              }}>Remove</button>
            </>}
          </div>)}
          {!!groupBy.length && <button type="button" disabled={groupBy.length === maxGroupLevels || !nextGroup} onClick={() => {
            setGroupBy(current => [...current, nextGroup!.id]); setDirty(true);
          }}>Add grouping level</button>}
          <p className="form-note">Nest up to three fields in order. Empty values have their own group. Options follow their configured order; other values sort in ascending order. Sorting applies within the last level. Records move after saving. Collapse choices are remembered on this device, including children of collapsed parents.</p>
          {!!groupBy.length && <><h3>Group measures</h3>
            <p className="form-note">Show totals and other numeric measures in each heading. They include all saved records matching this view, even in collapsed groups. Hover a heading to read its full summary.</p>
            {groupMeasures.map((measure, index) => <div className="form-row group-measure-row" key={index}>
              <label className="form-field">Field<select aria-label={`Measure ${index + 1} field`} value={measure.fieldId}
                onChange={event => setGroupMeasures(current => current.map((item, position) => position === index ? { ...item, fieldId: event.target.value } : item))}>
                {numericFields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
              </select></label>
              <label className="form-field">Calculation<select aria-label={`Measure ${index + 1} calculation`} value={measure.operation}
                onChange={event => setGroupMeasures(current => current.map((item, position) => position === index ? { ...item, operation: event.target.value as SummaryMeasure['operation'] } : item))}>
                <option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option>
              </select></label>
              <button type="button" aria-label={`Remove measure ${index + 1}`} onClick={() => { setGroupMeasures(current => current.filter((_, position) => position !== index)); setDirty(true); }}>Remove</button>
            </div>)}
            <button type="button" disabled={!numericFields.length || groupMeasures.length === 12} onClick={() => {
              setGroupMeasures(current => [...current, { fieldId: numericFields[0]!.id, operation: 'sum' }]); setDirty(true);
            }}>Add measure</button>
            {!numericFields.length && <p className="form-note">Add a numeric field to calculate group measures.</p>}
          </>}
        </>}
        {!displayOnly && !groupOnly && <>{!queryOnly && <label className="form-field">Saved search<input value={savedSearch} onChange={event => setSavedSearch(event.target.value)} /></label>}
        <QueryEditor fields={table.fields} filter={filter} sort={sort} section={queryOnly ? kind : undefined}
          onFilter={value => { setFilter(value); setDirty(true); }} onSort={value => { setSort(value); setDirty(true); }} /></>}
        {!queryOnly && !groupOnly && <><h3>Display</h3>
        {type === 'grid' && <><div className="form-row">
          <label className="form-field">Row density<select aria-label="Row density" value={rowHeight} onChange={event => setRowHeight(Number(event.target.value) as RowHeight)}>
            <option value={36}>Compact</option><option value={48}>Comfortable</option><option value={64}>Spacious</option>
          </select></label>
          <label className="form-field">Frozen columns<select aria-label="Frozen columns" value={Math.min(frozenColumns, visibleCount)} onChange={event => setFrozenColumns(Number(event.target.value))}>
            <option value={0}>None</option>{Array.from({ length: visibleCount }, (_, index) => <option key={index + 1} value={index + 1}>
              {index === 0 ? 'First column' : `First ${index + 1} columns`}</option>)}
          </select></label>
        </div>
        <p className="form-note">Keep leading columns visible while you scroll horizontally. These settings apply only to this view.</p></>}
        <h3>{type === 'grid' ? 'Columns' : 'Card fields'}</h3>
        <p className="form-note">{type === 'calendar' ? 'Calendar previews use the primary display field as their title. The record list shows the first three visible fields besides the title and calendar dates. Open a record to see every field.'
          : type === 'board' ? 'Cards show the first three visible fields besides their title and grouping field. Open a card to see every field.'
          : 'Choose the fields and their order in this view. Hidden fields remain in each record.'}</p>
        <div>{columns.map((column, index) => {
          const field = fields.get(column.fieldId)!;
          return <div className="view-column" role="group" aria-label={field.name} key={field.id}>
            <label className="check-field"><input type="checkbox" checked={!column.hidden} aria-label={`Show ${field.name}`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, hidden: !event.target.checked } : item))} />{field.name}</label>
            {type === 'grid' && <label className="column-width">Width<input type="number" min={50} max={1000} step={1} required value={column.width} aria-label={`${field.name} width`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, width: Number(event.target.value) } : item))} /></label>}
            <button type="button" disabled={index === 0} aria-label={`Move ${field.name} up`} onClick={event => { move(index, -1); event.currentTarget.parentElement!.querySelector('input')!.focus(); }}>↑</button>
            <button type="button" disabled={index === columns.length - 1} aria-label={`Move ${field.name} down`} onClick={event => { move(index, 1); event.currentTarget.parentElement!.querySelector('input')!.focus(); }}>↓</button>
          </div>;
        })}</div>
        {columns.every(column => column.hidden) && <p className="form-error">Keep at least one field visible.</p>}</>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy || (!deleting && (columns.every(column => column.hidden) || (type === 'board' && !groupBy.length) || (type === 'calendar' && !calendarStart)))}>
          {busy ? 'Working…' : deleting ? 'Delete view' : kind === 'create' ? 'Create view' : 'Save view'}</button></div>
    </form>
  </Dialog>;
}
