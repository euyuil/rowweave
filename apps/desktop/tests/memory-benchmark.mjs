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
  if (report.datasets.some(result => result.rows === dataset.rows && result.columns === dataset.columns && result.cycles.length === 5)) continue;
  const child = spawn(packaged.executable, ['--inspect=0'], {
    env: { ...process.env, ROWWEAVE_DATA_DIR: dirname(dataset.seed.database) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluation timed out.')); }, 30_000);
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
    const result = { rows: dataset.rows, columns: dataset.columns, memoryAtLoad: await metrics(), cycles: [] };
    report.datasets.push(result);
    for (let cycle = 0; cycle < 5; cycle++) {
      const renderer = `(async () => {
        const element = document.querySelector('.dvn-scroller');
        for (let step = 0; step < 120; step++) {
          element.scrollTop = (element.scrollHeight - element.clientHeight) * step / 119;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return true;
      })()`;
      await evaluate(`memoryTestElectron.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(renderer)})`);
      const snapshot = await metrics();
      result.cycles.push(snapshot);
      console.log(`${dataset.rows} × ${dataset.columns}, cycle ${cycle + 1}: ${snapshot.reduce((sum, metric) => sum + metric.workingSetMiB, 0).toFixed(1)} MiB total working sets.`);
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (evaluate && socket?.readyState === WebSocket.OPEN) {
      await evaluate('if (memoryTestElectron?.app) setTimeout(() => memoryTestElectron.app.quit(), 0); true').catch(() => {});
      socket.close();
    }
    const timer = setTimeout(() => child.kill(), 5_000);
    await exited;
    clearTimeout(timer);
  }
}
