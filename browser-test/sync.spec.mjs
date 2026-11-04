import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';

let demo;
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop(); });
async function forward(route, options) {
  try { return await route.fetch(options); } catch { throw new Error('Sync test forwarding failed; authorization headers omitted.'); }
}
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
}
const selectedSync = url => url.pathname === '/sync' && url.searchParams.get('conversationId') === scope.conversationId;

test('offline scope sync delivers only current changes without duplicating or reordering history', async ({ page }) => {
  const messages = Array.from({ length: 8 }, (_, i) => demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `历史 ${i}`, `sync-history-${i}`).message));
  let offline = false; const batches = [];
  await page.route(selectedSync, async route => {
    if (offline) return route.abort('failed');
    const response = await forward(route); batches.push(await response.json()); await route.fulfill({ response });
  });
  await connect(page); await expect(page.locator('.message')).toHaveCount(8);
  await expect.poll(() => batches.some(batch => !batch.reset && batch.messages.length === 0)).toBe(true);
  offline = true; await expect(page.locator('#sync-error')).toBeVisible();
  await requestJson(demo.url, demo.ownerToken, '/messages', { ...scope, text: '补发新消息', clientEventId: 'sync-new' });
  demo.engine.commit(() => {
    demo.engine.changeMessage('demo-researcher', messages[0].id, 'edit', 1, 'sync-edit', '更新后的历史');
    demo.engine.changeMessage('demo-researcher', messages[1].id, 'retract', 1, 'sync-retract');
  });
  offline = false; await page.getByRole('button', { name: '立即重连' }).click();
  await expect(page.locator('.message-text').first()).toHaveText('更新后的历史');
  await expect(page.locator('.message-text').nth(1)).toHaveText('消息已撤回');
  await expect(page.locator('.message')).toHaveCount(9);
  const delta = batches.find(batch => batch.messages.some(message => message.text === '补发新消息'));
  expect(delta.reset).toBe(false); expect(delta.messages).toHaveLength(3);
  expect(JSON.stringify(delta)).not.toContain('历史 0'); expect(JSON.stringify(delta)).not.toContain('历史 1');
  const expectedIds = [...demo.engine.state.messages.values()].filter(message => message.conversationId === scope.conversationId).map(message => message.id);
  expect(await page.locator('.message').evaluateAll(nodes => nodes.map(node => node.dataset.message))).toEqual(expectedIds);
});

for (const operation of ['send', 'edit', 'retract']) test(`an old sync cannot replace a locally confirmed ${operation} or advance its cursor`, async ({ page }) => {
  await connect(page); await page.locator('#message').fill('原始消息'); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toHaveText('原始消息');
  let ready, release, held = false, failed = false; const laterCursors = [];
  const started = new Promise(resolve => { ready = resolve; }), hold = new Promise(resolve => { release = resolve; });
  await page.route(selectedSync, async route => {
    if (failed) { laterCursors.push(new URL(route.request().url()).searchParams.get('cursor')); return route.abort('failed'); }
    if (held) return route.continue();
    held = true; const url = new URL(route.request().url()); url.searchParams.delete('cursor');
    const response = await forward(route, { url: url.toString() }); ready(); await hold; await route.fulfill({ response });
  });
  try {
    await started;
    if (operation === 'send') { await page.locator('#message').fill('新确认消息'); await page.locator('#send').click(); await expect(page.locator('.message')).toHaveCount(2); }
    else {
      await page.getByRole('button', { name: operation === 'edit' ? '编辑消息' : '撤回消息', exact: true }).click();
      if (operation === 'edit') await page.locator('#change-text').fill('新确认编辑');
      await page.locator('#change-save').click(); await expect(page.getByRole('dialog')).not.toBeVisible();
    }
    failed = true; release(); await expect(page.locator('#sync-error')).toBeVisible();
    if (operation === 'send') await expect(page.locator('.message-text')).toHaveText(['原始消息', '新确认消息']);
    else await expect(page.locator('.message-text')).toHaveText(operation === 'edit' ? '新确认编辑' : '消息已撤回');
    expect(laterCursors.length).toBeGreaterThan(0); expect(laterCursors.every(cursor => cursor === null)).toBe(true);
  } finally { release(); }
});

test('a background sync read denial evicts its cache and cursor despite a stale session listing', async ({ page }) => {
  const other = { conversationId: '研发讨论', threadId: '插件协议' };
  demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', other, '后台独有内容', 'background-private'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect(page.locator('.message-text')).toHaveText('后台独有内容'); await page.locator('#message').fill('应清除的引用草稿');
  await page.getByRole('button', { name: /产品讨论 日常交流/ }).click();
  const session = await requestJson(demo.url, demo.ownerToken, '/session');
  await page.route('**/session', route => route.fulfill({ json: session }));
  const otherSync = url => url.pathname === '/sync' && url.searchParams.get('conversationId') === other.conversationId;
  await page.route(otherSync, route => route.fulfill({ status: 403, json: { error: 'scope_denied' } }));
  await expect(page.getByRole('button', { name: /研发讨论 插件协议/ })).toHaveCount(0);
  await expect(page.locator('#app')).not.toContainText('后台独有内容'); await expect(page.locator('#connect')).toBeHidden();
  const cursors = []; await page.unroute(otherSync);
  await page.route(otherSync, async route => { cursors.push(new URL(route.request().url()).searchParams.get('cursor')); await route.continue(); });
  await expect(page.getByRole('button', { name: /研发讨论 插件协议/ })).toBeVisible();
  await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect(page.locator('.message-text')).toHaveText('后台独有内容'); await expect(page.locator('#message')).toHaveValue('');
  expect(cursors[0]).toBe(null);
});

test('an edit acknowledgement cannot discard a concurrent background read denial before going offline', async ({ page }) => {
  const other = { conversationId: '研发讨论', threadId: '插件协议' };
  demo.engine.commit(() => {
    demo.engine.state.createMessage('demo-owner', scope, '本讨论待修改', 'denial-edit-source');
    demo.engine.state.createMessage('demo-researcher', other, '被拒绝的后台内容', 'denial-other');
  });
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect(page.locator('.message-text')).toHaveText('被拒绝的后台内容');
  await page.getByRole('button', { name: /产品讨论 日常交流/ }).click();
  const session = await requestJson(demo.url, demo.ownerToken, '/session');
  let offline = false, ready, release;
  const started = new Promise(resolve => { ready = resolve; }), hold = new Promise(resolve => { release = resolve; });
  await page.route('**/session', route => offline ? route.abort('failed') : route.fulfill({ json: session }));
  await page.route(url => url.pathname === '/sync' && url.searchParams.get('conversationId') === other.conversationId,
    route => route.fulfill({ status: 403, json: { error: 'scope_denied' } }));
  await page.route(selectedSync, async route => { const response = await forward(route); ready(); await hold; await route.fulfill({ response }); });
  try {
    await started; await page.getByRole('button', { name: '编辑消息', exact: true }).click();
    await page.locator('#change-text').fill('已确认修改'); await page.locator('#change-save').click();
    await expect(page.getByRole('dialog')).not.toBeVisible(); offline = true; release();
    await expect(page.locator('#sync-error')).toBeVisible();
    await expect(page.getByRole('button', { name: /研发讨论 插件协议/ })).toHaveCount(0);
    await expect(page.locator('#app')).not.toContainText('被拒绝的后台内容');
    await expect(page.locator('.message-text')).toHaveText('已确认修改');
  } finally { release(); }
});

test('a restored stream replaces missing messages and does not retry an obsolete read target', async ({ page }) => {
  const first = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, '备份中的消息', 'backup-first').message);
  await connect(page); await expect(page.locator('.message-text')).toHaveText(first.text);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(first.id);
  const backup = demo.engine.state.snapshot();
  let restored = false; const targets = [];
  await page.route('**/read-position', async route => {
    if (restored) targets.push(route.request().postDataJSON().messageId);
    await route.continue();
  });
  const later = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, '备份之后的消息', 'backup-later').message);
  await expect(page.locator('.message')).toHaveCount(2);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(later.id);
  demo.engine.commit(() => { demo.engine.state.restore(backup); demo.engine.state.resetDelivery(); }); restored = true;
  await expect(page.locator('.message')).toHaveCount(1);
  await expect(page.locator('.message-text')).toHaveText(first.text);
  await expect(page.locator('#sync-error')).toBeHidden();
  expect(targets).not.toContain(later.id); expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(first.id);
});
