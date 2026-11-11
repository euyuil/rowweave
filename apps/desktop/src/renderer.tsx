import React from 'react';
import { createRoot } from 'react-dom/client';
import { createHttpClient, type Connection } from '../../../packages/client/src/http-client.js';
import { TableModel } from '../../../packages/client/src/table-model.js';
import { TableApp } from '../../../packages/ui/src/table-app.js';

declare global {
  interface Window {
    rowweave: {
      connection(): Promise<Connection>;
      confirmDiscard(): Promise<boolean>;
      setDirty(value: boolean): Promise<void>;
      onServiceExit(listener: () => void): () => void;
    };
  }
}

const root = createRoot(document.getElementById('root')!);
try {
  const connection = await window.rowweave.connection();
  const model = new TableModel(createHttpClient(connection));
  root.render(<TableApp model={model} host={window.rowweave} />);
} catch {
  root.render(<main role="alert">RowWeave could not connect to its data service. Please restart the application.</main>);
}
