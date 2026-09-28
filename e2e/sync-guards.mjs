// 403 must surface as an access error (not "no notebook yet"), and a mistyped passphrase
// must not silently create a different, empty notebook.
import assert from 'node:assert/strict';
import {
  baseUrl,
  chromium,
  createMockS3,
  enableSync,
  encryptState,
  freshPage,
  locatorFor,
  PASSPHRASE,
  waitFor,
} from './support.mjs';

// Placeholder passphrases only.
const TYPO = 'placeholder passphrase for tets';
const THIRD = 'another placeholder passphrase';

async function submitPassphrase(page, passphrase) {
  if (!(await page.locator('#sync-dialog').isVisible())) await page.locator('#sync-button').click();
  await page.locator('#sync-passphrase').fill(passphrase);
  await page.locator('#sync-confirm').fill(passphrase);
  await page.locator('#sync-submit').click();
}

async function dialogError(page) {
  await waitFor(async () => (await page.locator('#sync-error').innerText()).trim().length > 0, { message: 'dialog error' });
  return page.locator('#sync-error').innerText();
}

async function newSession(page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
}

const browser = await chromium.launch({ headless: true });
try {
  // ---- (a) live first-run path: S3 without s3:ListBucket answers 403 for a missing notebook ----
  const firstRun = createMockS3();
  firstRun.denyMissingWithoutList = true;
  const unrelated = await encryptState({ notes: [], tombstones: [] }, THIRD);
  firstRun.set(await locatorFor(THIRD), unrelated);
  const unrelatedEtag = firstRun.get(await locatorFor(THIRD)).etag;
  const firstRunContext = await browser.newContext();
  await firstRun.install(firstRunContext);
  const firstRunPage = await freshPage(firstRunContext);
  await enableSync(firstRunPage, PASSPHRASE);
  assert.match(await firstRunPage.locator('#save-state').innerText(), /created a new cloud notebook/);
  assert.equal(firstRun.log[0].method, 'GET');
  assert.equal(firstRun.log[0].status, 403, 'the missing notebook read as 403, like the live bucket');
  assert.deepEqual(
    firstRun.puts().map((entry) => [entry.locator, entry.ifNoneMatch, entry.ifMatch, entry.status]),
    [[await locatorFor(PASSPHRASE), '*', undefined, 200]],
    'exactly one create-only write',
  );
  assert.equal(firstRun.get(await locatorFor(THIRD)).etag, unrelatedEtag, 'nothing else was overwritten');
  // Once the notebook exists, reads succeed and later writes are conditional on its ETag.
  await firstRunPage.locator('#new-note').click();
  await firstRunPage.locator('#note-title').fill('After first run');
  await waitFor(() => firstRun.puts().length === 2, { message: 'second write' });
  const [, second] = firstRun.puts();
  assert.equal(second.status, 200);
  assert.equal(second.ifMatch, firstRun.puts()[0].etag, 'follow-up write uses If-Match');
  await firstRunContext.close();

  // ---- (b) 403 read + create rejected with 412: the notebook exists but reads are denied ----
  const hidden = createMockS3();
  hidden.getStatus = 403;
  hidden.set(await locatorFor(PASSPHRASE), await encryptState({ notes: [], tombstones: [] }, PASSPHRASE));
  const hiddenEtag = hidden.get(await locatorFor(PASSPHRASE)).etag;
  const hiddenContext = await browser.newContext();
  await hidden.install(hiddenContext);
  const hiddenPage = await freshPage(hiddenContext);
  await hiddenPage.locator('#new-note').click();
  await hiddenPage.locator('#note-title').fill('Local only note');
  await hiddenPage.waitForTimeout(450);
  await submitPassphrase(hiddenPage, PASSPHRASE);
  const hiddenError = await dialogError(hiddenPage);
  assert.match(hiddenError, /access was denied \(HTTP 403\)/);
  assert.match(hiddenError, /exists for this passphrase but could not be read/);
  assert.doesNotMatch(hiddenError, /changed during sync|kept changing/, 'a create precondition failure is not a lost race');
  assert.deepEqual(hidden.puts().map((entry) => [entry.ifNoneMatch, entry.status]), [['*', 412]], 'one create attempt, not retried');
  assert.ok(hidden.puts().every((entry) => entry.status !== 200), 'no successful write');
  assert.equal(hidden.get(await locatorFor(PASSPHRASE)).etag, hiddenEtag, 'existing notebook untouched');
  assert.match(await hiddenPage.locator('#save-state').innerText(), /Sync failed/);
  await hiddenPage.locator('#sync-cancel').click();
  const hiddenTitles = await hiddenPage.locator('.note-card .note-card-title').allInnerTexts();
  assert.ok(hiddenTitles.includes('Local only note') && hiddenTitles.includes('Welcome'), 'local notes remain intact');
  await hiddenContext.close();

  // ---- (b') 403 read + 403 write: access denied, nothing written ----
  const locked = createMockS3();
  locked.denyMissingWithoutList = true;
  locked.putStatus = 403;
  const lockedContext = await browser.newContext();
  await locked.install(lockedContext);
  const lockedPage = await freshPage(lockedContext);
  await submitPassphrase(lockedPage, PASSPHRASE);
  assert.match(await dialogError(lockedPage), /access was denied \(HTTP 403\)/);
  assert.deepEqual(locked.puts().map((entry) => [entry.ifNoneMatch, entry.status]), [['*', 403]]);
  assert.equal(locked.get(await locatorFor(PASSPHRASE)), null);
  assert.equal(await lockedPage.locator('#note-title').inputValue(), 'Welcome', 'local notes remain usable');
  await lockedContext.close();

  // ---- (c) the wrong-passphrase guard also holds on the 403 path ----
  const guarded = createMockS3();
  guarded.denyMissingWithoutList = true;
  const guardedContext = await browser.newContext();
  await guarded.install(guardedContext);
  const guardedPage = await freshPage(guardedContext);
  await enableSync(guardedPage, PASSPHRASE);
  await waitFor(
    () => guardedPage.evaluate(() => localStorage.getItem('my-office-assistant.passphrase-verifier.v1')),
    { message: 'verifier stored' },
  );
  await newSession(guardedPage);
  const putsBeforeTypo = guarded.puts().length;
  await submitPassphrase(guardedPage, TYPO);
  const guardedWarning = await dialogError(guardedPage);
  assert.match(guardedWarning, /No cloud notebook was found for this passphrase/);
  assert.match(guardedWarning, /Create new notebook/);
  assert.equal(guarded.log.at(-1).status, 403);
  assert.equal(guarded.puts().length, putsBeforeTypo, 'no write at all without explicit confirmation');
  await guardedPage.locator('#sync-submit').click();
  await guardedPage.locator('#save-state').filter({ hasText: 'created a new cloud notebook' }).waitFor();
  const confirmed = guarded.puts().at(-1);
  assert.equal(confirmed.locator, await locatorFor(TYPO));
  assert.equal(confirmed.ifNoneMatch, '*', 'confirmed creation is still create-only');
  await guardedContext.close();

  // ---- wrong passphrase guard ----
  const mock = createMockS3();
  const context = await browser.newContext();
  await mock.install(context);
  const page = await freshPage(context);
  await enableSync(page, PASSPHRASE);
  const verifier = await waitFor(
    () => page.evaluate(() => localStorage.getItem('my-office-assistant.passphrase-verifier.v1')),
    { message: 'local passphrase verifier to be stored' },
  );
  assert.ok(!verifier.includes('placeholder'), 'the verifier does not contain the passphrase');

  await newSession(page);
  await submitPassphrase(page, TYPO);
  const warning = await dialogError(page);
  assert.match(warning, /No cloud notebook exists for this passphrase/);
  assert.match(warning, /Create new notebook/);
  assert.equal(await page.locator('#sync-submit').innerText(), 'Create new notebook');
  assert.equal(mock.get(await locatorFor(TYPO)), null, 'no notebook created for the mistyped passphrase');
  assert.match(await page.locator('#sync-button').innerText(), /Enable sync/);

  // Editing the passphrase clears the pending confirmation; the right passphrase just works.
  await page.locator('#sync-passphrase').fill(PASSPHRASE);
  assert.equal(await page.locator('#sync-submit').innerText(), 'Enable and sync');
  await page.locator('#sync-confirm').fill(PASSPHRASE);
  await page.locator('#sync-submit').click();
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
  assert.equal(await page.locator('#sync-dialog').isVisible(), false, 'dialog closes together with the Synced status');

  // Explicit confirmation creates a new, separate notebook.
  await newSession(page);
  await submitPassphrase(page, TYPO);
  await dialogError(page);
  await page.locator('#sync-submit').click();
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
  const created = mock.puts().at(-1);
  assert.equal(created.locator, await locatorFor(TYPO));
  assert.equal(created.ifNoneMatch, '*');

  // Decryption failure of an existing object keeps the original "Unable to unlock" error.
  mock.set(await locatorFor(THIRD), await encryptState({ notes: [], tombstones: [] }, PASSPHRASE));
  await newSession(page);
  const putsBefore = mock.puts().length;
  await submitPassphrase(page, THIRD);
  assert.match(await dialogError(page), /Unable to unlock the cloud notebook/);
  assert.equal(mock.puts().length, putsBefore);

  console.log(JSON.stringify({ ok: true, forbiddenSurfaced: true, wrongPassphraseGuard: true, baseUrl }));
} finally {
  await browser.close();
}
