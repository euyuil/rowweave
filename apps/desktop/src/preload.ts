import { contextBridge, ipcRenderer } from 'electron';
import type { Connection } from '../../../packages/client/src/http-client.js';
import type { ConnectionChoice, ConnectionResult, DesktopConnectionState } from './connection-types.js';

contextBridge.exposeInMainWorld('rowweave', {
  connection: (): Promise<Connection> => ipcRenderer.invoke('connection'),
  connectionState: (): Promise<DesktopConnectionState> => ipcRenderer.invoke('connection-state'),
  connect: async (choice: ConnectionChoice): Promise<DesktopConnectionState> => {
    const result: ConnectionResult = await ipcRenderer.invoke('connect', choice);
    if (!result.ok) throw new Error(result.error);
    return result.state;
  },
  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('confirm-discard'),
  setDirty: (value: boolean): Promise<void> => ipcRenderer.invoke('dirty', value),
  saveCsv: (name: string, csv: string): Promise<boolean> => ipcRenderer.invoke('save-csv', name, csv),
  onServiceExit: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('service-exit', handler);
    return () => ipcRenderer.removeListener('service-exit', handler);
  },
});
