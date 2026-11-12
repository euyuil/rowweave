import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeCsvFile(path: string, csv: string): Promise<void> {
  const temporary = join(dirname(path), `.rowweave-export-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, csv, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
