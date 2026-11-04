import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import catalog from '../web/locales/zh-CN.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop();
});

for (const width of [320, 390, 1280]) test(`expanded presentation resources remain text and keep actions visible at ${width}px`, async ({ page }) => {
  const expanded = structuredClone(catalog);
  expanded.messages['run.unknown'] = `待核对·${'ExpandedStatus'.repeat(10)}<b>普通文本</b>`;
  expanded.messages['error.connection'] = `连接异常·${'ExpandedConnection'.repeat(10)}`;
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(expanded)};` }));
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  const { message } = await requestJson(demo.url, demo.ownerToken, '/messages', { ...scope, text: '日期与状态资源验证', clientEventId: 'presentation-source' });
  // A synthetic unknown run exercises the honest state label without invoking a model.
  demo.engine.commit(() => { demo.engine.state.claim('demo-researcher', message.id).run.status = 'unknown'; });
  await page.setViewportSize({ width, height: 900 }); await page.goto(demo.url);
  await page.getByLabel('本地演示访问凭据').fill(demo.ownerToken);
  await page.getByRole('button', { name: '连接会话', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', catalog.locale);
  await expect(page.locator('.status-label')).toHaveText(expanded.messages['run.unknown']);
  await expect(page.locator('.status-label b')).toHaveCount(0);
  expect(await page.locator('.message time').first().evaluate(node => node.title === new Date(node.dateTime).toLocaleString(document.documentElement.lang))).toBe(true);
  const cancel = page.getByRole('button', { name: '取消研究', exact: true });
  await cancel.scrollIntoViewIfNeeded();
  const bounds = await page.locator('.run').evaluate(node => {
    const box = node.getBoundingClientRect(), label = node.querySelector('.run-state').getBoundingClientRect(), action = node.querySelector('.run-cancel').getBoundingClientRect();
    return { boxLeft: box.left, boxRight: box.right, labelLeft: label.left, labelRight: label.right, actionRight: action.right };
  });
  expect(bounds.labelLeft).toBeGreaterThanOrEqual(bounds.boxLeft); expect(bounds.labelRight).toBeLessThanOrEqual(bounds.boxRight);
  expect(bounds.actionRight).toBeLessThanOrEqual(bounds.boxRight);
  expect(await page.locator('.status-label').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.getByRole('button', { name: '查看这条消息的讨论', exact: true }).click();
  await expect(page.locator('.thread-status > span')).toHaveText(expanded.messages['run.unknown']);
  expect(await page.locator('.thread-status > span').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.locator('#details-close').click();
  await page.route('**/session', route => route.abort('failed'));
  await expect(page.locator('#sync-error-text')).toContainText(expanded.messages['error.connection']);
  const reconnect = page.getByRole('button', { name: '立即重连', exact: true });
  await expect(reconnect).toBeInViewport();
  expect(await reconnect.evaluate(node => {
    const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === node || node.contains(hit);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width === 390) {
    await mkdir('.impeccable/review', { recursive: true });
    await page.screenshot({ path: '.impeccable/review/presentation-expanded-390.png' });
  }
});
