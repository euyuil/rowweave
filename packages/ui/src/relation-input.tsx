import React, { useContext, useEffect, useState } from 'react';
import type { Field, QueryPage, RecordLink, RowRecord, Table } from '../../contracts/src/index.js';
import { cellText } from '../../client/src/cell-values.js';
import { WorkspaceContext } from './workspace-context.js';

export function RelationInput({ id, field, value, disabled, onChange }: {
  id: string; field: Field; value: string[] | null; disabled: boolean; onChange(value: string[], links: RecordLink[]): void;
}) {
  const api = useContext(WorkspaceContext)!;
  const targetId = field.relation!.tableId;
  const selected = value ?? [];
  const selectedKey = JSON.stringify(selected);
  const [table, setTable] = useState<Table>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QueryPage>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState<RowRecord>();
  const label = (record: RowRecord, target: Table) => record.formulaErrors?.[target.primaryFieldId] ? `#ERROR: ${record.formulaErrors[target.primaryFieldId]}`
    : cellText(target.fields.find(field => field.id === target.primaryFieldId)!, record.values[target.primaryFieldId]) || '(Untitled)';
  const change = (ids: string[]) => onChange(ids, ids.map(id => ({ id, label: labels[id] ?? id })));
  const checkSchema = (result: QueryPage, target: Table) => {
    if (result.schemaVersion !== target.version) throw new Error('The target schema changed. Reload records before continuing.');
    return result.records;
  };
  useEffect(() => {
    let active = true;
    void api.getTable(targetId).then(table => { if (active) setTable(table); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [api, targetId]);
  useEffect(() => {
    if (!table) return;
    const controller = new AbortController();
    const ids = JSON.parse(selectedKey) as string[];
    if (ids.length) void api.queryRecords(targetId, { recordIds: ids, fields: [table.primaryFieldId], limit: 200 }, controller.signal)
      .then(result => {
        const selectedLabels = Object.fromEntries(checkSchema(result, table).map(record => [record.id, label(record, table)]));
        setLabels(current => ({ ...current, ...selectedLabels }));
      })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [api, targetId, table, selectedKey]);
  useEffect(() => {
    if (!table || composing) return;
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      void api.queryRecords(targetId, { search, offset, limit: 50, fields: [table.primaryFieldId],
        ...(offset && page ? { expectedRevision: page.revision } : {}) }, controller.signal).then(result => {
        checkSchema(result, table);
        setPage(result);
        setLabels(current => ({ ...Object.fromEntries(Object.entries(current).filter(([id]) => selected.includes(id))),
          ...Object.fromEntries(result.records.map(record => [record.id, label(record, table)])) }));
        setError(undefined);
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, targetId, table, search, offset, composing]);
  return <div className="relation-input">
    <div className="linked-records">{selected.map(recordId => <div key={recordId}>
      <button type="button" disabled={disabled || !table} title={recordId} onClick={() => {
        void api.queryRecords(targetId, { recordIds: [recordId], limit: 1 }).then(result => {
          const record = checkSchema(result, table!)[0];
          if (!record) throw new Error('This record no longer exists.');
          setDetails(record);
        }).catch(error => setError(error.message));
      }}>{labels[recordId] ?? recordId}</button>
      <button type="button" disabled={disabled} aria-label={`Unlink ${labels[recordId] ?? recordId}`}
        onClick={() => change(selected.filter(id => id !== recordId))}>×</button>
    </div>)}</div>
    <input id={id} type="search" placeholder="Find records…" value={search} disabled={disabled}
      onChange={event => { setSearch(event.target.value); setOffset(0); setPage(undefined); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
    <div className="relation-results" aria-busy={busy}>{page?.records.map(record => <label key={record.id} title={record.id}>
      <input type="checkbox" disabled={disabled || busy || (!selected.includes(record.id) && selected.length >= 200)}
        checked={selected.includes(record.id)} onChange={event => change(event.target.checked
          ? field.relation!.multiple ? [...selected, record.id] : [record.id] : selected.filter(id => id !== record.id))} />
      {label(record, table!)}
    </label>)}</div>
    <div className="relation-pages"><button type="button" disabled={disabled || busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
      <small>{busy ? 'Loading…' : `${page?.total ?? 0} matching records`}</small>
      <button type="button" disabled={disabled || busy || !page || offset + 50 >= page.total} onClick={() => setOffset(offset + 50)}>Next</button></div>
    {error && <p role="alert">{error} <button type="button" onClick={() => {
      setOffset(0); setPage(undefined); setDetails(undefined); setTable(undefined); setLabels({});
      void api.getTable(targetId).then(setTable).catch(error => setError(error.message));
    }}>Reload records</button></p>}
    {details && table && <section className="linked-details" aria-label="Linked record details"><strong>{label(details, table)}</strong>
      <dl>{table.fields.map(field => <div key={field.id}><dt>{field.name}</dt><dd>{details.formulaErrors?.[field.id] ? `#ERROR: ${details.formulaErrors[field.id]}`
        : details.links?.[field.id]?.map(link => link.label).join(', ') ?? cellText(field, details.values[field.id])}</dd></div>)}</dl>
      <button type="button" onClick={() => setDetails(undefined)}>Close details</button></section>}
  </div>;
}
