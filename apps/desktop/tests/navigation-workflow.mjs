import assert from 'node:assert/strict';

export async function verifyNavigationWorkflow(page, application) {
  const previousSize = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const size = window.getSize();
    window.setSize(1024, 768);
    return size;
  });
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await page.getByLabel('Table name', { exact: true }).fill('Navigation lab');
  await page.getByRole('dialog').getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Navigation lab', exact: true }).waitFor();
  const names = await page.evaluate(async () => {
    const connection = await window.rowweave.connection();
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const table = (await fetch(`${connection.url}/tables`, { headers }).then(response => response.json()))
      .find(table => table.name === 'Navigation lab');
    const names = [];
    for (let index = 1; index <= 12; index++) {
      const name = `Team ${index} — a longer saved view name`;
      const response = await fetch(`${connection.url}/tables/${table.id}/views`, {
        method: 'POST', headers, body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error('Could not prepare navigation views.');
      names.push(name);
    }
    return names;
  });
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Views', exact: true });
  await tabs.getByRole('tab', { name: names.at(-1), exact: true }).waitFor({ state: 'attached' });
  const initial = tabs.getByRole('tab', { name: 'All records', exact: true });
  await initial.focus();
  await page.keyboard.press('End');
  assert.equal(await initial.getAttribute('aria-selected'), 'true');
  const last = tabs.getByRole('tab', { name: names.at(-1), exact: true });
  assert.equal(await last.evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  await page.getByRole('tabpanel', { name: names.at(-1), exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-disabled') === 'false');
  assert.equal(await last.evaluate(element => element === document.activeElement), true);
  const bounds = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]').getBoundingClientRect();
    const selected = document.querySelector('[role="tab"][aria-selected="true"]').getBoundingClientRect();
    const grid = document.querySelector('.grid-host').getBoundingClientRect();
    const create = document.querySelector('button[aria-label="New view"]').getBoundingClientRect();
    return { list: { left: list.left, right: list.right }, selected: { left: selected.left, right: selected.right },
      gridHeight: grid.height, createRight: create.right, viewport: innerWidth, contentWidth: document.documentElement.scrollWidth };
  });
  assert.ok(bounds.selected.left >= bounds.list.left - 1 && bounds.selected.right <= bounds.list.right + 1);
  assert.ok(bounds.createRight <= bounds.viewport);
  assert.ok(bounds.gridHeight >= 400, `Expected room for records at 1024 × 768; got ${bounds.gridHeight}px.`);
  assert.equal(bounds.contentWidth, bounds.viewport);
  await page.screenshot({ path: '.artifacts/desktop-view-tabs.png' });
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.getByRole('tabpanel', { name: 'All records', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), previousSize);
}
