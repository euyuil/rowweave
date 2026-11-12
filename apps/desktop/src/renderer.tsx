import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceClient, type Connection } from '../../../packages/client/src/http-client.js';
import { WorkspaceApp } from '../../../packages/ui/src/workspace-app.js';
import type { TableHost } from '../../../packages/ui/src/table-app.js';
import type { ConnectionChoice, DesktopConnectionState } from './connection-types.js';
import { ConnectionDialog } from './connection-dialog.js';

declare global {
  interface Window {
    rowweave: TableHost & {
      connection(): Promise<Connection>;
      connectionState(): Promise<DesktopConnectionState>;
      connect(choice: ConnectionChoice): Promise<DesktopConnectionState>;
    };
  }
}

function DesktopApp() {
  const [state, setState] = useState<DesktopConnectionState>();
  const [generation, setGeneration] = useState(0);
  const [settings, setSettings] = useState(false);
  const api = useMemo(() => state?.connection ? createWorkspaceClient(state.connection) : undefined, [state?.connection]);
  useEffect(() => {
    void window.rowweave.connectionState().then(setState).catch((error: unknown) => {
      setState({ mode: 'local', error: error instanceof Error ? error.message : 'Could not load the workspace connection.' });
    });
  }, []);
  const dialog = settings && state && <ConnectionDialog current={state} onClose={() => setSettings(false)} onConnect={async choice => {
    const next = await window.rowweave.connect(choice);
    setState(next);
    setGeneration(value => value + 1);
    setSettings(false);
  }} />;
  return api ? <WorkspaceApp key={generation} api={api} host={window.rowweave}
    workspaceLabel={state?.mode === 'remote' ? 'Remote workspace' : 'Local workspace'} onConnectionSettings={() => setSettings(true)}>
    {dialog}
  </WorkspaceApp> : <main className="rowweave-app">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">▦</span> RowWeave</div></header>
    <section className="empty-workspace"><h1>{state ? 'Open your workspace' : 'Opening your workspace…'}</h1>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      {state && <button className="primary" onClick={() => setSettings(true)}>Connection</button>}
    </section>{dialog}
  </main>;
}

createRoot(document.getElementById('root')!).render(<DesktopApp />);
