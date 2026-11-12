import type { Connection } from '../../../packages/client/src/http-client.js';

export type ConnectionChoice = { mode: 'local' } | { mode: 'remote'; url: string; token: string };

export interface DesktopConnectionState {
  mode: ConnectionChoice['mode'];
  url?: string;
  connection?: Connection;
  error?: string;
}

export type ConnectionResult = { ok: true; state: DesktopConnectionState } | { ok: false; error: string };
