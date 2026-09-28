import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(`${process.env.HOME}/.hermes/hermes-agent/node_modules/playwright`);
const baseUrl = process.env.APP_URL || 'http://127.0.0.1:4173';
const screenshot = process.env.SCREENSHOT || '/Users/eveso/Projects/My office assistant/artifacts/app-desktop.png';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });

assert.equal(await page.title(), 'My Office Assistant');
assert.equal(await page.locator('.note-card').count(), 1);
assert.equal(await page.locator('#note-title').inputValue(), 'Welcome');

await page.locator('#new-note').click();
await page.locator('#note-title').fill('Peter meeting');
await page.locator('#note-content').fill('Discuss Model Automation and Target Price follow-ups.');
await page.waitForTimeout(500);
assert.match(await page.locator('#save-state').innerText(), /Saved locally/);

await page.reload({ waitUntil: 'networkidle' });
assert.equal(await page.locator('#note-title').inputValue(), 'Peter meeting');
assert.match(await page.locator('#note-content').inputValue(), /Target Price/);
await page.locator('#search').fill('Peter');
assert.equal(await page.locator('.note-card').count(), 1);
await page.locator('#search').fill('No such note');
assert.equal(await page.locator('.no-results').innerText(), 'No matching notes');
await page.locator('#search').fill('');

await page.screenshot({ path: screenshot, fullPage: true });
const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
assert.equal(bodyWidth, 1440);

await browser.close();
console.log(JSON.stringify({ ok: true, screenshot, baseUrl }));
