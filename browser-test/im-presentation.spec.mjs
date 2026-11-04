import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import catalog from '../web/locales/zh-CN.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop(); });
async function connect(page, translated) {
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(translated)};` }));
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
}
async function fits(locator) {
  expect.soft(await locator.evaluate(node => node.scrollWidth <= node.clientWidth), `${locator} should wrap within its width`).toBe(true);
}

test('IM resources follow live quotes and literal search without translating user data', async ({ page }) => {
  const translated = structuredClone(catalog);
  for (const key of Object.keys(translated.messages)) {
    if (/^(room|message|reply|discussion|search)\./.test(key)) translated.messages[key] = `资源·${translated.messages[key]}`;
  }
  await connect(page, translated);
  await expect(page.locator('#room-count')).toHaveText('资源·2 个讨论');
  await expect(page.locator('#thread-title')).toHaveText('资源·日常交流 · 2 位成员');
  const original = '<b>Raw original</b>';
  await page.locator('#message').fill(original); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toHaveText(original);
  const source = [...demo.engine.state.messages.values()][0];
  await page.getByRole('button', { name: translated.messages['message.reply'], exact: true }).click();
  await expect(page.locator('#reply-preview p')).toHaveText(original);
  await expect(page.locator('#reply-preview button')).toHaveText(translated.messages['reply.cancel']);
  await page.locator('#message').fill('Raw reply'); await page.locator('#send').click();
  await expect(page.locator('.quote-text')).toHaveText(original);
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/edit`, { expectedRevision: 1, clientEventId: 'resource-edit', text: 'Raw edited' });
  await expect(page.locator('.quote-author')).toContainText(' · 原消息已编辑');
  await expect(page.locator('.quote-author')).toContainText('资源·回复');
  await expect(page.locator('.quote-text')).toHaveText('Raw edited');
  await page.locator('#search-toggle').click(); await page.locator('#search-query').fill('raw edited');
  await expect(page.locator('#details-title')).toHaveText(translated.messages['search.title']);
  await expect(page.locator('#search-count')).toHaveText('资源·找到 1 条，显示 1 条（最新在前）。');
  await expect(page.locator('.search-result')).toContainText('Raw edited');
  await page.locator('#details-close').click();
  await page.locator(`[data-action="source-${source.id}"]`).click();
  await expect(page.locator('#details-title')).toHaveText(translated.messages['discussion.title']);
  await expect(page.locator('.thread-intro')).toHaveText(translated.messages['discussion.intro']);
  await page.locator('#details-close').click();
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/retract`, { expectedRevision: 2, clientEventId: 'resource-retract' });
  await expect(page.locator('.quote-text')).toHaveText(translated.messages['message.retracted']);
  await expect(page.locator('.message-text').first()).toHaveText(translated.messages['message.retracted']);
  await page.locator('#search-toggle').click(); await page.locator('#search-query').fill('Raw edited');
  await expect(page.locator('#search-count')).toHaveText(translated.messages['search.empty']);
  await expect(page.locator('#messages b')).toHaveCount(0);
});

for (const width of [320, 390]) test(`expanded seat permissions and reply controls remain readable at ${width}px`, async ({ page }) => {
  const translated = structuredClone(catalog);
  for (const key of ['seat.present', 'seat.readOnly', 'seat.availableUntil', 'permission.read', 'permission.availableUntil', 'reply.cancel']) {
    translated.messages[key] = `${'ExpandedLabel'.repeat(4)}·${translated.messages[key]}`;
  }
  await page.setViewportSize({ width, height: 900 }); await connect(page, translated);
  await fits(page.locator('#seat')); await fits(page.locator('.seat-standing')); await fits(page.locator('.seat-detail'));
  await page.locator('#members-toggle').click();
  await fits(page.locator('#my-seat')); await fits(page.locator('.my-seat-head .standing'));
  for (const item of await page.locator('.perm-list dt, .perm-list dd').all()) await fits(item);
  await page.locator('#details-close').click();
  await page.locator('#message').fill('引用正文仍须可读'); await page.locator('#send').click();
  await page.getByRole('button', { name: '回复消息', exact: true }).click();
  await fits(page.locator('#reply-preview')); await fits(page.locator('#reply-preview button'));
  await expect(page.locator('#reply-preview p')).toHaveText('引用正文仍须可读');
  expect.soft(await page.locator('#reply-preview p').evaluate(node => node.clientWidth)).toBeGreaterThan(100);
  await page.locator('#reply-preview button').click(); await expect(page.locator('#message')).toBeFocused();
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
  await expect(page.locator('.seat-standing')).toHaveText(translated.messages['seat.readOnly']);
  await fits(page.locator('#seat')); await fits(page.locator('.seat-standing')); await fits(page.locator('.seat-detail'));
  await expect(page.locator('#message')).toBeDisabled();
  if (width === 390) {
    await mkdir('.impeccable/review', { recursive: true });
    await page.screenshot({ path: '.impeccable/review/im-permissions-expanded-390.png' });
  }
});
