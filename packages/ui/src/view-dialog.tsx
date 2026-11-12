import React, { useEffect, useState } from 'react';
import type { GridView, RowHeight, SortRule, Table, ViewColumn } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';
import { QueryEditor } from './query-editor.js';
import { filterDraft, filterValue } from './filter-draft.js';

export function ViewDialog({ kind, view, search, table, api, setDirty, onClose, onSaved }: {
  kind: 'create' | 'edit' | 'delete' | 'query' | 'display'; view: GridView; search: string; table: Table; api: WorkspaceApi;
  setDirty(value: boolean): void; onClose(): void; onSaved(view: GridView | undefined): void;
}) {
  const [name, setName] = useState(kind === 'create' ? 'New view' : view.name);
  const [savedSearch, setSavedSearch] = useState(search);
  const [columns, setColumns] = useState<ViewColumn[]>(view.columns);
  const [rowHeight, setRowHeight] = useState<RowHeight>(view.rowHeight);
  const [frozenColumns, setFrozenColumns] = useState(view.frozenColumns);
  const [type, setType] = useState(view.type);
  const [groupBy, setGroupBy] = useState(view.groupBy ?? table.fields.find(field => field.type === 'singleSelect')?.id ?? '');
  const [filter, setFilter] = useState(() => filterDraft(view.query.filter, table.fields));
  const [sort, setSort] = useState<SortRule[]>(view.query.sort ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const deleting = kind === 'delete';
  const queryOnly = kind === 'query';
  const displayOnly = kind === 'display';
  const visibleCount = columns.filter(column => !column.hidden).length;
  const fields = new Map(table.fields.map(field => [field.id, field]));
  useEffect(() => () => setDirty(false), [setDirty]);
  const move = (index: number, delta: number) => {
    const next = [...columns];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    setColumns(next);
    setDirty(true);
  };
  return <Dialog title={kind === 'create' ? 'Create view' : deleting ? 'Delete view' : queryOnly ? 'Filter and sort' : displayOnly ? 'Display settings' : 'View settings'} onClose={onClose} busy={busy} wide={!deleting}>
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
        const config = { name, ...display, type, ...(type === 'board' ? { groupBy } : {}), query: { filter: filterValue(filter, table.fields), sort, search: savedSearch } };
        if (deleting) await api.deleteView(table.id, view.id, view.version);
        else if (kind === 'create') result = await api.createView(table.id, config);
        else result = await api.updateView(table.id, view.id, { ...(queryOnly ? { query: config.query } : displayOnly ? display : config), expectedVersion: view.version });
        setDirty(false);
        onSaved(result);
      })().catch(error => { setError(error instanceof Error ? error.message : 'The view could not be saved.'); setBusy(false); });
    }}>
      {deleting ? <p>Delete <strong>{view.name}</strong>? Its records remain in the table.</p> : <fieldset disabled={busy}>
        {!queryOnly && !displayOnly && <><label className="form-field">View name<input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
          <div className="form-row"><label className="form-field">View type<select aria-label="View type" value={type} onChange={event => setType(event.target.value as GridView['type'])}>
            <option value="grid">Grid</option><option value="board">Board</option>
          </select></label>
          {type === 'board' && <label className="form-field">Group by<select aria-label="Board group field" required value={groupBy} onChange={event => setGroupBy(event.target.value)}>
            <option value="" disabled>Choose a single-select field</option>{table.fields.filter(field => field.type === 'singleSelect').map(field => <option key={field.id} value={field.id}>{field.name}</option>)}
          </select></label>}</div>
          {type === 'board' && !groupBy && <p className="form-note">Add a single-select field to use a board view.</p>}
        </>}
        {!displayOnly && <><label className="form-field">Saved search<input value={savedSearch} onChange={event => setSavedSearch(event.target.value)} /></label>
        <QueryEditor fields={table.fields} filter={filter} sort={sort}
          onFilter={value => { setFilter(value); setDirty(true); }} onSort={value => { setSort(value); setDirty(true); }} /></>}
        {!queryOnly && <><h3>Display</h3>
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
        <h3>Columns</h3>
        <p className="form-note">{type === 'board' ? 'Cards show the first three visible fields besides their title and grouping field. Open a card to see every field.'
          : 'Choose the fields and their order in this view. Hidden fields remain in each record.'}</p>
        <div>{columns.map((column, index) => {
          const field = fields.get(column.fieldId)!;
          return <div className="view-column" role="group" aria-label={field.name} key={field.id}>
            <label className="check-field"><input type="checkbox" checked={!column.hidden} aria-label={`Show ${field.name}`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, hidden: !event.target.checked } : item))} />{field.name}</label>
            <label className="column-width">Width<input type="number" min={50} max={1000} step={1} required value={column.width} aria-label={`${field.name} width`}
              onChange={event => setColumns(current => current.map(item => item.fieldId === field.id ? { ...item, width: Number(event.target.value) } : item))} /></label>
            <button type="button" disabled={index === 0} aria-label={`Move ${field.name} up`} onClick={event => { move(index, -1); event.currentTarget.parentElement!.querySelector('input')!.focus(); }}>↑</button>
            <button type="button" disabled={index === columns.length - 1} aria-label={`Move ${field.name} down`} onClick={event => { move(index, 1); event.currentTarget.parentElement!.querySelector('input')!.focus(); }}>↓</button>
          </div>;
        })}</div>
        {columns.every(column => column.hidden) && <p className="form-error">Keep at least one field visible.</p>}</>}
      </fieldset>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={busy || (!deleting && (columns.every(column => column.hidden) || (type === 'board' && !groupBy)))}>
          {busy ? 'Working…' : deleting ? 'Delete view' : kind === 'create' ? 'Create view' : 'Save view'}</button></div>
    </form>
  </Dialog>;
}
