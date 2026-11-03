// Run after desktop-notification-smoke.mjs against the same test installation.
// Uses actual registered Windows protocol activations and native authorization;
// only delays delivery of an already-returned empty IPC response.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const uri = (await readFile('.local/last-notice-uri.txt', 'utf8')).trim();
assert.match(uri, /^coseat-demo-notice:\/\/notification\/[0-9a-f]{32}$/);
function activate() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${uri}' -WindowStyle Hidden`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
const endpoint = await fetch('http://127.0.0.1:9227/json/version').then(r => r.json());
const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://tauri.localhost/');
assert.ok(page);
try {
  if (await page.locator('#connect').isVisible()) await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.evaluate(() => {
    const original = window.__TAURI__.core;
    const probe = window.notificationRaceProbe = { takes: 0, opened: 0, held: false, armed: true };
    probe.restore = () => { window.__TAURI__.core = original; probe.release?.(); };
    window.__TAURI__.core = { ...original, invoke: async (...args) => {
      const result = await original.invoke(...args);
      if (args[0] === 'desktop_take_notification') {
        probe.takes++;
        if (result.kind === 'open') probe.opened++;
        if (result.kind === 'none' && probe.opened && probe.armed) {
          probe.armed = false; probe.held = true;
          await new Promise(resolve => { probe.release = () => { probe.held = false; resolve(); }; });
        }
      }
      return result;
    } };
  });
  activate();
  await expect.poll(() => page.evaluate(() => window.notificationRaceProbe.held)).toBe(true);
  activate();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('section.connection-page:not(#connect)')).toBeVisible();
  await page.evaluate(() => window.notificationRaceProbe.release());
  await expect.poll(() => page.evaluate(() => window.notificationRaceProbe.opened)).toBe(2);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await expect(page.locator('section.connection-page:not(#connect)')).toBeHidden();
  assert.equal(await page.evaluate(() => window.notificationRaceProbe.takes), 4);
  console.log('PASS installed WebView2: second real protocol activation survives an in-flight empty native IPC response; source restored, bounded drain, no blank window.');
} finally {
  await page.evaluate(() => { window.notificationRaceProbe?.restore(); delete window.notificationRaceProbe; }).catch(() => {});
  await browser.close();
}
