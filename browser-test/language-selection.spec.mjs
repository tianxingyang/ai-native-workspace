import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import catalog from '../web/locales/zh-CN.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo;
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await demo.stop(); });

// Only intercept a bundled module in this test. No synthetic language ships in the registry.
const synthetic = structuredClone(catalog);
synthetic.locale = 'en-GB';
for (const key of Object.keys(synthetic.messages)) synthetic.messages[key] = `SyntheticLongPresentation · ${synthetic.messages[key]}`;
delete synthetic.messages['connect.help'];
async function resources(page, testCatalog = synthetic) {
  await page.route('**/locales/registry.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    import demo from './zh-CN.js';
    export const fallbackId = 'zh-CN';
    export const catalogs = [{id:'zh-CN', label:'Existing demo', catalog:demo},
      {id:'synthetic', label:'Synthetic test resource', catalog:${JSON.stringify(testCatalog)}}];` }));
}
async function select(page, id) {
  await page.evaluate(async id => (await import('/presentation.js')).presentation.select(id), id);
}
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('the unchanged demo has no language choice and rejects arbitrary remote catalogs', async ({ page }) => {
  await page.goto(demo.url);
  await expect(page.locator('#connect [data-language]')).toBeHidden();
  expect(await page.evaluate(async () => {
    const { presentation } = await import('/presentation.js');
    try { presentation.select('https://example.test/en.js'); return false; } catch { return presentation.id === 'zh-CN'; }
  })).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

for (const width of [320, 390]) test(`language selection preserves content, draft, caret and connection at ${width}px`, async ({ page }) => {
  await resources(page); await page.setViewportSize({ width, height: 900 });
  await page.goto(demo.url);
  await page.locator('#connect [data-language]').selectOption('synthetic');
  await expect(page.locator('#credential-help')).toHaveText(catalog.messages['connect.help']);
  await expect(page.locator('#credential-help')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#app')).toBeVisible();
  const content = '原始 <script>不可翻译</script> {name}';
  await page.locator('#message').fill(content); await page.locator('#send').click();
  await expect(page.locator('.message-text').filter({ hasText: content })).toHaveCount(1);
  const timestamp = await page.locator('.message time').first().getAttribute('datetime');
  const permissions = structuredClone(demo.engine.state.config.grants);
  const draft = 'draft 未提交 <&> 保留';
  await page.locator('#message').fill(draft);
  await page.locator('#message').evaluate(node => { node.focus(); node.setSelectionRange(2, 7, 'backward'); });
  const requests = []; page.on('request', request => { if (request.method() === 'POST') requests.push(request.url()); });
  await select(page, 'zh-CN');
  await expect(page.locator('#message')).toHaveValue(draft); await expect(page.locator('#message')).toBeFocused();
  expect(await page.locator('#message').evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 7, 'backward']);
  await expect(page.locator('.message-text').filter({ hasText: content })).toHaveCount(1);
  expect(await page.locator('.message time').first().getAttribute('datetime')).toBe(timestamp);
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  expect(demo.engine.state.config.grants).toEqual(permissions);
  await select(page, 'synthetic');
  await expect(page.locator('#connection-status')).toHaveText(synthetic.messages['connection.connected']);
  await expect(page.locator('#message')).toHaveValue(draft);
  expect(requests.filter(url => !url.endsWith('/messages/read'))).toEqual([]);
  expect(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => {
    const rect = node.getBoundingClientRect(); return rect.width && rect.right > innerWidth + 1;
  }).slice(0, 12).map(node => ({ tag: node.tagName, id: node.id, class: node.className, right: node.getBoundingClientRect().right })))).toEqual([]);
  const time = page.locator('.message time').first();
  expect(await time.getAttribute('title')).toBe(new Intl.DateTimeFormat('en-GB', catalog.formats.dateTime).format(new Date(timestamp)));
});

test('switching keeps a management form and its focused controls intact', async ({ page }) => {
  const config = demo.engine.state.config, authority = { conversationId: '产品讨论', threadId: '日常交流' };
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  await resources(page); await connect(page);
  await page.locator('#create-conversation').click();
  await page.locator('#conversation-title').fill('不变的用户标题');
  await page.locator('#conversation-kind').selectOption('direct');
  const date = page.locator('#management-fields input[type=datetime-local]');
  const deadline = await date.inputValue();
  await page.locator('#conversation-title').focus();
  await select(page, 'synthetic');
  await expect(page.locator('#conversation-title')).toHaveValue('不变的用户标题');
  await expect(page.locator('#conversation-title')).toBeFocused();
  await expect(page.locator('#conversation-kind')).toHaveValue('direct');
  await expect(date).toHaveValue(deadline);
  await expect(page.locator('#conversation-kind option[value=direct]')).toHaveText(synthetic.messages['management.direct']);
  await expect(page.locator('#management-title')).toHaveText(synthetic.messages['management.create']);
});

test('switching preserves the same pending send and never retries it', async ({ page }) => {
  await resources(page); await connect(page);
  const submitted = [];
  await page.route(url => url.pathname === '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted.push(route.request().postDataJSON()); await route.abort('failed');
  });
  await page.locator('#message').fill('仍待确认的正文'); await page.locator('#send').click();
  const check = page.locator('[data-action=check-receipt]'); await expect(check).toBeVisible(); await check.focus();
  await select(page, 'synthetic');
  await expect(check).toBeFocused(); await expect(check).toHaveText(synthetic.messages['send.check']);
  await expect(page.locator('#message')).toHaveValue('仍待确认的正文');
  await expect(page.locator('[data-action=pending-status]')).toHaveText(synthetic.messages['error.connection']);
  expect(submitted).toHaveLength(1); expect(demo.engine.state.messages.size).toBe(0);
  await select(page, 'zh-CN'); await expect(check).toHaveText(catalog.messages['send.check']);
  expect(submitted).toHaveLength(1);
});

test('desktop locks shared resources to the compiled language and fails closed on mismatch', async ({ page }) => {
  await resources(page);
  await page.addInitScript(() => { window.__TAURI__ = {
    core: { invoke: async command => command === 'desktop_presentation' ? { locale: 'zh-CN', selection: 'rebuild' } : { kind: 'none' } },
    event: { listen: async () => () => {} },
  }; });
  await page.goto(demo.url); await expect(page.locator('#connect [data-language]')).toBeHidden();
  expect(await page.evaluate(async () => { const { presentation } = await import('/presentation.js'); try { presentation.select('synthetic'); return false; } catch { return presentation.id === 'zh-CN'; } })).toBe(true);
  await page.addInitScript(() => { window.__TAURI__.core.invoke = async () => ({ locale: 'unregistered', selection: 'rebuild' }); });
  await page.reload(); await expect(page.locator('#connect-button')).toBeDisabled();
  await expect(page.locator('#connect-error')).toHaveText(catalog.messages['language.unavailable']);
});

test('switching while reading history neither marks unread messages read nor restores cleared content', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  for (let i = 0; i < 40; i++) demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `历史原文 ${i}`, `language-history-${i}`));
  await resources(page); await connect(page);
  await expect(page.locator('.message')).toHaveCount(40);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', scope)).toBe([...demo.engine.state.messages.values()].at(-1).id);
  await page.locator('#timeline').evaluate(node => { node.scrollTop = 400; node.focus(); });
  const read = demo.engine.state.readPosition('demo-owner', scope);
  for (let i = 0; i < 15; i++) demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, `未读原文 ${i}`, `language-unread-${i}`));
  await expect(page.locator('.message')).toHaveCount(55);
  const reads = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/messages/read') reads.push(request.url()); });
  await select(page, 'synthetic');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#timeline')).toBeFocused();
  expect(demo.engine.state.readPosition('demo-owner', scope)).toBe(read); expect(reads).toEqual([]);
  await page.locator('#logout').click();
  await select(page, 'zh-CN'); await select(page, 'synthetic');
  await expect(page.locator('#messages')).toBeEmpty(); await expect(page.locator('#rooms')).toBeEmpty();
  for (const id of ['thread-title', 'members-count', 'scope-note', 'send-label', 'send-help', 'announcement', 'change-save']) await expect(page.locator(`#${id}`)).toBeEmpty();
  await expect(page.locator('body')).not.toContainText('历史原文'); await expect(page.locator('body')).not.toContainText('未读原文');
});

test('language selection cannot repopulate fixed scope or editor slots after reading access ends', async ({ page }) => {
  const config = demo.engine.state.config, authority = { conversationId: '产品讨论', threadId: '日常交流' };
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  await resources(page); await connect(page);
  await page.locator('#message').fill('待清理的编辑正文'); await page.locator('#send').click();
  await page.locator('[data-action^="edit-"]').click();
  await expect(page.locator('#change-text')).toHaveValue('待清理的编辑正文');
  await select(page, 'synthetic');
  await page.locator('#change-close').click();
  await select(page, 'zh-CN');
  await expect(page.locator('#change-save')).toBeEmpty();
  for (const grant of config.grants.filter(grant => grant.memberId === 'demo-owner')) grant.actions = grant.conversationId === authority.conversationId ? ['manage_workspace', 'grant_permissions'] : [];
  await expect(page.locator('#management-empty')).toBeVisible();
  await select(page, 'synthetic'); await select(page, 'zh-CN');
  for (const id of ['messages', 'thread-title', 'members-count', 'scope-note', 'send-label', 'send-help', 'announcement', 'change-save']) await expect(page.locator(`#${id}`)).toBeEmpty();
  await expect(page.locator('#change-text')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('待清理的编辑正文');
});

test('localized day labels cannot merge timestamp-based message groups', async ({ page }) => {
  const scope = { conversationId: '产品讨论', threadId: '日常交流' };
  demo.engine.commit(() => {
    const yesterday = demo.engine.state.createMessage('demo-researcher', scope, '前一天原文', 'language-day-1').message;
    yesterday.createdAt = Date.now() - 24 * 60 * 60 * 1000;
    demo.engine.state.createMessage('demo-researcher', scope, '当天原文', 'language-day-2');
  });
  const collision = structuredClone(synthetic);
  collision.messages['date.today'] = collision.messages['date.yesterday'] = 'Synthetic same display label';
  await resources(page, collision); await connect(page);
  const dividers = page.locator('.day-divider:not(.unread-divider)');
  await expect(dividers).toHaveCount(2);
  const times = await page.locator('.message time').evaluateAll(nodes => nodes.map(node => node.dateTime));
  await select(page, 'synthetic');
  await expect(dividers).toHaveCount(2); await expect(dividers).toHaveText(['Synthetic same display label', 'Synthetic same display label']);
  expect(await page.locator('.message time').evaluateAll(nodes => nodes.map(node => node.dateTime))).toEqual(times);
});

for (const width of [320, 390]) test(`thread creation and parent navigation retain scoped drafts across language selection at ${width}px`, async ({ page }) => {
  await resources(page); await page.setViewportSize({ width, height: 900 }); await connect(page);
  await page.locator('#message').fill('父会话未发送草稿');
  await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('设计 <原始标题>');
  await page.locator('#thread-create-name').evaluate(node => { node.focus(); node.setSelectionRange(1, 4); });
  const submissions = [];
  page.on('request', request => { if (request.method() === 'POST') submissions.push(request); });
  await select(page, 'synthetic');
  await expect(page.locator('#thread-create-name')).toHaveValue('设计 <原始标题>'); await expect(page.locator('#thread-create-name')).toBeFocused();
  expect(await page.locator('#thread-create-name').evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([1, 4]);
  await expect(page.locator('#thread-create-parent')).toHaveText(synthetic.messages['threads.parent'].replace('{title}', '产品讨论'));
  await expect(page.locator('#thread-create-save')).toHaveText(synthetic.messages['threads.submit']);
  expect(submissions).toHaveLength(0);
  await page.locator('#thread-create-save').click(); await expect(page.locator('#thread-create')).not.toBeVisible();
  await expect(page.locator('#room-title')).toHaveText('设计 <原始标题>'); await expect(page.locator('#room-title')).toBeFocused();
  await page.locator('#message').fill('线程未发送草稿');
  await page.locator('#parent-thread').focus(); await select(page, 'zh-CN');
  await expect(page.locator('#parent-thread')).toBeFocused(); await expect(page.locator('#parent-thread')).toHaveText('返回所属会话：产品讨论');
  await select(page, 'synthetic');
  await expect(page.locator('#parent-thread')).toHaveText(synthetic.messages['threads.back'].replace('{title}', '产品讨论'));
  await expect(page.locator('#scope-note')).toHaveText(synthetic.messages['threads.scopeNote']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#parent-thread').click(); await expect(page.locator('#message')).toHaveValue('父会话未发送草稿');
  await page.locator('#back').click();
  const child = page.locator('#rooms .child-thread');
  await expect(child).toHaveAttribute('aria-label', `设计 <原始标题> ${synthetic.messages['threads.inParent'].replace('{title}', '产品讨论')}`);
  await child.click(); await expect(page.locator('#message')).toHaveValue('线程未发送草稿');
  expect(submissions.filter(request => new URL(request.url()).pathname === '/threads')).toHaveLength(1);
});

test('language selection preserves an uncertain thread request and cannot restore it after revocation', async ({ page }) => {
  await resources(page); await connect(page);
  const bodies = []; let drop = true;
  await page.route('**/threads', async route => {
    bodies.push(route.request().postDataJSON());
    if (drop) { drop = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await page.locator('#create-thread').click(); await page.locator('#thread-create-name').fill('请求参数不变');
  await page.locator('#thread-create-save').click(); await expect(page.locator('#thread-create-status')).toHaveText(catalog.messages['threads.uncertain']);
  await page.locator('#thread-create-save').focus(); await select(page, 'synthetic');
  await expect(page.locator('#thread-create-save')).toBeFocused(); await expect(page.locator('#thread-create-save')).toHaveText(synthetic.messages['threads.retry']);
  await expect(page.locator('#thread-create-status')).toHaveText(synthetic.messages['threads.uncertain']);
  await expect(page.locator('#thread-create-name')).toBeDisabled(); expect(bodies).toHaveLength(1);
  await page.locator('#thread-create-save').click(); await expect(page.locator('#room-title')).toHaveText('请求参数不变');
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  expect(demo.engine.state.snapshot().threads.threads).toHaveLength(1);
  demo.engine.state.config.grants.find(grant => grant.memberId === 'demo-owner' && grant.conversationId === '产品讨论').revoked = true;
  await expect(page.locator('#room-title')).toHaveText('研发讨论'); await expect(page.locator('#rooms')).not.toContainText('请求参数不变');
  await select(page, 'zh-CN'); await select(page, 'synthetic');
  await expect(page.locator('#rooms')).not.toContainText('请求参数不变'); await expect(page.locator('#thread-create-parent')).toBeEmpty();
  await expect(page.locator('#parent-thread')).toBeHidden(); expect(bodies).toHaveLength(2);
});
