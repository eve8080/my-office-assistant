import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Writes to a real deployment, so the target must be named explicitly. The notebook
// locator is a capability for the stored object and is never computed or printed here.
const baseUrl = process.env.APP_URL;
if (!baseUrl) {
  console.error('APP_URL is required, e.g. APP_URL=https://<distribution>.cloudfront.net node e2e/live-sync.mjs');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.HOME}/.hermes/hermes-agent/node_modules/playwright`);
const runId = randomUUID();
const passphrase = `live sync verification ${runId}`;
const title = `Cloud sync verification ${runId.slice(0, 8)}`;

async function enableSync(page) {
  await page.locator('#sync-button').click();
  await page.locator('#sync-passphrase').fill(passphrase);
  await page.locator('#sync-confirm').fill(passphrase);
  const uploaded = page.waitForResponse((response) =>
    response.url().includes('/sync/notebooks/') && response.request().method() === 'PUT',
  );
  await page.locator('#sync-submit').click();
  const response = await uploaded;
  assert.equal(response.status(), 200);
  await page.locator('#save-state').filter({ hasText: 'Synced' }).waitFor();
}

const browser = await chromium.launch({ headless: true });
const firstContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const first = await firstContext.newPage();
await first.goto(baseUrl, { waitUntil: 'networkidle' });
await first.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await first.reload({ waitUntil: 'networkidle' });
await first.locator('#new-note').click();
await first.locator('#note-title').fill(title);
await first.locator('#note-content').fill('Encrypted note created on the first browser.');
await first.waitForTimeout(500);
await enableSync(first);

const secondContext = await browser.newContext({ viewport: { width: 1100, height: 800 } });
const second = await secondContext.newPage();
await second.goto(baseUrl, { waitUntil: 'networkidle' });
await second.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await second.reload({ waitUntil: 'networkidle' });
await enableSync(second);
await second.locator('#search').fill(title);
assert.equal(await second.locator('.note-card').count(), 1);
await second.locator('.note-card').click();
assert.equal(await second.locator('#note-content').inputValue(), 'Encrypted note created on the first browser.');

const secondUpload = second.waitForResponse((response) =>
  response.url().includes('/sync/notebooks/') && response.request().method() === 'PUT',
);
await second.locator('#note-content').fill('Encrypted note updated on the second browser.');
assert.equal((await secondUpload).status(), 200);

const firstRefresh = first.waitForResponse((response) =>
  response.url().includes('/sync/notebooks/') && response.request().method() === 'PUT',
);
await first.locator('#sync-button').click();
assert.equal((await firstRefresh).status(), 200);
await first.locator('#search').fill(title);
await first.locator('.note-card').click();
assert.equal(await first.locator('#note-content').inputValue(), 'Encrypted note updated on the second browser.');
assert.match(await first.locator('#save-state').innerText(), /Synced/);
assert.match(await first.locator('.sidebar-footer p').innerText(), /Encrypted S3 sync/);

const screenshot = '/Users/eveso/Projects/My office assistant/artifacts/app-cloudfront-sync.png';
await first.screenshot({ path: screenshot, fullPage: true });
await browser.close();
console.log(JSON.stringify({ ok: true, baseUrl, screenshot }));
