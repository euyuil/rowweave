import React, { useState } from 'react';
import type { GridView, Table } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import type { TableHost } from './table-app.js';
import { Dialog } from './dialog.js';

export function CsvExportDialog({ table, view, search, api, host, onClose }: {
  table: Table; view: GridView; search: string; api: WorkspaceApi; host: TableHost; onClose(): void;
}) {
  const [scope, setScope] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const csv = await api.exportCsv(table.id, scope === 'view' ? { viewId: view.id, expectedViewVersion: view.version, search } : {});
      const saved = await host.saveCsv(scope === 'view' ? `${table.name}-${view.name}` : table.name, csv);
      setStatus(saved ? 'CSV saved.' : 'Save canceled. No file was written.');
    } catch (error) { setError(error instanceof Error ? error.message : 'The CSV could not be saved.'); }
    finally { setBusy(false); }
  };
  return <Dialog title="Export CSV" busy={busy} onClose={onClose}>
    <label className="form-field">Export scope<select aria-label="Export scope" value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setStatus(undefined); }}>
      <option value="view">Current view: {view.name}</option><option value="table">Entire table: {table.name}</option>
    </select></label>
    <p>{scope === 'view' ? 'Export all matching records in the visible column order, with this view’s filters and sorting.'
      : 'Export every saved record and field in table order.'}</p>
    {scope === 'view' && search && <p>Search: <strong>{search}</strong></p>}
    <p className="form-note">UTF-8 CSV preserves full numeric values. Use your spreadsheet’s text import settings for dates, leading zeros, and formula-like text.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Close</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Exporting…' : 'Save CSV'}</button></div>
  </Dialog>;
}
