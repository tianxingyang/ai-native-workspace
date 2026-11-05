import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo;
const parent = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connect')).toBeHidden();
}
function threads() { return demo.engine.state.snapshot().threads.threads; }

async function managedGroup() {
  const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: parent, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  for (const grant of config.grants.filter(grant => grant.conversationId === parent.conversationId)) grant.actions.push('manage_workspace', 'grant_permissions');
  const expiresAt = Date.now() + 120000;
  return (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '成员换代的会话', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'thread-generation-group',
    initialGrants: [{ targetMemberId: 'demo-owner', actions: ['read', 'send'], expiresAt },
      { targetMemberId: 'demo-researcher', actions: ['read', 'send', 'manage_resource'], expiresAt }] })).conversation;
}

for (const width of [1280, 390]) test(`thread creation, parent navigation and independent messages/drafts at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await connect(page);
  await page.locator('#message').fill('父会话的草稿');
  await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('设计 <纯文本>');
  await page.locator('#thread-create-name').press('Alt+ArrowDown'); await expect(page.locator('#room-title')).toHaveText('产品讨论');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.getElementById('thread-create').contains(document.activeElement))).toBe(true);
  }
  expect(await page.locator('#thread-create').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.locator('#thread-create-save').click(); await expect(page.locator('#thread-create')).not.toBeVisible();
  await expect(page.locator('#room-title')).toHaveText('设计 <纯文本>'); await expect(page.locator('#room-title')).toBeFocused();
  await expect(page.locator('#create-thread')).toBeHidden(); await expect(page.locator('#message')).toHaveValue('');
  await page.locator('#message').fill('只属于设计线程的消息'); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toContainText('只属于设计线程的消息');
  await page.locator('#message').fill('线程草稿'); await page.locator('#parent-thread').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#room-title')).toHaveText('产品讨论'); await expect(page.locator('#message')).toHaveValue('父会话的草稿');
  await expect(page.locator('#room-title')).toBeFocused();
  await expect(page.locator('#messages')).not.toContainText('只属于设计线程的消息');
  if (width < 720) await page.locator('#back').click();
  await page.getByRole('button', { name: '设计 <纯文本> 讨论线程 · 产品讨论', exact: true }).click();
  await expect(page.locator('#message')).toHaveValue('线程草稿'); await expect(page.locator('#messages')).toContainText('只属于设计线程的消息');
  const child = threads()[0];
  const messages = await requestJson(demo.url, demo.ownerToken, `/messages?${new URLSearchParams(parent)}`);
  expect(messages.messages.some(message => message.text === '只属于设计线程的消息')).toBe(false);
  expect(child.parent).toEqual(parent);
  await page.reload(); await connect(page);
  if (width < 720) await page.locator('#back').click();
  await page.getByRole('button', { name: '设计 <纯文本> 讨论线程 · 产品讨论', exact: true }).click();
  await expect(page.locator('#messages')).toContainText('只属于设计线程的消息');
  expect(threads()).toHaveLength(1);
});

test('lost response freezes the original creation request and manual retry discovers one thread', async ({ page }) => {
  const bodies = []; let drop = true;
  await page.route('**/threads', async route => {
    bodies.push(route.request().postDataJSON());
    if (drop) { drop = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await connect(page); await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('重试一次');
  await page.locator('#thread-create-save').click(); await expect(page.locator('#thread-create-status')).toContainText('结果尚未确认');
  await expect(page.locator('#thread-create-name')).toBeDisabled();
  await page.locator('#thread-create-save').click(); await expect(page.locator('#room-title')).toHaveText('重试一次');
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(threads()).toHaveLength(1);
});

test('read-only members can discover authorized threads but cannot create, and revoked threads disappear', async ({ page }) => {
  await requestJson(demo.url, demo.ownerToken, '/threads', { ...parent, title: '阅读线程', clientEventId: 'seed-thread', expectedMembershipGeneration: 'initial' });
  const grant = demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === parent.conversationId);
  grant.actions = ['read'];
  await connect(page); await expect(page.locator('#create-thread')).toBeHidden();
  await page.getByRole('button', { name: '阅读线程 讨论线程 · 产品讨论', exact: true }).click();
  await expect(page.locator('#room-title')).toHaveText('阅读线程'); await expect(page.locator('#send')).toBeDisabled();
  grant.revoked = true;
  await expect(page.locator('#rooms')).not.toContainText('阅读线程'); await expect(page.locator('#room-title')).toHaveText('研发讨论');
});

test('late creation response after parent revocation cannot restore or select its thread', async ({ page }) => {
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/threads', async route => {
    const response = await route.fetch(); started(); await held;
    await route.fulfill({ response });
  });
  await connect(page); await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('迟到的线程');
  await page.locator('#thread-create-save').click(); await pending;
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === parent.conversationId).revoked = true;
  try {
    await expect(page.locator('#thread-create')).not.toBeVisible(); await expect(page.locator('#room-title')).toHaveText('研发讨论');
  } finally { release(); }
  await expect(page.locator('#rooms')).not.toContainText('迟到的线程');
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
});

test('creation dialog excludes background messages from reading and returns keyboard focus on close', async ({ page }) => {
  await connect(page); await page.locator('#create-thread').click();
  const message = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', parent, '弹窗期间不应已读', 'thread-modal-message')).message;
  await expect(page.locator('#messages')).toContainText(message.text);
  expect(demo.engine.state.readPosition('demo-owner', parent)).not.toBe(message.id);
  await page.locator('#thread-create-close').click(); await expect(page.locator('#create-thread')).toBeFocused();
});

for (const change of ['send-revoked', 'membership-rejoined']) test(`late creation result cannot navigate after ${change}`, async ({ page }) => {
  const scope = change === 'membership-rejoined' ? await managedGroup() : parent;
  const title = scope.title ?? scope.conversationId;
  let release, started, finished;
  const pending = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  await page.route('**/threads', async route => {
    const response = await route.fetch(); started(); await held;
    await route.fulfill({ response }); finished();
  });
  await connect(page);
  if (scope.title) await page.getByRole('button', { name: `${scope.title} main`, exact: true }).click();
  await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('已变更权限的创建');
  await page.locator('#thread-create-save').click(); await pending;
  if (change === 'send-revoked') {
    demo.engine.state.config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === parent.conversationId).actions = ['read'];
  } else {
    demo.engine.commit(() => {
      const revision = demo.engine.state.membershipRoster('demo-researcher', scope).revision;
      demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, revision, 'thread-remove');
      demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, revision + 1, 'thread-rejoin', { actions: ['read', 'send'], expiresAt: Date.now() + 100000 });
    });
  }
  try {
    await expect(page.locator('#thread-create')).not.toBeVisible(); await expect(page.locator('#room-title')).toHaveText(title);
    await expect(page.locator('#thread-create-parent')).toHaveText('');
    if (change === 'membership-rejoined') await page.locator('#message').fill('新成员版本的草稿');
    else await expect(page.locator('#create-thread')).toBeHidden();
  } finally { release(); }
  await settled;
  await expect(page.locator('#room-title')).toHaveText(title);
  if (change === 'membership-rejoined') await expect(page.locator('#message')).toHaveValue('新成员版本的草稿');
  expect(threads()).toHaveLength(1);
});

test('closing an uncertain creation and reconnecting cannot replay it or retain the old dialog title', async ({ page }) => {
  let requests = 0;
  await page.route('**/threads', async route => { requests++; await route.fetch(); await route.abort('failed'); });
  await connect(page); await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('断线前的创建');
  await page.locator('#thread-create-save').click(); await expect(page.locator('#thread-create-status')).toContainText('结果尚未确认');
  await page.locator('#thread-create-close').click(); await expect(page.locator('#thread-create-parent')).toHaveText('');
  await page.locator('#logout').click(); await expect(page.locator('#thread-toolbar')).toBeHidden(); await expect(page.locator('#parent-thread')).toHaveText('');
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connect')).toBeHidden(); await expect(page.locator('#room-title')).toHaveText('产品讨论');
  await expect(page.locator('#rooms')).toContainText('断线前的创建'); await expect(page.locator('#thread-create')).not.toBeVisible();
  expect(requests).toBe(1); expect(threads()).toHaveLength(1);
});
