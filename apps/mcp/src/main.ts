#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createWorkspaceClient } from '../../../packages/client/src/index.js';
import { createMcpServer } from './server.js';

try {
  if (process.argv.length > 2) throw new Error('Configure ROWWEAVE_URL and ROWWEAVE_TOKEN in the environment; no command arguments are accepted.');
  let endpoint: URL;
  try { endpoint = new URL(process.env['ROWWEAVE_URL'] ?? 'http://127.0.0.1:4317'); }
  catch { throw new Error('ROWWEAVE_URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('ROWWEAVE_URL must use HTTP or HTTPS without credentials, query parameters or a fragment.');
  }
  const token = process.env['ROWWEAVE_TOKEN'];
  if (!token) throw new Error('Set ROWWEAVE_TOKEN in the environment.');
  try { new Headers({ Authorization: `Bearer ${token}` }); }
  catch { throw new Error('ROWWEAVE_TOKEN is not a valid HTTP header value.'); }
  const api = createWorkspaceClient({ url: endpoint.href.replace(/\/$/, ''), token });
  serveStdio(() => createMcpServer(api), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 * 1024 }),
    onerror: () => { process.stderr.write('MCP transport failed. Check client messages and the 64 MiB input limit.\n'); },
  });
} catch (error) {
  process.stderr.write((error as Error).message + '\n');
  process.exitCode = 2;
}
