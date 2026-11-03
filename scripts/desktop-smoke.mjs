// Connect only to the temporary loopback WebView2 inspection port of a test
// installation. The release app does not enable this port itself.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const endpoint = await fetch('http://127.0.0.1:9227/json/version').then(r => r.json());
const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://tauri.localhost/');
assert.ok(page, 'Installed CoSeat WebView2 page must exist');
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('.local/desktop', { recursive: true });
await expect(page.locator('#token')).toBeHidden();
await page.locator('#connect-button').click();
await expect(page.locator('#connection-status')).toHaveText('已连接');
await page.locator('#message').fill('请调研一下 Windows 客户端的取消与恢复。');
await page.locator('#send').click();
await expect(page.locator('.status-label').last()).toHaveText('正在研究');
await page.getByRole('button', { name: '取消研究', exact: true }).last().click();
await expect(page.locator('.status-label').last()).toHaveText('已停止', { timeout: 15000 });
await expect(page.locator('.run').last()).toContainText('停止回执已保存');
await page.locator('#message').fill('请调研一下本地消息通知的边界。');
await page.locator('#composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
await expect(page.locator('.status-label').last()).toHaveText('已完成', { timeout: 15000 });
await expect(page.locator('.message-text').filter({ hasText: '请调研一下本地消息通知的边界。' })).toHaveCount(1);
await expect(page.locator('.result-label')).toHaveCount(1);
await page.locator('.sources summary').click();
await page.screenshot({ path: '.local/desktop/installed-chat.png' });
await page.locator('.room').nth(1).click();
await expect(page.locator('.message')).toHaveCount(0);
await page.locator('#message').fill('会话草稿');
await page.locator('.room').nth(0).click();
await page.locator('.room').nth(1).click();
await expect(page.locator('#message')).toHaveValue('会话草稿');
const denied = await page.evaluate(() => window.__TAURI__.core.invoke('desktop_request', { path: '/messages?conversationId=unshared&threadId=private' }));
assert.equal(denied.status, 403);
const noNativePrivilege = await page.evaluate(async () => {
  try { await window.__TAURI__.core.invoke('plugin:shell|execute', { program: 'cmd' }); return false; } catch { return true; }
});
assert.equal(noNativePrivilege, true);
assert.equal(await page.evaluate(async () => { try { await window.__TAURI__.core.invoke('desktop_request', { path: 'https://untrusted.invalid/messages' }); return false; } catch { return true; } }), true);
assert.equal(await page.evaluate(async () => { try { await fetch('https://untrusted.invalid/'); return false; } catch { return true; } }), true);
await page.evaluate(() => { location.href = 'https://untrusted.invalid/'; });
await page.waitForTimeout(150);
assert.equal(page.url(), 'http://tauri.localhost/');
await page.evaluate(() => { window.open('https://untrusted.invalid/'); });
await page.waitForTimeout(150);
assert.equal(browser.contexts().flatMap(c => c.pages()).length, 1);
assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
await page.reload();
await expect(page.locator('#connect')).toBeVisible();
await page.locator('#connect-button').click();
await expect(page.locator('#connection-status')).toHaveText('已连接');
await expect(page.locator('.status-label').last()).toHaveText('已完成');
assert.deepEqual(errors, []);
console.log('PASS installed WebView2: real send, duplicate-submit, completed synthetic sources, stopped receipt, room/draft isolation, 403 scope denial, denied external fetch/navigation/window/IPC URL, no shell privilege/storage, reload reconnect.');
await browser.close();
