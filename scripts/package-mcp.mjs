import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run package:mcp from the repository root.');
await mkdir('release/mcp', { recursive: true });
execFileSync(process.execPath, [npm, 'pack', './apps/mcp', '--ignore-scripts', '--pack-destination', resolve('release/mcp')], { stdio: 'inherit' });
