import { backup, DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { workspaceFormat } from './migrations.js';

async function snapshot(source: string, destination: string) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  const directory = await mkdtemp(join(dirname(destinationPath), '.rowweave-backup-'));
  const temporary = join(directory, 'workspace.sqlite');
  try {
    const sourceDb = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
    try { await backup(sourceDb, temporary); }
    finally { sourceDb.close(); }
    const check = new DatabaseSync(temporary);
    let version: number;
    try {
      check.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
      if (check.prepare('PRAGMA quick_check').get()!['quick_check'] !== 'ok'
        || check.prepare('PRAGMA foreign_key_check').get()) throw new Error('The database failed its integrity check.');
      version = check.prepare('PRAGMA user_version').get()!['user_version'] as number;
      if (version !== 0 && version !== workspaceFormat) throw new Error(`Unsupported database version: ${version}.`);
      if (version === 0 || !check.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'record_ids'").get()) {
        throw new Error('The source is not an initialized RowWeave workspace.');
      }
    } finally { check.close(); }
    await copyFile(temporary, destinationPath, constants.COPYFILE_EXCL);
    return { path: destinationPath, version, bytes: (await stat(destinationPath)).size };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function backupWorkspace(source: string, destination: string) {
  return snapshot(source, destination);
}

export function restoreWorkspace(source: string, destination: string) {
  return snapshot(source, destination);
}
