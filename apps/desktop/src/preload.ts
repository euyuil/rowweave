import { contextBridge, ipcRenderer } from 'electron';
import type { Connection } from '../../../packages/client/src/http-client.js';

contextBridge.exposeInMainWorld('rowweave', {
  connection: (): Promise<Connection> => ipcRenderer.invoke('connection'),
  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('confirm-discard'),
  setDirty: (value: boolean): Promise<void> => ipcRenderer.invoke('dirty', value),
  onServiceExit: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('service-exit', handler);
    return () => ipcRenderer.removeListener('service-exit', handler);
  },
});
