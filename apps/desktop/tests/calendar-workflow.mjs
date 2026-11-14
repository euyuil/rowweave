import assert from 'node:assert/strict';

export async function verifyCalendarWorkflow(page, application) {
  const originalSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const resize = async (width, height) => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
  };
  const call = (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Calendar lab');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Calendar lab', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await dialog.getByLabel('View type', { exact: true }).selectOption('calendar');
  await dialog.getByText('Add a date or timestamp field in Manage fields before creating a calendar.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Create view', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  let table = (await call('/tables')).find(table => table.name === 'Calendar lab');
  const root = '/tables/' + table.id, name = table.primaryFieldId;
  for (const field of [{ name: 'Start', type: 'date' }, { name: 'End', type: 'date' }, { name: 'At', type: 'datetime' },
    { name: 'Status', type: 'singleSelect', options: [{ id: 'todo', name: 'To do', color: '#315CBE' }] }, { name: 'Hidden', type: 'text' }]) {
    table = await call(root + '/fields', 'POST', { ...field, expectedVersion: table.version });
  }
  const [, start, end, at, status, hidden] = table.fields.map(field => field.id);
  const records = (await call(root + '/records', 'POST', [
    ...Array.from({ length: 53 }, (_, i) => ({ values: { [name]: 'Task ' + String(i).padStart(3, '0'), [start]: '2024-02-29',
      [end]: i === 0 ? '2024-03-02' : null, [status]: 'todo', [hidden]: 'Complete details ' + i } })),
    { values: { [name]: 'Unscheduled task' } }, { values: { [name]: 'Reversed range', [start]: '2024-02-29', [end]: '2024-02-27' } },
    { values: { [name]: 'Timed task', [at]: '2024-02-28T18:30:00.000Z' } },
  ])).records;
  const reads = [];
  const capture = request => { if (/\/calendar\/(query|records)$/.test(request.url())) reads.push({ url: request.url(), input: request.postDataJSON() }); };
  page.on('request', capture);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByText('56 records · 6 fields', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await dialog.getByLabel('View name', { exact: true }).fill('Schedule');
  await dialog.getByLabel('View type', { exact: true }).selectOption('calendar');
  await dialog.getByLabel('Calendar start field', { exact: true }).selectOption(start);
  await dialog.getByLabel('Calendar end field', { exact: true }).selectOption(end);
  await dialog.getByLabel('Calendar time zone', { exact: true }).fill('Asia/Shanghai');
  await dialog.getByLabel('Show Hidden', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Create view', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Schedule calendar', exact: true });
  await calendar.getByLabel('Calendar month', { exact: true }).fill('2024-02');
  const day = date => calendar.locator('[data-calendar-date="' + date + '"]');
  await day('2024-02-29').getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  assert.equal(await calendar.locator('[role="gridcell"]').count(), 42);
  assert.equal(await day('2024-02-29').locator('.calendar-preview').count(), 2);
  await day('2024-02-29').getByRole('button', { name: '+51 more', exact: true }).click();
  const pane = calendar.getByRole('complementary', { name: 'Calendar records', exact: true });
  await pane.getByRole('button', { name: 'Task 024', exact: true }).waitFor();
  assert.equal(await pane.locator('.calendar-record-card').count(), 25);
  await pane.getByRole('button', { name: 'Next', exact: true }).click();
  await pane.getByRole('button', { name: 'Task 025', exact: true }).waitFor();
  await pane.getByText('26–50 of 53', { exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Task 025', exact: true }).click();
  assert.equal(await dialog.getByLabel('Hidden', { exact: true }).inputValue(), 'Complete details 25');
  await dialog.getByLabel('Name', { exact: true }).fill('Edited calendar task');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await pane.getByRole('button', { name: 'Edited calendar task', exact: true }).waitFor();
  assert.equal(await calendar.getByLabel('Calendar month', { exact: true }).inputValue(), '2024-02');
  await pane.getByRole('button', { name: 'Next', exact: true }).click();
  await pane.getByText('51–53 of 53', { exact: true }).waitFor();
  assert.equal(await pane.locator('.calendar-record-card').count(), 3);
  await calendar.getByRole('button', { name: 'Unscheduled (2)', exact: true }).click();
  await pane.getByRole('button', { name: 'Unscheduled task', exact: true }).waitFor();
  await pane.getByRole('button', { name: 'Unscheduled task', exact: true }).click();
  await dialog.getByLabel('Start', { exact: true }).fill('2024-02-29');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await calendar.getByRole('button', { name: 'Unscheduled (1)', exact: true }).waitFor();
  await calendar.getByRole('button', { name: 'Invalid dates (1)', exact: true }).click();
  await pane.getByRole('button', { name: 'Reversed range', exact: true }).click();
  await dialog.getByLabel('End', { exact: true }).fill('2024-03-01');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await pane.getByText('No matching records.', { exact: true }).waitFor();
  const heading = calendar.locator('[data-calendar-day="2024-02-29"]');
  // Initialize the test poller's native frame callback before delaying application frames.
  await page.waitForFunction(() => !!document.querySelector('.calendar-records'));
  const releaseFrames = await page.evaluateHandle(() => {
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    const pending = new Map();
    let next = -1;
    window.requestAnimationFrame = callback => { const id = next--; pending.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (!pending.delete(id)) cancel.call(window, id); };
    return () => {
      window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel;
      const callbacks = [...pending.values()]; pending.clear();
      for (const callback of callbacks) callback(performance.now());
    };
  });
  try {
    await calendar.getByRole('button', { name: 'Close calendar records', exact: true }).evaluate(element => element.click());
    await page.waitForFunction(() => !document.querySelector('.calendar-records'), undefined, { polling: 10 });
    await heading.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-calendar-day') === '2024-03-01', undefined, { polling: 10 });
    await releaseFrames.evaluate(release => release());
    assert.equal(await page.locator(':focus').getAttribute('data-calendar-day'), '2024-03-01');
  } finally {
    await releaseFrames.evaluate(release => release());
    await releaseFrames.dispose();
  }
  await page.keyboard.press('Home');
  assert.equal(await page.locator(':focus').getAttribute('data-calendar-day'), '2024-02-26');
  await page.keyboard.press('Enter');
  await pane.getByRole('heading', { name: 'Monday, February 26, 2024', exact: true }).waitFor();
  await pane.getByRole('button', { name: '+ New record on this date', exact: true }).click();
  assert.equal(await dialog.getByLabel('Start', { exact: true }).inputValue(), '2024-02-26');
  assert.equal(await dialog.getByLabel('End', { exact: true }).inputValue(), '2024-02-26');
  await dialog.getByLabel('Name', { exact: true }).fill('Created on calendar');
  await dialog.getByRole('button', { name: 'Create record', exact: true }).click();
  await pane.getByRole('button', { name: 'Created on calendar', exact: true }).waitFor();
  await calendar.getByRole('button', { name: 'Close calendar records', exact: true }).click();
  await heading.focus(); await page.keyboard.press('PageDown');
  await calendar.getByRole('heading', { name: 'March 2024', exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-calendar-day') === '2024-03-29');
  await page.keyboard.press('PageUp');
  await calendar.getByRole('heading', { name: 'February 2024', exact: true }).waitFor();
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.fill('Edited calendar task');
  await day('2024-02-29').getByRole('button', { name: 'Edited calendar task', exact: true }).waitFor();
  assert.equal(await calendar.locator('.calendar-preview').count(), 1);
  await search.fill('');
  await day('2024-02-29').getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  await resize(1440, 1100);
  await calendar.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: '.artifacts/desktop-calendar-month.png' });
  await resize(1024, 768);
  await day('2024-02-29').locator('.calendar-day-heading').click();
  await pane.getByRole('button', { name: 'Task 024', exact: true }).waitFor();
  assert.ok(await calendar.locator('.calendar-month-scroll').evaluate(element => element.clientHeight >= 570), 'The month must not collapse into a small nested scroller.');
  assert.ok(await pane.evaluate(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight),
    'Opening a date brings the full record pane into the narrow viewport.');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '.artifacts/desktop-calendar-narrow.png' });
  await calendar.getByRole('button', { name: 'Close calendar records', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-calendar-day') === '2024-02-29');
  assert.ok(await heading.evaluate(element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight));
  await resize(...originalSize);
  await calendar.getByLabel('Calendar month', { exact: true }).fill('0001-01');
  await calendar.locator('[data-calendar-day="0001-01-01"]:enabled').waitFor();
  assert.equal(await calendar.getByRole('button', { name: 'Previous month', exact: true }).isDisabled(), true);
  await calendar.getByLabel('Calendar month', { exact: true }).fill('9999-11');
  await calendar.locator('[data-calendar-day="9999-11-01"]:enabled').waitFor();
  assert.equal(await calendar.getByRole('button', { name: 'Next month', exact: true }).isDisabled(), true);
  await calendar.getByLabel('Calendar month', { exact: true }).fill('2024-02');
  await day('2024-02-29').getByRole('button', { name: 'Task 000', exact: true }).waitFor();
  assert.ok(reads.filter(read => read.url.endsWith('/query')).every(read => read.input.previewLimit === 2));
  assert.ok(reads.filter(read => read.url.endsWith('/records')).every(read => read.input.limit === 25 && !read.input.fields.includes(hidden)));
  page.off('request', capture);
  const view = (await call(root + '/views')).find(view => view.name === 'Schedule');
  console.log('Calendar creation, bounded rendering, paging, record editing, exceptions, keyboard, search and narrow layout passed.');
  return { table, root, start, end, at, name, records, view };
}

export async function verifyCalendarAfterRestart(page, fixture) {
  await page.getByRole('navigation', { name: 'Tables', exact: true }).getByRole('button', { name: 'Calendar lab', exact: true }).click();
  const calendar = page.getByRole('region', { name: 'Schedule calendar', exact: true });
  await calendar.getByLabel('Calendar month', { exact: true }).fill('2024-02');
  await calendar.getByRole('button', { name: 'Created on calendar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'View settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Calendar start field', { exact: true }).inputValue(), fixture.start);
  assert.equal(await dialog.getByLabel('Calendar end field', { exact: true }).inputValue(), fixture.end);
  assert.equal(await dialog.getByLabel('Calendar time zone', { exact: true }).inputValue(), 'Asia/Shanghai');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  console.log('Calendar saved settings and records survived restart.');
}
