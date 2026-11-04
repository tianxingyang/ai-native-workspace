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

test('static resource slots match demo fallbacks and preserve icons and form values', async ({ page }) => {
  const html = await (await page.request.get(demo.url)).text();
  await page.goto(demo.url);
  const slots = await page.evaluate(source => {
    const template = new DOMParser().parseFromString(source, 'text/html');
    const values = [...template.querySelectorAll('[data-i18n]')].map(node => [node.dataset.i18n, node.textContent]);
    for (const attribute of ['aria-label', 'placeholder', 'title']) {
      for (const node of template.querySelectorAll(`[data-i18n-${attribute}]`)) values.push([node.getAttribute(`data-i18n-${attribute}`), node.getAttribute(attribute)]);
    }
    return values;
  }, html);
  expect(slots.length).toBeGreaterThan(30);
  for (const [key, value] of slots) expect(value).toBe(catalog.messages[key]);
  const result = await page.evaluate(async () => {
    const { applyStaticText, createPresentation } = await import('/presentation.js');
    const view = createPresentation({ locale: 'zh-CN', messages: { label: '<b>资源文字</b>' }, formats: {} });
    const root = document.createElement('div');
    root.innerHTML = '<button><svg></svg><span data-i18n="label"></span></button><input type="password" data-i18n-placeholder="label" data-i18n-value="label" data-i18n-onclick="label"><span data-i18n-aria-label="label"></span>';
    const field = root.querySelector('input'); field.value = 'synthetic-form-value';
    applyStaticText(root, view);
    const invalid = document.createElement('div'); invalid.innerHTML = '<button data-i18n="label"><svg></svg></button>';
    let rejectsRich = false; try { applyStaticText(invalid, view); } catch { rejectsRich = true; }
    const textarea = document.createElement('div'); textarea.innerHTML = '<textarea data-i18n="label">draft</textarea>';
    let rejectsFormText = false; try { applyStaticText(textarea, view); } catch { rejectsFormText = true; }
    return { svg: root.querySelectorAll('svg').length, bold: root.querySelectorAll('b').length,
      text: root.querySelector('button span').textContent, value: field.value, placeholder: field.placeholder,
      onclick: field.getAttribute('onclick'), aria: root.querySelector('[data-i18n-aria-label]').getAttribute('aria-label'), rejectsRich, rejectsFormText };
  });
  expect(result).toEqual({ svg: 1, bold: 0, text: '<b>资源文字</b>', value: 'synthetic-form-value', placeholder: '<b>资源文字</b>', onclick: null, aria: '<b>资源文字</b>', rejectsRich: true, rejectsFormText: true });
});

test('connection and editor labels use resources while message content remains unchanged', async ({ page }) => {
  const translated = structuredClone(catalog);
  Object.assign(translated.messages, { 'connect.submit': '资源连接', 'connect.connecting': '资源连接中', 'connect.credential': '资源凭据',
    'connection.connected': '资源已连接', 'composer.label': '资源消息输入', 'composer.send': '资源发送',
    'composer.threadPlaceholder': '资源范围<{thread}>', 'editor.editTitle': '资源编辑标题', 'editor.save': '资源保存', 'editor.content': '资源正文' });
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(translated)};` }));
  let release, held = false; const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/session', async route => { if (!held) { held = true; await hold; } await route.continue(); });
  try {
    await page.goto(demo.url);
    await page.getByLabel('资源凭据', { exact: true }).fill(demo.ownerToken);
    await page.getByRole('button', { name: '资源连接', exact: true }).click();
    await expect(page.locator('#connect-button')).toHaveText('资源连接中'); await expect(page.locator('#token')).toHaveValue(''); release();
    await expect(page.locator('#connection-status')).toHaveText('资源已连接');
    await expect(page.locator('#message')).toHaveAttribute('placeholder', '资源范围<日常交流>');
    const original = '用户正文保持原样 <em>字面文本</em>';
    await page.getByLabel('资源消息输入', { exact: true }).fill(original);
    await page.getByRole('button', { name: '资源发送', exact: true }).click();
    await expect(page.locator('.message-text')).toHaveText(original);
    await page.getByRole('button', { name: translated.messages['editor.editTitle'], exact: true }).click();
    await expect(page.locator('#change-title')).toHaveText('资源编辑标题');
    await page.getByLabel('资源正文', { exact: true }).fill('修改后的用户正文');
    await page.getByRole('button', { name: '资源保存', exact: true }).click();
    await expect(page.locator('.message-text')).toHaveText('修改后的用户正文');
    await page.locator('#logout').click(); await expect(page.locator('#connect-button')).toHaveText('资源连接');
  } finally { release(); }
});

test('expanded connection copy keeps credential and connect controls usable on a narrow screen', async ({ page }) => {
  const expanded = structuredClone(catalog);
  expanded.messages['connect.title'] = `连接标题${'ExtendedConnectionTitle'.repeat(6)}`;
  expanded.messages['connect.lede'] = `说明${'ExpandedIntroduction'.repeat(10)}`;
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(expanded)};` }));
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto(demo.url);
  await expect(page.locator('#connect-title')).toHaveText(expanded.messages['connect.title']);
  expect(await page.locator('#connect-title').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator('.connect-lede').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await mkdir('.impeccable/review', { recursive: true });
  await page.screenshot({ path: '.impeccable/review/static-presentation-connect-390.png', fullPage: true });
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
});

test('resource-backed run feedback distinguishes acknowledgement, application and stop evidence', async ({ page }) => {
  const translated = structuredClone(catalog);
  for (const key of Object.keys(translated.messages)) if (key.startsWith('run.note.') || key.startsWith('run.step.')) translated.messages[key] = `资源·${translated.messages[key]}`;
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(translated)};` }));
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  const { message } = await requestJson(demo.url, demo.ownerToken, '/messages', { ...scope, text: '运行状态展示验证', clientEventId: 'run-feedback' });
  demo.engine.commit(() => { demo.engine.state.claim('demo-researcher', message.id).run.status = 'unknown'; });
  const { runs: [original] } = await requestJson(demo.url, demo.ownerToken, `/runs?${new URLSearchParams(scope)}`);
  // Synthetic server projections exercise presentation; they do not claim real execution evidence.
  let projected = structuredClone(original);
  await page.route(url => url.pathname === '/runs' && url.searchParams.get('conversationId') === scope.conversationId,
    route => route.fulfill({ json: { runs: [projected] } }));
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  const note = page.locator('#messages .run-note'), steps = page.locator('#messages .run-steps');
  await expect(note).toHaveText(translated.messages['run.note.unknown']);
  projected = { ...original, status: 'cancel_requested' };
  await expect(note).toHaveText(translated.messages['run.note.cancelRequested']);
  projected = { ...original, status: 'stopped', events: [] };
  await expect(note).toHaveText(translated.messages['run.note.stopUnconfirmed']);
  projected = { ...original, status: 'stopped', events: [{ kind: 'stopped', at: Date.now(), data: { executionSettled: true } }] };
  await expect(note).toHaveText(translated.messages['run.note.executionStopped']);
  projected = { ...original, status: 'running', work: { ...original.work, contextRevision: 2 }, events: [{ kind: 'input_received', at: Date.now(), data: {} }] };
  await expect(note).toHaveText(translated.messages['run.note.running']);
  await expect(steps).not.toContainText(translated.messages['run.step.changeApplied']);
  projected.events.push({ kind: 'input_applied', at: Date.now(), data: {} });
  await expect(steps).toContainText(translated.messages['run.step.changeApplied']);
  projected = { ...original, contextInvalidated: true };
  await expect(note).toHaveText(translated.messages['run.note.invalidatedUnknown']);
  projected = { ...original, status: 'completed' };
  await expect(note).toHaveText(translated.messages['run.note.missingReceipt']);
  projected = { ...projected, receiptId: 'synthetic-published-receipt' };
  await expect(note).toHaveText(translated.messages['run.note.published']);
});

test('result resource templates preserve source data and keep placeholder addresses noninteractive', async ({ page }) => {
  const translated = structuredClone(catalog);
  for (const key of Object.keys(translated.messages)) if (key.startsWith('result.')) translated.messages[key] = `资源·${translated.messages[key]}`;
  await page.route('**/locales/zh-CN.js', route => route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(translated)};` }));
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await page.locator('#message').fill('请调研用于资源测试的协议'); await page.locator('#send').click();
  await expect(page.locator('.result-label')).toHaveText(translated.messages['result.synthetic']);
  const result = [...demo.engine.state.messages.values()].find(message => message.origin === 'research').result;
  await page.locator('details.sources summary').click();
  await expect(page.locator('details.sources summary')).toContainText(`资源·${result.sources.length} 条合成来源与限制`);
  const expectedUrl = `资源·${result.sources[0].url}（测试占位地址，不可作为证据链接）`;
  await expect(page.locator('details.sources .source-url').first()).toHaveText(expectedUrl);
  await expect(page.locator('details.sources a')).toHaveCount(0);
  await expect(page.locator('details.sources .source-title').first()).toHaveText(result.sources[0].title);
  await page.getByRole('button', { name: '查看来源消息与讨论', exact: true }).click();
  await expect(page.locator('.thread-synthetic')).toHaveText(translated.messages['result.synthetic']);
  await expect(page.locator('.thread-sources .source-url').first()).toHaveText(expectedUrl);
  await expect(page.locator('.thread-sources a')).toHaveCount(0);
  await expect(page.locator('.thread-limits strong')).toHaveText(translated.messages['result.limitations']);
  await expect(page.locator('.thread-limits')).toContainText(result.limitations[0]);
});

for (const width of [320, 390, 1280]) test(`expanded presentation resources remain text and keep actions visible at ${width}px`, async ({ page }) => {
  const expanded = structuredClone(catalog);
  expanded.messages['run.unknown'] = `待核对·${'ExpandedStatus'.repeat(10)}<b>普通文本</b>`;
  expanded.messages['error.connection'] = `连接异常·${'ExpandedConnection'.repeat(10)}`;
  expanded.messages['run.cancel.action'] = `取消研究·${'ExpandedCancel'.repeat(5)}`;
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
  const cancel = page.getByRole('button', { name: expanded.messages['run.cancel.action'], exact: true });
  await cancel.scrollIntoViewIfNeeded();
  const bounds = await page.locator('.run').evaluate(node => {
    const box = node.getBoundingClientRect(), label = node.querySelector('.run-state').getBoundingClientRect(), action = node.querySelector('.run-cancel').getBoundingClientRect();
    return { boxLeft: box.left, boxRight: box.right, labelLeft: label.left, labelRight: label.right, actionRight: action.right };
  });
  expect(bounds.labelLeft).toBeGreaterThanOrEqual(bounds.boxLeft); expect(bounds.labelRight).toBeLessThanOrEqual(bounds.boxRight);
  expect(bounds.actionRight).toBeLessThanOrEqual(bounds.boxRight);
  expect(await cancel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
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
