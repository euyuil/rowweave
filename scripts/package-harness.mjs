import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run package:harness from the repository root.');
await mkdir('release/harness', { recursive: true });
execFileSync(process.execPath, [npm, 'pack', './integrations/harness', '--ignore-scripts', '--pack-destination', resolve('release/harness')], { stdio: 'inherit' });
