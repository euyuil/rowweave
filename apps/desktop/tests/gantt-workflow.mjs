import { waitForLiveSync, closeSavedRecord, cancelDialog } from '../../../tests/live-ui.mjs';
import assert from 'node:assert/strict';

export function ganttApi(page) {
  return (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
}

export async function verifyGanttWorkflow(page, application) {
  const originalSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const resize = async (width, height) => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
  };
  const call = ganttApi(page), dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Gantt lab');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Gantt lab', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await dialog.getByLabel('View type', { exact: true }).selectOption('gantt');
  assert.equal(await dialog.getByRole('button', { name: 'Create view', exact: true }).isDisabled(), true);
  await cancelDialog(page);
  let table = (await call('/tables')).find(table => table.name === 'Gantt lab');
  const root = '/tables/' + table.id, name = table.primaryFieldId;
  for (const field of [{ name: 'Start', type: 'date' }, { name: 'End', type: 'date' }, { name: 'At', type: 'datetime' },
    { name: 'Status', type: 'singleSelect', options: [{ id: 'todo', name: 'To do', color: '#315CBE' }] }, { name: 'Hidden', type: 'text' }]) {
    table = await call(root + '/fields', 'POST', { ...field, expectedVersion: table.version });
  }
  const [, start, end, at, status, hidden] = table.fields.map(field => field.id);
  const records = (await call(root + '/records', 'POST', [
    ...Array.from({ length: 53 }, (_, i) => ({ values: { [name]: 'Task ' + String(i).padStart(3, '0'), [start]: '2024-02-29',
      [end]: '2024-03-02', [status]: 'todo', [hidden]: 'Complete details ' + i } })),
    { values: { [name]: 'Unscheduled task' } }, { values: { [name]: 'Reversed range', [start]: '2024-02-29', [end]: '2024-02-27' } },
    { values: { [name]: 'Timed task', [at]: '2024-02-28T18:30:00.000Z' } },
  ])).records;
  await waitForLiveSync(page);
  await page.getByText('56 records · 6 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await dialog.getByLabel('View name', { exact: true }).fill('Project plan');
  await dialog.getByLabel('View type', { exact: true }).selectOption('gantt');
  await dialog.getByLabel('Gantt start field', { exact: true }).selectOption(start);
  await dialog.getByLabel('Gantt end field', { exact: true }).selectOption(end);
  await dialog.getByLabel('Gantt time zone', { exact: true }).fill('Asia/Shanghai');
  await dialog.getByLabel('Show Hidden', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Create view', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Project plan timeline', exact: true });
  const row = index => timeline.locator('[data-gantt-record="' + records[index].id + '"]');
  const bar = index => row(index).locator('.gantt-bar');
  await timeline.getByLabel('Timeline start', { exact: true }).fill('2024-02-26');
  await bar(0).waitFor();
  assert.equal(await timeline.locator('.gantt-row').count(), 50);
  assert.equal(await timeline.locator('.gantt-axis > span').count(), 42);
  const current = index => call(root + '/records/' + records[index].id);
  const waitDates = async (index, from, to) => {
    await page.waitForFunction(({ id, from, to }) => {
      const bar = document.querySelector('[data-gantt-record="' + id + '"] .gantt-bar');
      return bar && !bar.disabled && bar.getAttribute('aria-label').endsWith(from + ' to ' + to);
    }, { id: records[index].id, from, to });
    const record = await current(index);
    assert.equal(record.values[start], from); assert.equal(record.values[end], to);
  };
  await bar(0).focus(); await page.keyboard.press('ArrowRight');
  await waitDates(0, '2024-03-01', '2024-03-03');
  assert.equal(await bar(0).evaluate(element => document.activeElement === element), true, 'Saving a keyboard move retains bar focus.');
  await page.keyboard.press('Shift+ArrowRight'); await waitDates(0, '2024-03-01', '2024-03-04');
  await page.keyboard.press('Alt+ArrowRight'); await waitDates(0, '2024-03-02', '2024-03-04');
  await page.keyboard.press('ArrowLeft'); await waitDates(0, '2024-03-01', '2024-03-03');
  const drag = async (index, selector, days, commit = true) => {
    const target = selector ? bar(index).locator(selector) : bar(index);
    await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); assert.ok(box);
    const before = await current(index);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + days * 40, box.y + box.height / 2, { steps: 4 });
    assert.deepEqual(await current(index), before, 'Dragging previews without writing.');
    if (!commit) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (!commit) assert.deepEqual(await current(index), before);
  };
  await drag(0, undefined, 2); await waitDates(0, '2024-03-03', '2024-03-05');
  await drag(0, '.gantt-grip.end', 1); await waitDates(0, '2024-03-03', '2024-03-06');
  await drag(0, '.gantt-grip.start', -1); await waitDates(0, '2024-03-02', '2024-03-06');
  await drag(0, undefined, 2, false); await waitDates(0, '2024-03-02', '2024-03-06');
  await drag(0, undefined, -12, false); await waitDates(0, '2024-03-02', '2024-03-06');
  await timeline.getByLabel('Schedule action', { exact: true }).selectOption('move');
  await timeline.getByLabel('Schedule days', { exact: true }).fill('-1');
  await timeline.getByRole('button', { name: 'Apply date change', exact: true }).click();
  await waitDates(0, '2024-03-01', '2024-03-05');
  await page.getByRole('button', { name: 'Undo saved change', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo operation', exact: true }).click();
  await dialog.getByRole('button', { name: 'Undo all changes', exact: true }).click();
  await waitDates(0, '2024-03-02', '2024-03-06');
  await bar(0).focus(); await page.keyboard.press('Enter');
  assert.equal(await dialog.getByLabel('Hidden', { exact: true }).inputValue(), 'Complete details 0');
  await dialog.getByLabel('Name', { exact: true }).fill('Edited timeline task');
  await closeSavedRecord(page);
  await row(0).getByRole('button', { name: 'Edited timeline task', exact: true }).waitFor();
  assert.equal(await timeline.getByLabel('Timeline start', { exact: true }).inputValue(), '2024-02-26');
  await timeline.getByRole('button', { name: 'Next records', exact: true }).click();
  await timeline.getByText('51–56 of 56 records', { exact: true }).waitFor();
  await row(53).getByRole('button', { name: 'Set a start date', exact: true }).click();
  await dialog.getByLabel('Start', { exact: true }).fill('2024-02-29');
  await closeSavedRecord(page);
  await bar(53).waitFor();
  await row(54).getByRole('button', { name: 'Check date range', exact: true }).click();
  await dialog.getByLabel('End', { exact: true }).fill('2024-03-01');
  await closeSavedRecord(page);
  await bar(54).waitFor();
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.fill('Edited timeline task');
  await timeline.getByText('1–1 of 1 record', { exact: true }).waitFor();
  await bar(0).waitFor(); assert.equal(await timeline.locator('.gantt-row').count(), 1);
  await search.fill('');
  await timeline.getByText('51–56 of 56 records', { exact: true }).waitFor();
  await timeline.getByRole('button', { name: 'Previous records', exact: true }).click();
  await bar(0).waitFor();
  await timeline.getByLabel('Timeline start', { exact: true }).fill('2024-03-02');
  await bar(1).focus(); await page.keyboard.press('Shift+ArrowLeft');
  await row(1).getByRole('button', { name: 'Before range · Show date', exact: true }).waitFor();
  await page.waitForFunction(id => document.activeElement?.getAttribute('data-gantt-focus') === 'title:' + id, records[1].id);
  assert.equal((await current(1)).values[end], '2024-03-01');
  await row(1).getByRole('button', { name: 'Before range · Show date', exact: true }).click();
  await bar(1).waitFor();
  await timeline.getByLabel('Timeline start', { exact: true }).fill('2024-02-26');
  let configured = (await call(root + '/views')).find(view => view.name === 'Project plan');
  configured = await call(root + '/views/' + configured.id, 'PATCH', { expectedVersion: configured.version,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: start, operator: 'gte', value: '2024-03-02' }] } } });
  await timeline.focus(); await timeline.getByText('1–1 of 1 record', { exact: true }).waitFor();
  await bar(0).focus(); await page.keyboard.press('ArrowLeft');
  await timeline.getByText('No matching records.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement === document.querySelector('.gantt-view'));
  assert.equal((await current(0)).values[start], '2024-03-01');
  configured = await call(root + '/views/' + configured.id, 'PATCH', { expectedVersion: configured.version, query: {} });
  await timeline.focus(); await bar(0).waitFor();
  await timeline.getByLabel('Timeline scale', { exact: true }).selectOption('week');
  await timeline.locator('.gantt-axis > span').nth(167).waitFor();
  await timeline.getByLabel('Timeline scale', { exact: true }).selectOption('day');
  await page.waitForFunction(() => document.querySelectorAll('.gantt-axis > span').length === 42);
  await resize(1440, 1100); await bar(0).focus();
  await page.screenshot({ path: '.artifacts/desktop-gantt-day.png' });
  await resize(1024, 768);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await timeline.locator('.gantt-viewport').evaluate(element => element.getBoundingClientRect().height >= 180));
  await page.screenshot({ path: '.artifacts/desktop-gantt-narrow.png' });
  await resize(...originalSize);
  const view = (await call(root + '/views')).find(view => view.name === 'Project plan');
  console.log('Gantt creation, bounded pages, keyboard/pointer scheduling, cancel, undo, record forms, exceptions and layouts passed.');
  return { table, root, name, start, end, at, hidden, records, view };
}

export async function verifyGanttAfterRestart(page, fixture) {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Gantt lab', exact: true }).click();
  const timeline = page.getByRole('region', { name: 'Project plan timeline', exact: true });
  await timeline.getByLabel('Timeline start', { exact: true }).fill('2024-02-26');
  await timeline.getByRole('button', { name: 'Edited timeline task', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Gantt start field', { exact: true }).inputValue(), fixture.start);
  assert.equal(await dialog.getByLabel('Gantt end field', { exact: true }).inputValue(), fixture.end);
  assert.equal(await dialog.getByLabel('Gantt time zone', { exact: true }).inputValue(), 'Asia/Shanghai');
  assert.equal(await dialog.getByLabel('Gantt scale', { exact: true }).inputValue(), 'day');
  await cancelDialog(page);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  console.log('Gantt settings and changed record dates survived restart.');
}
