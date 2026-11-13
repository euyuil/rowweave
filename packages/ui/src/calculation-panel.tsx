import React, { useEffect, useRef, useState } from 'react';
import type { CalculationStatus } from '../../contracts/src/index.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { Dialog } from './dialog.js';

const message = (error: unknown) => error instanceof Error ? error.message : 'Could not reach the calculation service.';
const utcTime = (value: string) => new Date(value).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';

export function CalculationPanel({ api, offline }: { api: WorkspaceApi; offline: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CalculationStatus>();
  const [statusError, setStatusError] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController>();
  useEffect(() => { setStatus(undefined); setStatusError(undefined); setRequestError(undefined); }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setRequesting(false);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 5_000;
      try {
        const current = await api.calculationStatus(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(current); setStatusError(undefined);
        if (current.running) delay = 1_000;
      } catch (error) {
        if (!controller.signal.aborted) setStatusError(message(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
      }
    };
    if (!offline) void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, offline, reload]);

  const update = async () => {
    const controller = lifetime.current!;
    setRequesting(true); setRequestError(undefined);
    try {
      await api.refreshCalculations(controller.signal);
      if (!controller.signal.aborted) setReload(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(message(error));
    } finally {
      if (!controller.signal.aborted) setRequesting(false);
    }
  };
  const running = requesting || status?.running;
  const failure = offline || statusError || requestError || status?.lastError;
  const label = offline ? 'Service offline' : statusError ? 'Status unavailable' : running ? 'Updating calculations…'
    : failure ? 'Calculation needs attention' : status?.lastResult ? 'Calculations updated' : status ? 'Ready to update' : 'Checking calculations…';
  return <>
    <button className="calculation-button" aria-label="Calculations" aria-haspopup="dialog" aria-expanded={open}
      title={label} onClick={() => setOpen(true)}>
      <span className={'calculation-dot ' + (failure ? 'failed' : running ? 'running' : status?.lastResult ? 'complete' : '')} aria-hidden="true" />
      Calculations{running && <span className="calculation-running"> · Updating</span>}
    </button>
    {open && <Dialog title="Calculations" onClose={() => setOpen(false)}>
      <section className="calculation-panel" aria-label="Calculation status">
        <p className="calculation-state" role="status">{label}</p>
        <p>Keep time-based formulas and their linked results up to date.</p>
        {status && <dl>
          <div><dt>Updates</dt><dd>{status.automatic ? 'Automatically every minute' : 'Manual updates on this service'}</dd></div>
          <div><dt>Last evaluated</dt><dd>{status.lastResult ? <time dateTime={status.lastResult.evaluatedAt}>{utcTime(status.lastResult.evaluatedAt)}</time> : 'No completed calculation in this session'}</dd></div>
          {status.lastResult && <div><dt>Last result</dt><dd>{status.lastResult.changedRecords.toLocaleString('en-US')} {status.lastResult.changedRecords === 1 ? 'record' : 'records'} changed
            {' across '}{status.lastResult.changedTableIds.length} {status.lastResult.changedTableIds.length === 1 ? 'table' : 'tables'}</dd></div>}
        </dl>}
        {status?.lastError && <p role="alert">Last calculation failed: {status.lastError}</p>}
        {requestError && <p role="alert">Update request failed: {requestError} Check the current status before trying again.</p>}
        {statusError && !offline && <p role="alert">Could not check calculation status: {statusError}
          {' '}<button disabled={requesting} onClick={() => setReload(value => value + 1)}>Check status</button></p>}
        {offline && <p role="alert">The data service stopped. Reconnect before updating calculations.</p>}
        <p className="form-note">Updates use saved records. Unsaved edits stay in your workspace; a later save may need you to review changed records.</p>
        <p className="form-note">Use Reload to see updated saved values, or Refresh view to keep unsaved edits. You can close this panel while calculations continue.</p>
        <footer><button onClick={() => setOpen(false)}>Close</button>
          <button className="primary" disabled={offline || !status || !!running || !!statusError} onClick={() => void update()}>
            {running ? 'Updating…' : 'Update calculations'}</button></footer>
      </section>
    </Dialog>}
  </>;
}
