import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeTextFile(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.rowweave-export-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
