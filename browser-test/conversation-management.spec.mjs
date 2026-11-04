import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo, thirdToken;
const authority = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo(); const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  thirdToken = randomBytes(32).toString('hex');
  config.members.push({ id: 'demo-third', name: '新同事', kind: 'human' }); config.memberships['demo-third'] = [authority];
  config.tokens[thirdToken] = 'demo-third'; config.credentialExpiresAt['demo-third'] = demo.expiresAt;
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connect')).toBeHidden();
}
async function selectMember(page, id, actions = []) {
  const row = page.locator(`[data-member="${id}"]`);
  await row.locator('input[type=checkbox]').first().check();
  for (const action of actions) await row.locator(`input[value="${action}"]`).check();
}
async function fillCreate(page, title) {
  await page.locator('#create-conversation').click(); await page.locator('#conversation-title').fill(title);
  await selectMember(page, 'demo-owner', ['read', 'send', 'manage_resource']);
  await selectMember(page, 'demo-researcher', ['read']);
}
async function group() {
  return (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '成员生命周期', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'managed-group',
    initialGrants: [{ targetMemberId: 'demo-owner', actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 120000 },
      { targetMemberId: 'demo-researcher', actions: ['read'], expiresAt: Date.now() + 120000 }] })).conversation;
}

for (const width of [1280, 390]) test(`create form requires explicit membership and permissions, sends normal chat at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await connect(page);
  if (width < 720) await page.locator('#back').click();
  await fillCreate(page, '新的讨论 <纯文本>');
  await page.locator('#conversation-kind').selectOption('direct');
  await expect(page.locator('[data-member="demo-third"] input[type=checkbox]').first()).not.toBeChecked();
  const title = await page.locator('#room-title').textContent();
  await page.locator('#conversation-title').press('Alt+ArrowDown'); await expect(page.locator('#room-title')).toHaveText(title);
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.getElementById('conversation-management').contains(document.activeElement))).toBe(true); }
  expect(await page.locator('#conversation-management').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  await page.getByRole('button', { name: '新的讨论 <纯文本> main', exact: true }).click();
  await page.locator('#message').fill('从创建界面进入普通聊天'); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toContainText('从创建界面进入普通聊天');
  expect(demo.engine.state.snapshot().conversations.conversations).toHaveLength(1);
});

test('an administrator with no read scope can create for others without gaining content access', async ({ page }) => {
  for (const grant of demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner')) grant.actions = grant.conversationId === authority.conversationId ? ['manage_workspace', 'grant_permissions'] : [];
  await connect(page); await expect(page.locator('#management-empty')).toBeVisible();
  await page.locator('#create-conversation').click(); await page.locator('#conversation-title').fill('只给其他成员');
  await selectMember(page, 'demo-researcher', ['read']); await selectMember(page, 'demo-third', ['read', 'send']);
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  const conversation = demo.engine.state.snapshot().conversations.conversations[0]; expect(conversation.memberIds).toEqual(['demo-researcher', 'demo-third']);
  await expect(page.locator('#rooms')).not.toContainText('只给其他成员');
  expect(demo.engine.state.authorization('demo-owner', 'read', conversation).allowed).toBe(false);
  await page.reload(); await connect(page); await expect(page.locator('#create-conversation')).toBeVisible();
});

test('member management adds, removes and rejoins with only the newly selected permissions', async ({ page }) => {
  const scope = await group(); await connect(page);
  await page.locator('#manage-conversation').click();
  await page.locator('#management-target').selectOption('demo-third');
  await page.locator('#management-fields input[value=read]').check();
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  const query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId });
  expect((await requestJson(demo.url, thirdToken, `/messages?${query}`)).messages).toEqual([]);
  await page.locator('#manage-conversation').click(); await page.getByRole('button', { name: '移除 新同事', exact: true }).click();
  await expect(page.locator('#conversation-management')).not.toBeVisible();
  await page.locator('#manage-conversation').click(); await page.locator('#management-target').selectOption('demo-third');
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  expect(demo.engine.state.authorization('demo-third', 'read', scope).allowed).toBe(false);
  expect(demo.engine.state.memberScopes('demo-third').some(s => s.conversationId === scope.conversationId)).toBe(true);
});

test('lost creation response freezes parameters and retries the exact request without duplication', async ({ page }) => {
  let drop = true; const bodies = [];
  await page.route('**/conversations', async route => {
    bodies.push(route.request().postDataJSON());
    if (drop) { drop = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await connect(page); await fillCreate(page, '确认丢失的创建'); await page.locator('#management-save').click();
  await expect(page.locator('#management-status')).toContainText('结果尚未确认'); await expect(page.locator('#conversation-title')).toBeDisabled();
  await page.locator('#management-save').click(); await expect(page.locator('#conversation-management')).not.toBeVisible();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(demo.engine.state.snapshot().conversations.conversations).toHaveLength(1);
});

test('management modal preserves unread messages and closes when creation authority is lost', async ({ page }) => {
  await connect(page); await page.locator('#create-conversation').click(); await expect(page.locator('#conversation-title')).toBeVisible();
  const message = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', authority, '弹窗期间的新消息', 'incoming-during-management')).message;
  await expect(page.locator('.message-text')).toContainText('弹窗期间的新消息');
  expect(demo.engine.state.readPosition('demo-owner', authority)).not.toBe(message.id);
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions = ['read', 'send'];
  await expect(page.locator('#conversation-management')).not.toBeVisible(); await expect(page.locator('#create-conversation')).toBeHidden();
});

test('rejoin between polls replaces the client cache generation and discards the former draft', async ({ page }) => {
  const scope = await group(); await connect(page);
  await page.getByRole('button', { name: '成员生命周期 main', exact: true }).click(); await page.locator('#message').fill('旧成员版本的草稿');
  // A second manager performs both changes before the next session refresh.
  const config = demo.engine.state.config;
  config.grants.push({ ...scope, id: 'temporary-fixture-manager', memberId: 'demo-researcher', actions: ['manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  config.grants.push({ ...authority, id: 'temporary-fixture-issuer', memberId: 'demo-researcher', actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'remove-old-generation'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'rejoin-new-generation', { actions: ['read'], expiresAt: Date.now() + 100000 }));
  // Read access returns before discovery observes a gap; generation still fences the old draft.
  await expect(page.getByRole('button', { name: '成员生命周期 main', exact: true })).toBeVisible();
  await expect(page.locator('#message')).toHaveValue('');
  expect(demo.engine.state.authorization('demo-owner', 'send', scope).allowed).toBe(false);
});

test('generation replacement clears old pending controls before an offline content refresh', async ({ page }) => {
  const scope = await group(); await connect(page); await page.getByRole('button', { name: '成员生命周期 main', exact: true }).click();
  await page.route('**/messages', route => route.abort('failed'));
  await page.locator('#message').fill('旧代待发内容'); await page.locator('#send').click();
  await expect(page.locator('#outbox button')).not.toHaveCount(0);
  const config = demo.engine.state.config;
  config.grants.push({ ...scope, id: 'replacement-manager', memberId: 'demo-researcher', actions: ['manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  config.grants.push({ ...authority, id: 'replacement-issuer', memberId: 'demo-researcher', actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  await page.route('**/sync?**', route => route.abort('failed'));
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'pending-remove'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'pending-rejoin', { actions: ['read', 'send'], expiresAt: Date.now() + 100000 }));
  await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#outbox')).toBeEmpty();
});

for (const action of ['manage_workspace', 'grant_permissions']) test(`management dialog clears independently authorized directory/options after ${action} loss`, async ({ page }) => {
  const scope = await group();
  demo.engine.state.config.grants.push({ ...scope, id: 'independent-target-admin', memberId: 'demo-owner', actions: ['manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  await connect(page); await page.locator('#manage-conversation').click(); await expect(page.locator('#management-target')).toBeVisible();
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId);
  grant.actions = grant.actions.filter(value => value !== action);
  await expect(page.locator('#conversation-management')).not.toBeVisible();
  expect(demo.engine.state.authorization('demo-owner', 'manage_resource', scope).allowed).toBe(true);
  await page.locator('#manage-conversation').click(); await expect(page.locator('#management-target')).toBeVisible();
  if (action === 'manage_workspace') expect(await page.locator('#management-target').evaluate(element => element.tagName)).toBe('INPUT');
  else await expect(page.locator('#management-fields input[value=read]')).toHaveCount(0);
});

test('a delayed old-generation send is rejected after removal and fresh read/send issuance', async ({ page }) => {
  const scope = await group(); await connect(page); await page.getByRole('button', { name: '成员生命周期 main', exact: true }).click();
  let release, observed; const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { observed = resolve; });
  await page.route('**/messages', async route => { observed(); await held; await route.continue(); });
  await page.locator('#message').fill('不能借新授权发送旧代内容'); await page.locator('#send').click(); await arrived;
  const config = demo.engine.state.config;
  config.grants.push({ ...scope, id: 'held-manager', memberId: 'demo-researcher', actions: ['manage_resource'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  config.grants.push({ ...authority, id: 'held-issuer', memberId: 'demo-researcher', actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'held-remove'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'held-rejoin', { actions: ['read', 'send'], expiresAt: Date.now() + 100000 }));
  const response = page.waitForResponse(response => response.url().endsWith('/messages') && response.request().method() === 'POST');
  release(); expect((await response).status()).toBe(409);
  expect([...demo.engine.state.messages.values()].some(message => message.text === '不能借新授权发送旧代内容')).toBe(false);
  await expect(page.locator('#message')).toHaveValue('');
});
