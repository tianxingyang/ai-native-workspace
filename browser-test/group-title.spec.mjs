import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo, scope;
const authority = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo(); const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  scope = (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '原来的群名', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'group',
    initialGrants: ['demo-owner', 'demo-researcher'].map(targetMemberId => ({ targetMemberId, actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 120000 })) })).conversation;
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page, navigate = true) {
  if (navigate) await page.goto(demo.url);
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connect')).toBeHidden();
}
async function openRename(page) {
  await page.locator('#manage-conversation').click(); await page.locator('#rename-conversation').click();
  await expect(page.locator('#rename-title')).toHaveValue(demo.engine.state.conversationMetadata(scope).title);
}
function otherRename(title, version = 1, id = 'other-rename') {
  return demo.engine.commit(() => demo.engine.state.renameConversation('demo-researcher', scope, title, version, 'initial', id));
}
async function holdInitialSyncSession(page, sessionNumber = 2) {
  let sessions = 0, release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { arrived = resolve; });
  await page.route(url => url.pathname === '/session', async route => {
    // Authentication reveals the app before its second session request starts
    // the initial sync. Control that boundary without sleeps or retrying a test.
    if (++sessions === sessionNumber) { arrived(); await held; }
    await route.continue();
  });
  return { entered, release };
}
async function holdInitialSnapshotRestore(page) {
  await page.goto(demo.url);
  await page.evaluate(async () => {
    const { SyncStore } = await import('/sync-store.js'), load = SyncStore.prototype.load;
    let release;
    const held = new Promise(resolve => { release = resolve; }), pending = [];
    window.initialSnapshotGate = {
      entered: false,
      stopIntercepting: () => { SyncStore.prototype.load = load; },
      release: async () => { release(); await Promise.allSettled(pending); },
    };
    SyncStore.prototype.load = function(...args) {
      window.initialSnapshotGate.entered = true;
      const result = held.then(() => load.apply(this, args)); pending.push(result); return result;
    };
  });
}

for (const width of [1280, 390]) test(`rename group updates list and header as text, preserves draft and keyboard focus at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await connect(page);
  if (width < 720) await page.locator('#back').click();
  await page.getByRole('button', { name: '原来的群名 main', exact: true }).click();
  await page.locator('#message').fill('仍然留在同一群聊的草稿');
  if (width < 720) await page.locator('#back').click();
  await openRename(page); await page.locator('#rename-title').fill('新的群名 <img src=x>');
  for (let i = 0; i < 7; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.getElementById('conversation-management').contains(document.activeElement))).toBe(true); }
  expect(await page.locator('#conversation-management').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  await expect(page.locator('#manage-conversation')).toBeFocused();
  await expect(page.locator('.room-name').filter({ hasText: '新的群名 <img src=x>' })).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText('新的群名 <img src=x>');
  await expect(page.locator('#rooms img')).toHaveCount(0); await expect(page.locator('#message')).toHaveValue('仍然留在同一群聊的草稿');
  expect(demo.engine.state.conversationMetadata(scope).titleRevision).toBe(2);
});

test('a competing rename reports a conflict and requires reopening the latest title', async ({ page }) => {
  await connect(page); await openRename(page); await page.locator('#rename-title').fill('过时的编辑');
  otherRename('其他人刚改的群名');
  await page.locator('#management-save').click(); await expect(page.locator('#management-status')).toContainText('群名已被其他人修改');
  await expect(page.locator('#management-save')).toBeDisabled(); expect(demo.engine.state.conversationMetadata(scope).title).toBe('其他人刚改的群名');
  await page.locator('#management-close').click(); await openRename(page); await page.locator('#rename-title').fill('核对后修改');
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  expect(demo.engine.state.conversationMetadata(scope).titleRevision).toBe(3);
});

test('lost rename response retries the frozen request without overwriting a later name', async ({ page }) => {
  let drop = true; const bodies = [];
  await page.route('**/conversations/rename', async route => {
    bodies.push(route.request().postDataJSON());
    if (drop) { drop = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await connect(page); await openRename(page); await page.locator('#rename-title').fill('首次改名'); await page.locator('#management-save').click();
  await expect(page.locator('#management-status')).toContainText('结果尚未确认'); await expect(page.locator('#rename-title')).toBeDisabled();
  otherRename('后来的群名', 2);
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(demo.engine.state.conversationMetadata(scope).title).toBe('后来的群名');
  await expect(page.locator('.room-name').filter({ hasText: '后来的群名' })).toBeVisible();
});

test('manage-only members can rename without member directory or reading chat', async ({ page }) => {
  const config = demo.engine.state.config;
  config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, id: 'independent-management', memberId: 'demo-owner', actions: ['manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  for (const grant of config.grants.filter(g => g.id !== 'independent-management' && g.memberId === 'demo-owner')) grant.actions = [];
  await connect(page); await expect(page.locator('#management-empty')).toBeVisible(); await openRename(page);
  await page.locator('#rename-title').fill('只有管理权限也能改名'); await page.locator('#management-save').click();
  await expect(page.locator('#conversation-management')).not.toBeVisible(); await expect(page.locator('#manage-conversation')).toBeFocused();
  expect(demo.engine.state.conversationMetadata(scope).title).toBe('只有管理权限也能改名');
  expect(demo.engine.state.authorization('demo-owner', 'read', scope).allowed).toBe(false);
  await expect(page.locator('#rooms')).toBeEmpty();
});

test('membership replacement closes the old rename draft and prevents its held request', async ({ page }) => {
  await connect(page); await openRename(page); await page.locator('#rename-title').fill('旧代操作');
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { arrived = resolve; });
  await page.route('**/conversations/rename', async route => { arrived(); await held; await route.continue(); });
  await page.locator('#management-save').click(); await observed;
  const config = demo.engine.state.config;
  config.grants.push({ ...authority, id: 'rejoin-authority', memberId: 'demo-researcher', actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'remove-owner'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'rejoin-owner', { actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 100000 }));
  const response = page.waitForResponse(r => r.url().endsWith('/conversations/rename'));
  release(); expect((await response).status()).toBe(409);
  await expect(page.locator('#conversation-management')).not.toBeVisible(); await expect(page.locator('#rename-title')).toHaveCount(0);
  expect(demo.engine.state.conversationMetadata(scope).title).toBe('原来的群名');
});

test('remote title discovery updates focused navigation in place', async ({ page }) => {
  await connect(page); const item = page.getByRole('button', { name: '原来的群名 main', exact: true });
  await item.focus(); const element = await item.elementHandle(); otherRename('远端更新');
  await expect(page.locator('.room-name').filter({ hasText: '远端更新' })).toBeVisible();
  expect(await element.evaluate(e => e === document.activeElement && e.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: '远端更新 main', exact: true })).toBeFocused();
});

test('finishing initial sync preserves navigation focus during remote title discovery', async ({ page }) => {
  const initial = await holdInitialSyncSession(page);
  try {
    await connect(page); await initial.entered;
    const item = page.getByRole('button', { name: '原来的群名 main', exact: true });
    await item.focus(); const element = await item.elementHandle();
    otherRename('远端更新'); initial.release();
    await expect(page.locator('#connection-status')).toHaveText('已连接');
    await expect(page.locator('.room-name').filter({ hasText: '远端更新' })).toBeVisible();
    const focus = await element.evaluate(e => ({ connected: e.isConnected, active: e === document.activeElement, activeId: document.activeElement.id }));
    expect(focus, 'The late initial sync must not take focus from an existing navigation button').toEqual({ connected: true, active: true, activeId: '' });
    await expect(page.getByRole('button', { name: '远端更新 main', exact: true })).toBeFocused();
  } finally { initial.release(); }
});

test('initial sync still focuses the composer when the member has not chosen another control', async ({ page }) => {
  const initial = await holdInitialSyncSession(page);
  try {
    await connect(page); await initial.entered; initial.release();
    await expect(page.locator('#connection-status')).toHaveText('已连接');
    await expect(page.locator('#message')).toBeFocused();
  } finally { initial.release(); }
});

for (const reconnect of [false, true]) test(`a late initial sync cannot take focus from ${reconnect ? 'a replacement connection' : 'the logged-out credential field'}`, async ({ page }) => {
  // HTTP requests abort on logout. Hold the non-network restore instead so the
  // old connect continuation really remains pending across invalidation.
  const replacement = reconnect ? await holdInitialSyncSession(page, 4) : undefined;
  await holdInitialSnapshotRestore(page);
  try {
    await connect(page, false);
    await page.waitForFunction(() => window.initialSnapshotGate.entered);
    await page.evaluate(() => window.initialSnapshotGate.stopIntercepting());
    await page.locator('#logout').click();
    await expect(page.locator('#token')).toBeFocused();
    if (reconnect) {
      await connect(page, false); await replacement.entered;
      // The new login still owns its default focus. The old client must not
      // supply it early while this connection's own initial sync is held.
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    }
    await page.evaluate(() => window.initialSnapshotGate.release());
    if (reconnect) {
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      replacement.release();
      await expect(page.locator('#connection-status')).toHaveText('已连接');
      await expect(page.locator('#message')).toBeFocused();
    } else {
      await expect(page.locator('#connect')).toBeVisible();
      await expect(page.locator('#token')).toBeFocused();
    }
  } finally {
    replacement?.release();
    await page.evaluate(() => window.initialSnapshotGate?.release()).catch(() => {});
  }
});

test('blank title cannot submit and cancel clears the draft', async ({ page }) => {
  let submissions = 0; await page.route('**/conversations/rename', route => { submissions++; return route.continue(); });
  await connect(page); await openRename(page); await page.locator('#rename-title').fill('   '); await page.locator('#management-save').click();
  await expect(page.locator('#management-status')).toContainText('请输入'); expect(submissions).toBe(0);
  await page.locator('#rename-title').fill('取消的群名'); await page.keyboard.press('Escape');
  await expect(page.locator('#rename-title')).toHaveCount(0); await expect(page.locator('#manage-conversation')).toBeFocused();
  expect(demo.engine.state.conversationMetadata(scope).titleRevision).toBe(1);
});

for (const width of [1280, 390]) test(`revoking management closes and clears the rename draft with usable focus at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const config = demo.engine.state.config;
  // Keep independent read/management grants after removing creation authority.
  config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, id: 'independent-access', memberId: 'demo-owner', actions: ['read', 'send', 'manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  for (const grant of config.grants.filter(g => g.id !== 'independent-access' && g.memberId === 'demo-owner')) grant.actions = ['read', 'send'];
  await connect(page);
  if (width < 720) await page.locator('#back').click();
  await openRename(page); await page.locator('#rename-title').fill('被撤权的草稿');
  config.grants.find(g => g.id === 'independent-access').actions = ['read', 'send'];
  await expect(page.locator('#conversation-management')).not.toBeVisible(); await expect(page.locator('#rename-title')).toHaveCount(0);
  await expect(page.locator('#manage-conversation')).toBeHidden();
  await expect(page.locator(width < 720 ? '#rooms button[aria-current="true"]' : '#room-title')).toBeFocused();
  expect(demo.engine.state.conversationMetadata(scope).titleRevision).toBe(1);
});

test('direct chats and configured scopes do not expose group rename', async ({ page }) => {
  const config = demo.engine.state.config;
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_resource');
  const direct = (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'direct', title: '双人私聊', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'direct',
    initialGrants: [{ targetMemberId: 'demo-owner', actions: ['read', 'manage_resource'], expiresAt: Date.now() + 120000 }] })).conversation;
  await connect(page); await page.locator('#manage-conversation').click(); await expect(page.locator('#management-scope')).toBeVisible();
  await expect(page.locator('#rename-conversation')).toHaveCount(0);
  await page.locator('#management-scope').selectOption(JSON.stringify([direct.conversationId, direct.threadId]));
  await expect(page.locator('#management-scope')).toHaveValue(JSON.stringify([direct.conversationId, direct.threadId]));
  await expect(page.locator('#rename-conversation')).toHaveCount(0);
});
