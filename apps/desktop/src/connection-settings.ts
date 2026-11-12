import { readFile } from 'node:fs/promises';
import { writeTextFile } from '../../../packages/node-host/src/files.js';
import type { ConnectionChoice } from './connection-types.js';

export function connectionChoice(input: unknown): ConnectionChoice {
  if (!input || typeof input !== 'object') throw new Error('Choose a local workspace or a service connection.');
  const value = input as Record<string, unknown>;
  if (value['mode'] === 'local') return { mode: 'local' };
  if (value['mode'] !== 'remote' || typeof value['url'] !== 'string' || typeof value['token'] !== 'string') {
    throw new Error('Enter a service URL and access token.');
  }
  let url: URL;
  try { url = new URL(value['url']); } catch { throw new Error('Enter a valid HTTP or HTTPS service URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS URL without credentials, query parameters, or a fragment.');
  }
  if (!/^[\x21-\x7e]{32,}$/.test(value['token'])) throw new Error('Enter an access token of at least 32 printable ASCII characters without spaces.');
  return { mode: 'remote', url: url.href.replace(/\/+$/, ''), token: value['token'] };
}

export async function readConnectionSettings(path: string, decrypt: (value: Buffer) => Promise<string>): Promise<ConnectionChoice> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'local' }; throw error; }
  let saved: Record<string, unknown>;
  try { saved = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error('The saved connection settings are not valid JSON.'); }
  if (!saved || saved['format'] !== 1) throw new Error('The saved connection settings have an unsupported format.');
  if (saved['mode'] === 'local') return { mode: 'local' };
  if (saved['mode'] !== 'remote' || typeof saved['encryptedToken'] !== 'string') throw new Error('The saved service connection is incomplete.');
  return connectionChoice({ mode: 'remote', url: saved['url'], token: await decrypt(Buffer.from(saved['encryptedToken'], 'base64')) });
}

export async function writeConnectionSettings(path: string, choice: ConnectionChoice, encrypt: (value: string) => Promise<Buffer>): Promise<void> {
  const saved = choice.mode === 'local' ? { format: 1, mode: 'local' }
    : { format: 1, mode: 'remote', url: choice.url, encryptedToken: (await encrypt(choice.token)).toString('base64') };
  await writeTextFile(path, JSON.stringify(saved) + '\n');
}
