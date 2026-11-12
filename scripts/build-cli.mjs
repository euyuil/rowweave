import { build } from 'esbuild';

await build({ entryPoints: ['apps/cli/src/main.ts'], outfile: 'apps/cli/dist/rowweave.js',
  bundle: true, format: 'esm', platform: 'node', target: 'node24' });
