import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
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
    '110 keyboard inputs per trial (10 warm-up, 100 measured); input-to-rAF and frame intervals are paint proxies, not hardware latency. ' +
    'A DOM paste event exercises the real parser and staging path without replacing the system clipboard. ' +
    'Query timings include authenticated HTTP and JSON decoding. Use benchmark:memory to measure without a renderer debugger.',
  datasets: [],
};
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
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
  const seeded = await run(process.execPath, ['scripts/generate-dataset.mjs', database, String(rows), String(columns), '--typed']);
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
        window.inputFrames = [];
        document.querySelector('[aria-label="Cell value"]').addEventListener('input', () => {
          const start = performance.now();
          requestAnimationFrame(() => window.inputFrames.push(performance.now() - start));
        }, { capture: true });
      });
      for (let input = 0; input < 110; input++) {
        await page.keyboard.press('x');
        await page.waitForFunction(count => window.inputFrames.length === count, input + 1, { polling: 'raf' });
      }
      result.inputSamplesMs = await page.evaluate(() => window.inputFrames.slice(10));
      result.inputToNextFrameMs = summarize(result.inputSamplesMs);
      await page.keyboard.press('Escape');
      await page.getByRole('textbox', { name: 'Cell value' }).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('canvas')?.contains(document.activeElement));
      const text = Array.from({ length: 1_000 }, (_, row) => Array.from({ length: 10 }, (_, col) =>
        `Trial ${trial} ${row}/${col} 🌱`).join('\t')).join('\n');
      const pasteStart = performance.now();
      result.paste1000x10Ms = await page.evaluate(text => new Promise((resolvePaste, reject) => {
        const status = document.querySelector('footer [role="status"]');
        const start = performance.now();
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Paste did not finish: ${status.textContent}`)); }, 30_000);
        const observer = new MutationObserver(() => {
          if (status.textContent === '10,000 unsaved cells') {
            observer.disconnect(); clearTimeout(timeout);
            requestAnimationFrame(() => resolvePaste(performance.now() - start));
          }
        });
        observer.observe(status, { childList: true, characterData: true, subtree: true });
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        document.querySelector('.grid-host').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      }), text);
      result.pasteWallMs = performance.now() - pasteStart;
      result.memoryWithDrafts = await memory(application);
      const saveStart = performance.now();
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByText('All changes saved', { exact: true }).waitFor();
      result.save1000x10Ms = performance.now() - saveStart;
      if (trial === 0) {
        result.queries = [];
        const table = dataset.seed.table;
        const field = name => table.fields.find(field => field.name === name).id;
        const cases = [
          ['first page', {}],
          ['numeric range', { filter: { conjunction: 'and', conditions: [{ fieldId: field('Amount'), operator: 'gte', value: 9900 }] } }],
          ['compound filter', { filter: { conjunction: 'and', conditions: [
            { fieldId: field('Amount'), operator: 'gte', value: 9900 }, { fieldId: field('Done'), operator: 'eq', value: true },
          ] } }],
          ['name sort', { sort: [{ fieldId: table.primaryFieldId, direction: 'asc' }] }],
          ['numeric sort', { sort: [{ fieldId: field('Amount'), direction: 'desc' }] }],
        ];
        for (const [name, query] of cases) {
          const measurement = await page.evaluate(async ({ tableId, name, query }) => {
            const connection = await window.rowweave.connection();
            const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
            const call = async (path, body) => {
              const response = await fetch(`${connection.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
              if (!response.ok) throw new Error(`Query benchmark failed: ${await response.text()}`);
              return response.json();
            };
            const prepared = performance.now();
            const view = await call(`/tables/${tableId}/views`, { name: `Benchmark ${name}`, query });
            const preparationMs = performance.now() - prepared;
            const samples = [];
            for (let iteration = 0; iteration < 22; iteration++) {
              const start = performance.now();
              const page = await call(`/tables/${tableId}/views/${view.id}/query`, { offset: 0, limit: 100 });
              samples.push({ ms: performance.now() - start, total: page.total });
            }
            return { preparationMs, firstMs: samples[0].ms, samples: samples.slice(2) };
          }, { tableId: table.id, name, query });
          result.queries.push({ name, query, ...measurement, durationMs: summarize(measurement.samples.map(sample => sample.ms)) });
          await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
          console.log(`${rows} × ${columns}, ${name}: p95 ${result.queries.at(-1).durationMs.p95.toFixed(0)} ms.`);
        }
      }
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
        result.scrollFramesMs = frames;
        result.longFrames = { over25ms: frames.filter(ms => ms > 25).length, over50ms: frames.filter(ms => ms > 50).length };
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
        const exited = once(application.process(), 'exit');
        await application.evaluate(({ app }) => app.quit());
        await exited;
      }
    }
  }
}
console.log(`Results: ${reportPath}`);
