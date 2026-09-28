// R3: two tabs of the same browser profile share localStorage. Verifies that they
// converge instead of one tab's whole-array write silently discarding the other's note.
import assert from 'node:assert/strict';
import { baseUrl, chromium, freshPage, noteTitles, sleep, waitFor } from './support.mjs';

async function addNote(page, title, content = '') {
  await page.locator('#new-note').click();
  await page.locator('#note-title').fill(title);
  if (content) await page.locator('#note-content').fill(content);
  await sleep(450);
}

async function waitForTitle(page, title, present = true) {
  await waitFor(async () => (await noteTitles(page)).includes(title) === present, {
    message: `${present ? 'presence' : 'absence'} of "${title}"`,
  });
}

async function storedTitles(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('my-office-assistant.notes.v1') || '[]').map((note) => note.title));
}

const browser = await chromium.launch({ headless: true });
try {
  // ---- BroadcastChannel path ----
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tabA = await freshPage(context);
  const tabB = await context.newPage();
  await tabB.goto(baseUrl, { waitUntil: 'networkidle' });

  await addNote(tabA, 'Tab A note', 'Written in tab A');
  await waitForTitle(tabB, 'Tab A note');
  await addNote(tabB, 'Tab B note', 'Written in tab B');
  await waitForTitle(tabA, 'Tab B note');
  for (const tab of [tabA, tabB]) {
    const titles = await storedTitles(tab);
    assert.ok(titles.includes('Tab A note') && titles.includes('Tab B note'), 'both notes stored');
  }

  // Tab B is typing when tab A's change arrives: B's in-progress text must survive.
  await tabB.locator('.note-card', { hasText: 'Tab B note' }).click();
  await tabB.locator('#note-content').click();
  await tabB.keyboard.press('End');
  let typed = '';
  for (const character of ' and more typing in B') {
    await tabB.keyboard.type(character);
    typed += character;
    if (typed.length === 6) {
      await tabA.locator('.note-card', { hasText: 'Tab A note' }).click();
      await tabA.locator('#note-content').fill('Tab A changed while B was typing');
      await sleep(450);
    }
    await sleep(40);
  }
  assert.equal(await tabB.locator('#note-content').inputValue(), `Written in tab B${typed}`);
  await sleep(450);
  await waitFor(async () => {
    await tabA.locator('#search').fill('Tab B note');
    const preview = await tabA.locator('.note-card .note-card-preview').first().innerText();
    await tabA.locator('#search').fill('');
    return preview === `Written in tab B${typed}`;
  }, { message: 'tab A to receive tab B typing' });
  await tabB.locator('#search').fill('Tab A note');
  await waitFor(
    async () => (await tabB.locator('.note-card .note-card-preview').first().innerText()) === 'Tab A changed while B was typing',
    { message: 'tab B to receive tab A edit made while B was typing' },
  );
  await tabB.locator('#search').fill('');

  // Read-merge-write: a store change this tab was never notified about is not overwritten.
  await tabB.evaluate(() => {
    const key = 'my-office-assistant.notes.v1';
    const stored = JSON.parse(localStorage.getItem(key));
    const now = new Date().toISOString();
    stored.push({ id: 'unannounced-writer', title: 'Unannounced writer note', content: '', createdAt: now, updatedAt: now });
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await addNote(tabB, 'Tab B second note');
  // Chromium propagates localStorage between tab processes asynchronously, so a tab's
  // view can briefly lag another tab's write; the requirement is that the store converges.
  for (const tab of [tabA, tabB]) {
    await waitFor(async () => {
      const titles = await storedTitles(tab);
      return titles.includes('Unannounced writer note') && titles.includes('Tab B second note');
    }, { message: 'unannounced note kept by read-merge-write alongside the new note' });
  }
  await waitForTitle(tabB, 'Unannounced writer note');

  // Deletions converge and are not resurrected by the other tab's next write.
  tabA.once('dialog', (dialog) => dialog.accept());
  await tabA.locator('.note-card', { hasText: 'Tab A note' }).click();
  await tabA.locator('#delete-note').click();
  await waitForTitle(tabB, 'Tab A note', false);
  await addNote(tabB, 'Tab B third note');
  assert.ok(!(await storedTitles(tabA)).includes('Tab A note'), 'deleted note not resurrected');

  // A note stamped by a device whose clock runs ahead can still be edited and deleted:
  // read-merge-write must not revert the local change to the "newer" stored version.
  await tabB.evaluate(() => {
    const key = 'my-office-assistant.notes.v1';
    const stored = JSON.parse(localStorage.getItem(key));
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    stored.push({ id: 'future-a', title: 'Future clock note', content: 'Original', createdAt: future, updatedAt: future });
    stored.push({ id: 'future-b', title: 'Future clock delete', content: '', createdAt: future, updatedAt: future });
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await tabB.reload({ waitUntil: 'networkidle' });
  await tabB.locator('.note-card', { hasText: 'Future clock note' }).click();
  await tabB.locator('#note-content').fill('Edited locally');
  await sleep(450);
  tabB.once('dialog', (dialog) => dialog.accept());
  await tabB.locator('.note-card', { hasText: 'Future clock delete' }).click();
  await tabB.locator('#delete-note').click();
  await waitForTitle(tabA, 'Future clock delete', false);
  await tabB.reload({ waitUntil: 'networkidle' });
  assert.ok(!(await noteTitles(tabB)).includes('Future clock delete'), 'delete of a future-stamped note sticks');
  await tabB.locator('.note-card', { hasText: 'Future clock note' }).click();
  assert.equal(await tabB.locator('#note-content').inputValue(), 'Edited locally', 'edit of a future-stamped note sticks');

  // Both tabs converge to the same notes after reload.
  await tabA.reload({ waitUntil: 'networkidle' });
  await tabB.reload({ waitUntil: 'networkidle' });
  assert.deepEqual((await noteTitles(tabA)).sort(), (await noteTitles(tabB)).sort());
  await context.close();

  // ---- storage-event fallback when BroadcastChannel is unavailable ----
  const fallback = await browser.newContext();
  await fallback.addInitScript(() => {
    delete window.BroadcastChannel;
  });
  const first = await freshPage(fallback);
  const second = await fallback.newPage();
  await second.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(await first.evaluate(() => typeof BroadcastChannel), 'undefined');
  await addNote(first, 'Fallback first tab note');
  await waitForTitle(second, 'Fallback first tab note');
  await addNote(second, 'Fallback second tab note');
  await waitForTitle(first, 'Fallback second tab note');
  await fallback.close();

  console.log(JSON.stringify({ ok: true, crossTabConverges: true, storageFallback: true, baseUrl }));
} finally {
  await browser.close();
}
