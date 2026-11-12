import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxCsvBytes } from '../../../packages/contracts/src/index.js';
import { writeTextFile } from '../../../packages/node-host/src/files.js';
import { createWorkspaceClient } from '../../../packages/client/src/http-client.js';
import { connectionChoice, readConnectionSettings, writeConnectionSettings } from './connection-settings.js';
import type { ConnectionResult, DesktopConnectionState } from './connection-types.js';
import { startLocalService, type LocalService } from './local-service.js';

app.setName('RowWeave');
if (process.env['ROWWEAVE_DATA_DIR']) {
  const dataDirectory = resolve(process.env['ROWWEAVE_DATA_DIR']);
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
}
const directory = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let local: LocalService | undefined;
let active: DesktopConnectionState = { mode: 'local' };
let settingsPath: string;
let changingConnection = false;
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
    detail: 'Your saved records will remain in their workspace.',
    buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

async function startLocal(): Promise<LocalService> {
  const database = join(app.getPath('userData'), 'prototype.sqlite');
  return startLocalService(join(directory, 'service-process.js'), database, service => {
    if (local !== service) return;
    local = undefined;
    if (active.mode !== 'local') return;
    active = { mode: 'local', error: 'The local data service stopped.' };
    if (!quitting && window && !window.isDestroyed()) window.webContents.send('service-exit');
  });
}

async function encryptToken(token: string): Promise<Buffer> {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('System credential encryption is unavailable. The connection was not saved.');
  return safeStorage.encryptStringAsync(token);
}

async function connect(input: unknown): Promise<DesktopConnectionState> {
  if (dirty) throw new Error('Save or discard your workspace edits before changing the connection.');
  if (changingConnection || quitting) throw new Error('Wait for the current connection change to finish.');
  const choice = connectionChoice(input);
  changingConnection = true;
  let candidate: LocalService | undefined;
  try {
    let next: DesktopConnectionState;
    if (choice.mode === 'local') {
      candidate = local ?? await startLocal();
      next = { mode: 'local', connection: candidate.connection };
    } else {
      const api = createWorkspaceClient(choice, async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Origin', 'null');
        const response = await fetch(input, { ...init, headers, redirect: 'error' }).catch(() => {
          throw new Error('Could not reach this service. Check its address, network connection, and certificate.');
        });
        if (response.headers.get('access-control-allow-origin') !== 'null') {
          throw new Error('This service does not allow the desktop origin. Configure ROWWEAVE_ALLOWED_ORIGINS to include null.');
        }
        return response;
      });
      if (!Array.isArray(await api.listTables())) throw new Error('This URL did not return a RowWeave workspace.');
      next = { mode: 'remote', url: choice.url, connection: { url: choice.url, token: choice.token } };
    }
    await writeConnectionSettings(settingsPath, choice, encryptToken);
    const previous = local;
    local = candidate;
    active = next;
    if (previous && previous !== candidate) await previous.stop();
    return active;
  } catch (error) {
    if (candidate && candidate !== local) await candidate.stop();
    throw error;
  } finally { changingConnection = false; }
}

void app.whenReady().then(async () => {
  try {
    settingsPath = join(app.getPath('userData'), 'connection.json');
    try {
      const choice = await readConnectionSettings(settingsPath, async encrypted => (await safeStorage.decryptStringAsync(encrypted)).result);
      if (choice.mode === 'local') {
        local = await startLocal();
        active = { mode: 'local', connection: local.connection };
      } else active = { mode: 'remote', url: choice.url, connection: { url: choice.url, token: choice.token } };
    } catch (error) {
      active = { mode: 'local', error: 'Could not open the saved workspace connection. ' + (error instanceof Error ? error.message : 'Open connection settings to recover.') };
    }
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
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      callback({ cancel: !active.connection || new URL(details.url).origin !== new URL(active.connection.url).origin });
    });
    ipcMain.handle('connection', event => {
      if (!trusted(event)) throw new Error('Untrusted request.');
      if (!active.connection) throw new Error('No workspace connection is active.');
      return active.connection;
    });
    ipcMain.handle('connection-state', event => {
      if (!trusted(event)) throw new Error('Untrusted request.');
      return active;
    });
    ipcMain.handle('connect', async (event, choice: unknown): Promise<ConnectionResult> => {
      if (!trusted(event)) throw new Error('Untrusted request.');
      try { return { ok: true, state: await connect(choice) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Could not change the workspace connection.' }; }
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
      const filename = 'rowweave-' + name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') + '.csv';
      const result = await dialog.showSaveDialog(window!, { title: 'Export CSV', defaultPath: filename,
        filters: [{ name: 'CSV files', extensions: ['csv'] }] });
      if (result.canceled) return false;
      await writeTextFile(result.filePath, csv);
      return true;
    });
    window.on('close', event => {
      if (changingConnection) { event.preventDefault(); return; }
      if (!dirty || quitting) return;
      event.preventDefault();
      if (closingPrompt) return;
      closingPrompt = true;
      void confirmDiscard().then(discard => {
        closingPrompt = false;
        if (discard) { dirty = false; window?.close(); }
      });
    });
    await window.loadFile(join(directory, '../index.html'));
    if (process.env['ROWWEAVE_HEADLESS'] !== '1') window.show();
  } catch (error) {
    await local?.stop();
    local = undefined;
    dialog.showErrorBox('RowWeave could not start', error instanceof Error ? error.message : 'Unknown startup error.');
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  if (changingConnection) { event.preventDefault(); return; }
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
  if (!local) return;
  event.preventDefault();
  quitting = true;
  void local.stop().then(() => app.quit());
});
