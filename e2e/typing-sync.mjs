// Reproduces R2: keystrokes typed while a cloud sync is in flight used to be reverted
// when the sync rendered the merged state. Verifies they are kept, uploaded and that
// the caret is not moved.
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
  sleep,
  waitFor,
} from './support.mjs';

const mock = createMockS3();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await mock.install(context);
  const page = await freshPage(context);
  await enableSync(page);

  await page.locator('#new-note').click();
  await page.locator('#note-title').fill('Typing during sync');
  await page.locator('#note-content').fill('First part. END');
  const putsBefore = mock.puts().length;
  await waitFor(() => mock.puts().length > putsBefore, { message: 'initial upload of the new note' });
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();

  // Another computer adds a note, so the in-flight sync really changes local state.
  const remote = await decryptStored(mock);
  const now = new Date().toISOString();
  remote.notes.push({ id: 'other-computer-note', title: 'From another computer', content: 'Added elsewhere', createdAt: now, updatedAt: now });
  mock.set(await locatorFor(), await encryptState(remote));

  // Put the caret in the middle of the text, before "END".
  await page.locator('#note-content').click();
  await page.keyboard.press('End');
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowLeft');

  mock.getDelay = 1500;
  const getsBefore = mock.log.filter((entry) => entry.method === 'GET').length;
  let typed = '';
  // Type a first burst, pause long enough for the local save and the queued sync to start.
  for (const character of 'alpha ') {
    await page.keyboard.type(character);
    typed += character;
  }
  await sleep(450);
  // Keep typing, without a debounce-length pause, until well after the delayed GET completed.
  const filler = 'bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango ';
  let completedAt = null;
  for (const character of filler.repeat(3)) {
    await page.keyboard.type(character);
    typed += character;
    await sleep(45);
    const gets = mock.log.filter((entry) => entry.method === 'GET');
    if (!completedAt && gets.length > getsBefore) completedAt = gets[gets.length - 1].completedAt;
    if (completedAt && Date.now() > completedAt + 1200) break;
  }
  assert.ok(completedAt, 'the delayed cloud GET must complete while the user is still typing');
  mock.getDelay = 0;

  const expected = `First part. ${typed}END`;
  // The merge result reached the UI while typing continued.
  await waitFor(async () => (await noteTitles(page)).includes('From another computer'), { message: 'remote note to appear' });
  assert.equal(await page.locator('#note-content').inputValue(), expected, 'no keystroke may be lost or reverted');
  const caret = await page.locator('#note-content').evaluate((field) => [field.selectionStart, field.selectionEnd]);
  assert.deepEqual(caret, [expected.length - 3, expected.length - 3], 'caret stays where the user was typing');

  // Every keystroke is eventually uploaded, alongside the remote note.
  await waitFor(async () => {
    const stored = await decryptStored(mock);
    return stored.notes.some((note) => note.title === 'Typing during sync' && note.content === expected);
  }, { timeout: 15000, message: 'typed text to be uploaded' });
  const stored = await decryptStored(mock);
  assert.ok(stored.notes.some((note) => note.id === 'other-computer-note'));
  assert.ok(mock.puts().every((entry) => !entry.unconditional), 'every write is conditional');
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();

  console.log(JSON.stringify({ ok: true, typingDuringSyncPreserved: true, typedCharacters: typed.length, baseUrl }));
} finally {
  await browser.close();
}
