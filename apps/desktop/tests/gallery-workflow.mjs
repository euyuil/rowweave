import { waitForLiveSync, closeSavedRecord, cancelDialog } from '../../../tests/live-ui.mjs';
import assert from 'node:assert/strict';
import { waitForResponse } from './wait-for-response.mjs';

export function galleryApi(page) {
  return (path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const connection = await window.rowweave.connection();
    const response = await fetch(connection.url + path, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(await response.text()); return response.json();
  }, { path, method, body });
}

export async function galleryArtwork(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, 640, 360);
    gradient.addColorStop(0, '#203c6c'); gradient.addColorStop(1, '#5a99bb');
    context.fillStyle = gradient; context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#f4dcad'; context.beginPath(); context.arc(470, 100, 45, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#3f7b8c'; context.beginPath(); context.moveTo(0, 280); context.lineTo(210, 90); context.lineTo(420, 360); context.lineTo(0, 360); context.fill();
    context.fillStyle = '#244c70'; context.beginPath(); context.moveTo(120, 360); context.lineTo(390, 160); context.lineTo(640, 360); context.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
}

export async function verifyGalleryWorkflow(page, application) {
  const originalSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const resize = async size => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
    await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size);
  };
  const call = galleryApi(page), dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '+ New table', exact: true }).click();
  await dialog.getByLabel('Table name', { exact: true }).fill('Gallery lab');
  await dialog.getByRole('button', { name: 'Create table', exact: true }).click();
  await page.getByRole('heading', { name: 'Gallery lab', exact: true }).waitFor();
  let table = (await call('/tables')).find(table => table.name === 'Gallery lab');
  const root = '/tables/' + table.id, name = table.primaryFieldId;
  for (const field of [{ name: 'Files', type: 'attachment' }, { name: 'Status', type: 'singleSelect', options: [{ id: 'ready', name: 'Ready', color: '#315CBE' }] },
    { name: 'Notes', type: 'multiline' }, { name: 'Hidden', type: 'text' }]) {
    table = await call(root + '/fields', 'POST', { ...field, expectedVersion: table.version });
  }
  const [, cover, status, notes, hidden] = table.fields.map(field => field.id);
  const upload = (filename, mediaType, data) => call(root + '/attachments', 'POST', { filename, mediaType, data });
  const artwork = await galleryArtwork(page);
  const image = await upload('landscape.png', 'image/png', artwork);
  const focusImage = await upload('focused-card.png', 'image/png', artwork);
  const document = await upload('notes.pdf', 'application/pdf', Buffer.from('Test document').toString('base64'));
  const broken = await upload('broken.png', 'image/png', Buffer.from('Not an image').toString('base64'));
  const records = (await call(root + '/records', 'POST', Array.from({ length: 45 }, (_, index) => ({ values: {
    [name]: 'Card ' + String(index).padStart(3, '0'), [cover]: index === 0 ? [document.id, image.id] : index === 1 ? [document.id]
      : index === 2 ? [broken.id] : index === 3 ? [] : index === 4 ? [focusImage.id] : [image.id], [status]: 'ready',
    [notes]: index === 0 ? 'A long note with multiple lines.\nSecond line, preserved in the full editor.\nThird line.' : 'A place for ideas and the details that matter.',
    [hidden]: 'Complete details ' + index,
  } })))).records;
  await waitForLiveSync(page);
  await page.getByText('45 records · 5 fields', { exact: true }).waitFor();
  const reads = [], downloads = [];
  const capture = request => {
    if (request.url().includes('/views/') && request.url().endsWith('/query')) reads.push(request.postDataJSON());
    if (request.method() === 'GET' && request.url().includes(root + '/attachments/')) downloads.push(request.url());
  };
  page.on('request', capture);
  await page.getByRole('button', { name: 'New view', exact: true }).click();
  await dialog.getByLabel('View name', { exact: true }).fill('Collection');
  await dialog.getByLabel('View type', { exact: true }).selectOption('gallery');
  await dialog.getByLabel('Gallery cover field', { exact: true }).selectOption(cover);
  await dialog.getByLabel('Show Files', { exact: true }).uncheck();
  await dialog.getByLabel('Show Name', { exact: true }).uncheck();
  await dialog.getByLabel('Show Hidden', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Create view', exact: true }).click();
  const gallery = page.getByRole('region', { name: 'Collection gallery', exact: true });
  const card = index => gallery.locator('[data-gallery-record="' + records[index].id + '"]');
  const title = index => card(index).locator('.gallery-title');
  await title(0).waitFor();
  assert.equal(await gallery.locator('.gallery-card').count(), 40);
  await page.waitForFunction(id => document.querySelector('[data-gallery-record="' + id + '"] img')?.naturalWidth === 640, records[0].id);
  await card(2).getByText('Preview unavailable', { exact: true }).waitFor();
  assert.equal(await card(1).getByText('notes.pdf', { exact: true }).count(), 1);
  assert.equal(await card(3).getByText('No cover', { exact: true }).count(), 1);
  assert.equal(await gallery.getByText('Hidden', { exact: true }).count(), 0);
  assert.ok(downloads.length > 0 && downloads.length < 30, 'Only covers near the viewport download initially.');
  assert.equal(await card(0).locator('.select-value').count() > 0, true);
  await title(0).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await title(1).evaluate(element => element === window.document.activeElement), true);
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  assert.equal(await dialog.getByLabel('Hidden', { exact: true }).inputValue(), 'Complete details 0');
  assert.equal(await dialog.getByLabel('Notes', { exact: true }).inputValue(), records[0].values[notes]);
  await dialog.getByLabel('Name', { exact: true }).fill('Edited gallery card');
  await closeSavedRecord(page);
  await title(0).filter({ hasText: 'Edited gallery card' }).waitFor();
  assert.equal(await title(0).evaluate(element => element === window.document.activeElement), true, 'Saving record details returns keyboard focus to its card.');
  await gallery.getByRole('button', { name: 'Next records', exact: true }).click();
  await title(44).waitFor(); assert.equal(await gallery.locator('.gallery-card').count(), 5);
  await gallery.getByText('41–45 of 45 records', { exact: true }).waitFor();
  await gallery.getByRole('button', { name: 'Previous records', exact: true }).click(); await title(0).waitFor();
  const search = page.getByRole('searchbox', { name: 'Search records', exact: true });
  await search.fill('Edited gallery card'); await gallery.getByText('1–1 of 1 record', { exact: true }).waitFor();
  await title(0).waitFor(); assert.equal(await gallery.locator('.gallery-card').count(), 1);
  await search.fill('no-such-card'); await gallery.getByText('No matching records.', { exact: true }).waitFor();
  await search.fill(''); await title(39).waitFor();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await dialog.getByLabel('Gallery card size', { exact: true }).selectOption('small');
  await dialog.getByLabel('Gallery cover fit', { exact: true }).selectOption('contain');
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await gallery.locator('.gallery-cover').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.gallery-view')?.classList.contains('gallery-small'));
  let view = (await call(root + '/views')).find(view => view.name === 'Collection');
  assert.deepEqual(view.gallery, { cardSize: 'small', coverFit: 'contain', coverFieldId: cover });
  await resize([1440, 1100]);
  await page.screenshot({ path: '.artifacts/desktop-gallery-wide.png' });
  await resize([1024, 768]);
  assert.equal(await gallery.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: '.artifacts/desktop-gallery-narrow.png' });
  assert.ok(reads.filter(read => read.limit === 40).every(read => read.fields.includes(name) && read.fields.includes(cover) && !read.fields.includes(hidden)));
  assert.ok(reads.every(read => read.limit <= 100));
  page.off('request', capture); await resize(originalSize);
  await verifyCoverLifecycle(page, { root, image });
  console.log('Gallery configuration, lazy image covers, explicit file failures, keyboard navigation, editing, paging, search and narrow layout passed.');
  return { table, root, name, cover, status, notes, hidden, image, focusImage, records, view };
}

async function verifyCoverLifecycle(page, { root, image }) {
  await page.getByRole('tab', { name: 'All records', exact: true }).click();
  await page.locator('.gallery-view').waitFor({ state: 'detached' });
  await page.evaluate(() => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    window.galleryUrls = { create, revoke, active: new Set(), created: 0 };
    URL.createObjectURL = value => { const url = create(value); window.galleryUrls.active.add(url); window.galleryUrls.created++; return url; };
    URL.revokeObjectURL = url => { window.galleryUrls.active.delete(url); revoke(url); };
  });
  let release, arrived, aborted, finished, request, intercepted = false;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { arrived = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; }), settled = new Promise(resolve => { finished = resolve; });
  const path = '**' + root + '/attachments/' + image.id + '/content';
  const slowCover = async route => {
    if (intercepted) return route.continue();
    intercepted = true; request = route.request(); arrived();
    try { await held; await route.abort(); } finally { finished(); }
  };
  const failed = candidate => { if (candidate === request) aborted(); };
  page.on('requestfailed', failed); await page.route(path, slowCover);
  try {
    await page.getByRole('tab', { name: 'Collection', exact: true }).click();
    await waitForResponse(ready, 'held gallery cover');
    await page.waitForFunction(() => window.galleryUrls.created > 0);
    await page.getByRole('tab', { name: 'All records', exact: true }).click();
    await page.locator('.gallery-view').waitFor({ state: 'detached' });
    await waitForResponse(cancelled, 'gallery cover cancellation before releasing its response');
    assert.equal(await page.evaluate(() => window.galleryUrls.active.size), 0, 'Unmounting cards releases every generated image URL.');
  } finally {
    release(); if (intercepted) await waitForResponse(settled, 'gallery cover cleanup');
    await page.unroute(path, slowCover); page.off('requestfailed', failed);
    await page.evaluate(() => { URL.createObjectURL = window.galleryUrls.create; URL.revokeObjectURL = window.galleryUrls.revoke; delete window.galleryUrls; });
  }
  await page.getByRole('tab', { name: 'Collection', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.gallery-cover img')?.naturalWidth === 640);
  console.log('Gallery cover requests cancel and image URLs are released when leaving the view.');
}

export async function verifyGalleryAfterRestart(page, fixture) {
  await page.getByRole('button', { name: 'Gallery lab', exact: true }).click();
  const gallery = page.getByRole('region', { name: 'Collection gallery', exact: true });
  await gallery.locator('.gallery-title').first().waitFor();
  const call = galleryApi(page), view = await call(fixture.root + '/views/' + fixture.view.id);
  assert.equal(view.type, 'gallery'); assert.deepEqual(view.gallery, fixture.view.gallery);
  assert.equal(await gallery.evaluate(element => element.classList.contains('gallery-small')), true);
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByLabel('Gallery cover field', { exact: true }).inputValue(), view.gallery.coverFieldId ?? '');
  await cancelDialog(page);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete table', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('Saved gallery settings and cards survived desktop restart.');
}
