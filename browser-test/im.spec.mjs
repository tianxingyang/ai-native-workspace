import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => {
  // Stop browser polling and settle intercepted responses before ending its host.
  await page.unrouteAll({ behavior: 'wait' });
  await page.close();
  await demo.stop();
});
async function forward(route) {
  try { return await route.fetch(); }
  catch { throw new Error('Mock request forwarding failed; authorization headers omitted.'); }
}
async function connect(page) {
  await page.goto(demo.url);
  await page.getByLabel('本地演示访问凭据').fill(demo.ownerToken);
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}
// Captures are review evidence: settle motion and park the pointer first.
async function capture(page, name, options = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(1, 1);
  await mkdir('.impeccable/review', { recursive: true });
  await page.screenshot({ path: `.impeccable/review/${name}.png`, ...options });
}
async function send(page, text) {
  await page.getByLabel('发送到当前会话的消息').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.message-text').filter({ hasText: text })).toHaveCount(1);
}

test('automatic receipt reconciliation preserves history position and leaves newer messages unread', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' }, messages = [];
  for (let i = 0; i < 50; i++) messages.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `回执前历史 ${i}`, `receipt-history-${i}`).message));
  demo.engine.commit(() => demo.engine.state.advanceReadPosition('demo-owner', scope, messages.at(-1).id));
  await connect(page);
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await forward(route); await route.abort('failed');
  });
  await page.getByLabel('发送到当前会话的消息').fill('已接受但丢失回执');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对发送结果', exact: true })).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(51);
  const own = [...demo.engine.state.messages.values()].at(-1);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(own.id);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 500; node.focus(); });
  const marker = demo.engine.state.readPosition('demo-owner', scope);
  for (let i = 0; i < 20; i++) demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `尚未阅读 ${i}`, `receipt-unread-${i}`));
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('.message')).toHaveCount(71);
  expect(await page.locator('#timeline').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(500);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(marker);
  await expect(page.locator('#timeline')).toBeFocused();
});

test('manual receipt checks retain keyboard focus while waiting and after an empty receipt', async ({ page }) => {
  await connect(page);
  await page.route(url => url.pathname === '/messages', async route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  let release; const hold = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/messages/receipt', async route => { await hold; await route.continue(); });
  try {
    await page.getByLabel('发送到当前会话的消息').fill('待核对焦点');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('button', { name: '核对发送结果', exact: true }).click();
    await expect(page.locator('#outbox [data-action="pending-status"]')).toBeFocused();
    release();
    await expect(page.getByRole('button', { name: '核对发送结果', exact: true })).toBeFocused();
    await expect(page.locator('#outbox')).toContainText('暂未查到已送达记录');
  } finally { release(); }
});

test('read-only send reconciliation clears an accepted lost send using its current retracted message', async ({ page }) => {
  await connect(page); let posts = 0, receipts = 0;
  await page.route(url => url.pathname === '/messages/receipt', async route => { receipts++; await route.continue(); });
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; const response = await forward(route), result = await response.json();
    demo.engine.commit(() => demo.engine.changeMessage('demo-owner', result.message.id, 'retract', 1, 'withdraw-before-receipt'));
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
    await route.abort('failed');
  });
  await page.getByLabel('发送到当前会话的消息').fill('回执核对后不应残留的原文');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => receipts).toBeGreaterThan(0);
  await expect(page.locator('#outbox')).toBeEmpty();
  await expect(page.locator('#message')).toHaveValue(''); await expect(page.locator('#message')).toBeDisabled();
  await expect(page.locator('.message-text')).toHaveText('消息已撤回');
  await expect(page.locator('#app')).not.toContainText('回执核对后不应残留的原文');
  await expect(page.locator('#connect')).toBeHidden(); expect(posts).toBe(1);
});

test('an absent receipt remains unknown and cannot resend until speaking is authorized', async ({ page }) => {
  await connect(page);
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  const actions = [...grant.actions], ids = []; let blocked = true;
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push(route.request().postDataJSON().clientEventId);
    if (blocked) { blocked = false; grant.actions = ['read']; return route.abort('failed'); }
    await route.continue();
  });
  await page.getByLabel('发送到当前会话的消息').fill('仍待核对的发送');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('#outbox')).toContainText('暂未查到已送达记录');
  await expect(page.getByRole('button', { name: '重试同一条消息', exact: true })).toHaveCount(0);
  expect(ids).toHaveLength(1); expect(demo.engine.state.messages.size).toBe(0);
  grant.actions = actions;
  await page.getByRole('button', { name: '重试同一条消息', exact: true }).click();
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('.message-text')).toHaveText('仍待核对的发送');
  expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); expect(demo.engine.state.messages.size).toBe(1);
});

test('a send denial preserves readable conversation and its pending reconciliation', async ({ page }) => {
  await connect(page);
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() === 'POST') demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
    await route.continue();
  });
  await page.getByLabel('发送到当前会话的消息').fill('发言撤权竞态');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('#outbox')).toContainText('暂未查到已送达记录');
  await expect(page.locator('#connect')).toBeHidden(); await expect(page.locator('#seat')).toContainText('列席');
  expect(demo.engine.state.messages.size).toBe(0);
});

test('opening a long discussion resumes at the first unread message without reading the tail', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' }, messages = [];
  for (let i = 0; i < 60; i++) messages.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `历史正文 ${i}`, `unread-entry-${i}`).message));
  demo.engine.commit(() => demo.engine.state.advanceReadPosition('demo-owner', scope, messages[19].id));
  await connect(page);
  await expect(page.locator('.unread-divider')).toHaveText('新消息');
  const target = page.locator(`[data-message="${messages[20].id}"]`);
  const timeline = page.locator('#timeline');
  await expect.poll(async () => Math.round((await target.boundingBox()).y - (await timeline.boundingBox()).y)).toBe(24);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(messages[19].id);
  await timeline.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(messages[59].id);
  await connect(page);
  await expect(page.locator('.unread-divider')).toHaveCount(0);
  expect(await timeline.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(90);
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  const added = [];
  for (let i = 0; i < 20; i++) added.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `离开后新增 ${i}`, `entry-later-${i}`).message));
  await expect(page.locator('.room').filter({ hasText: '产品讨论' }).locator('.room-badge')).toHaveText('20');
  await page.locator('.room').filter({ hasText: '产品讨论' }).click();
  await expect.poll(async () => Math.round((await page.locator(`[data-message="${added[0].id}"]`).boundingBox()).y - (await timeline.boundingBox()).y)).toBe(24);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(messages[59].id);
});

test('conversation switching restores a history anchor despite edits above it', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' }, messages = [];
  for (let i = 0; i < 35; i++) messages.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `锚点正文 ${i}`, `scroll-anchor-${i}`).message));
  demo.engine.commit(() => demo.engine.state.advanceReadPosition('demo-owner', scope, messages.at(-1).id));
  await connect(page);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 900; });
  const anchor = await page.locator('#timeline').evaluate(timeline => {
    const top = timeline.getBoundingClientRect().top;
    const item = [...timeline.querySelectorAll('.message')].find(node => node.getBoundingClientRect().bottom > top);
    return { id: item.dataset.message, offset: item.getBoundingClientRect().top - top };
  });
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  demo.engine.commit(() => demo.engine.changeMessage('demo-researcher', messages[0].id, 'edit', 1, 'edit-above-anchor', '变长的原文\n'.repeat(25)));
  await expect.poll(() => page.locator('.room').filter({ hasText: '产品讨论' }).getAttribute('aria-current')).toBe('false');
  // Wait for the background snapshot containing the edit, not a fixed timeout.
  await page.waitForResponse(async response => response.url().includes('/sync?') && response.request().method() === 'GET'
    && (await response.json()).messages?.some(message => message.id === messages[0].id && message.revision === 2));
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect.poll(async () => Math.round((await page.locator(`[data-message="${anchor.id}"]`).boundingBox()).y - (await page.locator('#timeline').boundingBox()).y)).toBe(Math.round(anchor.offset));
  await expect(page.locator('.unread-divider')).toHaveCount(0);
  const added = [];
  for (let i = 0; i < 20; i++) added.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `历史阅读期间新增 ${i}`, `history-new-${i}`).message));
  await expect(page.locator('.message')).toHaveCount(55);
  await page.getByRole('button', { name: '查看新消息', exact: true }).click();
  await expect.poll(async () => Math.round((await page.locator(`[data-message="${added[0].id}"]`).boundingBox()).y - (await page.locator('#timeline').boundingBox()).y)).toBe(24);
  await expect(page.locator(`[data-message="${added[0].id}"]`)).toBeFocused();
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(messages.at(-1).id);
});

test('narrow conversation-list navigation preserves the visible history anchor', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' }, messages = [];
  for (let i = 0; i < 45; i++) messages.push(demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `窄屏历史 ${i}`, `narrow-history-${i}`).message));
  demo.engine.commit(() => demo.engine.state.advanceReadPosition('demo-owner', scope, messages.at(-1).id));
  await page.setViewportSize({ width: 390, height: 844 }); await connect(page);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 900; });
  const before = await page.locator('#timeline').evaluate(node => node.scrollTop);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect.poll(() => page.locator('#timeline').evaluate(node => node.scrollTop)).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an open message editor does not mark incoming background messages as read', async ({ page }) => {
  await connect(page); await send(page, '编辑期间保留未读');
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  const original = [...demo.engine.state.messages.values()][0];
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(original.id);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const incoming = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, '编辑框背后的新消息', 'editor-background').message);
  await expect(page.locator('.message-text').filter({ hasText: incoming.text })).toHaveCount(1);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(original.id);
  await page.getByRole('button', { name: '返回讨论', exact: true }).click();
  await expect(page.locator('#timeline')).toBeFocused();
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(incoming.id);
});

for (const width of [1280, 390]) test(`message editor owns keyboard navigation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await connect(page); await send(page, '对话框快捷键隔离');
  if (width === 1280) await page.locator('#members-toggle').click();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('#room-title')).toHaveText('产品讨论');
  await expect(page.getByLabel('消息内容', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#message-change')).not.toBeVisible();
  await expect(page.locator('#timeline')).toBeFocused();
  if (width === 1280) await expect(page.locator('#details')).toBeVisible();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
});

test('unread positions survive reconnect and another client advances the same member', async ({ page, context }) => {
  const scope = { conversationId: '研发讨论', threadId: '插件协议' };
  const seed = id => demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, id, id).message);
  const first = seed('first-unread');
  await connect(page);
  const room = page.locator('.room').filter({ hasText: '研发讨论' });
  await expect(room.locator('.room-badge')).toHaveText('1');
  await room.click();
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(first.id);
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  const second = seed('second-unread');
  await expect(room.locator('.room-badge')).toHaveText('1');
  await connect(page); await expect(room.locator('.room-badge')).toHaveText('1');
  const device = await context.newPage();
  try {
    await connect(device);
    await device.locator('.room').filter({ hasText: '研发讨论' }).click();
    await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(second.id);
    await expect(room.locator('.room-badge')).toBeHidden();
  } finally { await device.close(); }
});

test('failed read-position delivery retries its fixed target after switching rooms', async ({ page }) => {
  const scope = { conversationId: '研发讨论', threadId: '插件协议' };
  const seed = id => demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, id, id).message);
  const seen = seed('seen-before-network-failure');
  let blocked = true, attempts = 0;
  await page.route(url => url.pathname === '/read-position', async route => {
    attempts++;
    if (blocked) return route.abort('failed');
    await route.continue();
  });
  await connect(page);
  const room = page.locator('.room').filter({ hasText: '研发讨论' });
  await room.click(); await expect.poll(() => attempts).toBeGreaterThan(0);
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  seed('unseen-background-message'); blocked = false;
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(seen.id);
  await expect(room.locator('.room-badge')).toHaveText('1');
});

test('read acknowledgement loss is reconciled and hidden or scrolled-back views do not advance', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  const seed = id => demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, id, id).message);
  for (let i = 0; i < 30; i++) seed(`read-history-${i}`);
  const original = [...demo.engine.state.messages.values()].at(-1);
  demo.engine.commit(() => demo.engine.state.advanceReadPosition('demo-owner', scope, original.id));
  let lost = false;
  await page.route(url => url.pathname === '/read-position', async route => {
    if (lost) return route.continue();
    lost = true; await forward(route); await route.abort('failed');
  });
  await connect(page);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(original.id);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
  const unseen = seed('arrived-while-reading-history');
  await expect(page.locator('.message-text').filter({ hasText: unseen.text })).toHaveCount(1);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(original.id);
  await page.getByRole('button', { name: '查看新消息', exact: true }).click();
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(unseen.id);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  const hidden = seed('arrived-while-hidden');
  await expect(page.locator('.message-text').filter({ hasText: hidden.text })).toHaveCount(1);
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(unseen.id);
  await page.evaluate(() => { delete document.hidden; });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(hidden.id);
  expect(lost).toBe(true);
});

test('message search matches literal text only in the current scope and follows changes', async ({ page }) => {
  await connect(page); await send(page, 'Release [draft] <script>literal</script>');
  const source = [...demo.engine.state.messages.values()][0];
  await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: '研发讨论', threadId: '插件协议', text: 'RELEASE other scope', clientEventId: 'search-other' });
  await page.getByRole('button', { name: '查找当前讨论的消息', exact: true }).click();
  const query = page.getByLabel('查找消息正文');
  await expect(query).toBeFocused(); await query.fill('release');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('#search-results')).not.toContainText('other scope');
  await query.fill('[draft]'); await expect(page.locator('.search-result')).toHaveCount(1);
  expect(await page.locator('#search-results script').count()).toBe(0);
  await page.locator('.search-result').click();
  await expect(page.locator('#details')).toBeHidden(); await expect(page.locator('.message').first()).toBeFocused();
  await expect(query).toHaveValue(''); await expect(page.locator('#search-results')).toBeEmpty();
  await page.getByRole('button', { name: '查找当前讨论的消息', exact: true }).click(); await query.fill('release');
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/edit`, { expectedRevision: 1, clientEventId: 'search-edit', text: 'Changed body' });
  await expect(page.locator('.search-result')).toHaveCount(0); await query.fill('changed');
  await expect(page.locator('.search-result')).toHaveCount(1); await expect(query).toBeFocused();
  await page.locator('.search-result').focus();
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/retract`, { expectedRevision: 2, clientEventId: 'search-retract' });
  await expect(page.locator('.search-result')).toHaveCount(0); await expect(page.locator('#search-results')).not.toContainText('Changed body');
  await expect(query).toBeFocused();
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await expect(query).toHaveValue(''); await expect(page.locator('#details')).toBeHidden();
  await page.getByRole('button', { name: '查找当前讨论的消息', exact: true }).click(); await query.fill('release');
  await expect(page.locator('.search-result')).toContainText('other scope');
});

test('message search is readable without send permission and expands result batches', async ({ page }) => {
  for (let i = 0; i < 53; i++) demo.engine.state.createMessage('demo-owner', { conversationId: '产品讨论', threadId: '日常交流' }, `可检索消息 ${i}`, `search-batch-${i}`);
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
  await page.setViewportSize({ width: 390, height: 844 }); await connect(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '查找当前讨论的消息', exact: true }).click();
  await page.getByLabel('查找消息正文').fill('可检索');
  await expect(page.locator('.search-result')).toHaveCount(50);
  await expect(page.locator('.search-result').first()).toContainText('52');
  await page.getByRole('button', { name: '显示更多消息', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(53);
  await expect(page.locator('.search-result').nth(50)).toBeFocused();
  const focusedMessage = await page.locator('.search-result').nth(50).getAttribute('data-search-message');
  demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', { conversationId: '产品讨论', threadId: '日常交流' }, '可检索的新消息', 'search-incoming'));
  await expect(page.locator('.search-result')).toHaveCount(54);
  await expect(page.locator(`.search-result[data-search-message="${focusedMessage}"]`)).toBeFocused();
  await expect(page.locator('#chat')).toHaveAttribute('inert');
  await capture(page, 'scoped-search-mobile', { fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查找当前讨论的消息', exact: true })).toBeFocused();
  await expect(page.locator('#search-results')).toBeEmpty();
});

test('message search clears query and matches at offline read expiry', async ({ page, context }) => {
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  grant.expiresAt = Date.now() + 6000;
  await connect(page); await send(page, '到期必须清除的查找正文');
  await page.getByRole('button', { name: '查找当前讨论的消息', exact: true }).click();
  await page.getByLabel('查找消息正文').fill('必须清除');
  await expect(page.locator('.search-result')).toHaveCount(1); await context.setOffline(true);
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.locator('#search-results')).toBeEmpty(); await expect(page.locator('#search-query')).toHaveValue('');
  await expect(page.locator('#details')).toBeHidden(); await expect(page.locator('#app')).not.toContainText('到期必须清除的查找正文');
  await context.setOffline(false);
});

test('nested replies stay in their discussion and quotes follow edits and retractions', async ({ page }) => {
  await connect(page); await send(page, '引用源消息');
  await page.locator('.message').first().getByRole('button', { name: '回复消息', exact: true }).click();
  await expect(page.locator('#reply-preview')).toContainText('引用源消息');
  await send(page, '第一条回复');
  await expect(page.locator('.reply-quote')).toContainText('引用源消息');
  await page.locator('.message').nth(1).getByRole('button', { name: '回复消息', exact: true }).click();
  await send(page, '回复的回复');
  await page.locator('.message').last().getByRole('button', { name: '查看这条消息的讨论', exact: true }).click();
  await expect(page.locator('#details .thread-item')).toHaveCount(3);
  const source = [...demo.engine.state.messages.values()][0];
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/edit`, { expectedRevision: 1, clientEventId: 'edit-reply-parent', text: '引用源消息已更新' });
  await expect(page.locator('#messages .reply-quote').first()).toContainText('引用源消息已更新');
  await expect(page.locator('#details')).toContainText('原消息已编辑');
  await requestJson(demo.url, demo.ownerToken, `/messages/${source.id}/retract`, { expectedRevision: 2, clientEventId: 'withdraw-reply-parent' });
  await expect(page.locator('#messages .reply-quote').first()).toContainText('消息已撤回');
  await expect(page.locator('#app')).not.toContainText('引用源消息已更新');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture(page, 'scoped-replies-mobile', { fullPage: true });
});

test('reply drafts are per room and are cleared when the room loses read access', async ({ page }) => {
  await connect(page); await send(page, '只在原会话可见的引用');
  await page.locator('.message').first().getByRole('button', { name: '回复消息', exact: true }).click();
  await page.getByLabel('发送到当前会话的消息').fill('尚未发送的回复');
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await expect(page.locator('#reply-preview')).toBeHidden();
  await expect(page.locator('#message')).toHaveValue('');
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect(page.locator('#reply-preview')).toContainText('只在原会话可见的引用');
  await expect(page.locator('#message')).toHaveValue('尚未发送的回复');
  // Revoke at session discovery, rather than race an in-flight snapshot (whose
  // authorization failure deliberately disconnects and clears every cache).
  await page.route(url => url.pathname === '/session', async route => {
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').revoked = true;
    await route.continue();
  });
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.locator('#reply-preview')).toBeHidden();
  await expect(page.locator('#reply-preview')).toBeEmpty();
  await expect(page.locator('#message')).toHaveValue('');
});

test('a lost reply acknowledgement is reconciled after its parent is withdrawn without duplication', async ({ page }) => {
  await connect(page); await send(page, '随后撤回的原文');
  const parent = [...demo.engine.state.messages.values()][0];
  await page.locator('.message').first().getByRole('button', { name: '回复消息', exact: true }).click();
  let once = true;
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST' || !once) return route.continue();
    once = false; await forward(route);
    await requestJson(demo.url, demo.ownerToken, `/messages/${parent.id}/retract`, { expectedRevision: 1, clientEventId: 'withdraw-after-reply' });
    await route.abort('failed');
  });
  await page.getByLabel('发送到当前会话的消息').fill('已发送但响应丢失的回复');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试同一条消息', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试同一条消息', exact: true }).click();
  await expect(page.locator('#outbox')).toBeEmpty();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.reply-quote')).toContainText('消息已撤回');
  expect([...demo.engine.state.messages.values()].filter(m => m.replyToMessageId === parent.id)).toHaveLength(1);
  await expect(page.locator('#app')).not.toContainText('随后撤回的原文');
});

test('editing running research rebuilds its session; retract removes content and obsolete results', async ({ page }) => {
  await connect(page); await send(page, '请调研编辑前的要求');
  await expect(page.locator('.status-label')).toHaveText('正在研究');
  const original = [...demo.engine.state.runs.values()][0];
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('请调研编辑后的新要求');
  await capture(page, 'message-edit-dialog');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.message-text').first()).toHaveText('请调研编辑后的新要求');
  await expect(page.locator('.status-label').last()).toHaveText('已完成');
  const replacement = [...demo.engine.state.runs.values()].find(r => r.id !== original.id);
  expect(replacement.sessionId).not.toBe(original.sessionId);
  expect(original.status).toBe('stopped'); expect(replacement.work.contextRevision).toBe(2);
  await page.getByRole('button', { name: '撤回消息', exact: true }).click();
  await page.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(page.locator('.message-text').first()).toHaveText('消息已撤回');
  await expect(page.locator('.message-text').last()).toHaveText('原上下文已变更，此结果已失效。');
  await expect(page.locator('.sources')).toHaveCount(0);
  await page.reload(); await page.getByLabel('本地演示访问凭据').fill(demo.ownerToken);
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('.message-text').first()).toHaveText('消息已撤回');
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0);
});

test('lost edit acknowledgement reconciles after speaking loss without replacing a newer device edit', async ({ page }) => {
  await connect(page); await send(page, '编辑核对原文'); let posts = 0, receipts = 0;
  await page.route(url => url.pathname === '/messages/change-receipt', async route => { receipts++; await route.continue(); });
  await page.route('**/messages/*/edit', async route => {
    posts++; const response = await forward(route), result = await response.json();
    demo.engine.commit(() => demo.engine.changeMessage('demo-owner', result.message.id, 'edit', 2, 'newer-device-edit', '另一设备的最新版本'));
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('已接收但随后被更新的版本');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect.poll(() => receipts).toBeGreaterThan(0);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.message-text')).toHaveText('另一设备的最新版本');
  await expect(page.locator('#announcement')).toContainText('消息随后又有变更');
  await expect(page.locator('#timeline')).toBeFocused();
  await expect(page.locator('#connect')).toBeHidden(); expect(posts).toBe(1);
  expect(demo.engine.state.changes.size).toBe(2);
});

test('missing change receipt preserves uncertainty and explicit retry reuses its original id', async ({ page }) => {
  await connect(page); await send(page, '待修改原文');
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  const actions = [...grant.actions], ids = []; let blocked = true;
  await page.route('**/messages/*/edit', async route => {
    ids.push(route.request().postDataJSON().clientEventId);
    if (blocked) { blocked = false; grant.actions = ['read']; return route.abort('failed'); }
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('同一变更重试后正文');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#change-error')).toContainText('暂未查到该次变更');
  const check = page.getByRole('button', { name: '核对变更结果', exact: true });
  await check.click(); await expect(check).toBeEnabled(); await expect(check).toBeFocused();
  expect(ids).toHaveLength(1); expect(demo.engine.state.changes.size).toBe(0);
  grant.actions = actions;
  const retry = page.getByRole('button', { name: '重试同一变更', exact: true });
  await expect(retry).toBeEnabled(); await retry.click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.message-text')).toHaveText('同一变更重试后正文');
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(demo.engine.state.changes.size).toBe(1);
});

test('a delayed change receipt cannot restore an unreadable room or submit again', async ({ page }) => {
  await connect(page); await send(page, '撤权后不应恢复的编辑正文'); let posts = 0;
  await page.route('**/messages/*/edit', async route => { posts++; await forward(route); await route.abort('failed'); });
  let release, received = false; const hold = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/messages/change-receipt', async route => {
    const response = await forward(route); received = true; await hold; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '编辑消息', exact: true }).click();
    await page.getByLabel('消息内容', { exact: true }).fill('撤权后的迟到回执正文');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await page.getByRole('button', { name: '重试同一变更', exact: true }).click();
    await expect.poll(() => received).toBe(true); await expect(page.locator('#change-error')).toBeFocused();
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').revoked = true;
    await expect(page.locator('#room-title')).toHaveText('研发讨论');
    await expect(page.getByRole('dialog')).not.toBeVisible(); release();
    await expect(page.locator('#change-text')).toHaveValue('');
    await expect(page.locator('#app')).not.toContainText('撤权后的迟到回执正文');
    await expect(page.locator('#connect')).toBeHidden(); expect(posts).toBe(1);
  } finally { release(); }
});

for (const kind of ['edit', 'retract']) test(`a lost ${kind} receipt survives a retracted snapshot while discarding withdrawn text`, async ({ page }) => {
  await connect(page); await send(page, '需要从编辑框移除的撤回原文'); let posts = 0, received = false;
  let release; const hold = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/messages/change-receipt', async route => {
    const response = await forward(route); received = true; await hold; await route.fulfill({ response });
  });
  await page.route(`**/messages/*/${kind}`, async route => {
    posts++; const response = await forward(route), result = await response.json();
    if (kind === 'edit') demo.engine.commit(() => demo.engine.changeMessage('demo-owner', result.message.id, 'retract', 2, 'other-device-retract'));
    else demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
    await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: kind === 'edit' ? '编辑消息' : '撤回消息', exact: true }).click();
    if (kind === 'edit') await page.getByLabel('消息内容', { exact: true }).fill('被撤回的编辑版本');
    await page.getByRole('button', { name: kind === 'edit' ? '保存修改' : '确认撤回', exact: true }).click();
    await expect.poll(() => received).toBe(true);
    await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.locator('#change-text')).toHaveValue('');
    await expect(page.locator('#change-text')).toBeHidden(); release();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('.message-text')).toHaveText('消息已撤回');
    await expect(page.locator('#announcement')).toContainText('消息变更已收到');
    await expect(page.locator('#timeline')).toBeFocused(); expect(posts).toBe(1);
  } finally { release(); }
});

test('another device retracting a message does not confirm an unreceived edit', async ({ page }) => {
  await connect(page); await send(page, '被另一设备撤回的正文'); let posts = 0;
  const source = [...demo.engine.state.messages.values()][0];
  await page.route('**/messages/*/edit', async route => {
    posts++; demo.engine.commit(() => demo.engine.changeMessage('demo-owner', source.id, 'retract', 1, 'independent-retraction'));
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('从未接收的编辑');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#change-error')).toContainText('暂未查到该次变更');
  await expect(page.locator('#change-text')).toHaveValue('');
  await page.getByRole('button', { name: '核对变更结果', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对变更结果', exact: true })).toBeEnabled();
  expect(posts).toBe(1); expect(demo.engine.state.changes.size).toBe(1);
});

test('send-only edit denial preserves readable conversations and permits receipt checks', async ({ page }) => {
  await connect(page); await send(page, '仍可阅读的原文');
  await page.route('**/messages/*/edit', async route => {
    demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').actions = ['read'];
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('未获授权的编辑');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对变更结果', exact: true })).toBeEnabled();
  await expect(page.locator('#change-error')).toContainText('暂未查到该次变更');
  await page.getByRole('button', { name: '返回讨论', exact: true }).click();
  await expect(page.locator('.message-text')).toHaveText('仍可阅读的原文');
  await expect(page.locator('#timeline')).toBeFocused();
  await expect(page.locator('#connect')).toBeHidden(); expect(demo.engine.state.changes.size).toBe(0);
});

test('lost edit response retries one change and a concurrent version conflict never overwrites newer content', async ({ page }) => {
  await connect(page); await send(page, '原始消息');
  let once = true;
  await page.route('**/messages/*/edit', async route => {
    if (!once) return route.continue();
    once = false; await forward(route); await route.abort('failed');
  });
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await page.getByLabel('消息内容', { exact: true }).fill('网络恢复后的编辑');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试同一变更' })).toBeEnabled();
  await page.getByRole('button', { name: '重试同一变更' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(demo.engine.state.changes.size).toBe(1);
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  const message = [...demo.engine.state.messages.values()][0];
  await requestJson(demo.url, demo.ownerToken, `/messages/${message.id}/edit`, { expectedRevision: 2, clientEventId: 'other-device', text: '另一台设备的新内容' });
  await page.getByLabel('消息内容', { exact: true }).fill('陈旧编辑');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.locator('#change-error')).toContainText('消息版本已变化');
  await expect(page.getByRole('button', { name: '重试同一变更' })).toBeDisabled();
  await page.getByRole('button', { name: '返回讨论', exact: true }).click();
  await expect(page.locator('.message-text')).toHaveText('另一台设备的新内容');
  expect(demo.engine.state.changes.size).toBe(2);
});

test('revoking the edited room clears the modal while another readable room remains', async ({ page }) => {
  await connect(page); await send(page, '失去权限后不能留在编辑框的内容');
  await page.getByRole('button', { name: '编辑消息', exact: true }).click();
  await expect(page.getByLabel('消息内容', { exact: true })).toHaveValue('失去权限后不能留在编辑框的内容');
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论').revoked = true;
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#change-text')).toHaveValue('');
  await expect(page.locator('#messages')).not.toContainText('失去权限后不能留在编辑框的内容');
  await expect(page.locator('#connect')).toBeHidden();
});

test('real two-process research returns to its source, sources are honest, desktop and narrow screen', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await connect(page);
  await page.getByRole('button', { name: '2 位成员' }).click();
  await expect(page.locator('#members')).toContainText('研究伙伴');
  await send(page, '请调研一下插件协议，整理取消与恢复的边界。');
  await expect(page.locator('.status-label')).toHaveText('正在研究');
  await expect(page.locator('.status-label')).toHaveText('已完成');
  await expect(page.locator('.message-text')).toHaveCount(2);
  await expect(page.locator('.result-label')).toHaveText('模拟研究结果 · 合成资料');
  await page.locator('.sources summary').click();
  await expect(page.locator('.sources')).toContainText('测试占位地址');
  await page.getByRole('button', { name: '查看来源消息与讨论' }).click();
  await expect(page.locator('#details-title')).toHaveText('讨论详情');
  await expect(page.locator('#details-title')).toBeFocused();
  await expect(page.locator('#details .thread-item')).toHaveCount(2);
  await expect(page.locator('#details')).toContainText('测试占位地址');
  await expect(page.locator('.message')).toHaveCount(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await capture(page, 'desktop-discussion');
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.getByRole('button', { name: '查看来源消息与讨论' })).toBeFocused();
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
  await capture(page, 'desktop', { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '会话列表' })).toBeVisible();
  await capture(page, 'mobile', { fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '会话列表' }).click();
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.locator('#room-title')).toBeFocused();
  await expect(page.locator('.message')).toHaveCount(0);
  await send(page, '新的会话只讨论接口命名。');
  await page.getByRole('button', { name: '会话列表' }).click();
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect(page.locator('.message')).toHaveCount(2);
  expect(errors).toEqual([]);
  const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
  expect(stored).toEqual({ local: 0, session: 0, cookies: '' });
});

test('running cancellation is accepted before a real stopped receipt', async ({ page }) => {
  await connect(page); await send(page, '请调研取消协议');
  await expect(page.locator('.status-label')).toHaveText('正在研究');
  await expect(page.locator('#seats .seat.is-live')).toContainText('研究伙伴');
  await capture(page, 'desktop-running');
  let acceptedStatus, holdRuns = false;
  await page.route('**/runs/*/cancel', async route => {
    const response = await forward(route); acceptedStatus = (await response.json()).status; holdRuns = true; await route.fulfill({ response });
  });
  // Briefly hold run polling so acceptance-before-stop is observable evidence, not a race.
  await page.route(url => url.pathname === '/sync', async route => {
    if (holdRuns) await new Promise(resolve => setTimeout(resolve, 2500));
    await route.continue();
  });
  await page.getByRole('button', { name: '取消研究', exact: true }).click();
  await expect(page.locator('.status-label')).toHaveText('等待停止确认');
  await expect(page.locator('.run')).toContainText('尚未收到实际停止确认');
  await capture(page, 'cancel-requested');
  holdRuns = false;
  await expect(page.locator('.status-label')).toHaveText('已停止');
  expect(acceptedStatus).toBe('cancel_requested');
  await expect(page.locator('.run')).toContainText('执行设备已确认运行结束');
  const run = [...demo.engine.state.runs.values()][0];
  expect(run.events.some(event => event.kind === 'stopped' && event.data.executionSettled === true)).toBe(true);
  expect([...demo.engine.state.messages.values()].filter(message => message.origin === 'research')).toHaveLength(0);
  await capture(page, 'cancelled', { fullPage: true });
  await send(page, '请调研一下窄窗口里的进度展示');
  await expect(page.locator('.status-label').last()).toHaveText('正在研究');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'mobile-running');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Tauri shell mode reuses the interface through the native request bridge with no credential field', async ({ page }) => {
  const calls = [];
  // Stands in for the Rust/Node bridge: the credential stays in this test process, never in the page.
  await page.exposeFunction('__bridge', async (path, body) => {
    const response = await fetch(new URL(path, demo.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${demo.ownerToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  });
  await page.exposeFunction('__record', command => { calls.push(command); });
  await page.addInitScript(() => {
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        await window.__record(command);
        if (command === 'desktop_request') return window.__bridge(args.path, args.body);
        if (command === 'desktop_take_notification') return { kind: 'none' };
        return null;
      } },
      event: { listen: async () => () => {} },
    };
  });
  await page.goto(demo.url);
  await expect(page.locator('#token')).toBeHidden();
  await expect(page.locator('.demo-note')).toContainText('CoSeat Demo 0.1.3');
  await page.getByRole('button', { name: '进入本地演示' }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(calls).toContain('desktop_connected');
  await send(page, '桌面壳中的普通消息');
  await expect(page.getByRole('button', { name: '断开连接' })).toBeVisible();
  await capture(page, 'desktop-shell');
  await page.getByRole('button', { name: '退出应用' }).click();
  await expect.poll(() => calls.includes('desktop_quit')).toBe(true);
  await page.getByRole('button', { name: '断开连接' }).click();
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
});

for (const inFlight of [false, true]) {
  test(`cancellation keeps its task when ${inFlight ? 'a stale poll is in flight' : 'refresh fails'}`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await connect(page); await send(page, '请调研取消响应关联');
    await expect(page.locator('.status-label')).toHaveText('正在研究');
    const runId = await page.locator('.run').getAttribute('data-run');
    const sourceId = await page.locator('.message').getAttribute('data-message');
    let failReads = false, releasePoll, pollReady;
    const ready = new Promise(resolve => { pollReady = resolve; });
    const release = new Promise(resolve => { releasePoll = resolve; });
    await page.route('**/sync?*', async route => {
      if (inFlight && !failReads) {
        const response = await forward(route);
        pollReady(); await release;
        await route.fulfill({ response });
      } else if (failReads) await route.abort('failed');
      else await route.continue();
    });
    await page.route('**/session', async route => {
      if (failReads) await route.abort('failed'); else await route.continue();
    });
    let acknowledgement;
    await page.route('**/runs/*/cancel', async route => {
      const response = await forward(route); acknowledgement = await response.json();
      failReads = true; await route.fulfill({ response });
    });
    if (inFlight) await ready;
    try {
      await page.getByRole('button', { name: '取消研究', exact: true }).click();
      await expect(page.locator('#announcement')).toHaveText('取消请求已受理，正在核对停止状态。');
      expect(acknowledgement).toEqual({ status: 'cancel_requested', publishedReceiptId: null });
      const card = page.locator(`[data-message="${sourceId}"] [data-run="${runId}"]`);
      await expect(card.locator('.status-label')).toHaveText('等待停止确认');
      await expect(card).toContainText('尚未收到实际停止确认');
      await expect(card.getByRole('button', { name: '取消研究', exact: true })).toHaveCount(0);
      releasePoll();
      await expect(page.locator('#sync-error')).toBeVisible();
      await expect(card.locator('.status-label')).toHaveText('等待停止确认');
      await page.unroute('**/sync?*'); await page.unroute('**/session');
      await page.getByRole('button', { name: '立即重连' }).click();
      await expect(card.locator('.status-label')).toHaveText('已停止');
      await expect(card).toContainText('执行设备已确认运行结束');
      expect(errors).toEqual([]);
    } finally { releasePoll(); }
  });
}

test('late cancellation acknowledgement preserves a polled stopped receipt', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await connect(page); await send(page, '请调研停止回执保留');
  await expect(page.locator('.status-label')).toHaveText('正在研究');
  let releaseCancel;
  const release = new Promise(resolve => { releaseCancel = resolve; });
  await page.route('**/runs/*/cancel', async route => {
    const response = await forward(route);
    expect((await response.json()).status).toBe('cancel_requested');
    await release; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '取消研究', exact: true }).click();
    await expect(page.locator('.status-label')).toHaveText('已停止');
    await expect(page.locator('.run')).toContainText('执行设备已确认运行结束');
    await page.route('**/session', route => route.abort('failed'));
    releaseCancel();
    await expect(page.locator('#announcement')).toHaveText('取消请求已受理，正在核对停止状态。');
    await expect(page.locator('#sync-error')).toBeVisible();
    await expect(page.locator('.status-label')).toHaveText('已停止');
    await expect(page.locator('.run')).toContainText('执行设备已确认运行结束');
    expect(errors).toEqual([]);
  } finally { releaseCancel(); }
});

test('lost send response and repeated submit retry the same message without duplicate work', async ({ page }) => {
  await connect(page);
  let drop = true;
  await page.route('**/messages', async route => {
    if (route.request().method() === 'POST' && drop) { drop = false; await forward(route); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByLabel('发送到当前会话的消息').fill('请调研消息去重');
  await page.locator('#composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); form.requestSubmit(); });
  await expect(page.getByRole('button', { name: '重试同一条消息' })).toBeVisible();
  await page.getByRole('button', { name: '重试同一条消息' }).click();
  await expect(page.locator('#outbox')).toBeEmpty();
  expect([...demo.engine.state.messages.values()].filter(m => m.origin === 'chat')).toHaveLength(1);
  expect(demo.engine.state.runs.size).toBe(1);
  await expect(page.locator('.status-label')).toHaveText('已完成');
});

test('offline recovery, refresh reconnect, draft isolation and untrusted message text', async ({ page, context }) => {
  await connect(page); await send(page, '<img src=x onerror=alert(1)> 普通讨论');
  await expect(page.locator('.message img')).toHaveCount(0);
  await page.getByLabel('发送到当前会话的消息').fill('未发送草稿');
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await expect(page.locator('#message')).toHaveValue('');
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect(page.locator('#message')).toHaveValue('未发送草稿');
  await context.setOffline(true);
  await expect(page.locator('#sync-error')).toBeVisible();
  await expect(page.locator('#connection-status')).toHaveText('连接中断');
  await context.setOffline(false);
  await expect(page.locator('#sync-error')).toBeHidden();
  await page.reload(); await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#token')).toHaveValue('');
  await page.getByLabel('本地演示访问凭据').fill(demo.ownerToken);
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('.message-text')).toContainText('普通讨论');
  expect(demo.engine.state.messages.size).toBe(1);
});

test('invalid identity, read-only permissions and expiry fail closed with honest feedback', async ({ page }) => {
  await page.goto(demo.url); await page.getByLabel('本地演示访问凭据').fill('invalid');
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('#connect-error')).toContainText('凭据无效');
  await capture(page, 'connect');
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'connect-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const grant of demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner')) grant.actions = ['read'];
  await connect(page); await expect(page.locator('#message')).toBeDisabled();
  await expect(page.locator('#send-help')).toContainText('只读');
  for (const grant of demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner')) grant.expiresAt = Date.now() - 1;
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#connect-error')).toContainText('授权已到期');
  await expect(page.locator('#messages')).toBeEmpty();
});

test('send while switching conversations keeps acknowledgement and pending state scoped', async ({ page }) => {
  await connect(page);
  await page.route('**/messages', async route => {
    if (route.request().method() === 'POST') { const response = await forward(route); await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({ response }); }
    else await route.continue();
  });
  await page.getByLabel('发送到当前会话的消息').fill('慢响应的普通消息');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click();
  await expect(page.locator('#outbox')).toBeEmpty();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect(page.locator('#outbox')).toBeEmpty();
  await expect(page.locator('.message-text')).toHaveText('慢响应的普通消息');
});

test('keyboard navigation survives polling, Enter sends and composition does not submit', async ({ page }) => {
  await connect(page);
  const room = page.getByRole('button', { name: '研发讨论 插件协议' });
  await room.focus();
  await page.waitForResponse(response => response.url().endsWith('/session'));
  await expect(room).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await page.locator('#message').fill('输入法组合');
  await page.locator('#message').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(demo.engine.state.messages.size).toBe(0);
  await page.locator('#message').press('Shift+Enter');
  await expect(page.locator('#message')).toHaveValue('输入法组合\n');
  await page.locator('#message').press('Enter');
  await expect(page.locator('.message-text')).toHaveText('输入法组合');
});

test('focused source disclosures survive incoming messages and cancelled controls leave visible focus', async ({ page }) => {
  await connect(page); await send(page, '请调研来源关联');
  await expect(page.locator('.status-label')).toHaveText('已完成');
  const summary = page.locator('.sources summary'); await summary.focus(); await summary.press('Enter');
  await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: '产品讨论', threadId: '日常交流', text: '收到，继续讨论。', clientEventId: 'focus-incoming' });
  await expect(page.locator('.message-text').last()).toHaveText('收到，继续讨论。');
  await expect(summary).toBeFocused();
  await expect(page.locator('.sources')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '查看来源消息与讨论' }).focus();
  await page.keyboard.press('Enter'); await expect(page.locator('#details-title')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#details')).toBeHidden();
  await expect(page.getByRole('button', { name: '查看来源消息与讨论' })).toBeFocused();
  await page.getByRole('button', { name: '查看来源消息与讨论' }).click();
  await page.getByRole('button', { name: '退出连接' }).click();
  await connect(page); await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('.message')).toHaveCount(3);
});

test('other conversations surface live research and new results; a finished card jumps to its result', async ({ page }) => {
  await connect(page);
  await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: '研发讨论', threadId: '插件协议', text: '请调研一下插件协议的版本策略。', clientEventId: 'other-room-research' });
  const other = page.getByRole('button', { name: '研发讨论 插件协议' });
  await expect(other).toHaveAttribute('aria-label', /调研进行中/);
  await expect(other.locator('.room-preview')).toContainText('正在调研');
  await capture(page, 'desktop-live');
  await expect(page.locator('#seats')).not.toContainText('调研中');
  await expect(other).toHaveAttribute('aria-label', /1 条新消息/);
  await expect(other.locator('.room-badge')).toHaveText('1');
  await capture(page, 'desktop-new');
  await other.click();
  await expect(page.locator('.status-label')).toHaveText('已完成');
  await expect(other).not.toHaveAttribute('aria-label', /新消息/);
  await expect(page.locator('.run-steps').first()).toContainText('结果回到讨论');
  await page.getByRole('button', { name: '查看结果' }).click();
  await expect(page.locator('article.message.is-result')).toBeFocused();
});

test('own permissions, advance expiry notice, and a lapsed speaking grant fold the seat to read-only', async ({ page }) => {
  await connect(page);
  await expect(page.locator('#seat')).toContainText('出席');
  await page.getByRole('button', { name: '2 位成员' }).click();
  await expect(page.locator('#details-title')).toHaveText('座次与权限');
  await expect(page.locator('#my-seat')).toContainText('取消调研');
  await expect(page.locator('#my-seat')).toContainText('可用');
  await capture(page, 'desktop-members');
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.getByRole('button', { name: '2 位成员' })).toBeFocused();
  const [grant] = demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner');
  grant.expiresAt = Date.now() + 4 * 60 * 1000;
  await expect(page.locator('#expiry')).toContainText('到期');
  await expect(page.locator('#seat')).toContainText('剩');
  await capture(page, 'desktop-expiring');
  grant.actions = ['read', 'cancel']; grant.expiresAt = Date.now() + 20 * 60 * 1000;
  demo.engine.state.config.grants.push({ ...grant, id: 'grant-demo-owner-short-send', actions: ['send'], expiresAt: Date.now() + 5000 });
  await expect(page.locator('#send-help')).toContainText('到期', { timeout: 15000 });
  await expect(page.locator('#send-help')).toContainText('只读');
  await expect(page.locator('#message')).toBeDisabled();
  await expect(page.locator('#seat')).toContainText('列席');
  await expect(page.locator('#expiry')).toBeHidden();
  await capture(page, 'desktop-readonly');
});

test('offline read expiry clears only the expired room, its draft and open details', async ({ page, context }) => {
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  grant.expiresAt = Date.now() + 6000;
  await connect(page); await send(page, '请调研到期后不应留在缓存中的测试消息');
  await page.locator('#message').fill('到期后应清除的草稿');
  await page.getByRole('button', { name: '查看这条消息的讨论' }).click();
  await expect(page.locator('#details')).toBeVisible();
  await expect(page.locator('#details-thread')).toContainText('到期后不应留在缓存中的测试消息');
  await context.setOffline(true);
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  expect(Date.now()).toBeGreaterThanOrEqual(grant.expiresAt);
  await expect(page.locator('.room')).toHaveCount(1);
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#messages')).not.toContainText('到期后不应留在缓存中的测试消息');
  await expect(page.locator('#rooms')).not.toContainText('到期后不应留在缓存中的测试消息');
  await expect(page.locator('#app')).not.toContainText('到期后不应留在缓存中的测试消息');
  await expect(page.locator('#details-thread')).toBeEmpty();
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('#chat')).not.toHaveAttribute('inert');
  await capture(page, 'partial-read-expiry');
  await context.setOffline(false);
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await send(page, '仍在授权范围内的会话继续可用');
  await expect(page.locator('.room')).toHaveCount(1);
});

test('read deadline clears all cached scopes even while session polling is stalled', async ({ page }) => {
  for (const grant of demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner')) grant.expiresAt = Date.now() + 4500;
  await connect(page); await send(page, '阅读到期清理');
  // Retain a response sampled before expiry; it must not revive expired scopes.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let sampled;
  const sampling = new Promise(resolve => { sampled = resolve; });
  await page.route('**/session', async route => {
    const response = await forward(route); sampled(); await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await sampling;
    await expect(page.locator('#connect')).toBeVisible();
    await expect(page.locator('#messages')).toBeEmpty();
    await expect(page.locator('#rooms')).toBeEmpty();
    await expect(page.locator('#connect-error')).toContainText('授权已到期');
  } finally { release(); }
  await page.waitForTimeout(200);
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#messages')).toBeEmpty();
});

test('a delayed session response cannot revive an expired background room', async ({ page }) => {
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === '产品讨论');
  grant.expiresAt = Date.now() + 4000;
  await connect(page); await send(page, '后台会话的到期预览');
  await page.locator('.room').nth(1).click();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let sampled;
  const sampling = new Promise(resolve => { sampled = resolve; });
  await page.route('**/session', async route => {
    const response = await forward(route); sampled(); await held;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await sampling;
    await expect(page.locator('.room')).toHaveCount(1);
    expect(Date.now()).toBeGreaterThanOrEqual(grant.expiresAt);
    await expect(page.locator('#rooms')).not.toContainText('后台会话的到期预览');
    await expect(page.locator('#room-title')).toHaveText('研发讨论');
  } finally { release(); }
  await page.waitForTimeout(300);
  await expect(page.locator('.room')).toHaveCount(1);
  await expect(page.locator('#connect')).toBeHidden();
});

test('overlay details contain keyboard focus, restore it, and adapt to a wide nonmodal layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await page.locator('#members-toggle').click();
  await expect(page.locator('#details')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#details')).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#chat')).toHaveAttribute('inert');
  await expect(page.locator('#sidebar')).toHaveAttribute('inert');
  await page.keyboard.press('Tab'); await expect(page.locator('#details-close')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#details-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#details-close')).toBeFocused();
  await capture(page, 'mobile-details-focus');
  await page.keyboard.press('Escape');
  await expect(page.locator('#members-toggle')).toBeFocused();
  await expect(page.locator('#chat')).not.toHaveAttribute('inert');
  await page.locator('#members-toggle').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#details')).not.toHaveAttribute('aria-modal');
  await expect(page.locator('#chat')).not.toHaveAttribute('inert');
  await page.locator('#message').focus(); await expect(page.locator('#message')).toBeFocused();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.locator('#details-title')).toBeFocused();
  await expect(page.locator('#details')).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#members-toggle')).toBeFocused();
});
