import type { Connection } from './http-client.js';

export function workspaceEvents(connection: Connection, request: typeof fetch) {
  const listeners = new Set<{ changed(): void; failed(error: Error): void }>();
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1_000;
  const connect = async () => {
    const current = controller;
    if (!current) return;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await request(`${connection.url.replace(/\/$/, '')}/workspace/events`, {
        headers: { Authorization: `Bearer ${connection.token}` }, signal: current.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Live connection failed (${response.status}).`);
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Live connection closed. Reconnecting…');
        if (current.signal.aborted) return;
        // Notifications carry no data; coalesce frames and always read authoritative state.
        if (value.includes(10)) { retryMs = 1_000; for (const listener of listeners) listener.changed(); }
      }
    } catch (failure) {
      if (current.signal.aborted) return;
      for (const listener of listeners) listener.failed(failure instanceof Error ? failure : new Error('Live connection failed.'));
    } finally { await reader?.cancel().catch(() => undefined); }
    if (!current.signal.aborted) { retry = setTimeout(() => void connect(), retryMs); retryMs = Math.min(10_000, retryMs * 2); }
  };
  return (changed: () => void, failed: (error: Error) => void): (() => void) => {
    const listener = { changed, failed };
    listeners.add(listener);
    if (!controller) { controller = new AbortController(); void connect(); }
    else queueMicrotask(() => { if (listeners.has(listener)) changed(); });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { controller?.abort(); controller = undefined; clearTimeout(retry); }
    };
  };
}
