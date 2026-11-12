import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'packages/client/tsconfig.sdk.json'], { stdio: 'inherit' });
await build({ entryPoints: ['packages/client/src/index.ts'], outfile: 'packages/client/dist/index.js',
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2023' });
