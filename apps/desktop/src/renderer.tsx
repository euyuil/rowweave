import React from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceClient, type Connection } from '../../../packages/client/src/http-client.js';
import { WorkspaceApp } from '../../../packages/ui/src/workspace-app.js';
import type { TableHost } from '../../../packages/ui/src/table-app.js';

declare global {
  interface Window {
    rowweave: TableHost & {
      connection(): Promise<Connection>;
    };
  }
}

const root = createRoot(document.getElementById('root')!);
try {
  const connection = await window.rowweave.connection();
  root.render(<WorkspaceApp api={createWorkspaceClient(connection)} host={window.rowweave} />);
} catch {
  root.render(<main role="alert">RowWeave could not connect to its data service. Please restart the application.</main>);
}
