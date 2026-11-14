import { once } from 'node:events';

export async function closeApplication(application) {
  const process = application.process();
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  await application.close();
  await exited;
}
