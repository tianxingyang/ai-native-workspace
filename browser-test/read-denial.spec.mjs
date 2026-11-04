import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';

let demo;
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
const other = { conversationId: '研发讨论', threadId: '插件协议' };
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop(); });
async function forward(route) {
  try { return await route.fetch(); } catch { throw new Error('Read-denial forwarding failed; authorization headers omitted.'); }
}
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}

for (const operation of ['edit receipt', 'retract receipt', 'send receipt', 'read position']) {
  test(`${operation} read denial clears only its room even when subsequent synchronization is offline`, async ({ page }) => {
    demo.engine.commit(() => {
      demo.engine.state.createMessage('demo-owner', scope, '必须清除的原讨论正文', 'denied-room-source');
      demo.engine.state.createMessage('demo-owner', other, '另一讨论仍可浏览', 'retained-room-source');
    });
    let offline = false, denied = 0, armed = false;
    await page.route(url => ['/session', '/sync'].includes(url.pathname), route => offline ? route.abort('failed') : route.continue());
    const path = operation === 'read position' ? '/read-position' : operation === 'send receipt' ? '/messages/receipt' : '/messages/change-receipt';
    await page.route(url => url.pathname === path, async route => {
      if (!armed) return route.continue();
      armed = false; offline = true;
      demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).revoked = true;
      const response = await forward(route); expect(response.status()).toBe(403); denied++;
      await route.fulfill({ response });
    });
    await connect(page); await expect(page.locator('.message-text')).toHaveText('必须清除的原讨论正文');
    // Load another authorized room so its cached content remains useful offline.
    await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
    await expect(page.locator('.message-text')).toHaveText('另一讨论仍可浏览');
    await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
    if (operation.endsWith('receipt') && operation !== 'send receipt') {
      const kind = operation.startsWith('edit') ? 'edit' : 'retract';
      await page.route(`**/messages/*/${kind}`, route => route.abort('failed'));
      await page.getByRole('button', { name: kind === 'edit' ? '编辑消息' : '撤回消息', exact: true }).click();
      if (kind === 'edit') await page.locator('#change-text').fill('必须清除的未确认编辑');
      await page.locator('#change-save').click();
      await expect(page.locator('#change-save')).toBeEnabled(); armed = true;
      await page.locator('#change-save').click();
    } else if (operation === 'send receipt') {
      await page.route(url => url.pathname === '/messages', route => route.abort('failed'));
      await page.locator('#message').fill('必须清除的待确认发送'); await page.locator('#send').click();
      await expect(page.locator('[data-action="check-receipt"]')).toBeEnabled(); armed = true;
      await page.locator('[data-action="check-receipt"]').click();
    } else {
      armed = true;
      demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, '触发新阅读位置', 'next-read-position'));
    }
    await expect.poll(() => denied).toBe(1);
    await expect(page.locator('#room-title')).toHaveText(other.conversationId);
    await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('#change-text')).toHaveValue('');
    await expect(page.locator('#app')).not.toContainText('必须清除');
    await expect(page.locator('.message-text')).toHaveText('另一讨论仍可浏览');
    await expect(page.locator('#connect')).toBeHidden(); await expect(page.locator('#sync-error')).toBeVisible();
  });
}

test('a retry receipt with no result followed by send-only denial preserves readable content', async ({ page }) => {
  demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, '仍有阅读权限的正文', 'readable-source'));
  await connect(page); let posts = 0;
  await page.route('**/messages/*/edit', async route => {
    posts++;
    if (posts === 1) return route.abort('failed');
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).actions = ['read'];
    const response = await forward(route); expect(response.status()).toBe(403); await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click(); await page.locator('#change-text').fill('尚未提交的修改');
  await page.locator('#change-save').click(); await expect(page.locator('#change-save')).toBeEnabled();
  await page.locator('#change-save').click(); await expect.poll(() => posts).toBe(2);
  await expect(page.locator('#change-save')).toHaveText('核对变更结果');
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('.message-text')).toHaveText('仍有阅读权限的正文');
});

test('a background read denial fences a held session response and keeps remaining polling alive', async ({ page }) => {
  demo.engine.commit(() => {
    demo.engine.state.createMessage('demo-owner', scope, '后台待清除内容', 'background-read');
    demo.engine.state.createMessage('demo-owner', other, '当前讨论保留', 'current-read');
  });
  let releaseRead, releaseSession, readHeld = false, sessionHeld = false, holdSession = false, offline = false, retries = 0;
  const readGate = new Promise(resolve => { releaseRead = resolve; }), sessionGate = new Promise(resolve => { releaseSession = resolve; });
  await page.route(url => url.pathname === '/read-position', async route => {
    if (route.request().postDataJSON().conversationId !== scope.conversationId) return route.continue();
    readHeld = true; await readGate; const response = await forward(route); expect(response.status()).toBe(403); await route.fulfill({ response });
  });
  await page.route(url => url.pathname === '/session', async route => {
    if (offline) { retries++; return route.abort('failed'); }
    if (!holdSession) return route.continue();
    holdSession = false; const response = await forward(route); sessionHeld = true; await sessionGate; await route.fulfill({ response });
  });
  try {
    await connect(page); await expect.poll(() => readHeld).toBe(true);
    holdSession = true; await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
    await expect.poll(() => sessionHeld).toBe(true);
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).revoked = true;
    offline = true; releaseRead();
    await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
    releaseSession(); await expect.poll(() => retries).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
    await expect(page.locator('.message-text')).toHaveText('当前讨论保留'); await expect(page.locator('#connect')).toBeHidden();
  } finally { releaseRead(); releaseSession(); }
});

test('a late denial from a discarded room cannot clear a freshly authorized cache', async ({ page }) => {
  demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, '重新授权后可读', 'fresh-cache'));
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId);
  let release, held = false, first = true; const gate = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/read-position', async route => {
    if (!first || route.request().postDataJSON().conversationId !== scope.conversationId) return route.continue();
    first = false; grant.revoked = true;
    const response = await forward(route); expect(response.status()).toBe(403); held = true; await gate; await route.fulfill({ response });
  });
  try {
    await connect(page); await expect.poll(() => held).toBe(true);
    await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
    grant.revoked = false;
    await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
    await expect(page.locator('.message-text')).toHaveText('重新授权后可读');
    const completed = page.waitForResponse(response => response.url().endsWith('/read-position') && response.status() === 403);
    release(); await completed;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#connection-status')).toHaveText('已连接');
    await expect(page.locator('#room-title')).toHaveText(scope.conversationId);
    await expect(page.locator('.message-text')).toHaveText('重新授权后可读');
  } finally { release(); }
});
