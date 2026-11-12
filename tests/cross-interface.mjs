import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import extract from '@electron-internal/extract-zip';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { createWorkspaceClient } from '../packages/client/dist/index.js';

const run = promisify(execFile);

export async function verifyCrossInterfaceWorkflow(connection, harnessPage, tableId, packaged) {
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-interfaces-'));
  const sdk = createWorkspaceClient(connection);
  const environment = { ROWWEAVE_URL: connection.url, ROWWEAVE_TOKEN: connection.token };
  const client = new Client({ name: 'rowweave-interface-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('apps/mcp/dist/rowweave-mcp.js')],
    cwd: directory, env: { ...getDefaultEnvironment(), ...environment }, stderr: 'pipe' });
  let desktop;
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'records_update'));
    const mcp = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result.content));
      assert.equal(result.content[0].type, 'text');
      return JSON.parse(result.content[0].text);
    };
    const cli = async (args, input) => {
      const inputPath = join(directory, 'input.json');
      if (input !== undefined) await writeFile(inputPath, JSON.stringify(input));
      const result = await run(process.execPath, [resolve('apps/cli/dist/rowweave.js'), ...args,
        ...(input !== undefined ? ['--input', inputPath] : [])], { cwd: directory, env: { ...process.env, ...environment } });
      return JSON.parse(result.stdout);
    };
    const before = await sdk.getTable(tableId);
    const table = await sdk.createField(tableId, { expectedVersion: before.version, name: 'Reviewed', type: 'checkbox', defaultValue: false });
    await assert.rejects(sdk.createField(tableId, { expectedVersion: before.version, name: 'Stale schema', type: 'text' }),
      error => error.code === 'SCHEMA_CONFLICT');
    const reviewed = table.fields.at(-1).id;
    const budget = table.fields.find(field => field.name === 'Budget').id;
    assert.deepEqual(await cli(['tables', 'get', tableId]), table);
    const schema = await client.readResource({ uri: `rowweave://tables/${tableId}/schema` });
    assert.deepEqual(JSON.parse(schema.contents[0].text), table);
    const record = (await cli(['records', 'create', tableId], [{ values: {
      [table.primaryFieldId]: 'CLI project 🌱', [budget]: 25, [reviewed]: true,
    } }])).records[0];
    const view = await sdk.createView(tableId, { name: 'Cross-interface review', query: {
      filter: { conjunction: 'and', conditions: [{ fieldId: budget, operator: 'gte', value: 20 }] },
      sort: [{ fieldId: table.primaryFieldId, direction: 'asc' }],
    } });
    const page = await mcp('views_query', { tableId, viewId: view.id, query: { expectedViewVersion: view.version } });
    assert.equal(page.records[0].id, record.id);
    const updated = (await mcp('records_update', { tableId, records: [{ id: record.id, expectedVersion: record.version, values: { [budget]: 42 } }] })).records[0];
    await assert.rejects(cli(['records', 'update', tableId], [{ id: record.id, expectedVersion: record.version, values: { [budget]: 999 } }]),
      error => JSON.parse(error.stderr).error.code === 'VERSION_CONFLICT' && error.stdout === '');
    assert.deepEqual(await sdk.getRecord(tableId, record.id), updated);

    const editFromUi = async (page, expected, next) => {
      await page.getByLabel('Current view', { exact: true }).selectOption(view.id);
      await page.waitForFunction(() => document.querySelector('.grid-host')?.getAttribute('aria-busy') === 'false');
      const bounds = await page.locator('canvas').first().boundingBox();
      await page.mouse.click(bounds.x + 100, bounds.y + 58);
      await page.getByRole('button', { name: 'Open record', exact: true }).click();
      assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'CLI project 🌱');
      assert.equal(await page.getByLabel('Budget', { exact: true }).inputValue(), String(expected));
      assert.equal(await page.getByLabel('Reviewed', { exact: true }).inputValue(), 'true');
      await page.getByLabel('Budget', { exact: true }).fill(String(next));
      await page.getByRole('button', { name: 'Save record', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal((await sdk.getRecord(tableId, record.id)).values[budget], next);
    };
    await harnessPage.getByRole('button', { name: 'Reload', exact: true }).click();
    await harnessPage.getByText('3 records · 3 fields', { exact: true }).waitFor();
    await editFromUi(harnessPage, 42, 43);

    let executablePath = electronPath;
    if (packaged) {
      const manifest = JSON.parse(await readFile('release/latest.json', 'utf8'));
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(manifest.zip)) hash.update(chunk);
      assert.equal(hash.digest('hex'), manifest.sha256);
      const target = join(directory, 'application');
      await mkdir(target);
      await extract(manifest.zip, { dir: target });
      executablePath = join(target, 'rowweave-win32-x64', 'rowweave.exe');
    }
    desktop = await electron.launch({ executablePath, args: packaged ? [] : [resolve('.')], cwd: directory,
      env: { ...process.env, ROWWEAVE_DATA_DIR: join(directory, 'profile'), ROWWEAVE_HEADLESS: '1' }, timeout: 40_000 });
    const desktopPage = await desktop.firstWindow();
    desktopPage.setDefaultTimeout(20_000);
    const errors = [];
    desktopPage.on('pageerror', error => errors.push(error.message));
    await desktopPage.getByRole('heading', { name: 'Make room for your ideas', exact: true }).waitFor();
    await desktopPage.getByRole('button', { name: 'Connection', exact: true }).click();
    await desktopPage.getByLabel('Workspace', { exact: true }).selectOption('remote');
    await desktopPage.getByLabel('Service URL', { exact: true }).fill(connection.url);
    await desktopPage.getByLabel('Access token', { exact: true }).fill(connection.token);
    await desktopPage.getByRole('button', { name: 'Connect and save', exact: true }).click();
    await desktopPage.getByRole('heading', { name: table.name, exact: true }).waitFor();
    await editFromUi(desktopPage, 43, 44);
    const final = await mcp('records_get', { tableId, recordId: record.id });
    assert.equal(final.version, 4);
    assert.equal(final.values[budget], 44);
    assert.deepEqual(await cli(['records', 'get', tableId, record.id]), final);
    await harnessPage.getByRole('button', { name: 'Reload', exact: true }).click();
    await editFromUi(harnessPage, 44, 45);
    assert.equal((await mcp('records_get', { tableId, recordId: record.id })).version, 5);
    assert.deepEqual(errors, []);
    await desktopPage.screenshot({ path: '.artifacts/desktop-cross-interface.png' });
    console.log(`Shared-service acceptance passed: ${packaged ? 'packaged' : 'source'} desktop, SDK bundle, CLI subprocess, MCP protocol and Harness UI.`);
  } finally {
    if (desktop) {
      const exited = once(desktop.process(), 'exit');
      await desktop.evaluate(({ app }) => app.exit());
      await exited;
    }
    await client.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
