import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { Connection } from '../../../packages/client/src/http-client.js';
import { HarnessWorkspace, type WorkspaceSession } from './workspace.js';
import './harness.css';

export const panelId = 'rowweave' as MainPanelId;
export const inject = ['slots', 'layout'];

function PanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16M3 15h18" />
  </svg>;
}

export function apply(ctx: Context): void {
  let connection: Connection | undefined;
  let dirty = false;
  let restoringPanel = false;
  const session: WorkspaceSession = {
    getConnection: () => connection,
    setConnection: value => { connection = value; },
    setDirty: value => { dirty = value; },
  };
  ctx.effect(() => {
    const existing = document.getElementById('portal');
    const portal = existing ?? document.createElement('div');
    if (!existing) {
      portal.id = 'portal';
      Object.assign(portal.style, { position: 'fixed', left: '0', top: '0', zIndex: '9999' });
      document.body.appendChild(portal);
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (!existing) portal.remove();
      connection = undefined;
      dirty = false;
    };
  }, 'rowweave: browser lifecycle');
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: panelId, inject: () => ({ session }) }, HarnessWorkspace);
    yield ctx.layout.panelInfo.subscribe(() => {
      if (!dirty || restoringPanel || ctx.layout.panelInfo.getSnapshot().activePanelId === panelId) return;
      restoringPanel = true;
      try {
        ctx.layout.selectPanel(panelId);
        window.alert('Save or discard your RowWeave edits before leaving this panel.');
      } finally { restoringPanel = false; }
    });
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 100, label: 'RowWeave',
  }, PanelIcon));
}
