import React, { useState } from 'react';
import { Dialog } from '../../../packages/ui/src/dialog.js';
import type { ConnectionChoice, DesktopConnectionState } from './connection-types.js';

export function ConnectionDialog({ current, onClose, onConnect }: {
  current: DesktopConnectionState; onClose(): void; onConnect(choice: ConnectionChoice): Promise<void>;
}) {
  const [mode, setMode] = useState(current.mode);
  const [url, setUrl] = useState(current.url ?? 'http://127.0.0.1:4317');
  const [token, setToken] = useState(current.mode === 'remote' ? current.connection?.token ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try { await onConnect(mode === 'local' ? { mode } : { mode, url, token }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect to this workspace.'); }
    finally { setBusy(false); }
  };
  return <Dialog title="Workspace connection" onClose={onClose} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); void connect(); }}>
      <fieldset disabled={busy}>
        <label className="form-field">Workspace<select aria-label="Workspace" value={mode} onChange={event => setMode(event.target.value as ConnectionChoice['mode'])}>
          <option value="local">On this device</option><option value="remote">Independent service</option>
        </select></label>
        {mode === 'local' ? <p className="form-note">Open the workspace stored on this device. RowWeave starts its data service for you.</p>
          : <><label className="form-field">Service URL<input value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" required /></label>
            <label className="form-field">Access token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label>
            <p className="form-note">Connect to a running RowWeave service. Your token is encrypted on this device. Use HTTPS for encrypted remote access.</p></>}
      </fieldset>
      <p className="form-note">The connection is checked before it is saved. Switching does not move or copy records between workspaces.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect and save'}</button></div>
    </form>
  </Dialog>;
}
