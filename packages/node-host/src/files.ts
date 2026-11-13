import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeTextFile(path: string, text: string): Promise<void> {
  await writeExportFile(path, text);
}

export async function writeBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeExportFile(path, bytes);
}

async function writeExportFile(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.rowweave-export-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
