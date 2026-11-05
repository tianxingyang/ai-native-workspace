import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo;
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
const file = (text = '<script>window.executed=true</script>\n# ordinary text', name = 'notes.md') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
test.beforeEach(async () => { demo = await startWebDemo(); });
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page) {
  await page.goto(demo.url); await page.locator('#token').fill(demo.ownerToken); await page.locator('#connect-button').click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
}
function seed() {
  return demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, 'attachment caption', 'fixture', undefined, 'initial', { name: 'notes.md', text: 'private attachment body' })).message;
}
async function forward(route) {
  try { return await route.fetch(); } catch { throw new Error('Attachment forwarding failed; credentials omitted.'); }
}

for (const width of [1280, 390]) test(`send, preview literal text, edit caption and retract attachment at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await connect(page);
  await page.locator('#attachment-file').setInputFiles(file()); await expect(page.locator('#attachment-name')).toContainText('notes.md');
  await expect(page.locator('#send')).toBeDisabled();
  await page.locator('#message').fill('File for the discussion'); await page.locator('#send').click();
  await expect(page.locator('.attachment-link')).toHaveCount(1); await expect(page.locator('#attachment-draft')).toBeHidden();
  await page.getByRole('button', { name: '编辑消息', exact: true }).click(); await page.locator('#change-text').fill('Updated caption'); await page.locator('#change-save').click();
  await expect(page.locator('#message-change')).not.toBeVisible(); await page.locator('.attachment-link').click();
  await expect(page.locator('#attachment-content')).toHaveText(file().buffer.toString()); expect(await page.evaluate(() => window.executed)).toBeUndefined();
  await expect(page.locator('#attachment-content script')).toHaveCount(0);
  expect(await page.locator('#attachment-view').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.getElementById('attachment-view').contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Alt+ArrowDown'); await expect(page.locator('#room-title')).toHaveText(scope.conversationId);
  await page.keyboard.press('Escape'); await expect(page.locator('.attachment-link')).toBeFocused();
  await page.getByRole('button', { name: '撤回消息', exact: true }).click(); await page.locator('#change-save').click();
  await expect(page.locator('.attachment-link')).toHaveCount(0); await expect(page.locator('#attachment-content')).toHaveText('');
});

test('lost send response reconciles the same attachment without a duplicate', async ({ page }) => {
  let posts = 0;
  await page.route(url => url.pathname === '/messages', async route => { posts++; await forward(route); await route.abort('failed'); });
  await connect(page); await page.locator('#attachment-file').setInputFiles(file('only one copy'));
  await expect(page.locator('#attachment-name')).toContainText('notes.md'); await page.locator('#message').fill('one attachment'); await page.locator('#send').click();
  await expect(page.locator('[data-action="retry-send"]')).toBeEnabled(); await page.locator('[data-action="retry-send"]').click();
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('.attachment-link')).toHaveCount(1);
  expect(posts).toBe(1); expect(demo.engine.state.snapshot().attachments).toHaveLength(1);
});

test('invalid UTF-8, binary controls, unsupported extensions and oversized files are rejected locally', async ({ page }) => {
  await connect(page);
  for (const input of [{ ...file(), buffer: Buffer.from([0xc3, 0x28]) }, file('binary\0'), file('text', 'image.svg'), file('x'.repeat(8193))]) {
    await page.locator('#attachment-file').setInputFiles(input); await expect(page.locator('#attachment-error')).not.toBeEmpty();
    await expect(page.locator('#attachment-draft')).toBeHidden();
  }
  await page.locator('#attachment-file').setInputFiles(file('\ufeffvalid BOM text')); await expect(page.locator('#attachment-name')).toContainText('notes.md');
  await page.locator('#attachment-remove').click(); await expect(page.locator('#attachment-draft')).toBeHidden();
  expect(demo.engine.state.messages.size).toBe(0);
});

test('late local file read cannot cross a conversation switch', async ({ page }) => {
  await connect(page);
  await page.evaluate(() => { const read = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function () { return new Promise(resolve => { window.releaseFile = async () => resolve(await read.call(this)); }); }; });
  await page.locator('#attachment-file').setInputFiles(file('late private file'));
  await page.getByRole('button', { name: '研发讨论 插件协议' }).click(); await page.evaluate(() => window.releaseFile());
  await expect(page.locator('#attachment-draft')).toBeHidden(); await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await expect(page.locator('#attachment-draft')).toBeHidden();
});

test('a held successful preview is discarded after source retraction', async ({ page }) => {
  const message = seed(); let held;
  await page.route(url => url.pathname === '/attachments', async route => { const response = await forward(route); held = () => route.fulfill({ response }); });
  await connect(page); await page.locator('.attachment-link').click(); await expect.poll(() => Boolean(held)).toBe(true);
  demo.engine.commit(() => demo.engine.changeMessage('demo-owner', message.id, 'retract', 1, 'withdraw'));
  await expect(page.locator('#attachment-view')).not.toBeVisible(); await held();
  await expect(page.locator('#attachment-content')).toHaveText(''); await expect(page.locator('.attachment-link')).toHaveCount(0);
});

test('attachment read denial clears only its scope even when sync is offline', async ({ page }) => {
  seed(); let offline = false;
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => offline ? route.abort('failed') : route.continue());
  await page.route(url => url.pathname === '/attachments', async route => {
    offline = true; demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).revoked = true;
    const response = await forward(route); expect(response.status()).toBe(403); await route.fulfill({ response });
  });
  await connect(page); await page.getByRole('button', { name: '研发讨论 插件协议' }).click(); await page.getByRole('button', { name: '产品讨论 日常交流' }).click();
  await page.locator('.attachment-link').click(); await expect(page.locator('#attachment-view')).not.toBeVisible();
  await expect(page.locator('#room-title')).toHaveText('研发讨论'); await expect(page.locator('#attachment-content')).toHaveText('');
  await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0); await expect(page.locator('#connect')).toBeHidden();
});

test('known read expiry clears an open preview during an outage', async ({ page }) => {
  seed(); demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).expiresAt = Date.now() + 4000;
  await connect(page); await page.locator('.attachment-link').click(); await expect(page.locator('#attachment-content')).toHaveText('private attachment body');
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => route.abort('failed'));
  await expect(page.locator('#attachment-view')).not.toBeVisible(); await expect(page.locator('#attachment-content')).toHaveText('');
});

for (const status of [401, 403]) test(`late attachment ${status} still invalidates access after preview closes`, async ({ page }) => {
  seed(); let held, offline = false;
  await page.route(url => ['/session', '/sync'].includes(url.pathname), route => offline ? route.abort('failed') : route.continue());
  await page.route(url => url.pathname === '/attachments', async route => {
    if (status === 401) demo.engine.state.config.credentialExpiresAt['demo-owner'] = Date.now() - 1;
    else demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).revoked = true;
    offline = true; const response = await forward(route); expect(response.status()).toBe(status); held = () => route.fulfill({ response });
  });
  await connect(page); await page.locator('.attachment-link').click(); await expect.poll(() => Boolean(held)).toBe(true);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '研发讨论 插件协议' }).click(); await held();
  await expect(page.locator('#attachment-content')).toHaveText('');
  if (status === 401) await expect(page.locator('#connect')).toBeVisible();
  else { await expect(page.getByRole('button', { name: '产品讨论 日常交流' })).toHaveCount(0); await expect(page.locator('#room-title')).toHaveText('研发讨论'); }
});

test('preview close restores focus after timeline rerender and retraction uses a visible fallback', async ({ page }) => {
  const message = seed(); await connect(page); await page.locator('.attachment-link').click();
  demo.engine.commit(() => demo.engine.state.createMessage('demo-owner', scope, 'arrived while previewing', 'later'));
  await expect(page.locator('.message-text').last()).toHaveText('arrived while previewing');
  await page.keyboard.press('Escape'); await expect(page.locator('.attachment-link')).toBeFocused();
  await page.locator('.attachment-link').click(); demo.engine.commit(() => demo.engine.changeMessage('demo-owner', message.id, 'retract', 1, 'retract-focus'));
  await expect(page.locator('#attachment-view')).not.toBeVisible(); await expect(page.locator('#timeline')).toBeFocused();
});

test('file chooser binds the initiating conversation before an automatic permission switch', async ({ page }) => {
  await connect(page);
  const choosing = page.waitForEvent('filechooser'); await page.locator('#attach').click(); const chooser = await choosing;
  demo.engine.state.config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === scope.conversationId).revoked = true;
  await expect(page.locator('#room-title')).toHaveText('研发讨论');
  await chooser.setFiles(file('private file for the previous discussion'));
  await expect(page.locator('#attachment-draft')).toBeHidden(); await expect(page.locator('#attach')).toBeEnabled();
});

test('generation replacement releases a hung local file read before its result arrives', async ({ page }) => {
  const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: scope, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 180000 };
  for (const id of ['demo-owner', 'demo-researcher']) config.grants.find(g => g.memberId === id && g.conversationId === scope.conversationId).actions.push('manage_workspace', 'grant_permissions');
  const conversation = demo.engine.commit(() => demo.engine.state.createConversation('demo-owner', { kind: 'group', title: 'Generation file test', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'generation-room', initialGrants: [
    { targetMemberId: 'demo-owner', actions: ['read', 'send'], expiresAt: Date.now() + 120000 },
    { targetMemberId: 'demo-researcher', actions: ['manage_resource'], expiresAt: Date.now() + 120000 },
  ] })).conversation;
  await connect(page); await page.getByRole('button', { name: 'Generation file test main', exact: true }).click();
  await page.evaluate(() => { const read = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function () { return new Promise(resolve => { window.releaseFile = async () => resolve(await read.call(this)); }); }; });
  await page.locator('#message').fill('old draft'); await page.locator('#attachment-file').setInputFiles(file('old generation file'));
  await expect(page.locator('#send')).toBeDisabled();
  await page.route('**/sync?**', route => route.abort('failed'));
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', conversation, 1, 'remove-file-reader'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', conversation, 2, 'rejoin-file-reader', { actions: ['read', 'send'], expiresAt: Date.now() + 100000 }));
  await expect(page.locator('#message')).toHaveValue(''); await expect(page.locator('#attach')).toBeEnabled();
  await page.locator('#message').fill('new generation draft'); await expect(page.locator('#send')).toBeEnabled();
  await page.evaluate(() => window.releaseFile()); await expect(page.locator('#attachment-draft')).toBeHidden();
});

test('logout clears attachment draft metadata from the hidden DOM', async ({ page }) => {
  await connect(page); await page.locator('#attachment-file').setInputFiles(file('draft secret', 'private-name.txt'));
  await expect(page.locator('#attachment-name')).toContainText('private-name.txt'); await page.locator('#logout').click();
  await expect(page.locator('#attachment-name')).toHaveText(''); await expect(page.locator('#attachment-content')).toHaveText('');
});
