// Requires the installed test instance's temporary loopback inspection port.
// Exercises the actual Windows registered protocol, not an injected JS callback.
// This proves routing; it does not claim a visible banner/Notification Center click.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const endpoint = await fetch('http://127.0.0.1:9227/json/version').then(r => r.json());
const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://tauri.localhost/');
assert.ok(page);
function powershell(args) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function history() { return JSON.parse(powershell(['-File', 'scripts/desktop-notification-history.ps1'])); }
function activate(uri) {
  assert.match(uri, /^coseat-demo-notice:\/\/notification\/[0-9a-f]{32}$/);
  powershell(['-Command', `Start-Process -FilePath '${uri}'`]);
}
const before = new Set(history().map(n => n.uri));
await page.locator('.room').nth(1).click();
await page.locator('#message').fill('请调研一下通知来源的安全恢复。');
await page.locator('#send').click();
await expect(page.locator('.status-label').last()).toHaveText('正在研究');
await page.locator('.room').nth(0).click();
// WM_CLOSE exercises the actual native close-to-tray handler.
powershell(['-File', 'scripts/desktop-test-window.ps1', '-Action', 'close']);
await expect.poll(async () => (await page.evaluate(() => window.__TAURI__.core.invoke('desktop_status'))).visible).toBe(false);
let notice;
await expect.poll(() => { notice = history().find(n => !before.has(n.uri)); return Boolean(notice); }, { timeout: 20000 }).toBe(true);
assert.equal(notice.activation, 'protocol');
await writeFile('.local/last-notice-uri.txt', notice.uri);
activate(notice.uri);
await expect(page.locator('#room-title')).toContainText('研发讨论');
await expect(page.locator('#app')).toBeVisible();
await expect.poll(async () => (await page.evaluate(() => window.__TAURI__.core.invoke('desktop_status'))).visible).toBe(true);
console.log('PASS Windows notification history + registered protocol: hidden window restored to freshly authorized source.');
activate(notice.uri); activate(notice.uri); activate(notice.uri);
await expect(page.locator('#app')).toBeVisible();
await expect(page.locator('#room-title')).toContainText('研发讨论');
await expect.poll(async () => await page.locator('section.connection-page:visible').count()).toBe(0);
console.log('PASS repeated notification activation keeps source selection and leaves no loading overlay.');

// An otherwise valid ID does not supply authority while disconnected.
await page.locator('#logout').click();
activate(notice.uri);
await expect(page.locator('#connect-error')).toContainText('当前已断开连接');
await expect(page.locator('#app')).toBeHidden();
await expect(page.locator('.message')).toHaveCount(0);
await page.locator('#connect-button').click();
await expect(page.locator('#connection-status')).toHaveText('已连接');
activate('coseat-demo-notice://notification/00000000000000000000000000000000');
await expect(page.locator('#connect-error')).toContainText('已结束或不可用');
await expect(page.locator('#app')).toBeHidden();
await expect(page.locator('.message')).toHaveCount(0);
console.log('PASS disconnected/unknown notification references fail closed and clear cached messages.');
await browser.close();
