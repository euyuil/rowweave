import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createWorkspaceClient, type Connection } from '../../../packages/client/src/http-client.js';
import { WorkspaceApp } from '../../../packages/ui/src/workspace-app.js';
import type { TableHost } from '../../../packages/ui/src/table-app.js';
import { Dialog } from '../../../packages/ui/src/dialog.js';

export interface WorkspaceSession {
  getConnection(): Connection | undefined;
  setConnection(connection: Connection): void;
  setDirty(value: boolean): void;
}

export function HarnessWorkspace({ session }: { session: WorkspaceSession }) {
  const [connection, setConnection] = useState(session.getConnection);
  const [settings, setSettings] = useState(false);
  const api = useMemo(() => connection ? createWorkspaceClient(connection) : undefined, [connection]);
  const host = useMemo<TableHost>(() => ({
    confirmDiscard: async () => window.confirm('Discard your unsaved RowWeave edits?'),
    setDirty: async value => session.setDirty(value),
    onServiceExit: () => () => {},
    saveCsv: async (name, csv) => {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return 'download-started';
    },
  }), [session]);
  const connected = (value: Connection) => {
    session.setConnection(value);
    setConnection(value);
    setSettings(false);
  };
  return <div className="rowweave-harness">
    {api && connection ? <WorkspaceApp api={api} host={host} workspaceLabel={connection.url} onConnectionSettings={() => setSettings(true)}>
      {settings && <Dialog title="RowWeave connection" onClose={() => setSettings(false)}><ConnectionForm current={connection} onConnected={connected} onCancel={() => setSettings(false)} /></Dialog>}
    </WorkspaceApp> : <main className="rowweave-app"><section className="harness-connect">
      <h1>Connect your RowWeave workspace</h1>
      <p>Use your running RowWeave service to organize tables, records and views here.</p>
      <ConnectionForm onConnected={connected} />
    </section></main>}
  </div>;
}

function ConnectionForm({ current, onConnected, onCancel }: { current?: Connection; onConnected(connection: Connection): void; onCancel?(): void }) {
  const [url, setUrl] = useState(current?.url ?? 'http://127.0.0.1:4317');
  const [token, setToken] = useState(current?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController>();
  useEffect(() => () => pending.current?.abort(), []);
  const connect = async () => {
    if (busy) return;
    let endpoint: URL;
    try { endpoint = new URL(url); }
    catch { setError('Enter a valid HTTP or HTTPS service URL.'); return; }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      setError('Use an HTTP or HTTPS URL without credentials, query parameters or a fragment.'); return;
    }
    if (!/^[\x21-\x7e]{32,}$/.test(token)) { setError('Enter the service token: at least 32 printable ASCII characters without spaces.'); return; }
    setBusy(true);
    setError(undefined);
    const connection = { url: endpoint.href.replace(/\/$/, ''), token };
    const controller = new AbortController();
    pending.current = controller;
    try {
      await createWorkspaceClient(connection, (input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      })).listTables();
      if (!controller.signal.aborted) onConnected(connection);
    } catch {
      if (!controller.signal.aborted) setError('Could not connect. Check the service URL, token, HTTPS settings and allowed browser origin.');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <form onSubmit={event => { event.preventDefault(); void connect(); }}>
    <label className="form-field">Service URL<input type="url" required value={url} onChange={event => setUrl(event.target.value)} disabled={busy} /></label>
    <label className="form-field">Service token<input type="password" required autoComplete="off" value={token} onChange={event => setToken(event.target.value)} disabled={busy} /></label>
    <p className="form-note">Credentials stay in this page's memory. Reconnect after reloading Harness. Save edits before disabling the plugin.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button></div>
  </form>;
}
