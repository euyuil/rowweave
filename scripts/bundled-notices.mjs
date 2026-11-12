import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function bundledNotices(meta) {
  const dependencyRoots = new Set();
  const bundledInputs = new Set(Object.values(meta.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([, details]) => details.bytesInOutput > 0).map(([input]) => input)));
  for (const input of bundledInputs) {
    const matches = [...input.replaceAll('\\', '/').matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    const match = matches.at(-1);
    if (match) dependencyRoots.add(input.slice(0, match.index + match[0].length));
  }
  const notices = [];
  for (const root of [...dependencyRoots].sort()) {
    const dependency = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const names = (await readdir(root)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
    const fallback = dependency.name === 'react-easy-swipe' && dependency.version === '0.0.21'
      ? await readFile('docs/third-party/react-easy-swipe-license.txt', 'utf8') : undefined;
    if (fallback && !fallback.includes('Copyright (c) 2016 Leandro Lemos')) throw new Error('Incomplete fallback license notice.');
    if (!names.length && !fallback) throw new Error(`Missing license notice for bundled dependency ${dependency.name}.`);
    notices.push(`${dependency.name}@${dependency.version}\n${fallback ?? (await Promise.all(names.map(name => readFile(join(root, name), 'utf8')))).join('\n')}`);
  }
  return notices.join('\n\n--------------------\n\n');
}
