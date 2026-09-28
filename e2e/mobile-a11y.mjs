// R7 and accessibility: mobile delete, search name, keyboard-operable import (including
// honest restore of previously deleted notes) and mobile sidebar state.
import assert from 'node:assert/strict';
import { baseUrl, chromium, freshPage, noteTitles, sleep, waitFor } from './support.mjs';

async function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
}

async function sidebarState(page) {
  return page.evaluate(() => ({
    expanded: document.getElementById('open-sidebar').getAttribute('aria-expanded'),
    controls: document.getElementById('open-sidebar').getAttribute('aria-controls'),
    inert: document.getElementById('sidebar').inert,
    open: document.getElementById('sidebar').classList.contains('open'),
    focus: document.activeElement?.id || document.activeElement?.tagName,
    focusInSidebar: document.getElementById('sidebar').contains(document.activeElement),
  }));
}

async function newMobileNote(page, title) {
  await page.locator('#open-sidebar').click();
  await page.locator('#new-note').click();
  await page.locator('#note-title').fill(title);
  await sleep(450);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const page = await freshPage(context);

  // ---- mobile delete ----
  await newMobileNote(page, 'Mobile delete target');
  const deleteButton = page.getByRole('button', { name: 'Delete note' });
  assert.equal(await deleteButton.count(), 1, 'delete has an accessible name');
  assert.equal(await deleteButton.isVisible(), true, 'delete is visible on mobile');
  const box = await deleteButton.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, `delete inside viewport (${JSON.stringify(box)})`);
  assert.ok(box.width >= 44 && box.height >= 44, `delete tap target at least 44x44 (${box.width}x${box.height})`);
  assert.ok((await horizontalOverflow(page)) <= 0, 'no horizontal overflow at 375px');
  for (const id of ['open-sidebar', 'sync-button']) {
    const control = await page.locator(`#${id}`).boundingBox();
    assert.ok(control.height >= 44, `#${id} tap target height`);
  }
  let dialogMessage = '';
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    dialog.accept();
  });
  await deleteButton.tap();
  assert.match(dialogMessage, /Mobile delete target/);
  await waitFor(async () => !(await noteTitles(page)).includes('Mobile delete target'), { message: 'note deleted on mobile' });
  // Keyboard users can reach and activate delete too.
  await newMobileNote(page, 'Keyboard delete target');
  await deleteButton.focus();
  page.once('dialog', (dialog) => dialog.accept());
  await page.keyboard.press('Enter');
  await waitFor(async () => !(await noteTitles(page)).includes('Keyboard delete target'), { message: 'keyboard delete' });
  assert.ok((await horizontalOverflow(page)) <= 0);

  // ---- mobile sidebar: expanded state, inert, Escape ----
  let state = await sidebarState(page);
  assert.deepEqual([state.expanded, state.controls, state.inert, state.open], ['false', 'sidebar', true, false]);
  await page.locator('#open-sidebar').focus();
  await page.keyboard.press('Tab');
  assert.equal((await sidebarState(page)).focusInSidebar, false, 'closed sidebar is not in the focus order');
  await page.locator('#open-sidebar').click();
  state = await sidebarState(page);
  assert.deepEqual([state.expanded, state.inert, state.open, state.focusInSidebar], ['true', false, true, true]);
  await page.keyboard.press('Escape');
  state = await sidebarState(page);
  assert.deepEqual([state.expanded, state.inert, state.open, state.focus], ['false', true, false, 'open-sidebar']);

  // ---- search accessible name ----
  await page.locator('#open-sidebar').click();
  const search = page.getByRole('searchbox', { name: 'Search notes' });
  assert.equal(await search.count(), 1, 'search input has the accessible name "Search notes"');

  // ---- keyboard-operable import with honest restore of a deleted note ----
  const importButton = page.getByRole('button', { name: /Import/ });
  assert.equal(await importButton.count(), 1, 'import is a named button');
  const before = new Date(Date.now() - 60000).toISOString();
  const importFile = JSON.stringify({
    version: 1,
    notes: [
      { id: 'previously-deleted', title: 'Previously deleted note', content: 'Back again', createdAt: before, updatedAt: before },
      { id: 'brand-new-import', title: 'Brand new import', content: '', createdAt: before, updatedAt: before },
    ],
  });
  await page.evaluate(() => {
    const deletedAt = new Date().toISOString();
    localStorage.setItem('my-office-assistant.tombstones.v1', JSON.stringify([{ id: 'previously-deleted', deletedAt }]));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#open-sidebar').click();
  await importButton.focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'import-button', 'import receives keyboard focus');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(importFile) });
  await waitFor(async () => /restored/.test(await page.locator('#toast').innerText()), { message: 'import toast' });
  const toast = await page.locator('#toast').innerText();
  assert.match(toast, /Imported 2 notes/);
  assert.match(toast, /1 previously deleted note restored/);
  assert.match(toast, /1 new/);
  const titles = await noteTitles(page);
  assert.ok(titles.includes('Previously deleted note') && titles.includes('Brand new import'), titles.join(' | '));
  assert.equal(await page.evaluate(() => localStorage.getItem('my-office-assistant.tombstones.v1')), '[]');

  // ---- desktop: sidebar is never inert and delete still behaves as before ----
  await page.setViewportSize({ width: 1440, height: 1000 });
  await waitFor(async () => (await sidebarState(page)).inert === false, { message: 'desktop sidebar not inert' });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const desktopPage = await freshPage(desktop);
  assert.equal((await sidebarState(desktopPage)).inert, false);
  assert.equal(await desktopPage.getByRole('button', { name: 'Delete note' }).isVisible(), true);
  assert.equal(await desktopPage.getByRole('searchbox', { name: 'Search notes' }).isVisible(), true);
  assert.ok((await horizontalOverflow(desktopPage)) <= 0);
  await desktop.close();

  console.log(JSON.stringify({ ok: true, mobileDelete: true, accessibility: true, importRestore: true, baseUrl }));
} finally {
  await browser.close();
}
