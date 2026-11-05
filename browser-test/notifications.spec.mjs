import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';

let demo;
const first = { conversationId: '产品讨论', threadId: '日常交流' };
const second = { conversationId: '研发讨论', threadId: '插件协议' };
test.beforeEach(async ({ page }) => {
  demo = await startWebDemo();
  // Real session/snapshot authorization, with only the native notification IPC
  // mocked. Credentials stay in the test host, outside the renderer.
  await page.exposeBinding('desktopRequest', async (_, { path, body }) => {
    const response = await fetch(new URL(path, demo.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${demo.ownerToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  });
  await page.addInitScript(() => {
    const bridge = window.notices = { queue: [], takes: 0, active: 0, maxActive: 0, presented: [], blocked: false };
    window.__TAURI__ = {
      event: { listen: async (_, listener) => { bridge.wake = listener; } },
      core: { invoke: async (command, args) => {
        if (command === 'desktop_presentation') return { locale: 'zh-CN', selection: 'rebuild' };
        if (command === 'desktop_request') return window.desktopRequest(args);
        if (command === 'desktop_connected') return;
        if (command === 'desktop_present') {
          bridge.presented.push({ app: !document.getElementById('app').hidden, connect: !document.getElementById('connect').hidden });
          return;
        }
        if (command !== 'desktop_take_notification') throw new Error(`Unexpected command: ${command}`);
        bridge.takes++; bridge.active++; bridge.maxActive = Math.max(bridge.maxActive, bridge.active);
        // Capture the result before suspending delivery, exactly like a native
        // IPC response already in flight when another activation is queued.
        const item = bridge.queue.shift() ?? { result: { kind: 'none' } };
        try {
          if (item.hold) await new Promise((resolve, reject) => {
            bridge.blocked = true;
            bridge.release = () => { bridge.blocked = false; item.fail ? reject(new Error('IPC failed')) : resolve(); };
          });
          return item.result;
        } finally { bridge.active--; }
      } },
    };
  });
  await page.goto(demo.url);
  await expect.poll(() => page.evaluate(() => window.notices.takes)).toBe(1);
  await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.locator('#message').fill('cached discussion must not survive denied access');
  await page.locator('#send').click();
  await expect(page.locator('.message')).toHaveCount(1);
});
test.afterEach(async ({ page }) => { await page.close(); await demo?.stop(); });

async function pauseDrain(page, { handled = true, fail = false } = {}) {
  await page.evaluate(({ scope, handled, fail }) => {
    if (handled) window.notices.queue.push({ result: { kind: 'open', scope } });
    window.notices.queue.push({ result: { kind: 'none' }, hold: true, fail });
    window.notices.wake();
  }, { scope: first, handled, fail });
  await expect.poll(() => page.evaluate(() => window.notices.blocked)).toBe(true);
}
async function wakeWhileBusy(page, result, count = 1) {
  await page.evaluate(({ result, count }) => {
    if (result) window.notices.queue.push({ result });
    for (let i = 0; i < count; i++) window.notices.wake();
  }, { result, count });
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('section.connection-page:not(#connect)')).toBeVisible();
}
async function finish(page, takes) {
  await page.evaluate(() => window.notices.release());
  await expect.poll(() => page.evaluate(() => window.notices.takes)).toBe(takes);
  await expect(page.locator('section.connection-page:not(#connect)')).toBeHidden();
  const stats = await page.evaluate(async () => {
    // Let queued continuations and paints finish; no timing sleeps to arrange
    // the race, and a runaway drain cannot silently pass the bounded count.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { takes, active, maxActive, queue, presented } = window.notices;
    return { takes, active, maxActive, remaining: queue.length, presented };
  });
  expect(stats).toMatchObject({ takes, active: 0, maxActive: 1, remaining: 0 });
  for (const view of stats.presented) expect(Number(view.app) + Number(view.connect)).toBe(1);
}

test('activation arriving during the final empty IPC response is drained in order', async ({ page }) => {
  await pauseDrain(page);
  await wakeWhileBusy(page, { kind: 'open', scope: second }, 3);
  await finish(page, 5);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText(second.conversationId);
  await expect(page.locator('.message')).toHaveCount(0);
  // The handler becomes idle and still accepts a later independent activation.
  await page.evaluate(scope => {
    window.notices.queue.push({ result: { kind: 'open', scope } }); window.notices.wake();
  }, first);
  await expect(page.locator('#room-title')).toHaveText(first.conversationId);
  await expect(page.locator('.message')).toHaveCount(1);
});

test('an empty first drain also preserves a racing activation', async ({ page }) => {
  await pauseDrain(page, { handled: false });
  await wakeWhileBusy(page, { kind: 'open', scope: second });
  await finish(page, 4);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText(second.conversationId);
});

test('notification recovery closes a narrow modal and releases its inert background', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#members-toggle').click();
  await expect(page.locator('#details')).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#chat')).toHaveAttribute('inert');
  await pauseDrain(page, { handled: false });
  await wakeWhileBusy(page, { kind: 'open', scope: second });
  await finish(page, 4);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText(second.conversationId);
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#chat')).not.toHaveAttribute('inert');
  await expect(page.locator('#sidebar')).not.toHaveAttribute('inert');
  await expect(page.locator('#members')).toBeEmpty();
  await page.locator('#message').fill('恢复后的消息输入仍可用');
  await page.locator('#send').click();
  await expect(page.locator('.message-text')).toHaveText('恢复后的消息输入仍可用');
});

test('duplicate wake-ups with no pending notice restore the view and stop draining', async ({ page }) => {
  await pauseDrain(page);
  await wakeWhileBusy(page, null, 3);
  await finish(page, 4);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(1);
});

for (const outcome of ['expired', 'unauthorized', 'unavailable', 'ipc-failure']) {
  test(`a racing ${outcome} notification clears cached content and shows a safe view`, async ({ page }) => {
    await pauseDrain(page, { fail: outcome === 'ipc-failure' });
    if (outcome === 'expired') {
      for (const grant of demo.engine.state.config.grants.filter(g => g.memberId === 'demo-owner')) grant.expiresAt = Date.now() - 1;
    }
    const result = outcome === 'expired' ? { kind: 'open', scope: second }
      : outcome === 'unauthorized' ? { kind: 'unauthorized', status: 401 }
      : { kind: 'unavailable', reason: 'ended' };
    await wakeWhileBusy(page, result);
    // Failed session validation exits that drain; it must not spin/retry it.
    await finish(page, outcome === 'expired' ? 4 : 5);
    await expect(page.locator('#connect')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('#messages')).toBeEmpty();
    await expect(page.locator('#connect-error')).not.toBeEmpty();
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
  });
}
