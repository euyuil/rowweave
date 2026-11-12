import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { bundledNotices } from './bundled-notices.mjs';

const result = await build({ entryPoints: ['apps/mcp/src/main.ts'], outfile: 'apps/mcp/dist/rowweave-mcp.js',
  bundle: true, format: 'esm', platform: 'node', target: 'node24', metafile: true });
await writeFile('apps/mcp/dist/THIRD-PARTY-NOTICES.txt', await bundledNotices(result.metafile));
