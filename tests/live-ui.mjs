import assert from 'node:assert/strict';
const connections = new WeakMap();
export function registerLiveConnection(page, connection) { connections.set(page, connection); }
export async function requestLiveSync(page) { await page.locator('.table-title h1').click(); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); }
export async function waitForLiveSync(page) {
  const connection = connections.get(page) ?? await page.evaluate(() => window.rowweave.connection());
  const tableId = await page.locator('.table-workspace').getAttribute('data-table-id');
  const response = await fetch(connection.url + '/workspace/state', { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId }) });
  assert.equal(response.status, 200);
  const { table } = await response.json();
  await requestLiveSync(page);
  try {
    await page.waitForFunction(table => {
      const workspace = document.querySelector('.table-workspace');
      return Number(workspace?.dataset.revision) >= table.dataRevision && Number(workspace?.dataset.schemaVersion) >= table.schemaVersion &&
        Number(workspace?.dataset.viewsRevision) >= table.viewsRevision;
    }, table);
  } catch (error) {
    const rendered = await page.locator('.table-workspace').evaluate(element => ({ ...element.dataset }));
    throw new Error(`Live sync did not reach ${JSON.stringify(table)}; rendered ${JSON.stringify(rendered)}.`, { cause: error });
  }
}
export async function waitForAutosave(page) {
  if (await page.getByRole('textbox', { name: 'Cell value', exact: true }).count()) await page.keyboard.press('Control+s');
  await page.locator('.table-workspace footer').getByText('All changes saved', { exact: true }).waitFor();
}
export async function closeSavedRecord(page) {
  const dialog = page.getByRole('dialog');
  await dialog.locator('.record-save-status').filter({ hasText: /^All changes saved$/ }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
export async function cancelDialog(page) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  if (await dialog.locator('.record-sections').count()) {
    await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
    const discard = dialog.getByRole('button', { name: 'Discard changes', exact: true });
    if (await discard.count()) await discard.click();
  } else await page.getByRole('button', { name: 'Cancel', exact: true }).click();
}
