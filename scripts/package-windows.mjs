import { packager } from '@electron/packager';
import { ZipFile } from 'yazl';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { bundledNotices } from './bundled-notices.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Package on Windows x64.');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const artifacts = resolve('.artifacts');
await mkdir(artifacts, { recursive: true });
const stage = await mkdtemp(join(artifacts, 'package-'));
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const output = resolve('release', `${manifest.version}-${stamp}`);
try {
  await cp('dist', join(stage, 'dist'), {
    recursive: true,
    filter: source => !source.split(/[\\/]/).includes('tests') && !source.endsWith('.map') && !source.endsWith('.meta.json')
      && !/^(?:apps\/mcp|integrations\/harness)(?:\/|$)/.test(relative('dist', source).replaceAll('\\', '/')),
  });
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: 'rowweave', productName: 'RowWeave', version: manifest.version,
    type: 'module', main: manifest.main, description: 'Local structured tables for people and software.',
  }, null, 2));
  const meta = JSON.parse(await readFile('dist/apps/desktop/renderer.meta.json', 'utf8'));
  await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), await bundledNotices(meta));
  const electronVersion = manifest.devDependencies.electron;
  const localZip = join(artifacts, `electron-v${electronVersion}-win32-x64.zip`);
  const hasLocalZip = await access(localZip).then(() => true, () => false);
  if (hasLocalZip) {
    const checksums = JSON.parse(await readFile('node_modules/electron/checksums.json', 'utf8'));
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(localZip)) digest.update(chunk);
    if (digest.digest('hex') !== checksums[basename(localZip)]) throw new Error('Cached Electron archive checksum mismatch.');
  }
  const [directory] = await packager({
    dir: stage, out: output, name: 'RowWeave', executableName: 'RowWeave',
    platform: 'win32', arch: 'x64', electronVersion, asar: true, prune: false,
    ...(hasLocalZip ? { electronZipDir: artifacts } : {}),
    win32metadata: { CompanyName: 'RowWeave', FileDescription: 'RowWeave desktop prototype' },
  });
  if (!directory) throw new Error('Packaging did not produce an application.');
  const zip = join(output, `rowweave-${manifest.version}-win32-x64.zip`);
  const archive = new ZipFile();
  const finished = pipeline(archive.outputStream, createWriteStream(zip, { flags: 'wx' }));
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const source = join(entry.parentPath, entry.name);
      archive.addFile(source, `${basename(directory)}/${relative(directory, source).replaceAll('\\', '/')}`);
    }
  }
  archive.end();
  await finished;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const result = {
    version: manifest.version, createdAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    executable: join(directory, 'RowWeave.exe'), zip, sha256: hash.digest('hex'),
  };
  await writeFile(`${zip}.sha256`, `${result.sha256}  ${basename(zip)}\n`);
  await writeFile('release/latest.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (dirname(resolve(stage)) !== artifacts || !basename(stage).startsWith('package-')) throw new Error('Unsafe staging path.');
  await rm(stage, { recursive: true, force: true });
}
