import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['apps/desktop/src/renderer.tsx'],
  outfile: 'dist/apps/desktop/renderer.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true, sourcemap: true,
});
await build({
  entryPoints: ['apps/desktop/src/preload.ts'],
  outfile: 'dist/apps/desktop/preload.cjs',
  bundle: true, format: 'cjs', platform: 'node', external: ['electron'],
});
await copyFile('apps/desktop/index.html', 'dist/apps/desktop/index.html');
