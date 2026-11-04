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
  await page.route(url => url.pathname === '/runs', async route => {
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
    await page.route('**/runs?*', async route => {
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
      await page.unroute('**/runs?*'); await page.unroute('**/session');
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
