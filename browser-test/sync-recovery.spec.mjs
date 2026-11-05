import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';
let demo;
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
const other = { conversationId: '研发讨论', threadId: '插件协议' };
const selectedSync = url => url.pathname === '/sync' && url.searchParams.get('conversationId') === scope.conversationId;
const backgroundSync = url => url.pathname === '/sync' && url.searchParams.get('conversationId') === other.conversationId;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop(); });
async function connect(page, navigate = true) {
  if (navigate) await page.goto(demo.url);
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click(); await expect(page.locator('#app')).toBeVisible();
}
function create(where, text, event) { return demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', where, text, event).message); }
async function checkpoint(page, where = scope) {
  const session = await requestJson(demo.url, demo.ownerToken, '/session');
  const target = session.scopes.find(item => item.conversationId === where.conversationId && item.threadId === where.threadId);
  return page.evaluate(async ({ secret, identity }) => {
    const { SyncStore } = await import('/sync-store.js'); const store = new SyncStore(secret);
    try { return await store.load(identity); } finally { store.close(); }
  }, { secret: target.outboxKey, identity: [session.member.id, target.conversationId, target.threadId, target.membershipGeneration] });
}
test('reload quarantines the encrypted baseline until current sync and restores only current edits and tombstones', async ({ page }) => {
  const message = create(scope, '旧正文不可闪现', 'reload-source'); await connect(page);
  await expect(page.locator('.message-text')).toHaveText(message.text);
  await expect.poll(async () => (await checkpoint(page))?.messages.length).toBe(1);
  await page.reload(); await expect(page.locator('#app')).toBeHidden();
  demo.engine.commit(() => demo.engine.changeMessage('demo-researcher', message.id, 'retract', 1, 'reload-retract'));
  create(scope, '离线期间的新消息', 'reload-new');
  let offline = true; const cursors = [];
  await page.route(selectedSync, async route => {
    cursors.push(new URL(route.request().url()).searchParams.get('cursor'));
    if (offline) return route.abort('failed'); await route.continue();
  });
  await connect(page, false); await expect(page.locator('#sync-error')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0); await expect(page.locator('#app')).not.toContainText(message.text);
  offline = false; await page.locator('#reconnect').click();
  await expect(page.locator('.message-text')).toHaveText(['消息已撤回', '离线期间的新消息']);
  expect(cursors[0]).toBeTruthy();
});
test('unconfirmed reading intent survives reload without marking newer background messages read', async ({ page }) => {
  const seen = create(other, '已经看过', 'seen-background');
  await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect(page.locator('.message-text')).toHaveText(seen.text);
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(seen.id);
  await page.reload(); create(other, '还没看过', 'not-seen-background');
  const targets = []; await page.unroute('**/read-position');
  await page.route('**/read-position', async route => { targets.push(route.request().postDataJSON()); await route.continue(); });
  await connect(page, false);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', other)).toBe(seen.id);
  expect(targets.filter(item => item.conversationId === other.conversationId).map(item => item.messageId)).toEqual([seen.id]);
});
test('a confirmed local edit followed by offline reload retains the fixed pending reading target', async ({ page }) => {
  const own = demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', other, '待编辑', 'read-edit').message);
  await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(own.id);
  await page.route(backgroundSync, route => route.abort('failed'));
  await page.getByRole('button', { name: '编辑消息', exact: true }).click(); await page.locator('#change-text').fill('已确认编辑'); await page.locator('#change-save').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(async () => { const saved = await checkpoint(page, other); return saved?.cursor === undefined && saved?.pendingReadMessageId === own.id; }).toBe(true);
  await page.reload(); await page.unroute(backgroundSync); await page.unroute('**/read-position');
  await connect(page, false); await expect.poll(() => demo.engine.state.readPosition('demo-owner', other)).toBe(own.id);
});
test('backup restore rejects the old checkpoint and obsolete reading intent after reload', async ({ page }) => {
  const first = create(other, '备份内消息', 'backup-before'); const backup = demo.engine.state.snapshot();
  const later = create(other, '备份外消息', 'backup-after');
  await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(later.id);
  await page.reload(); demo.engine.commit(() => { demo.engine.state.restore(backup); demo.engine.state.resetDelivery(); });
  const targets = []; await page.unroute('**/read-position');
  await page.route('**/read-position', async route => { targets.push(route.request().postDataJSON().messageId); await route.continue(); });
  await connect(page, false); await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(targets).not.toContain(later.id); expect(demo.engine.state.readPosition('demo-owner', other)).toBeNull();
  await page.getByRole('button', { name: /研发讨论 插件协议/ }).click(); await expect(page.locator('.message-text')).toHaveText(first.text);
});
for (const cursor of ['not-a-cursor', 'ahead']) test(`a ${cursor} checkpoint rebuilds the baseline and discards obsolete reading intent`, async ({ page }) => {
  const seen = create(other, '损坏恢复', 'corrupt'); await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(seen.id);
  await page.reload();
  const session = await requestJson(demo.url, demo.ownerToken, '/session'), target = session.scopes.find(item => item.conversationId === other.conversationId);
  await page.evaluate(async ({ target, memberId, cursor }) => {
    const { SyncStore } = await import('/sync-store.js'), store = new SyncStore(target.outboxKey);
    const record = await store.load([memberId, target.conversationId, target.threadId, target.membershipGeneration]);
    if (cursor === 'ahead') {
      record.cursor = record.cursor.replace(/[^.]+$/, String(Number.MAX_SAFE_INTEGER));
    } else record.cursor = cursor;
    await store.save(record, target.outboxExpiresAt); store.close();
  }, { target, memberId: session.member.id, cursor });
  const targets = []; await page.unroute('**/read-position');
  await page.route('**/read-position', async route => { targets.push(route.request().postDataJSON().messageId); await route.continue(); });
  await connect(page, false); await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(targets).not.toContain(seen.id);
});
test('read denial clears ciphertext and reload cannot display or replay the denied scope', async ({ page }) => {
  create(other, '权限撤销后不可恢复', 'denied'); await connect(page);
  await expect.poll(async () => (await checkpoint(page, other))?.messages.length).toBe(1);
  const stale = await requestJson(demo.url, demo.ownerToken, '/session');
  await page.route('**/session', route => route.fulfill({ json: stale }));
  await page.route(backgroundSync, route => route.fulfill({ status: 403, json: { error: 'scope_denied' } }));
  await expect.poll(async () => await checkpoint(page, other)).toBeNull();
  await page.reload(); await connect(page, false); await expect(page.locator('#app')).not.toContainText('权限撤销后不可恢复');
});
test('native transport bridge reload uses the recovered cursor without exposing a credential field', async ({ page }) => {
  const cursors = [];
  create(scope, '桥接恢复', 'bridge');
  await page.exposeFunction('__bridge', async (path, body) => {
    const url = new URL(path, demo.url); if (url.pathname === '/sync' && url.searchParams.get('conversationId') === scope.conversationId) cursors.push(url.searchParams.get('cursor'));
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${demo.ownerToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  });
  await page.addInitScript(() => { window.__TAURI__ = { core: { invoke: (command, args = {}) => command === 'desktop_request' ? window.__bridge(args.path, args.body) : Promise.resolve(command === 'desktop_take_notification' ? { kind: 'none' } : null) }, event: { listen: async () => () => {} } }; });
  await page.goto(demo.url); await page.locator('#connect-button').click(); await expect(page.locator('.message-text')).toHaveText('桥接恢复');
  await expect.poll(async () => (await checkpoint(page))?.messages.length).toBe(1);
  await page.reload(); cursors.length = 0; await expect(page.locator('#token')).toBeHidden();
  await page.locator('#connect-button').click(); await expect(page.locator('.message-text')).toHaveText('桥接恢复'); expect(cursors[0]).toBeTruthy();
});

test('a compacted cursor rebuilds state while retaining only the previously observed reading target', async ({ page }) => {
  const seen = create(other, '压缩前已见', 'compact-seen'); await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(seen.id);
  await page.reload();
  demo.engine.commit(() => { for (let index = 0; index < 515; index++) demo.engine.state.createMessage('demo-researcher', other, `后台消息 ${index}`, `compact-${index}`); });
  await requestJson(demo.url, demo.ownerToken, `/sync?${new URLSearchParams(other)}`);
  let reset; await page.route(backgroundSync, async route => { const response = await route.fetch(); const value = await response.json(); reset = value.reset; await route.fulfill({ response }); });
  await page.unroute('**/read-position'); await connect(page, false);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', other)).toBe(seen.id); expect(reset).toBe(true);
});
test('storage failure prevents read transmission until the observed target is durable', async ({ page }) => {
  await connect(page); await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.evaluate(() => { window.originalOpen = indexedDB.open.bind(indexedDB); indexedDB.open = () => { throw new Error('disk-unavailable'); }; });
  const targets = []; await page.route('**/read-position', async route => { targets.push(route.request().postDataJSON().messageId); await route.continue(); });
  const seen = create(scope, '应先落盘', 'durable-first'); await expect(page.locator('.message-text')).toHaveText(seen.text);
  expect(targets).toEqual([]); expect(demo.engine.state.readPosition('demo-owner', scope)).toBeNull();
  await page.evaluate(() => { indexedDB.open = window.originalOpen; }); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe(seen.id);
});
test('credential deadline clears checkpoint ciphertext while offline', async ({ page }) => {
  create(scope, '短期限缓存', 'expiry'); await connect(page);
  await expect.poll(async () => (await checkpoint(page))?.messages.length).toBe(1);
  const expiry = Date.now() + 2200; demo.engine.state.config.credentialExpiresAt['demo-owner'] = expiry;
  await page.waitForResponse(async response => response.url().endsWith('/session') && response.status() === 200 && (await response.json()).scopes.some(item => item.outboxExpiresAt === expiry));
  await page.route('**/session', route => route.abort('failed')); await page.route('**/sync?**', route => route.abort('failed'));
  await expect(page.locator('#connect')).toBeVisible(); await expect(page.locator('.message')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('coseat-sync-v1', 1); request.onsuccess = () => { const db = request.result, tx = db.transaction('checkpoints'), rows = tx.objectStore('checkpoints').getAll(); rows.onsuccess = () => resolve(rows.result.filter(row => row.ciphertext).length); tx.oncomplete = () => db.close(); };
  }))).toBe(0);
});

test('initial storage failure retries initialization and resumes reading without reconnecting', async ({ page }) => {
  create(scope, '首次存储恢复', 'initial-storage'); await page.goto(demo.url);
  await page.evaluate(() => { window.originalOpen = indexedDB.open.bind(indexedDB); indexedDB.open = () => { throw new Error('initial-disk-failure'); }; });
  await connect(page, false); await expect(page.locator('.message-text')).toHaveText('首次存储恢复');
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBeNull();
  await page.evaluate(() => { indexedDB.open = window.originalOpen; window.dispatchEvent(new Event('online')); });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).not.toBeNull();
  await expect.poll(async () => (await checkpoint(page))?.messages.length).toBe(1);
});

test('storage initialization retry replays a saved background target without reading newer messages', async ({ page }) => {
  const seen = create(other, '故障前已看', 'retry-seen'); await page.route('**/read-position', route => route.abort('failed'));
  await connect(page); await page.getByRole('button', { name: /研发讨论 插件协议/ }).click();
  await expect.poll(async () => (await checkpoint(page, other))?.pendingReadMessageId).toBe(seen.id);
  await page.reload(); create(other, '故障后未看', 'retry-unseen'); await page.unroute('**/read-position');
  await page.evaluate(() => { window.originalOpen = indexedDB.open.bind(indexedDB); indexedDB.open = () => { throw new Error('initial-disk-failure'); }; });
  await connect(page, false); await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(demo.engine.state.readPosition('demo-owner', other)).toBeNull();
  await page.evaluate(() => { indexedDB.open = window.originalOpen; window.dispatchEvent(new Event('online')); });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', other)).toBe(seen.id);
});

async function createChild(parent, title) {
  const session = await requestJson(demo.url, demo.ownerToken, '/session');
  const membership = session.scopes.find(item => item.conversationId === parent.conversationId && item.threadId === parent.threadId);
  return (await requestJson(demo.url, demo.ownerToken, '/threads', { conversationId: parent.conversationId, threadId: parent.threadId,
    title, clientEventId: `create-${title}`, expectedMembershipGeneration: membership.membershipGeneration })).thread;
}
test('ordinary child threads recover their own cursor and observed reading target independently of the parent', async ({ page }) => {
  const child = await createChild(scope, '持久恢复线程');
  create(scope, '父会话消息', 'parent-only'); const seen = create(child, '线程内已看', 'child-seen');
  await page.route('**/read-position', route => route.abort('failed')); await connect(page);
  await page.getByRole('button', { name: /^持久恢复线程 讨论线程 · 产品讨论/ }).click();
  await expect(page.locator('.message-text')).toHaveText(seen.text);
  await expect.poll(async () => (await checkpoint(page, child))?.pendingReadMessageId).toBe(seen.id);
  const saved = await checkpoint(page, child); await page.reload(); create(child, '线程内尚未看', 'child-unseen');
  await page.unroute('**/read-position'); const cursors = [];
  await page.route(url => url.pathname === '/sync' && url.searchParams.get('threadId') === child.threadId,
    async route => { cursors.push(new URL(route.request().url()).searchParams.get('cursor')); await route.continue(); });
  await connect(page, false); await expect.poll(() => demo.engine.state.readPosition('demo-owner', child)).toBe(seen.id);
  expect(cursors[0]).toBe(saved.cursor); await expect(page.locator('#messages')).not.toContainText('线程内');
  expect(demo.engine.state.readPosition('demo-owner', scope)).not.toBe(seen.id);
});
test('parent-only denial evicts the encrypted child checkpoint even when child sync is offline', async ({ page }) => {
  const child = await createChild(scope, '撤权恢复线程'); create(child, '撤权后不可恢复', 'child-denied');
  await connect(page); await expect.poll(async () => (await checkpoint(page, child))?.messages.length).toBe(1);
  const session = await requestJson(demo.url, demo.ownerToken, '/session');
  const target = session.scopes.find(item => item.threadId === child.threadId);
  await page.route(url => url.pathname === '/sync' && url.searchParams.get('threadId') === child.threadId, route => route.abort('failed'));
  await page.route('**/session', route => route.fulfill({ json: session }));
  demo.engine.state.config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === scope.conversationId).revoked = true;
  await expect(page.locator('#rooms')).not.toContainText('撤权恢复线程');
  await expect.poll(() => page.evaluate(async ({ target, memberId }) => {
    const { SyncStore } = await import('/sync-store.js'), store = new SyncStore(target.outboxKey);
    try { return await store.load([memberId, target.conversationId, target.threadId, target.membershipGeneration]); }
    finally { store.close(); }
  }, { target, memberId: session.member.id })).toBeNull();
  await expect(page.locator('#app')).not.toContainText('撤权后不可恢复');
});
test('parent membership replacement cannot replay a child checkpoint from the previous generation', async ({ page }) => {
  const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: scope, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  for (const grant of config.grants.filter(grant => grant.conversationId === scope.conversationId)) grant.actions.push('manage_workspace', 'grant_permissions');
  const expiresAt = Date.now() + 120000;
  const group = (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '换代父会话', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'generation-parent',
    initialGrants: [{ targetMemberId: 'demo-owner', actions: ['read', 'send'], expiresAt }, { targetMemberId: 'demo-researcher', actions: ['read', 'send', 'manage_resource'], expiresAt }] })).conversation;
  const child = await createChild(group, '换代子线程'); const seen = create(child, '旧代际已看', 'old-child-seen');
  await page.route('**/read-position', route => route.abort('failed')); await connect(page);
  await page.getByRole('button', { name: /^换代子线程 讨论线程 · 换代父会话/ }).click();
  await expect.poll(async () => (await checkpoint(page, child))?.pendingReadMessageId).toBe(seen.id);
  const before = (await requestJson(demo.url, demo.ownerToken, '/session')).scopes.find(item => item.threadId === child.threadId);
  await page.reload(); demo.engine.commit(() => {
    const revision = demo.engine.state.membershipRoster('demo-researcher', group).revision;
    demo.engine.removeScopeMember('demo-researcher', 'demo-owner', group, revision, 'child-remove');
    demo.engine.addScopeMember('demo-researcher', 'demo-owner', group, revision + 1, 'child-rejoin', { actions: ['read', 'send'], expiresAt });
  });
  const after = (await requestJson(demo.url, demo.ownerToken, '/session')).scopes.find(item => item.threadId === child.threadId);
  expect(after.outboxKey).not.toBe(before.outboxKey); expect(after.membershipGeneration).not.toBe(before.membershipGeneration);
  await page.unroute('**/read-position'); await connect(page, false); await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(demo.engine.state.readPosition('demo-owner', child)).toBeNull();
  await expect.poll(async () => (await checkpoint(page, child))?.messages.length).toBe(1);
  expect((await checkpoint(page, child)).pendingReadMessageIds).toEqual([]);
});

test('confirmed parent leave clears a child checkpoint and content while all subsequent sync is offline', async ({ page }) => {
  const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: scope, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === scope.conversationId).actions.push('manage_workspace', 'grant_permissions');
  const expiresAt = Date.now() + 120000;
  const group = (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '退出父会话', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'leave-parent',
    initialGrants: ['demo-owner', 'demo-researcher'].map(targetMemberId => ({ targetMemberId, actions: ['read', 'send'], expiresAt })) })).conversation;
  const child = await createChild(group, '退出子线程'); create(child, '退出后必须清除', 'leave-child');
  await connect(page); await page.getByRole('button', { name: /^退出子线程 讨论线程 · 退出父会话/ }).click();
  await expect(page.locator('.message-text')).toHaveText('退出后必须清除');
  await expect.poll(async () => (await checkpoint(page, child))?.messages.length).toBe(1);
  const session = await requestJson(demo.url, demo.ownerToken, '/session'), target = session.scopes.find(item => item.threadId === child.threadId);
  await page.locator('#parent-thread').click(); await expect(page.locator('#room-title')).toHaveText('退出父会话');
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => route.abort('failed'));
  await page.locator('#members-toggle').click(); await page.locator('#leave-conversation').click(); await page.locator('#leave-submit').click();
  await expect(page.locator('#leave-dialog')).not.toBeVisible(); await expect(page.locator('#rooms')).not.toContainText('退出子线程');
  await expect(page.locator('#app')).not.toContainText('退出后必须清除');
  await expect.poll(() => page.evaluate(async ({ target, memberId }) => {
    const { SyncStore } = await import('/sync-store.js'), store = new SyncStore(target.outboxKey);
    try { return await store.load([memberId, target.conversationId, target.threadId, target.membershipGeneration]); } finally { store.close(); }
  }, { target, memberId: session.member.id })).toBeNull();
});
