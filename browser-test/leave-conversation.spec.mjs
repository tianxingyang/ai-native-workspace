import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo, thirdToken;
const authority = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo(); const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  thirdToken = randomBytes(32).toString('hex'); config.members.push({ id: 'third', name: '单会话成员', kind: 'human' });
  config.memberships.third = [authority]; config.tokens[thirdToken] = 'third'; config.credentialExpiresAt.third = demo.expiresAt;
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
function group({ kind = 'group', actor = 'demo-owner', actions = ['read', 'send'], expiresAt = Date.now() + 120000 } = {}) {
  const memberIds = actor === 'third' ? ['demo-owner', 'third'] : ['demo-owner', 'demo-researcher'];
  const initialGrants = [{ targetMemberId: actor, actions, expiresAt }];
  if (actor === 'third') initialGrants.push({ targetMemberId: 'demo-owner', actions: ['manage_resource'], expiresAt });
  return demo.engine.commit(() => demo.engine.state.createConversation('demo-owner', { kind, title: '退出测试 <只作文本>', memberIds, initialGrants, clientEventId: 'leave-room' })).conversation;
}
async function connect(page, token = demo.ownerToken) {
  await page.goto(demo.url); await page.locator('#token').fill(token); await page.locator('#connect-button').click();
  await expect(page.locator('#connect')).toBeHidden();
  if (!await page.getByRole('button', { name: '退出测试 <只作文本> main', exact: true }).isVisible()) await page.locator('#back').click();
  await page.getByRole('button', { name: '退出测试 <只作文本> main', exact: true }).click();
}
async function open(page) { await page.locator('#members-toggle').click(); await page.locator('#leave-conversation').click(); await expect(page.locator('#leave-dialog')).toBeVisible(); }
async function forward(route) { try { return await route.fetch(); } catch { throw new Error('Leave forwarding failed; credentials omitted.'); } }
const member = scope => demo.engine.state.memberScopes('demo-owner').some(s => s.conversationId === scope.conversationId);

for (const [kind, width] of [['group', 1280], ['direct', 390]]) test(`read-only member can leave ${kind} at ${width}px without management permission`, async ({ page }) => {
  const scope = group({ kind, actions: ['read'] }); await page.setViewportSize({ width, height: 900 }); await connect(page);
  await expect(page.locator('#message')).toBeDisabled(); await open(page);
  await expect(page.locator('#leave-name')).toHaveText('退出测试 <只作文本>');
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.getElementById('leave-dialog').contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Alt+ArrowDown'); await expect(page.locator('#room-title')).toHaveText('退出测试 <只作文本>');
  expect(await page.locator('#leave-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.locator('#leave-submit').click(); await expect(page.locator('#leave-dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '退出测试 <只作文本> main', exact: true })).toHaveCount(0);
  expect(member(scope)).toBe(false); await expect(page.locator('#connect')).toBeHidden(); await expect(page.locator('#room-title')).toBeFocused();
});

test('cancel preserves membership and static configured rooms have no leave control', async ({ page }) => {
  const scope = group(); await connect(page); await open(page); await page.keyboard.press('Escape');
  await expect(page.locator('#members-toggle')).toBeFocused(); expect(member(scope)).toBe(true);
  await page.getByRole('button', { name: '产品讨论 日常交流', exact: true }).click(); await page.locator('#members-toggle').click();
  await expect(page.locator('#leave-conversation')).toBeHidden();
});

test('lost leave response retries the frozen original ID while the connection remains usable', async ({ page }) => {
  const scope = group(); let offline = false; const requests = [];
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => offline ? route.abort('failed') : route.continue());
  await page.route('**/memberships/leave', async route => {
    requests.push(route.request().postDataJSON()); const response = await forward(route);
    if (requests.length === 1) { offline = true; await route.abort('failed'); }
    else { expect((await response.json()).duplicate).toBe(true); await route.fulfill({ response }); }
  });
  await connect(page); await open(page); await page.locator('#leave-submit').click();
  await expect(page.locator('#leave-submit')).toHaveText('核对并重试原请求'); await expect(page.locator('#leave-status')).toContainText('尚未确认');
  await page.locator('#leave-submit').click(); await expect(page.locator('#leave-dialog')).not.toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(member(scope)).toBe(false);
  await expect(page.getByRole('button', { name: '退出测试 <只作文本> main', exact: true })).toHaveCount(0);
});

test('last-scope lost response clears content but does not claim the leave request was confirmed', async ({ page }) => {
  group({ actor: 'third' });
  await page.route('**/memberships/leave', async route => { await forward(route); await route.abort('failed'); });
  await connect(page, thirdToken); await open(page); await page.locator('#leave-submit').click();
  await expect(page.locator('#connect')).toBeVisible(); await expect(page.locator('#connect-error')).toContainText('未收到确认');
  await expect(page.locator('#messages')).toBeEmpty(); await expect(page.locator('#leave-name')).toHaveText('');
  await expect(page.locator('#announcement')).not.toContainText('已确认退出');
});

test('confirmed last-scope leave gives an explicit confirmation without an access-error claim', async ({ page }) => {
  group({ actor: 'third' }); await connect(page, thirdToken); await open(page); await page.locator('#leave-submit').click();
  await expect(page.locator('#connect')).toBeVisible(); await expect(page.locator('#connect-error')).toContainText('已确认退出');
});

test('confirmed leave clears management, pending content and attachment metadata despite a stale session response', async ({ page }) => {
  const scope = group({ actions: ['read', 'send', 'manage_resource'] }); let hold = false, held, offline = false;
  await page.route(url => url.pathname === '/session', async route => {
    if (offline) return route.abort('failed');
    if (hold) { hold = false; const response = await forward(route); held = () => route.fulfill({ response }); return; }
    await route.continue();
  });
  await page.route('**/messages', route => route.abort('failed'));
  await connect(page); await page.locator('#attachment-file').setInputFiles({ name: 'old-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('old attachment') });
  await expect(page.locator('#attachment-name')).toContainText('old-draft.txt'); await page.locator('#message').fill('old pending message'); await page.locator('#send').click();
  await expect(page.locator('#outbox')).not.toBeEmpty(); await open(page); hold = true; await expect.poll(() => Boolean(held)).toBe(true);
  offline = true; await page.locator('#leave-submit').click(); await expect(page.locator('#leave-dialog')).not.toBeVisible(); await held();
  expect(member(scope)).toBe(false); await expect(page.locator('#manage-conversation')).toBeHidden();
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('#attachment-name')).toHaveText('');
  await expect(page.locator('#app')).not.toContainText('old pending message'); await expect(page.getByRole('button', { name: '退出测试 <只作文本> main', exact: true })).toHaveCount(0);
});

test('late success from the previous membership cannot clear a newly joined generation', async ({ page }) => {
  const scope = group({ actor: 'third' }); let held;
  await page.route('**/memberships/leave', async route => {
    const response = await forward(route);
    demo.engine.commit(() => demo.engine.addScopeMember('demo-owner', 'third', scope, 2, 'rejoin-after-leave', { actions: ['read', 'send'], expiresAt: Date.now() + 100000 }));
    held = () => route.fulfill({ response });
  });
  await connect(page, thirdToken); await page.locator('#message').fill('old generation draft'); await open(page); await page.locator('#leave-submit').click();
  await expect.poll(() => Boolean(held)).toBe(true); await expect(page.locator('#leave-dialog')).not.toBeVisible(); await expect(page.locator('#message')).toHaveValue('');
  await page.locator('#message').fill('new generation draft'); await held();
  await expect(page.locator('#message')).toHaveValue('new generation draft'); await expect(page.locator('#message')).toBeFocused(); await expect(page.locator('#send')).toBeEnabled(); await expect(page.locator('#connect')).toBeHidden();
});

test('leave confirmation blocks background read advancement and clears at known expiry offline', async ({ page }) => {
  const scope = group({ expiresAt: Date.now() + 6000 }); await connect(page); await open(page);
  // A shared member can send; keep this fixture source message ordinary so no worker starts.
  const message = demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, 'arrived while confirming', 'unread-during-leave')).message;
  await expect(page.locator('.message-text')).toHaveText('arrived while confirming');
  expect(demo.engine.state.readPosition('demo-owner', scope)).not.toBe(message.id);
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => route.abort('failed'));
  await expect(page.locator('#leave-dialog')).not.toBeVisible(); await expect(page.locator('#leave-name')).toHaveText('');
});

test('leaving the last readable room preserves creation authority and focuses its visible entry', async ({ page }) => {
  const config = demo.engine.state.config;
  for (const grant of config.grants.filter(g => g.memberId === 'demo-owner')) grant.actions = grant.conversationId === authority.conversationId ? ['manage_workspace', 'grant_permissions'] : [];
  group(); await connect(page); await open(page); await page.locator('#leave-submit').click();
  await expect(page.locator('#management-empty')).toBeVisible(); await expect(page.locator('#create-conversation')).toBeFocused(); await expect(page.locator('#connect')).toBeHidden();
});
