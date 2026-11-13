import React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import * as cordis from '@deepseek-ai/cordis';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
import * as store from '@deepseek-ai/dsh-client-store';
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts';
import { removeOwnedStyles } from '@deepseek-ai/dsh-client-modules/src/client/entry-lifecycle.ts';

const seed = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient, 'react/jsx-runtime': jsx,
  '@deepseek-ai/cordis': cordis, '@deepseek-ai/dsh-client-ui-slots': slots, '@deepseek-ai/dsh-client-store': store };
const target = window.__ModuleLoader__;
const bootstrapId = '@deepseek-ai/dsh-client-modules';
const [bootstrapRegistration] = target.pendingQueue.splice(target.pendingQueue.findIndex(entry => entry.id === bootstrapId), 1);
const bootstrap = bootstrapRegistration.factory(name => {
  if (!(name in seed)) throw new Error(`Unexpected bootstrap dependency ${name}`);
  return seed[name];
});
const entries = [
  [bootstrapId, '/modules.js'], ['@deepseek-ai/dsh-client-ui-renderer', '/renderer.js'],
  ['@deepseek-ai/dsh-client-ui-layout', '/layout.js'], ['@rowweave/harness', '/rowweave.js'],
].map(([id, url]) => ({ id, url: `${url}?rev=test`, rev: 'test' }));
const modules = bootstrap.createClientModuleSystem(target, { id: bootstrapId, exports: bootstrap }, {
  boot: { rev: 'test', entries, batches: entries.map(entry => ({ phase: 'application', url: entry.url, rev: 'test', entries: [entry.id] })) },
  staticModules: seed,
});
const renderer = await modules.import('@deepseek-ai/dsh-client-ui-renderer', '', {});
const { LayoutController } = await modules.import('@deepseek-ai/dsh-client-ui-layout', '', {});
const ctx = new cordis.Context();
await ctx.plugin(renderer).await();
// This fixture has no AI conversation or selected session; the real renderer still requires its absent binding.
const absentSession = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
const sessionSource = { getSnapshot: () => absentSession, subscribe: () => () => {} };
ctx.slots.installScope('session', { current: sessionSource, bindingSource: () => sessionSource });
const layoutStore = createLayoutStore().create();
const panelInfo = { getSnapshot: () => layoutStore.getSnapshot().panelInfo, subscribe: listener => layoutStore.subscribe(listener) };
const layout = new LayoutController(layoutStore.actions, id => ctx.slots.entries('main').some(entry => entry.options.key === id), panelInfo);
ctx.reflect.provide('layout', layout);
ctx.slots.provideRoot({ hooks: { panelInfo } });
function Frame({ renderSlot, usePanelInfo }) {
  const active = usePanelInfo(value => value.activePanelId);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <nav aria-label="Harness panels" style={{ display: 'flex', gap: 12, padding: 8 }}>
      <button onClick={() => layout.selectPanel(null)}>Conversation</button>
      <button onClick={() => layout.selectPanel('rowweave')}>RowWeave</button>
      <input aria-label="Harness draft" placeholder="Host input" />
      {renderSlot('sidebar.panellist', { size: 24, active: active === 'rowweave' })}
    </nav>
    <div style={{ flex: 1, minHeight: 0 }}>{renderSlot('main', {}, { entryKey: active ?? 'conversation' })}</div>
  </div>;
}
const declareFrame = () => ctx.slots.register({ name: 'root', children: {
  main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
} }, Frame);
let removeFrame = declareFrame();
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'conversation' }, () => <h1>Harness conversation</h1>));
let plugin = await modules.import('@rowweave/harness', '', {});
let fiber = ctx.plugin(plugin);
await fiber.await();
ctx.uiRenderer.mount(document.getElementById('root'));
window.harnessTest = {
  inspect: () => ({ main: ctx.slots.entries('main').map(entry => entry.options.key),
    sidebar: ctx.slots.entries('sidebar.panellist').map(entry => entry.options.id), active: panelInfo.getSnapshot().activePanelId }),
  async unload() {
    layout.selectPanel(null);
    await fiber.dispose();
    modules.invalidate('@rowweave/harness');
    removeOwnedStyles('@rowweave/harness');
  },
  async reload() { plugin = await modules.import('@rowweave/harness', '', {}); fiber = ctx.plugin(plugin); await fiber.await(); },
  redeclare() { layout.selectPanel(null); removeFrame(); removeFrame = declareFrame(); },
};
window.harnessReady = true;
