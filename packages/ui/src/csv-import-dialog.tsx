import React, { useEffect, useState } from 'react';
import { maxCsvBytes, type CsvPreview, type Table } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';
import { fieldTypeNames } from './field-form.js';

export function CsvImportDialog({ initial, api, setDirty, onClose, onImported }: {
  initial: Table; api: WorkspaceApi; setDirty(value: boolean): void;
  onClose(): void; onImported(count: number): void;
}) {
  const [table, setTable] = useState(initial);
  const [source, setSource] = useState<{ csv: string }>();
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<Array<string | null>>();
  const [preview, setPreview] = useState<CsvPreview>();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [schemaConflict, setSchemaConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [columnPage, setColumnPage] = useState(0);
  const fields = table.fields.filter(field => field.type !== 'lookup');
  useEffect(() => () => setDirty(false), [setDirty]);
  const resetPreview = () => { setPreview(undefined); setMapping(undefined); setChecked(false); setColumnPage(0); };
  const fail = (error: unknown) => {
    setError(error instanceof Error ? error.message : 'The CSV operation failed.');
    setSchemaConflict(error instanceof ApiFailure && error.code === 'SCHEMA_CONFLICT');
    setChecked(false);
  };
  const readFile = async (file: File | undefined) => {
    setSource(undefined);
    resetPreview();
    setError(undefined);
    if (!file) return;
    setBusy(true);
    setDirty(true);
    try {
      if (file.size > maxCsvBytes) throw new Error('Choose a CSV file up to 32 MiB.');
      const bytes = await file.arrayBuffer();
      let csv: string;
      try { csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('This file is not valid UTF-8. Export it as UTF-8 CSV, then choose it again.'); }
      setSource({ csv });
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const inspect = async () => {
    setBusy(true);
    setError(undefined);
    setChecked(false);
    try {
      const result = await api.previewCsv(table.id, { expectedVersion: table.version, csv: source!.csv, hasHeader,
        ...(mapping ? { mapping } : {}) });
      setPreview(result);
      setMapping(result.mapping);
      setChecked(true);
      setSchemaConflict(false);
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const importRows = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.importCsv(table.id, { expectedVersion: table.version, csv: source!.csv, hasHeader, mapping: mapping! });
      setDirty(false);
      onImported(result.imported);
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.status >= 500) {
        setUncertain(true);
        setChecked(false);
        setError('The connection failed before the import result was confirmed. Close this dialog and inspect the reloaded table before importing again; the records may already be saved.');
      } else fail(error);
      setBusy(false);
    }
  };
  const reloadSchema = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setTable(await api.getTable(table.id));
      resetPreview();
      setSchemaConflict(false);
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const start = columnPage * 10;
  const visibleColumns = preview?.columns.slice(start, start + 10) ?? [];
  return <Dialog title="Import CSV" wide busy={busy} onClose={onClose}>
    <p>Append records to <strong>{table.name}</strong>. Match columns to your fields, then check the preview before importing.</p>
    <label className="form-field">CSV file<input type="file" accept=".csv,text/csv" disabled={busy}
      onChange={event => { void readFile(event.target.files?.[0]); }} /></label>
    <label className="check-field"><input type="checkbox" checked={hasHeader} disabled={busy}
      onChange={event => { setHasHeader(event.target.checked); resetPreview(); setError(undefined); }} />First row contains column names</label>
    <p className="form-note">UTF-8 · Up to 32 MiB · Unmapped fields use their defaults. Empty cells are null; quoted empty text stays empty.</p>
    {preview && mapping && <>
      <div className="csv-column-pages"><strong>Column mapping</strong>
        <span>{start + 1}–{Math.min(start + 10, preview.columns.length)} of {preview.columns.length}</span>
        <button disabled={busy || columnPage === 0} onClick={() => setColumnPage(page => page - 1)}>Previous columns</button>
        <button disabled={busy || start + 10 >= preview.columns.length} onClick={() => setColumnPage(page => page + 1)}>Next columns</button>
      </div>
      <div className="csv-mapping">{visibleColumns.map((column, offset) => {
        const index = start + offset;
        return <label className="csv-column" key={index}><span>{index + 1}. {column || '(empty heading)'}</span>
          <select aria-label={`Map column ${index + 1}`} value={mapping[index] ?? ''} disabled={busy}
            onChange={event => {
              setMapping(current => current!.map((id, position) => position === index ? event.target.value || null : id));
              setChecked(false);
              setError(undefined);
            }}>
            <option value="">Skip column</option>
            {fields.map(field => <option key={field.id} value={field.id}
              disabled={mapping.includes(field.id) && mapping[index] !== field.id}>{table.fields.indexOf(field) + 1}. {field.name} · {fieldTypeNames[field.type]}{field.required ? ' · Required' : ''}</option>)}
          </select></label>;
      })}</div>
      <p role="status">{checked ? `${preview.total.toLocaleString()} ${preview.total === 1 ? 'row' : 'rows'} · ${preview.invalid.toLocaleString()} invalid`
        : 'Mapping changed. Preview again before importing.'}</p>
      {checked && !preview.validated && <p className="form-note">Map at least one column, then preview again to validate its values.</p>}
      <div className="csv-sample-scroll"><table className="csv-samples"><caption>First {preview.samples.length} rows · long values shortened</caption>
        <thead><tr><th>Row</th>{visibleColumns.map((name, index) => <th key={index}>{name || '(empty heading)'}</th>)}</tr></thead>
        <tbody>{preview.samples.map(sample => <tr key={sample.row}><th>{sample.row}</th>{visibleColumns.map((_, offset) => {
          const value = sample.cells[start + offset];
          return <td key={offset}>{value === null ? <em>Null</em> : value === '' ? <em>Empty text</em> : value ?? <em>Missing cell</em>}</td>;
        })}</tr>)}</tbody>
      </table></div>
      {checked && preview.issues.length > 0 && <div className="form-error" role="alert">
        <p>Fix invalid values in the source file, or change the mapping and preview again. No records have been imported.</p>
        <ul>{preview.issues.map(issue => <li key={issue.row}>Row {issue.row}: {issue.message}</li>)}</ul>
        {preview.invalid > preview.issues.length && <p>Showing the first {preview.issues.length} errors.</p>}
      </div>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {schemaConflict && <button disabled={busy} onClick={() => void reloadSchema()}>Reload schema</button>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>{uncertain ? 'Close and reload' : 'Cancel'}</button>
      <button disabled={busy || !source || schemaConflict || uncertain} onClick={() => void inspect()}>{busy ? 'Working…' : 'Preview CSV'}</button>
      <button className="primary" disabled={busy || !checked || !preview?.validated || preview.invalid > 0 || !preview.total || schemaConflict || uncertain}
        onClick={() => void importRows()}>Import {preview ? `${preview.total.toLocaleString()} ${preview.total === 1 ? 'record' : 'records'}` : 'records'}</button></div>
  </Dialog>;
}
