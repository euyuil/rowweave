import assert from 'node:assert/strict';
import { galleryApi } from './gallery-workflow.mjs';
import { waitForResponse } from './wait-for-response.mjs';

export async function verifyGalleryRefresh(page, fixture) {
  const { root, name, cover, records, image, focusImage, hidden } = fixture;
  let { table, view } = fixture;
  const call = galleryApi(page), gallery = page.getByRole('region', { name: 'Collection gallery', exact: true });
  const dialog = page.getByRole('dialog');
  const card = index => gallery.locator('[data-gallery-record="' + records[index].id + '"]');
  const title = index => card(index).locator('.gallery-title');
  const current = index => call(root + '/records/' + records[index].id);
  const update = async (index, values) => { const record = await current(index);
    return call(root + '/records', 'PATCH', [{ id: record.id, expectedVersion: record.version, values }]); };
  await title(4).focus();
  await page.waitForFunction(id => document.querySelector('[data-gallery-record="' + id + '"] img')?.naturalWidth === 640, records[4].id);
  const coverUrl = await card(4).locator('img').getAttribute('src');
  await gallery.locator('.gallery-viewport').evaluate(element => { window.galleryViewport = element; });
  const scroll = await gallery.locator('.gallery-viewport').evaluate(element => element.scrollTop);
  const downloads = [], capture = request => {
    if (request.method() === 'GET' && request.url().endsWith(root + '/attachments/' + focusImage.id + '/content')) downloads.push(request.url());
  };
  page.on('request', capture);
  await update(4, { [name]: 'Remote card 004' });
  await title(4).filter({ hasText: 'Remote card 004' }).waitFor();
  assert.equal(await title(4).evaluate(element => element === document.activeElement), true);
  assert.equal(await gallery.locator('.gallery-viewport').evaluate(element => element === window.galleryViewport && element.scrollTop), scroll);
  assert.equal(downloads.length, 0, 'An unrelated record update does not download the already loaded visible cover again.');
  assert.equal(await card(4).locator('img').getAttribute('src'), coverUrl, 'The visible cover keeps its existing image URL.');
  page.off('request', capture);
  await title(5).click();
  const input = dialog.getByLabel('Name', { exact: true });
  await input.fill('图库草稿'); await input.dispatchEvent('compositionstart');
  await update(6, { [name]: 'Remote card 006' });
  await page.getByText('Updates are available. Finish editing to load them automatically, or use Refresh view to keep cell drafts. Reload resets local undo history.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '图库草稿'); assert.equal(await input.evaluate(element => element === document.activeElement), true);
  await input.dispatchEvent('compositionend', { data: '图库草稿' });
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await title(5).filter({ hasText: '图库草稿' }).waitFor(); await title(6).filter({ hasText: 'Remote card 006' }).waitFor();

  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Outside gallery' }] } } });
  await page.getByRole('button', { name: 'Filters', exact: true }).getByText('On', { exact: true }).waitFor();
  await title(7).focus(); await update(7, { [name]: 'Outside gallery' });
  await title(7).waitFor({ state: 'detached' });
  assert.equal(await gallery.evaluate(element => element === document.activeElement), true, 'Filtering out the focused card restores gallery focus.');
  await update(7, { [name]: 'Card 007' }); await title(7).waitFor();
  await title(9).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await title(9).evaluate(element => element === document.activeElement), true, 'Cancelling details retains card focus.');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Name', { exact: true }).fill('Outside gallery');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await title(9).waitFor({ state: 'detached' });
  assert.equal(await gallery.evaluate(element => element === document.activeElement), true, 'Saving outside the filter returns focus to the gallery.');
  await update(9, { [name]: 'Card 009' }); await title(9).waitFor();

  let release, arrived, finished, pageFailure, intercepted = false;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { arrived = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const path = '**' + root + '/views/' + view.id + '/query';
  const slowPage = async route => {
    if (intercepted || route.request().postDataJSON().limit !== 40) return route.continue();
    intercepted = true;
    try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
    catch (error) { pageFailure = error; }
    finally { finished(); }
  };
  await page.route(path, slowPage);
  try {
    await gallery.focus(); await update(8, { [name]: 'Remote card 008' }); await waitForResponse(ready, 'Gallery refresh page');
    await gallery.getByRole('button', { name: 'Next records', exact: true }).click();
    release(); await waitForResponse(settled, 'Released gallery page');
    await title(44).waitFor(); assert.equal(await gallery.locator('.gallery-card').count(), 5);
    assert.equal(await title(8).count(), 0, 'An obsolete refresh does not replace the newly selected page.');
  } finally { release(); if (intercepted) await waitForResponse(settled, 'Gallery page cleanup'); await page.unroute(path, slowPage); }
  assert.equal(pageFailure, undefined);
  await gallery.focus();
  await call(root + '/records', 'DELETE', await Promise.all(records.slice(38).map(async record => {
    const current = await call(root + '/records/' + record.id); return { id: current.id, expectedVersion: current.version };
  })));
  await title(8).filter({ hasText: 'Remote card 008' }).waitFor();
  await gallery.getByText('1–38 of 38 records', { exact: true }).waitFor();
  assert.equal(await gallery.locator('.gallery-card').count(), 38);

  table = await call(root);
  table = await call(root + '/fields', 'POST', { expectedVersion: table.version, name: 'New cover', type: 'attachment' });
  const replacement = table.fields.at(-1).id;
  await update(0, { [replacement]: [image.id] });
  view = await call(root + '/views/' + view.id);
  view = await call(root + '/views/' + view.id, 'PATCH', { expectedVersion: view.version,
    gallery: { ...view.gallery, coverFieldId: replacement }, columns: view.columns.map(column => ({ ...column, hidden: column.fieldId === hidden || column.fieldId === cover || column.fieldId === replacement })) });
  table = await call(root + '/fields/' + cover, 'DELETE', { expectedVersion: table.version });
  await gallery.focus();
  await page.waitForFunction(id => document.querySelector('[data-gallery-record="' + id + '"] img')?.naturalWidth === 640, records[0].id);
  await card(4).getByText('No cover', { exact: true }).waitFor();
  assert.equal(await gallery.locator('.gallery-card').count(), 38);
  const unavailable = route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Gallery temporarily unavailable.' } }) });
  await page.route(path, unavailable);
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Gallery temporarily unavailable.' }).waitFor();
    assert.equal(await title(0).count(), 1, 'A failed refresh leaves the previous complete snapshot visible.');
  } finally { await page.unroute(path, unavailable); }
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Gallery temporarily unavailable.' }).waitFor({ state: 'detached' });
  await title(0).waitFor();
  console.log('Gallery external updates preserve focus, scroll and composition drafts; obsolete pages, removed pages, schema replacement and failed reads are handled.');
  return { ...fixture, table, view, cover: replacement };
}
