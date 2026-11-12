import { contextBridge, ipcRenderer } from 'electron';
import type { Connection } from '../../../packages/client/src/http-client.js';

contextBridge.exposeInMainWorld('rowweave', {
  connection: (): Promise<Connection> => ipcRenderer.invoke('connection'),
  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('confirm-discard'),
  setDirty: (value: boolean): Promise<void> => ipcRenderer.invoke('dirty', value),
  saveCsv: (name: string, csv: string): Promise<boolean> => ipcRenderer.invoke('save-csv', name, csv),
  onServiceExit: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('service-exit', handler);
    return () => ipcRenderer.removeListener('service-exit', handler);
  },
});
