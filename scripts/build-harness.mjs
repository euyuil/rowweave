import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { bundledNotices } from './bundled-notices.mjs';

const directory = 'integrations/harness/lib';
const { name } = JSON.parse(await readFile('integrations/harness/package.json', 'utf8'));
await mkdir(directory, { recursive: true });
const client = await build({ entryPoints: ['integrations/harness/src/client.tsx'], outfile: `${directory}/client.js`,
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', write: false, metafile: true, minify: true,
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'], define: { 'process.env.NODE_ENV': '"production"' } });
const js = client.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = client.outputFiles.find(file => file.path.endsWith('.css')).text;
const wrapper = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const style = document.createElement('style');
style.dataset.plugin = ${JSON.stringify(name)};
style.dataset.pluginCss = ${JSON.stringify(`${name}/client.css`)};
style.textContent = ${JSON.stringify(css)};
document.head.appendChild(style);
${js}
return module.exports;
} });
`;
await writeFile(`${directory}/client.js`, wrapper);
await writeFile(`${directory}/THIRD-PARTY-NOTICES.txt`, await bundledNotices(client.metafile));
await build({ entryPoints: ['integrations/harness/src/index.ts'], outfile: `${directory}/index.js`,
  bundle: true, format: 'esm', platform: 'node', target: 'node24' });
