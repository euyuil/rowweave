import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { SqliteRecordStore } from '../../../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../../../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/scalar-grid-performance-'));
const count = 100000, key = index => 'Group ' + String(index).padStart(6, '0');
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  os: os.type() + ' ' + os.release() + ' ' + os.arch(), rows: count, distinctGroups: count,
  method: 'Production renderer in source Electron, isolated local service, offscreen automated window, 1220x820. No other local tests or downloads overlap. Navigation wall time includes automation IPC, bounded group/read requests and two animation frames after the expected record appears. Input-to-rAF and scrolling frames are offscreen proxies, not physical latency or final packaged/native acceptance.',
  navigationMs: [], trials: [] };
const store = new SqliteRecordStore(join(directory, 'prototype.sqlite'), null);
const service = new RecordService(store);
try {
  const table = service.createTable({ name: '100k groups' });
  const start = performance.now();
  for (let offset = 0; offset < count; offset += 2000) service.createRecords(table.id, Array.from({ length: 2000 }, (_, index) => ({
    values: { [table.primaryFieldId]: key(count - 1 - offset - index) },
  })));
  const view = service.listViews(table.id)[0];
  service.updateView(table.id, view.id, { expectedVersion: view.version, groupBy: table.primaryFieldId });
  result.seedMs = performance.now() - start;
} finally { store.close(); }
console.log('Seed complete: ' + directory);
const summary = values => { const sorted = [...values].sort((a, b) => a - b); return {
  count: values.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
  p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1),
}; };
for (let trial = 0; trial < 3; trial++) {
  let app;
  try {
    const start = performance.now();
    app = await electron.launch({ executablePath: electronPath, args: ['.'], cwd: process.cwd(),
      env: { ...process.env, ROWWEAVE_DATA_DIR: directory, ROWWEAVE_HEADLESS: '1' }, timeout: 60000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cell = (row, text) => page.waitForFunction(({ row, text }) =>
      document.querySelector(`canvas [aria-rowindex="${row + 2}"] [role="gridcell"][aria-colindex="1"]`)?.textContent === text,
    { row, text }, { polling: 20 });
    const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await cell(1, key(0)); await paint();
    const measurement = { startupMs: performance.now() - start, inputMs: [] }; result.trials.push(measurement);
    if (trial === 0) {
      result.runtime = await app.evaluate(({ screen }) => ({ versions: process.versions, display: screen.getPrimaryDisplay() }));
      result.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
      const capture = request => { if (request.url().endsWith('/groups/query')) result.groupRequests.push(request.postDataJSON()); };
      result.groupRequests = []; page.on('request', capture);
      for (let index = 1; index <= 20; index++) {
        const record = index * 4900, row = record * 2;
        const started = performance.now();
        await page.locator('.dvn-scroller').evaluate((element, row) => { element.scrollTop = row * 36; }, row);
        await cell(row + 1, key(record)); await paint();
        result.navigationMs.push(performance.now() - started);
      }
      await page.evaluate(() => {
        window.groupFrames = []; let previous;
        const frame = now => { if (previous !== undefined) window.groupFrames.push(now - previous);
          previous = now; window.groupFrameRequest = requestAnimationFrame(frame); };
        window.groupFrameRequest = requestAnimationFrame(frame);
      });
      for (let index = 0; index < 100; index++) {
        await page.locator('.dvn-scroller').evaluate((element, index) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * index / 99; }, index);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      result.scrollFramesMs = await page.evaluate(() => { cancelAnimationFrame(window.groupFrameRequest); return window.groupFrames; });
      page.off('request', capture);
      assert.ok(result.groupRequests.every(query => query.limit <= 500));
      await cell(count * 2 - 1, key(count - 1)); await paint();
      await page.screenshot({ path: join(directory, 'deep.png') });
    }
    await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
    await page.locator('.dvn-scroller').evaluate(element => { element.scrollTop = 0; });
    await cell(1, key(0));
    const bounds = await page.locator('canvas').first().boundingBox();
    await page.mouse.click(bounds.x + 100, bounds.y + 94);
    await cell(1, key(0)); await page.keyboard.press('Enter'); await page.getByRole('textbox', { name: 'Cell value', exact: true }).waitFor();
    await page.evaluate(() => {
      window.inputSamples = [];
      document.querySelector('[aria-label="Cell value"]').addEventListener('input', () => {
        const start = performance.now(); requestAnimationFrame(() => window.inputSamples.push(performance.now() - start));
      }, { capture: true });
    });
    for (let index = 0; index < 110; index++) {
      await page.keyboard.press('x');
      await page.waitForFunction(length => window.inputSamples.length === length, index + 1, { polling: 'raf' });
    }
    measurement.inputMs = await page.evaluate(() => window.inputSamples.slice(10));
    measurement.input = summary(measurement.inputMs);
    await page.keyboard.press('Escape');
    measurement.memory = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
      type: metric.type, name: metric.name, workingSetMiB: metric.memory.workingSetSize / 1024,
      privateMiB: (metric.memory.privateBytes ?? 0) / 1024,
    })));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ trial, startupMs: measurement.startupMs, input: measurement.input }));
  } finally {
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await app.close();
    }
  }
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
}
result.navigation = summary(result.navigationMs); result.frames = summary(result.scrollFramesMs);
result.longFrames = { over25: result.scrollFramesMs.filter(ms => ms > 25).length, over50: result.scrollFramesMs.filter(ms => ms > 50).length };
await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ directory, navigation: result.navigation, frames: result.frames, longFrames: result.longFrames }));
