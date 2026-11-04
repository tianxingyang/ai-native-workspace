import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo;
const authority = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo();
  const config = demo.engine.state.config;
  // Provisioning is enabled only in this disposable fixture.
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send'], maxGrantDurationMs: 120000 };
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function create(title, clientEventId, grantOwner = true) {
  const initialGrants = [{ targetMemberId: 'demo-researcher', actions: ['read'], expiresAt: Date.now() + 100000 }];
  if (grantOwner) initialGrants.push({ targetMemberId: 'demo-owner', actions: ['read', 'send'], expiresAt: Date.now() + 100000 });
  return requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'direct', title, memberIds: ['demo-owner', 'demo-researcher'], initialGrants, clientEventId });
}
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}

test('newly authorized conversations appear by name, carry normal messages and clear after source loss', async ({ page }) => {
  await connect(page);
  const { conversation } = await create('新建私聊 <安全文本>', 'browser-create');
  const room = page.getByRole('button', { name: '新建私聊 <安全文本> main', exact: true });
  await expect(room).toBeVisible(); await room.click();
  await expect(page.locator('#room-title')).toHaveText('新建私聊 <安全文本>');
  await page.locator('#message').fill('新私聊的日常消息'); await page.locator('#send').click();
  await expect(page.locator('.message-text')).toContainText('新私聊的日常消息');
  expect([...demo.engine.state.messages.values()].find(m => m.text === '新私聊的日常消息').conversationId).toBe(conversation.conversationId);
  await page.reload(); await connect(page); await room.click();
  await expect(page.locator('.message-text')).toContainText('新私聊的日常消息');
  await page.locator('#message').fill('该私聊的草稿');
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).revision++;
  await expect(room).toHaveCount(0); await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#app')).not.toContainText('新私聊的日常消息');
  await expect(page.locator('#connect')).toBeHidden();
});

test('creation and membership do not make an ungranted private conversation discoverable', async ({ page }) => {
  await create('仅另一成员可读', 'hidden-conversation', false);
  await connect(page); await expect(page.locator('#rooms')).not.toContainText('仅另一成员可读');
  expect((await requestJson(demo.url, demo.ownerToken, '/session')).scopes.some(scope => scope.title === '仅另一成员可读')).toBe(false);
});
