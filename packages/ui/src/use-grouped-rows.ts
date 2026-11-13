import { useEffect, useMemo, useRef, useState } from 'react';
import { groupFieldIds, valueField, type GridView, type QueryPage, type Table } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import { ApiFailure, type WorkspaceApi } from '../../client/src/http-client.js';
import { GroupReader } from '../../client/src/group-reader.js';
import type { GroupRows } from '../../client/src/group-rows.js';
import { pruneGroupChoice, readGroupPreference, writeGroupPreference, type GroupChoice, type GroupPreference } from './group-preferences.js';

const emptyCollapse: GroupChoice = { defaultCollapsed: false, exceptions: [] };
const snapshotKey = (model: TableModel, view: GridView | undefined, search: string) =>
  JSON.stringify([view?.id, view?.version, model.queryVersion, model.table?.version, model.dataRevision, model.dateContext, search]);
const collapseKey = (table: Table, view: GridView) => {
  const types = groupFieldIds(view.groupBy).map(id => valueField(table.fields.find(field => field.id === id)!).type);
  return JSON.stringify([view.id, view.groupBy, types.length === 1 ? types[0] : types]);
};
interface PreparedGroups { key: string; reader: GroupReader; rows: GroupRows; choice: GroupChoice }

export function useGroupedRows(model: TableModel, api: WorkspaceApi, view: GridView | undefined, search: string,
  visible: { y: number; height: number }) {
  const table = model.table, revision = model.dataRevision, dateContext = model.dateContext;
  const enabled = view?.type === 'grid' && !!view.groupBy;
  const ready = !!table && groupFieldIds(view?.groupBy).every(id => table.fields.some(field => field.id === id));
  const key = snapshotKey(model, view, search);
  const [collapsed, setCollapsed] = useState(new Map<string, GroupChoice>());
  const preferences = useRef(new Map<string, GroupPreference>());
  const [prepared, setPrepared] = useState<PreparedGroups>();
  const [failure, setFailure] = useState<{ key: string; message: string; stale: boolean }>();
  const preparedRef = useRef(prepared); preparedRef.current = prepared;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const choiceFor = (nextTable: Table, nextView: GridView) => {
    const namespace = collapseKey(nextTable, nextView);
    const definitions = groupFieldIds(nextView.groupBy).map(id => nextTable.fields.find(field => field.id === id)!);
    let remembered = preferences.current.get(namespace);
    if (!remembered) {
      remembered = readGroupPreference(namespace, definitions, localStorage);
      preferences.current.set(namespace, remembered);
    }
    return pruneGroupChoice(definitions, collapsed.get(namespace) ?? remembered.choice);
  };
  const choice = useMemo(() => enabled && ready && table && view ? choiceFor(table, view) : emptyCollapse,
    [enabled, ready, table, view, collapsed]);
  const latest = useRef({ key, choice }); latest.current = { key, choice };
  const replace = (candidate: { reader: GroupReader; rows: GroupRows }, nextKey: string) => {
    const previous = preparedRef.current;
    if (previous?.reader !== candidate.reader) previous?.reader.dispose();
    const next = { ...candidate, key: nextKey, choice: candidate.reader.context.collapse };
    preparedRef.current = next; setPrepared(next); setFailure(undefined);
    const namespace = collapseKey(candidate.reader.context.table, candidate.reader.context.view);
    if (preferences.current.get(namespace)?.choice !== next.choice) {
      preferences.current.set(namespace, writeGroupPreference(namespace, next.choice, localStorage));
    }
    setCollapsed(current => current.get(namespace) === next.choice ? current : new Map(current).set(namespace, next.choice));
  };
  useEffect(() => () => preparedRef.current?.reader.dispose(), []);
  useEffect(() => {
    if (!enabled || !ready || !table || !view || revision === undefined ||
        (preparedRef.current?.key === key && preparedRef.current.choice === choice)) return;
    const controller = new AbortController();
    const reader = new GroupReader(api, { table, view, revision, ...(dateContext ? { dateContext } : {}), search, collapse: choice });
    const start = preparedRef.current?.key === key ? visibleRef.current.y : 0;
    void reader.readWindow(start, visibleRef.current.height + 5, controller.signal).then(rows => {
      if (!controller.signal.aborted && latest.current.key === key && latest.current.choice === choice) replace({ reader, rows }, key);
    }).catch(error => {
      if (controller.signal.aborted || latest.current.key !== key || latest.current.choice !== choice) return;
      setFailure({ key, message: error instanceof Error ? error.message : 'Could not load groups.',
        stale: error instanceof ApiFailure && ['DATA_CHANGED', 'SCHEMA_CONFLICT', 'VIEW_CONFLICT'].includes(error.code) });
      const previous = preparedRef.current;
      if (previous?.key === key) setCollapsed(current => new Map(current).set(collapseKey(table, view), previous.choice));
    });
    return () => { controller.abort(); if (preparedRef.current?.reader !== reader) reader.dispose(); };
  }, [api, model, key, enabled, ready, choice]);

  const current = enabled && prepared?.key === key ? prepared : undefined;
  const pending = enabled && (!current || current.choice !== choice);
  const preference = enabled && ready && table && view ? preferences.current.get(collapseKey(table, view)) : undefined;
  return { enabled, rows: current?.rows, reader: current?.reader, pending,
    error: (enabled && failure?.key === key ? failure.message : undefined) ?? preference?.error,
    stale: enabled && failure?.key === key && failure.stale,
    collapse: (next: GroupChoice) => setCollapsed(current => new Map(current).set(collapseKey(table!, view!), next)),
    choice,
    commitWindow: (reader: GroupReader, rows: GroupRows) => {
      const previous = preparedRef.current;
      if (previous?.reader !== reader || previous.key !== latest.current.key || previous.choice !== latest.current.choice || previous.rows === rows) return;
      const next = { ...previous, rows }; preparedRef.current = next; setPrepared(next);
    },
    prepareRefresh: async (nextTable: Table, nextView: GridView, first: QueryPage, nextSearch: string,
      signal: AbortSignal, start: number, count: number) => {
      const reader = new GroupReader(api, { table: nextTable, view: nextView, revision: first.revision,
        ...(first.dateContext ? { dateContext: first.dateContext } : {}), search: nextSearch, collapse: choiceFor(nextTable, nextView) });
      try { return { reader, rows: await reader.readWindow(start, count, signal) }; }
      catch (error) { reader.dispose(); throw error; }
    },
    commitRefresh: (candidate: { reader: GroupReader; rows: GroupRows }, nextView: GridView, nextSearch: string) =>
      replace(candidate, snapshotKey(model, nextView, nextSearch)),
  };
}
