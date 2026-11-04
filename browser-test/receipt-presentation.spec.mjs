import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import catalog from '../web/locales/zh-CN.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop();
});
async function connect(page, width, translated) {
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(translated)};` }));
  await page.setViewportSize({ width, height: 900 }); await page.goto(demo.url);
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
}
async function contained(locator, selector) {
  const bounds = await locator.evaluate((parent, selector) => {
    const box = parent.getBoundingClientRect();
    return [...parent.querySelectorAll(selector)].map(node => {
      const child = node.getBoundingClientRect();
      return { within: child.left >= box.left && child.right <= box.right, wraps: node.scrollWidth <= node.clientWidth };
    });
  }, selector);
  expect(bounds.length).toBeGreaterThan(0);
  for (const bound of bounds) expect(bound).toEqual({ within: true, wraps: true });
}
function resources(prefix, keys) {
  const translated = structuredClone(catalog);
  for (const key of Object.keys(translated.messages)) if (key.startsWith(prefix)) translated.messages[key] = `资源·${translated.messages[key]}`;
  for (const key of keys) translated.messages[key] = `${'ExpandedReceipt'.repeat(4)}·${translated.messages[key]}`;
  return translated;
}

for (const width of [320, 390]) test(`send receipt resources preserve uncertainty, focus and retry identity at ${width}px`, async ({ page }) => {
  const translated = resources('send.', ['send.check', 'send.retry', 'send.missingReceipt', 'send.receiptHelp']);
  await connect(page, width, translated);
  const ids = []; let blocked = true, release;
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push(route.request().postDataJSON().clientEventId);
    if (blocked) return route.abort('failed');
    await route.continue();
  });
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/messages/receipt', async route => { await hold; await route.continue(); });
  try {
    await page.locator('#message').fill('原样保留的待确认正文'); await page.locator('#send').click();
    const check = page.locator('[data-action="check-receipt"]');
    await expect(check).toHaveText(translated.messages['send.check']);
    await check.click();
    await expect(page.locator('[data-action="pending-status"]')).toHaveText(translated.messages['send.checking']);
    await expect(page.locator('[data-action="pending-status"]')).toBeFocused();
    await expect(check).toHaveText(translated.messages['send.checkingAction']);
    release();
    await expect(page.locator('[data-action="pending-status"]')).toHaveText(translated.messages['send.missingReceipt']);
    await expect(check).toBeFocused();
    await expect(page.locator('.outbox-actions .muted')).toHaveText(translated.messages['send.receiptHelp']);
    await contained(page.locator('.outbox-item'), 'button, p');
    expect(ids).toHaveLength(1); expect(demo.engine.state.messages.size).toBe(0);
    if (width === 390) {
      await mkdir('.impeccable/review', { recursive: true });
      await page.screenshot({ path: '.impeccable/review/receipt-outbox-390.png' });
    }
    blocked = false; await page.locator('[data-action="retry-send"]').click();
    await expect(page.locator('#outbox')).toBeEmpty();
    await expect(page.locator('.message-text')).toHaveText('原样保留的待确认正文');
    await expect(page.locator('#announcement')).toHaveText(translated.messages['send.delivered']);
    expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); expect(demo.engine.state.messages.size).toBe(1);
  } finally { release(); }
});

for (const width of [320, 390]) test(`edit receipt resources preserve read-only checks and the original retry at ${width}px`, async ({ page }) => {
  const translated = resources('editor.', ['editor.check', 'editor.retry', 'editor.return', 'editor.missingReceipt']);
  await connect(page, width, translated);
  await page.locator('#message').fill('编辑之前的正文'); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toHaveText('编辑之前的正文');
  // This grant belongs only to the temporary test demo, not to a real system identity.
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  const actions = [...grant.actions], ids = []; let blocked = true;
  await page.route('**/messages/*/edit', async route => {
    ids.push(route.request().postDataJSON().clientEventId);
    if (blocked) { grant.actions = ['read']; return route.abort('failed'); }
    await route.continue();
  });
  await page.getByRole('button', { name: translated.messages['editor.editTitle'], exact: true }).click();
  await page.locator('#change-text').fill('编辑之后的正文'); await page.locator('#change-save').click();
  await expect(page.locator('#change-error')).toHaveText(translated.messages['editor.missingReceipt']);
  await expect(page.locator('#change-save')).toHaveText(translated.messages['editor.check']);
  await page.locator('#change-save').click();
  await expect(page.locator('#change-save')).toBeEnabled(); await expect(page.locator('#change-save')).toBeFocused();
  expect(ids).toHaveLength(1); expect(demo.engine.state.changes.size).toBe(0);
  await contained(page.locator('#message-change'), '#change-error, .change-actions button');
  if (width === 390) {
    await mkdir('.impeccable/review', { recursive: true });
    await page.screenshot({ path: '.impeccable/review/receipt-editor-390.png' });
  }
  grant.actions = actions; blocked = false;
  await expect(page.locator('#change-save')).toHaveText(translated.messages['editor.retry']);
  await page.locator('#change-save').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.message-text')).toHaveText('编辑之后的正文');
  await expect(page.locator('#announcement')).toHaveText(translated.messages['editor.received']);
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(demo.engine.state.changes.size).toBe(1);
});
