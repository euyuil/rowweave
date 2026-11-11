import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

const run = promisify(execFile);
const timingsOnly = process.argv.includes('--timings-only');
const packaged = JSON.parse(await readFile('release/latest.json', 'utf8'));
const output = resolve('.artifacts', 'benchmarks', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const reportPath = join(output, 'results.json');
const report = {
  measuredAt: new Date().toISOString(), package: packaged,
  environment: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: totalmem() / 1024 ** 3,
    os: `${platform()} ${release()}`, architecture: arch() },
  method: 'Production packaged renderer, Playwright instrumentation, preseeded databases, three launches per size. ' +
    (timingsOnly ? 'This run skips scrolling. ' : 'The first trial includes five nominal 12-second scrolling circuits and a separate forced-GC diagnostic. ') +
    'Frame intervals and input-to-rAF are paint proxies, not hardware latency. Use benchmark:memory to measure without a renderer debugger.',
  datasets: [],
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) };
};
async function memory(application) {
  return application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
    type: metric.type, name: metric.name ?? metric.type,
    workingSetMiB: metric.memory.workingSetSize / 1024,
    privateMiB: (metric.memory.privateBytes ?? 0) / 1024,
    cpuPercent: metric.cpu.percentCPUUsage,
  })));
}
for (const [rows, columns] of [[10_000, 20], [100_000, 100]]) {
  const dataDirectory = join(output, `${rows}x${columns}`);
  const database = join(dataDirectory, 'prototype.sqlite');
  const seeded = await run(process.execPath, ['scripts/generate-dataset.mjs', database, String(rows), String(columns)]);
  const dataset = { rows, columns, seed: JSON.parse(seeded.stdout), trials: [] };
  report.datasets.push(dataset);
  for (let trial = 0; trial < 3; trial++) {
    let application;
    let page;
    try {
      const started = performance.now();
      application = await electron.launch({ executablePath: packaged.executable, args: [],
        env: { ...process.env, ROWWEAVE_DATA_DIR: dataDirectory }, timeout: 60_000 });
      page = await application.firstWindow();
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.getByText(`${rows.toLocaleString()} records · ${columns} fields`, { exact: true }).waitFor();
      await page.locator('canvas').first().waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = { trial: trial + 1, startupToGridMs: performance.now() - started, memoryAtLoad: await memory(application) };
      dataset.trials.push(result);
      if (!report.runtime) {
        report.runtime = await application.evaluate(({ screen, app }) => {
          const display = screen.getPrimaryDisplay();
          return { versions: process.versions, display: { size: display.size, scaleFactor: display.scaleFactor,
            refreshHz: display.displayFrequency }, appVersion: app.getVersion() };
        });
        report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
      }
      const canvas = await page.locator('canvas').first().boundingBox();
      assert.ok(canvas);
      await page.mouse.click(canvas.x + 100, canvas.y + 58);
      await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
      await page.keyboard.press('Enter');
      await page.getByRole('textbox', { name: 'Cell value' }).waitFor();
      await page.evaluate(() => {
        window.inputPaint = new Promise(resolve => {
          document.querySelector('[aria-label="Cell value"]').addEventListener('input', () => {
            const start = performance.now();
            requestAnimationFrame(() => resolve(performance.now() - start));
          }, { once: true });
        });
      });
      await page.keyboard.insertText('x');
      result.inputToNextFrameMs = await page.evaluate(() => window.inputPaint);
      await page.keyboard.press('Escape');
      await page.getByRole('textbox', { name: 'Cell value' }).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
      const text = Array.from({ length: 1_000 }, (_, row) => Array.from({ length: 10 }, (_, col) =>
        `Trial ${trial} ${row}/${col} 🌱`).join('\t')).join('\n');
      await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
      const pasteStart = performance.now();
      await page.keyboard.press('Control+v');
      await page.getByText('10,000 unsaved cells', { exact: true }).waitFor();
      result.paste1000x10Ms = performance.now() - pasteStart;
      result.memoryWithDrafts = await memory(application);
      const saveStart = performance.now();
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByText('All changes saved', { exact: true }).waitFor();
      result.save1000x10Ms = performance.now() - saveStart;
      if (trial === 0 && !timingsOnly) {
        const scrollStart = performance.now();
        result.scrollMemory = [];
        await page.evaluate(() => {
          window.frameIntervals = [];
          let previous;
          const frame = now => {
            if (previous !== undefined) window.frameIntervals.push(now - previous);
            previous = now;
            window.frameRequest = requestAnimationFrame(frame);
          };
          window.frameRequest = requestAnimationFrame(frame);
        });
        for (let cycle = 0; cycle < 5; cycle++) {
          for (let step = 0; step < 120; step++) {
            await page.locator('.dvn-scroller').evaluate((element, step) => {
              element.scrollTop = (element.scrollHeight - element.clientHeight) * step / 119;
            }, step);
            await sleep(100);
          }
          result.scrollMemory.push(await memory(application));
        }
        const frames = await page.evaluate(() => {
          cancelAnimationFrame(window.frameRequest);
          return window.frameIntervals;
        });
        result.scrollFrameIntervalMs = summarize(frames);
        result.scrollElapsedMs = performance.now() - scrollStart;
        const session = await page.context().newCDPSession(page);
        result.heapBeforeForcedGc = await session.send('Runtime.getHeapUsage');
        await session.send('HeapProfiler.collectGarbage');
        result.heapAfterForcedGc = await session.send('Runtime.getHeapUsage');
        result.memoryAfterForcedGc = await memory(application);
        await session.detach();
        await page.locator('.dvn-scroller').evaluate(element => { element.scrollTop = 0; });
        await sleep(200);
        await page.screenshot({ path: join(output, `${rows}x${columns}.png`) });
      }
      assert.deepEqual(errors, []);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`${rows} × ${columns}, trial ${trial + 1}: startup ${result.startupToGridMs.toFixed(0)} ms; paste ${result.paste1000x10Ms.toFixed(0)} ms; save ${result.save1000x10Ms.toFixed(0)} ms.`);
    } catch (error) {
      if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
      throw error;
    } finally {
      if (application) {
        await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
        await application.close();
      }
    }
  }
}
console.log(`Results: ${reportPath}`);
