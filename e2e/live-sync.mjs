import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.HOME}/.hermes/hermes-agent/node_modules/playwright`);
const baseUrl = process.env.APP_URL || 'https://dxwxnajdv6k2s.cloudfront.net';
const runId = randomUUID();
const passphrase = `live sync verification ${runId}`;
const title = `Cloud sync verification ${runId.slice(0, 8)}`;
const locator = createHash('sha256').update(`my-office-assistant-sync-v1:${passphrase}`).digest('hex');

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
console.log(JSON.stringify({ ok: true, baseUrl, locator, title, screenshot }));
