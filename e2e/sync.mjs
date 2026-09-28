import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.HOME}/.hermes/hermes-agent/node_modules/playwright`);
const baseUrl = process.env.APP_URL || 'http://127.0.0.1:4173';
const passphrase = 'a long private sync phrase';
let encryptedNotebook = null;
let notebookEtag = null;
let etagVersion = 0;
let putCount = 0;
const putLog = [];

async function installApi(context) {
  await context.route('**/sync/notebooks/*.json', async (route) => {
    if (route.request().method() === 'GET') {
      if (!encryptedNotebook) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { ETag: notebookEtag },
          body: JSON.stringify(encryptedNotebook),
        });
      }
      return;
    }
    if (route.request().method() === 'PUT') {
      const rawBody = route.request().postData() || '';
      const expectedHash = createHash('sha256').update(rawBody).digest('hex');
      assert.equal(route.request().headers()['x-amz-content-sha256'], expectedHash);
      const ifMatch = route.request().headers()['if-match'];
      const ifNoneMatch = route.request().headers()['if-none-match'];
      const existed = Boolean(encryptedNotebook);
      // S3 conditional-write semantics.
      const rejected = (ifNoneMatch === '*' && existed) || (ifMatch !== undefined && ifMatch !== notebookEtag);
      putLog.push({ existed, ifMatch, ifNoneMatch, status: rejected ? 412 : 200 });
      if (rejected) {
        await route.fulfill({ status: 412, contentType: 'application/xml', body: '<Error><Code>PreconditionFailed</Code></Error>' });
        return;
      }
      encryptedNotebook = route.request().postDataJSON();
      etagVersion += 1;
      notebookEtag = `"sync-mock-${etagVersion}"`;
      putCount += 1;
      await route.fulfill({ status: 200, headers: { ETag: notebookEtag }, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 405, body: 'method_not_allowed' });
  });
}

async function enableSync(page) {
  await page.locator('#sync-button').click();
  await page.locator('#sync-passphrase').fill(passphrase);
  await page.locator('#sync-confirm').fill(passphrase);
  await page.locator('#sync-submit').click();
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
}

const browser = await chromium.launch({ headless: true });
const firstContext = await browser.newContext();
await installApi(firstContext);
const first = await firstContext.newPage();
await first.goto(baseUrl, { waitUntil: 'networkidle' });
await first.evaluate(() => localStorage.clear());
await first.reload({ waitUntil: 'networkidle' });
await first.locator('#new-note').click();
await first.locator('#note-title').fill('Shared planning note');
await first.locator('#note-content').fill('Created on computer one.');
await first.waitForTimeout(500);
await enableSync(first);
assert.ok(encryptedNotebook);
assert.ok(!JSON.stringify(encryptedNotebook).includes('Shared planning note'));

const secondContext = await browser.newContext();
await installApi(secondContext);
const second = await secondContext.newPage();
await second.goto(baseUrl, { waitUntil: 'networkidle' });
await second.evaluate(() => localStorage.clear());
await second.reload({ waitUntil: 'networkidle' });
await enableSync(second);
await second.locator('#search').fill('Shared planning');
assert.equal(await second.locator('.note-card').count(), 1);
await second.locator('.note-card').click();
assert.equal(await second.locator('#note-content').inputValue(), 'Created on computer one.');

const putsBeforeEdit = putCount;
await second.locator('#note-content').fill('Updated on computer two.');
const deadline = Date.now() + 8000;
while (putCount <= putsBeforeEdit && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(putCount > putsBeforeEdit, 'expected a cloud PUT after editing the note');
const putsBeforeRefresh = putCount;
await first.locator('#sync-button').click();
const refreshDeadline = Date.now() + 8000;
while (putCount <= putsBeforeRefresh && Date.now() < refreshDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(putCount > putsBeforeRefresh, 'expected a cloud PUT after manual sync');
await first.locator('#search').fill('Shared planning');
await first.locator('.note-card').click();
assert.equal(await first.locator('#note-content').inputValue(), 'Updated on computer two.');
assert.match(await first.locator('#save-state').innerText(), /Synced/);
assert.doesNotMatch(await first.locator('#save-state').innerText(), /no version check/);

// Every write was conditional: the first created the notebook with If-None-Match: *, and
// every write after an existing notebook was read carried If-Match with its ETag.
assert.ok(putLog.length >= 3, `expected several writes, saw ${putLog.length}`);
assert.equal(putLog[0].ifNoneMatch, '*');
for (const entry of putLog.filter((item) => item.existed)) {
  assert.ok(entry.ifMatch, 'a write to an existing notebook carries If-Match');
}
assert.ok(putLog.some((entry) => entry.existed && entry.ifMatch && entry.status === 200));
assert.ok(putLog.every((entry) => entry.ifMatch || entry.ifNoneMatch), 'no unconditional write');

await browser.close();
console.log(JSON.stringify({ ok: true, encrypted: true, twoComputerSync: true, baseUrl }));
