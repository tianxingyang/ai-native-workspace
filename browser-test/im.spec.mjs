import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async () => { await demo.stop(); });
async function connect(page) {
  await page.goto(demo.url);
  await page.getByLabel('本地演示访问凭据').fill(demo.ownerToken);
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}
async function send(page, text) {
  await page.getByLabel('发送到当前会话的消息').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.message-text').filter({ hasText: text })).toHaveCount(1);
}

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
  await expect(page.locator('#source-filter')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(2);
  await page.getByRole('button', { name: '返回全部消息' }).click();
  await expect(page.locator('#timeline')).toBeFocused();
  await page.locator('.sources summary').click();
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
  await mkdir('.impeccable/review', { recursive: true });
  await page.screenshot({ path: '.impeccable/review/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByRole('button', { name: '会话列表' })).toBeVisible();
  await page.screenshot({ path: '.impeccable/review/mobile.png', fullPage: true });
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
  let acceptedStatus;
  await page.route('**/runs/*/cancel', async route => {
    const response = await route.fetch(); acceptedStatus = (await response.json()).status; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '取消研究', exact: true }).click();
  await expect(page.locator('.status-label')).toHaveText('已停止');
  expect(acceptedStatus).toBe('cancel_requested');
  await expect(page.locator('.run')).toContainText('执行设备已确认运行结束');
  const run = [...demo.engine.state.runs.values()][0];
  expect(run.events.some(event => event.kind === 'stopped' && event.data.executionSettled === true)).toBe(true);
  expect([...demo.engine.state.messages.values()].filter(message => message.origin === 'research')).toHaveLength(0);
  await page.screenshot({ path: '.impeccable/review/cancelled.png', fullPage: true });
});

test('lost send response and repeated submit retry the same message without duplicate work', async ({ page }) => {
  await connect(page);
  let drop = true;
  await page.route('**/messages', async route => {
    if (route.request().method() === 'POST' && drop) { drop = false; await route.fetch(); await route.abort('failed'); }
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
    if (route.request().method() === 'POST') { const response = await route.fetch(); await new Promise(resolve => setTimeout(resolve, 1500)); await route.fulfill({ response }); }
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
  await page.keyboard.press('Enter'); await expect(page.locator('#timeline')).toBeFocused();
  await page.getByRole('button', { name: '返回全部消息' }).focus();
  await page.keyboard.press('Enter'); await expect(page.locator('#timeline')).toBeFocused();
  await page.getByRole('button', { name: '查看来源消息与讨论' }).click();
  await page.getByRole('button', { name: '退出连接' }).click();
  await connect(page); await expect(page.locator('#source-filter')).toBeHidden();
  await expect(page.locator('.message')).toHaveCount(3);
});
