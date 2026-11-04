import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';

let demo;
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo();
  // Explicit authorization only in this disposable fixture; no deployment config changes.
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).actions.push('manage_resource');
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}
const remove = (targetMemberId, clientEventId) => requestJson(demo.url, demo.ownerToken, '/memberships/remove', { ...scope, targetMemberId, expectedRevision: 1, clientEventId });

test('persisted membership removal clears a selected room and cannot return on reconnect', async ({ page }) => {
  demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, '成员移除后的不可见内容', 'membership-source'));
  await connect(page); await expect(page.locator('.message-text')).toHaveText('成员移除后的不可见内容');
  await page.locator('#message').fill('该讨论的私有草稿'); await page.locator('#search-toggle').click();
  await page.locator('#search-query').fill('不可见'); await expect(page.locator('#search-results')).toContainText('不可见内容');
  await remove('demo-owner', 'remove-current-member');
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
  await expect(page.locator('#message')).toHaveValue(''); await expect(page.locator('#search-query')).toHaveValue('');
  await expect(page.locator('#app')).not.toContainText('不可见内容'); await expect(page.locator('#connect')).toBeHidden();
  await page.reload(); await connect(page);
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0);
});

test('removing a running Agent updates the member roster and keeps stop status uncertain', async ({ page }) => {
  const researcherName = demo.engine.state.config.members.find(member => member.id === 'demo-researcher').name;
  await connect(page); await page.locator('#message').fill('请调研一下成员移除协议'); await page.locator('#send').click();
  await expect.poll(() => [...demo.engine.state.runs.values()].some(run => run.status === 'running')).toBe(true);
  const result = await remove('demo-researcher', 'remove-running-agent');
  expect(result.change.targetMemberId).toBe('demo-researcher');
  await expect.poll(() => [...demo.engine.state.runs.values()][0]?.status).toBe('unknown');
  await expect(page.locator('#thread-title')).toContainText('1');
  await page.locator('#members-toggle').click();
  await expect(page.locator('#members')).not.toContainText(researcherName);
  await expect(page.locator('#app')).toContainText('执行结果待核对');
  expect([...demo.engine.state.runs.values()][0].stopEvidence).toBeUndefined();
  expect([...demo.engine.state.messages.values()].filter(message => message.origin === 'research')).toHaveLength(0);
  await expect(page.locator('#connect')).toBeHidden();
});
