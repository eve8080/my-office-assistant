import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { decryptSyncState, deriveSyncLocator, encryptSyncState } from '../web/sync-crypto.js';

const require = createRequire(import.meta.url);
export const { chromium } = require(`${process.env.HOME}/.hermes/hermes-agent/node_modules/playwright`);
export const baseUrl = process.env.APP_URL || 'http://127.0.0.1:4173';
// Obvious placeholder passphrases for mocked tests only.
export const PASSPHRASE = 'placeholder passphrase for tests';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeout = 10000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

/**
 * In-memory stand-in for the CloudFront /sync/* route in front of S3. Objects are keyed
 * by locator and carry an ETag; PUT honours If-Match and If-None-Match like S3.
 */
export function createMockS3() {
  const objects = new Map();
  let version = 0;
  const mock = {
    log: [],
    getDelay: 0,
    getStatus: null,
    // Real S3 without s3:ListBucket: a GET for a key that does not exist is 403 AccessDenied,
    // while an existing object still returns 200 with its ETag.
    denyMissingWithoutList: false,
    putStatus: null,
    beforePut: null,
    locatorOf(url) {
      return new URL(url).pathname.match(/\/sync\/notebooks\/([a-f0-9]{64})\.json$/)?.[1];
    },
    get(locator) {
      return objects.get(locator) || null;
    },
    set(locator, body) {
      version += 1;
      const entry = { body, etag: `"mock-etag-${version}"` };
      objects.set(locator, entry);
      return entry;
    },
    puts() {
      return this.log.filter((entry) => entry.method === 'PUT');
    },
    async install(context) {
      await context.route('**/sync/notebooks/*.json', async (route) => {
        const request = route.request();
        const method = request.method();
        const locator = mock.locatorOf(request.url());
        const headers = request.headers();
        if (method === 'GET') {
          const delay = mock.getDelay;
          const startedAt = Date.now();
          if (delay) await sleep(delay);
          if (mock.getStatus) {
            mock.log.push({ method, status: mock.getStatus, locator });
            await route.fulfill({ status: mock.getStatus, contentType: 'application/xml', body: '<Error/>' });
            return;
          }
          const entry = objects.get(locator);
          if (!entry && mock.denyMissingWithoutList) {
            mock.log.push({ method, status: 403, locator, startedAt, completedAt: Date.now() });
            await route.fulfill({ status: 403, contentType: 'application/xml', body: '<Error><Code>AccessDenied</Code></Error>' });
            return;
          }
          mock.log.push({ method, status: entry ? 200 : 404, etag: entry?.etag, locator, startedAt, completedAt: Date.now() });
          if (!entry) {
            await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
          } else {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              headers: { ETag: entry.etag },
              body: JSON.stringify(entry.body),
            });
          }
          return;
        }
        if (method === 'PUT') {
          if (mock.beforePut) {
            const hook = mock.beforePut;
            mock.beforePut = null;
            await hook(locator);
          }
          const rawBody = request.postData() || '';
          assert.equal(headers['content-type'], 'application/json');
          assert.equal(headers['x-amz-content-sha256'], createHash('sha256').update(rawBody).digest('hex'));
          const ifMatch = headers['if-match'];
          const ifNoneMatch = headers['if-none-match'];
          const current = objects.get(locator);
          let status = 200;
          if (mock.putStatus) status = mock.putStatus;
          else if (ifNoneMatch === '*' && current) status = 412;
          else if (ifMatch && (!current || ifMatch !== current.etag)) status = 412;
          const entry = { method, status, locator, ifMatch, ifNoneMatch, unconditional: !ifMatch && !ifNoneMatch };
          mock.log.push(entry);
          if (status !== 200) {
            const code = status === 403 ? 'AccessDenied' : 'PreconditionFailed';
            await route.fulfill({ status, contentType: 'application/xml', body: `<Error><Code>${code}</Code></Error>` });
            return;
          }
          const stored = mock.set(locator, JSON.parse(rawBody));
          entry.etag = stored.etag;
          await route.fulfill({ status: 200, headers: { ETag: stored.etag }, body: '' });
          return;
        }
        await route.fulfill({ status: 405, body: 'method_not_allowed' });
      });
    },
  };
  return mock;
}

export async function locatorFor(passphrase = PASSPHRASE) {
  return deriveSyncLocator(passphrase);
}

export async function decryptStored(mock, passphrase = PASSPHRASE) {
  const entry = mock.get(await locatorFor(passphrase));
  assert.ok(entry, 'expected a stored notebook');
  return decryptSyncState(entry.body, passphrase);
}

export async function encryptState(state, passphrase = PASSPHRASE) {
  return encryptSyncState(state, passphrase);
}

export async function freshPage(context, url = baseUrl) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle' });
  return page;
}

export async function enableSync(page, passphrase = PASSPHRASE) {
  await page.locator('#sync-button').click();
  await page.locator('#sync-passphrase').fill(passphrase);
  await page.locator('#sync-confirm').fill(passphrase);
  await page.locator('#sync-submit').click();
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
}

export async function noteTitles(page) {
  return page.locator('.note-card .note-card-title').allInnerTexts();
}
