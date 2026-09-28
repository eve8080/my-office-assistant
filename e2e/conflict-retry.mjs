// R5 + R6: a cloud write that races another computer gets 412 Precondition Failed.
// The app must refetch, decrypt, merge and retry with the fresh ETag, and a
// conflicting edit to the same note must survive as a labelled conflict copy.
import assert from 'node:assert/strict';
import {
  baseUrl,
  chromium,
  createMockS3,
  decryptStored,
  enableSync,
  encryptState,
  freshPage,
  locatorFor,
  noteTitles,
  waitFor,
} from './support.mjs';

const LOCAL_TEXT = 'Edited on this computer';
const CONCURRENT_TEXT = 'Edited on the other computer at the same time';
const mock = createMockS3();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await mock.install(context);
  const page = await freshPage(context);
  await enableSync(page);
  const [created] = mock.puts();
  assert.equal(created.ifNoneMatch, '*', 'a new notebook is created with If-None-Match: *');
  assert.equal(created.status, 200);

  await page.locator('#new-note').click();
  await page.locator('#note-title').fill('Retry target');
  await page.locator('#note-content').fill('Base text');
  await waitFor(async () => (await decryptStored(mock)).notes.some((note) => note.content === 'Base text'), {
    message: 'base version upload',
  });
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
  const baseNote = (await decryptStored(mock)).notes.find((note) => note.title === 'Retry target');
  const locator = await locatorFor();
  const etagBeforeRace = mock.get(locator).etag;
  const logStart = mock.log.length;

  // Just before this computer's next PUT lands, another computer edits the same note.
  let concurrentEtag;
  mock.beforePut = async () => {
    const remote = await decryptStored(mock);
    remote.notes = remote.notes.map((note) => (note.id === baseNote.id
      ? { ...note, content: CONCURRENT_TEXT, updatedAt: new Date(Date.now() - 1000).toISOString() }
      : note));
    concurrentEtag = mock.set(locator, await encryptState(remote)).etag;
  };
  await page.locator('#note-content').fill(LOCAL_TEXT);
  await waitFor(() => mock.log.slice(logStart).some((entry) => entry.method === 'PUT' && entry.status === 200), {
    timeout: 15000,
    message: 'successful retried PUT',
  });

  const sequence = mock.log.slice(logStart).map((entry) => `${entry.method} ${entry.status}`);
  const race = mock.log.slice(logStart);
  assert.deepEqual(sequence, ['GET 200', 'PUT 412', 'GET 200', 'PUT 200'], `request sequence ${sequence.join(', ')}`);
  assert.equal(race[1].ifMatch, etagBeforeRace, 'first write is conditional on the ETag that was read');
  assert.equal(race[2].etag, concurrentEtag, 'refetch observes the concurrent version');
  assert.equal(race[3].ifMatch, concurrentEtag, 'retry uses the fresh ETag');
  assert.notEqual(race[3].ifMatch, race[1].ifMatch);

  // Both edits survive in the cloud and on this computer.
  const stored = await decryptStored(mock);
  const original = stored.notes.find((note) => note.id === baseNote.id);
  const copy = stored.notes.find((note) => note.conflictOf === baseNote.id);
  assert.ok(original && copy, 'original note and conflict copy uploaded');
  assert.deepEqual([original.content, copy.content].sort(), [CONCURRENT_TEXT, LOCAL_TEXT].sort());
  assert.match(copy.title, /\(conflict copy\)$/);
  await page.locator('#save-state').filter({ hasText: 'Synced after 1 retry' }).waitFor();
  const notice = page.locator('#conflict-notice');
  assert.equal(await notice.isVisible(), true, 'conflict is surfaced in the UI');
  assert.match(await notice.innerText(), /conflict copy/);
  const titles = await noteTitles(page);
  assert.ok(titles.includes('Retry target') && titles.includes('Retry target (conflict copy)'), titles.join(' | '));
  await page.locator('#conflict-open').click();
  assert.equal(await notice.isVisible(), false);
  assert.match(await page.locator('#note-title').inputValue(), /\(conflict copy\)$/);
  assert.ok(mock.puts().every((entry) => !entry.unconditional), 'no unconditional overwrite ever sent');

  // A write that keeps losing the race is reported, not silently dropped or forced.
  const failStart = mock.log.length;
  const keepRacing = async () => {
    const remote = await decryptStored(mock);
    remote.notes.push({ id: `racer-${mock.log.length}`, title: 'Racing writer', content: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    mock.set(locator, await encryptState(remote));
    mock.beforePut = keepRacing;
  };
  mock.beforePut = keepRacing;
  await page.locator('#note-content').fill('One more local edit');
  await page.locator('#save-state').filter({ hasText: 'Sync failed' }).waitFor({ timeout: 20000 });
  mock.beforePut = null;
  const failedPuts = mock.log.slice(failStart).filter((entry) => entry.method === 'PUT');
  assert.equal(failedPuts.length, 3, 'bounded to three write attempts');
  assert.ok(failedPuts.every((entry) => entry.status === 412 && entry.ifMatch));
  assert.match(await page.locator('#toast').innerText(), /kept changing/);
  assert.equal(await page.locator('#note-content').inputValue(), 'One more local edit', 'local edit kept');
  await page.locator('#sync-button').click();
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
  assert.ok((await decryptStored(mock)).notes.some((note) => note.content === 'One more local edit'));

  console.log(JSON.stringify({ ok: true, conditionalWriteRetried: true, conflictPreserved: true, baseUrl }));
} finally {
  await browser.close();
}
