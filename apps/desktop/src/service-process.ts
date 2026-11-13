import { startWorkspaceServer } from '../../server/src/workspace-server.js';

const database = process.env['ROWWEAVE_DB'];
const token = process.env['ROWWEAVE_TOKEN'];
if (!database || !token || !process.parentPort) throw new Error('Missing service launch configuration.');
const server = await startWorkspaceServer(database, { token });
let closing = false;
process.parentPort.on('message', async ({ data }: { data: unknown }) => {
  if (data !== 'shutdown' || closing) return;
  closing = true;
  await server.close();
  process.exit(0);
});
process.parentPort.postMessage({ type: 'ready', url: server.url });
