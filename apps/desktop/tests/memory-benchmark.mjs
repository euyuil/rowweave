import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Pass the results.json path from npm run benchmark.');
const previous = JSON.parse(await readFile(input, 'utf8'));
const packaged = JSON.parse(await readFile('release/latest.json', 'utf8'));
const reportPath = join(dirname(input), 'memory-without-renderer-debugger.json');
const report = process.argv.includes('--resume') ? JSON.parse(await readFile(reportPath, 'utf8')) : {
  measuredAt: new Date().toISOString(), package: packaged,
  method: 'Main-process Node inspector only; no renderer debugger or network-response recording. Five 120-step scrolling circuits, 100 ms between steps, no forced GC.', datasets: [] };
if (report.package.sha256 !== packaged.sha256) throw new Error('Cannot resume measurements from a different application package.');
for (const dataset of previous.datasets) {
  const prior = report.datasets.findIndex(result => result.rows === dataset.rows && result.columns === dataset.columns);
  if (prior !== -1) {
    const shutdown = report.shutdowns?.filter(result => result.rows === dataset.rows && result.columns === dataset.columns).at(-1);
    if (report.datasets[prior].summary?.passed && shutdown?.exitCode === 0 && !shutdown.forced) continue;
    report.previousAttempts ??= [];
    report.previousAttempts.push(report.datasets.splice(prior, 1)[0]);
  }
  const child = spawn(packaged.executable, ['--inspect=0'], {
    env: { ...process.env, ROWWEAVE_DATA_DIR: dirname(dataset.seed.database) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  let processOutput = '', completed = false;
  child.stdout.on('data', chunk => { processOutput += chunk; });
  child.stderr.on('data', chunk => { processOutput += chunk; });
  let socket;
  let evaluate;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Node inspector startup timed out.')), 30_000);
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr += chunk;
        const match = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`App exited before inspector startup: ${code}`)); });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) pending.get(message.id)?.(message);
    });
    evaluate = expression => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluation timed out: ' + expression.slice(0, 240))); }, 30_000);
      pending.set(id, message => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    // Electron replaces its bootstrap execution context during initialization. Memory sampling starts after warm-up.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    let electronReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      electronReady = await evaluate('globalThis.memoryTestElectron = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json")("electron"); Boolean(memoryTestElectron.app)').catch(() => false);
      if (electronReady) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!electronReady) throw new Error('Electron did not finish initializing its main-process API.');
    await evaluate(`(async () => {
      await memoryTestElectron.app.whenReady();
      for (let attempt = 0; attempt < 100; attempt++) {
        const window = memoryTestElectron.BrowserWindow.getAllWindows()[0];
        if (window && !window.webContents.isLoadingMainFrame() && await window.webContents.executeJavaScript('!!document.querySelector("canvas")')) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Grid did not load.');
    })()`);
    const metrics = () => evaluate(`memoryTestElectron.app.getAppMetrics().map(metric => ({
      type: metric.type, name: metric.name ?? metric.type,
      workingSetMiB: metric.memory.workingSetSize / 1024,
      privateMiB: (metric.memory.privateBytes ?? 0) / 1024,
      cpuPercent: metric.cpu.percentCPUUsage
    }))`);
    const windowState = () => evaluate(`(() => {
      const window = memoryTestElectron.BrowserWindow.getAllWindows()[0];
      return { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused() };
    })()`);
    const result = { rows: dataset.rows, columns: dataset.columns, memoryAtLoad: await metrics(), cycles: [], windowStates: [], cycleDurationsMs: [] };
    report.datasets.push(result);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    for (let cycle = 0; cycle < 5; cycle++) {
      result.windowStates.push(await windowState());
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      const renderer = `(async () => {
        const element = document.querySelector('.dvn-scroller');
        for (let step = 0; step < 120; step++) {
          element.scrollTop = (element.scrollHeight - element.clientHeight) * step / 119;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return true;
      })()`;
      const started = performance.now();
      await evaluate(`memoryTestElectron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(renderer)})`);
      result.cycleDurationsMs.push(performance.now() - started);
      const snapshot = await metrics();
      result.cycles.push(snapshot);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`${dataset.rows} × ${dataset.columns}, cycle ${cycle + 1}: ${snapshot.reduce((sum, metric) => sum + metric.workingSetMiB, 0).toFixed(1)} MiB total working sets.`);
    }
    const totals = result.cycles.map(snapshot => snapshot.reduce((sum, metric) => sum + metric.workingSetMiB, 0));
    const maximumMiB = Math.max(...totals), lastThreeSpreadMiB = Math.max(...totals.slice(-3)) - Math.min(...totals.slice(-3));
    result.summary = { maximumMiB, lastThreeSpreadMiB, passed: maximumMiB < 650 && lastThreeSpreadMiB <= 50 };
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (!result.summary.passed) throw new Error('Memory acceptance failed: ' + JSON.stringify(result.summary));
    completed = true;
  } catch (error) {
    report.failures ??= [];
    report.failures.push({ rows: dataset.rows, columns: dataset.columns, message: error.message, processOutput });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    if (evaluate && socket?.readyState === WebSocket.OPEN) {
      await evaluate('if (memoryTestElectron?.app) setTimeout(() => memoryTestElectron.app.quit(), 0); true').catch(() => {});
      socket.close();
    }
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill(); }, 5_000);
    const exitCode = await exited;
    clearTimeout(timer);
    report.shutdowns ??= [];
    report.shutdowns.push({ rows: dataset.rows, columns: dataset.columns, exitCode, forced });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    if (completed && (forced || exitCode !== 0)) throw new Error('The measured application did not exit normally. See the recorded shutdown result.');
  }
}
