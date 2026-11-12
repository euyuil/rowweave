import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxCsvBytes } from '../../../packages/contracts/src/index.js';
import { writeCsvFile } from './csv-file.js';

app.setName('RowWeave');
if (process.env['ROWWEAVE_DATA_DIR']) {
  const dataDirectory = resolve(process.env['ROWWEAVE_DATA_DIR']);
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
}
const directory = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let child: ReturnType<typeof utilityProcess.fork> | undefined;
let dirty = false;
let quitting = false;
let closingPrompt = false;

function trusted(event: IpcMainInvokeEvent): boolean {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
}

async function confirmDiscard(): Promise<boolean> {
  if (!window) return false;
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: 'Unsaved changes',
    message: 'Discard your unsaved changes?',
    detail: 'Your saved records will remain on this device.',
    buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

void app.whenReady().then(async () => {
  try {
    const token = randomBytes(32).toString('hex');
    const database = join(process.env['ROWWEAVE_DATA_DIR'] ?? app.getPath('userData'), 'prototype.sqlite');
    child = utilityProcess.fork(join(directory, 'service-process.js'), [], {
      serviceName: 'RowWeave data service',
      env: { ...process.env, ROWWEAVE_DB: database, ROWWEAVE_TOKEN: token },
      stdio: 'pipe',
    });
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    const service = child;
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Data service startup timed out.')), 30_000);
      service.once('exit', code => { clearTimeout(timer); reject(new Error(`Data service exited with code ${code}.`)); });
      service.once('message', (message: unknown) => {
        clearTimeout(timer);
        const ready = message as { type?: string; url?: string };
        if (ready.type !== 'ready' || !ready.url?.match(/^http:\/\/127\.0\.0\.1:\d+$/)) {
          reject(new Error('Invalid data service startup response.'));
        } else resolve(ready.url);
      });
    });
    window = new BrowserWindow({
      width: 1220, height: 820, minWidth: 800, minHeight: 560, title: 'RowWeave',
      show: false, backgroundColor: '#f7f9fc',
      webPreferences: {
        preload: join(directory, '../preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: process.env['ROWWEAVE_HEADLESS'] !== '1',
        offscreen: process.env['ROWWEAVE_HEADLESS'] === '1',
      },
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle('connection', event => {
      if (!trusted(event)) throw new Error('Untrusted request.');
      return { url, token };
    });
    ipcMain.handle('confirm-discard', event => {
      if (!trusted(event)) throw new Error('Untrusted request.');
      return confirmDiscard();
    });
    ipcMain.handle('dirty', (event, value: unknown) => {
      if (!trusted(event) || typeof value !== 'boolean') throw new Error('Invalid edit state.');
      dirty = value;
    });
    ipcMain.handle('save-csv', async (event, name: unknown, csv: unknown) => {
      if (!trusted(event) || typeof name !== 'string' || name.length > 500 || typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > maxCsvBytes) {
        throw new Error('Invalid CSV export.');
      }
      const filename = 'RowWeave-' + name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') + '.csv';
      const result = await dialog.showSaveDialog(window!, { title: 'Export CSV', defaultPath: filename,
        filters: [{ name: 'CSV files', extensions: ['csv'] }] });
      if (result.canceled) return false;
      await writeCsvFile(result.filePath, csv);
      return true;
    });
    window.on('close', event => {
      if (!dirty || quitting) return;
      event.preventDefault();
      if (closingPrompt) return;
      closingPrompt = true;
      void confirmDiscard().then(discard => {
        closingPrompt = false;
        if (discard) { dirty = false; window?.close(); }
      });
    });
    service.on('exit', () => {
      child = undefined;
      if (!quitting && window && !window.isDestroyed()) window.webContents.send('service-exit');
    });
    await window.loadFile(join(directory, '../index.html'));
    if (process.env['ROWWEAVE_HEADLESS'] !== '1') window.show();
  } catch (error) {
    child?.kill();
    child = undefined;
    dialog.showErrorBox('RowWeave could not start', error instanceof Error ? error.message : 'Unknown startup error.');
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  if (dirty) {
    event.preventDefault();
    if (closingPrompt) return;
    closingPrompt = true;
    void confirmDiscard().then(discard => {
      closingPrompt = false;
      if (discard) { dirty = false; app.quit(); }
    });
    return;
  }
  if (!child) return;
  event.preventDefault();
  quitting = true;
  const service = child;
  const timer = setTimeout(() => { service.kill(); app.quit(); }, 3_000);
  timer.unref();
  service.once('exit', () => { clearTimeout(timer); app.quit(); });
  service.postMessage('shutdown');
});
