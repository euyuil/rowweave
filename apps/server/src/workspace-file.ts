import { parseArgs } from 'node:util';
import { backupWorkspace, restoreWorkspace } from '../../../packages/storage-sqlite/src/backup.js';

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({ strict: true, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help || positionals.length === 0) {
    process.stdout.write(`RowWeave workspace files

Usage: npm run workspace:file -- <backup|restore> <source.sqlite> <new-destination.sqlite>

backup   Create a consistent snapshot, including committed WAL data.
restore  Check a snapshot and migrate its copy to the current workspace format.

The source is never migrated or replaced. The destination must not exist, and its
parent directory must exist. Use only a completed successful result as a backup.
For JSON output without npm banners, invoke this compiled file with Node directly.
After restoring, stop the current service before switching to the new workspace.
`);
    return;
  }
  const [operation, source, destination] = positionals;
  if (positionals.length !== 3 || !['backup', 'restore'].includes(operation!)) {
    throw new Error('Use backup or restore with a source path and a new destination path. Run --help for details.');
  }
  const result = await (operation === 'backup' ? backupWorkspace : restoreWorkspace)(source!, destination!);
  process.stdout.write(JSON.stringify(result) + '\n');
}

void run().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ error: { code: 'WORKSPACE_FILE_FAILED',
    message: error instanceof Error ? error.message : 'The workspace operation failed.' } }) + '\n');
  process.exitCode = 1;
});
