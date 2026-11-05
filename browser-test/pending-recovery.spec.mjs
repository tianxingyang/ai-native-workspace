import { test, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';
import { requestJson } from '../dist/src/http.js';
import { defaultPolicy } from '../dist/src/control/authorization.js';

let demo, scope;
const authority = { conversationId: '产品讨论', threadId: '日常交流' };
test.beforeEach(async () => {
  demo = await startWebDemo(); const config = demo.engine.state.config;
  config.policy = defaultPolicy(); config.policy.disabledActions = config.policy.disabledActions.filter(action => action !== 'grant_permissions');
  config.conversationCreation = { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 240000 };
  config.grants.find(g => g.memberId === 'demo-owner' && g.conversationId === authority.conversationId).actions.push('manage_workspace', 'grant_permissions');
  scope = (await requestJson(demo.url, demo.ownerToken, '/conversations', { kind: 'group', title: '恢复发送', memberIds: ['demo-owner', 'demo-researcher'], clientEventId: 'recovery-group',
    initialGrants: ['demo-owner', 'demo-researcher'].map(targetMemberId => ({ targetMemberId, actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 180000 })) })).conversation;
});
test.afterEach(async ({ page }) => { await page.close(); await demo.stop(); });
async function connect(page, token = demo.ownerToken, navigate = true) {
  if (navigate) await page.goto(demo.url);
  await page.locator('#token').fill(token); await page.locator('#connect-button').click(); await expect(page.locator('#connect')).toBeHidden();
  await page.getByRole('button', { name: '恢复发送 main', exact: true }).click();
  await expect(page.locator('#send-help')).toBeVisible();
}
async function stored(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('coseat-pending-v1', 1); open.onerror = reject;
    open.onsuccess = () => { const db = open.result, tx = db.transaction('pending'), get = tx.objectStore('pending').getAll();
      get.onsuccess = () => resolve(get.result); get.onerror = reject; tx.oncomplete = () => db.close(); };
  }));
}
async function pending(page, text = '刷新后仍能核对的消息') {
  await page.locator('#message').fill(text); await page.locator('#send').click(); await expect(page.locator('#outbox [data-action=retry-send]')).toBeVisible();
}
test('encrypted unsent intent survives reload and only an explicit retry sends it', async ({ page }) => {
  const bodies = []; let drop = true;
  await page.route('**/messages', async route => { bodies.push(route.request().postDataJSON()); if (drop) { drop = false; await route.abort('failed'); } else await route.continue(); });
  await connect(page); await pending(page);
  const rows = await stored(page); expect(rows).toHaveLength(1);
  const serialized = JSON.stringify(rows); expect(serialized).not.toContain('刷新后'); expect(serialized).not.toContain(scope.conversationId); expect(serialized).not.toContain(demo.ownerToken);
  expect(Object.keys(rows[0]).sort()).toEqual(['ciphertext', 'expiresAt', 'id', 'iv', 'slot']);
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeVisible(); await expect(page.locator('#message')).toHaveValue('刷新后仍能核对的消息');
  expect(bodies).toHaveLength(1);
  await page.locator('#outbox [data-action=retry-send]').click(); await expect(page.locator('#outbox')).toBeEmpty();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(await stored(page)).toHaveLength(0);
});
test('accepted send with lost response recovers its current receipt after reload without another POST', async ({ page }) => {
  let sent = 0;
  await page.route('**/messages', async route => { sent++; await route.fetch(); await route.abort('failed'); });
  await connect(page); await pending(page, '已送达但没有确认');
  expect(await stored(page)).toHaveLength(1);
  const message = [...demo.engine.state.messages.values()].find(m => m.text === '已送达但没有确认');
  demo.engine.commit(() => demo.engine.changeMessage('demo-owner', message.id, 'edit', 1, 'later-edit', '另一设备已更新'));
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('.message-text')).toContainText('另一设备已更新'); await expect(page.locator('#outbox')).toBeEmpty();
  expect(sent).toBe(1); await expect.poll(async () => (await stored(page)).length).toBe(0);
});
test('a recovered attachment and reply retain the original send identity', async ({ page }) => {
  const source = (await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: scope.conversationId, threadId: scope.threadId, text: '回复来源', clientEventId: 'source' })).message;
  let drop = true; const bodies = [];
  await page.route('**/messages', async route => { bodies.push(route.request().postDataJSON()); if (drop) { drop = false; await route.abort('failed'); } else await route.continue(); });
  await connect(page); await page.locator(`[data-action="reply-${source.id}"]`).click();
  await page.locator('#attachment-file').setInputFiles({ name: 'restore.txt', mimeType: 'text/plain', buffer: Buffer.from('恢复的文本附件') });
  await pending(page, '带附件的回复'); await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeVisible();
  await page.locator('#outbox [data-action=retry-send]').click(); await expect(page.locator('#outbox')).toBeEmpty();
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(bodies[1].replyToMessageId).toBe(source.id);
  expect(bodies[1].attachment).toEqual({ name: 'restore.txt', text: '恢复的文本附件' });
});
test('storage failure stops HTTP transmission and retains an honest pending state', async ({ page }) => {
  let sent = 0; await page.route('**/messages', route => { sent++; return route.continue(); });
  await connect(page); await expect(page.locator('#message')).toBeEnabled();
  await page.evaluate(() => { indexedDB.open = () => { throw new Error('unavailable'); }; });
  await pending(page, '磁盘失败不能发送'); await expect(page.locator('#outbox')).toContainText('本次未发出请求'); expect(sent).toBe(0);
});
test('another credential cannot restore the encrypted intent, while the original credential still can', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '只属于原身份');
  const otherToken = Object.entries(demo.engine.state.config.tokens).find(([, actor]) => actor === 'demo-researcher')[0];
  await page.reload(); await connect(page, otherToken, false); await expect(page.locator('#message')).toBeEnabled();
  await expect(page.locator('#message')).toHaveValue(''); await expect(page.locator('#outbox')).toBeEmpty();
  await page.reload(); await connect(page, demo.ownerToken, false); await expect(page.locator('#message')).toHaveValue('只属于原身份');
});
test('logout clears the observed encrypted intent and reconnect does not revive it', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page);
  await page.locator('#logout').click(); await expect.poll(async () => (await stored(page)).length).toBe(0);
  await connect(page, demo.ownerToken, false); await expect(page.locator('#message')).toBeEnabled(); await expect(page.locator('#outbox')).toBeEmpty();
});
test('membership replacement cannot restore the old-generation encrypted send', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '旧成员代际的发送');
  await page.reload();
  const config = demo.engine.state.config;
  config.grants.push({ ...authority, id: 'recovery-rejoin-source', memberId: 'demo-researcher', actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
  demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'remove'));
  demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'rejoin', { actions: ['read', 'send'], expiresAt: Date.now() + 120000 }));
  await connect(page, demo.ownerToken, false); await expect(page.locator('#message')).toBeEnabled();
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('#message')).toHaveValue('');
});
test('logout during encryption fences a late save and sends no HTTP request', async ({ page }) => {
  let sent = 0; await page.route('**/messages', route => { sent++; return route.continue(); });
  await connect(page); await expect(page.locator('#message')).toBeEnabled();
  await page.evaluate(() => { const original = crypto.subtle.encrypt.bind(crypto.subtle); window.encryptArrived = false;
    crypto.subtle.encrypt = async (...args) => { window.encryptArrived = true; await new Promise(resolve => { window.releaseEncrypt = resolve; }); return original(...args); }; });
  await page.locator('#message').fill('迟到加密不可复活'); await page.locator('#send').click(); await expect.poll(() => page.evaluate(() => window.encryptArrived)).toBe(true);
  await page.locator('#logout').click(); await page.evaluate(() => window.releaseEncrypt());
  await expect(page.locator('#connect')).toBeVisible(); await expect.poll(async () => (await stored(page)).length).toBe(0); expect(sent).toBe(0);
});

test('read revocation clears an observed record while other conversations remain usable', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '撤权后清理');
  demo.engine.state.config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, memberId: 'demo-owner', id: 'deny-recovery', revision: 1, actions: ['read'], effect: 'deny', revoked: false, expiresAt: demo.expiresAt });
  await expect(page.getByRole('button', { name: '恢复发送 main', exact: true })).toHaveCount(0);
  await expect(page.locator('#outbox')).toBeEmpty(); await expect.poll(async () => (await stored(page)).length).toBe(0);
  await expect(page.locator('#connect')).toBeHidden();
});
test('a delayed decrypt cannot restore a pending message into a closed connection', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '解密迟到不显示');
  await page.reload();
  await page.evaluate(() => { const original = crypto.subtle.decrypt.bind(crypto.subtle); window.decryptArrived = false;
    crypto.subtle.decrypt = async (...args) => { window.decryptArrived = true; await new Promise(resolve => { window.releaseDecrypt = resolve; }); return original(...args); }; });
  await connect(page, demo.ownerToken, false); await expect.poll(() => page.evaluate(() => window.decryptArrived)).toBe(true);
  await page.locator('#logout').click(); await page.evaluate(() => window.releaseDecrypt());
  await expect(page.locator('#connect')).toBeVisible(); await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#outbox')).toBeEmpty(); await expect.poll(async () => (await stored(page)).length).toBe(0);
});
test('reconnection uses server expiry even after the local clock jumps forward', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '时钟校正不能丢失');
  await page.addInitScript(() => { const actual = Date.now.bind(Date); Date.now = () => actual() + 3600000; });
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#message')).toHaveValue('时钟校正不能丢失'); await expect(page.locator('#outbox [data-action=retry-send]')).toBeVisible();
  expect(await stored(page)).toHaveLength(1);
});
test('a shorter credential deadline clears observed pending content even while offline', async ({ page }) => {
  await page.route('**/messages', route => route.abort('failed')); await connect(page); await pending(page, '短凭据期限');
  const expiry = Date.now() + 2500;
  demo.engine.state.config.credentialExpiresAt['demo-owner'] = expiry;
  await page.waitForResponse(async response => response.url().endsWith('/session') && response.status() === 200
    && (await response.json()).scopes.some(item => item.outboxExpiresAt === expiry));
  await page.route('**/session', route => route.abort('failed')); await page.route('**/sync?**', route => route.abort('failed'));
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('#message')).toHaveValue('');
  await expect.poll(async () => (await stored(page)).length).toBe(0);
});
test('cancelling a rejected reply waits for durable deletion and remains retryable after storage failure', async ({ page }) => {
  const source = (await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: scope.conversationId, threadId: scope.threadId, text: '即将撤回的来源', clientEventId: 'source' })).message;
  let requests = 0;
  await page.route('**/messages', async route => {
    if (++requests === 1) demo.engine.commit(() => demo.engine.changeMessage('demo-owner', source.id, 'retract', 1, 'withdraw-source'));
    await route.continue();
  });
  await connect(page); await page.locator(`[data-action="reply-${source.id}"]`).click(); await pending(page, '可取消的回复');
  await expect(page.locator('#outbox [data-action=cancel-reply]')).toBeVisible();
  await page.evaluate(() => { window.originalOpen = indexedDB.open.bind(indexedDB); indexedDB.open = () => { throw new Error('unavailable'); }; });
  await page.locator('#outbox [data-action=cancel-reply]').click(); await expect(page.locator('#outbox')).toContainText('尚未取消');
  await expect(page.locator('#message')).toBeDisabled(); expect(requests).toBe(1);
  await page.evaluate(() => { indexedDB.open = window.originalOpen; });
  expect(await stored(page)).toHaveLength(1); await page.locator('#outbox [data-action=cancel-reply]').click();
  await expect(page.locator('#outbox')).toBeEmpty(); expect(await stored(page)).toHaveLength(0);
  await page.locator('#send').click(); await expect(page.locator('#outbox')).toBeEmpty(); expect(requests).toBe(2);
});
test('send permission loss still permits recovery and receipt checking but never automatic resend', async ({ page }) => {
  let requests = 0; await page.route('**/messages', route => { requests++; return route.abort('failed'); });
  await connect(page); await pending(page, '只读时核对'); await page.reload();
  demo.engine.state.config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, memberId: 'demo-owner', id: 'deny-send-recovery', revision: 1, actions: ['send'], effect: 'deny', revoked: false, expiresAt: demo.expiresAt });
  await connect(page, demo.ownerToken, false); await expect(page.locator('#outbox [data-action=check-receipt]')).toBeVisible();
  await expect(page.locator('#outbox [data-action=retry-send]')).toHaveCount(0); await expect(page.locator('#message')).toHaveValue('只读时核对');
  expect(requests).toBe(1); expect(await stored(page)).toHaveLength(1);
});
test('send loss during a held save exposes receipt checking immediately even when sync is offline', async ({ page }) => {
  let requests = 0; await page.route('**/messages', route => { requests++; return route.continue(); });
  await connect(page); await expect(page.locator('#message')).toBeEnabled();
  await page.evaluate(() => { const original = crypto.subtle.encrypt.bind(crypto.subtle); window.encryptArrived = false;
    crypto.subtle.encrypt = async (...args) => { window.encryptArrived = true; await new Promise(resolve => { window.releaseEncrypt = resolve; }); return original(...args); }; });
  await page.locator('#message').fill('保存期间失去发言权'); await page.locator('#send').click(); await expect.poll(() => page.evaluate(() => window.encryptArrived)).toBe(true);
  demo.engine.state.config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, memberId: 'demo-owner', id: 'held-save-deny', revision: 1, actions: ['send'], effect: 'deny', revoked: false, expiresAt: demo.expiresAt });
  await expect(page.locator('#composer')).toHaveClass(/is-readonly/);
  await page.route('**/session', route => route.abort('failed')); await page.route('**/sync?**', route => route.abort('failed'));
  await page.evaluate(() => window.releaseEncrypt());
  await expect(page.locator('#outbox [data-action=check-receipt]')).toBeVisible(); await expect(page.locator('#outbox [data-action=retry-send]')).toHaveCount(0);
  expect(requests).toBe(0); expect(await stored(page)).toHaveLength(1);
});

test('reload before the durable save commits sends nothing and does not promise draft recovery', async ({ page }) => {
  let requests = 0; await page.route('**/messages', route => { requests++; return route.continue(); });
  await connect(page); await expect(page.locator('#message')).toBeEnabled();
  await page.evaluate(() => {
    window.encryptArrived = false;
    crypto.subtle.encrypt = async () => { window.encryptArrived = true; return new Promise(() => {}); };
  });
  await page.locator('#message').fill('保存提交前中断'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => window.encryptArrived)).toBe(true);
  expect(await stored(page)).toHaveLength(0); expect(requests).toBe(0);
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#message')).toBeEnabled(); await expect(page.locator('#message')).toHaveValue('');
  await expect(page.locator('#outbox')).toBeEmpty(); expect(requests).toBe(0);
  expect([...demo.engine.state.messages.values()].some(message => message.text === '保存提交前中断')).toBe(false);
});

test('reload after durable commit but before POST recovers the original id and waits for explicit retry', async ({ page }) => {
  const bodies = []; await page.route('**/messages', route => { bodies.push(route.request().postDataJSON()); return route.continue(); });
  await connect(page); await expect(page.locator('#message')).toBeEnabled();
  await page.evaluate(async () => {
    const { PendingStore } = await import('/pending-store.js'), save = PendingStore.prototype.save;
    window.saveCommitted = false;
    PendingStore.prototype.save = async function (...args) {
      await save.apply(this, args); window.saveCommitted = true; await new Promise(() => {});
    };
  });
  await page.locator('#message').fill('提交后请求前中断'); await page.locator('#send').click();
  await expect.poll(() => page.evaluate(() => window.saveCommitted)).toBe(true);
  const [record] = await stored(page); expect(record).toBeTruthy(); expect(bodies).toHaveLength(0);
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeEnabled();
  await expect(page.locator('#message')).toHaveValue('提交后请求前中断'); expect(bodies).toHaveLength(0);
  await page.locator('#outbox [data-action=check-receipt]').click();
  await expect(page.locator('#outbox [data-action=check-receipt]')).toBeEnabled(); expect(bodies).toHaveLength(0);
  await page.locator('#outbox [data-action=retry-send]').click(); await expect(page.locator('#outbox')).toBeEmpty();
  expect(bodies).toHaveLength(1); expect(bodies[0].clientEventId).toBe(record.id);
  expect([...demo.engine.state.messages.values()].filter(message => message.text === '提交后请求前中断')).toHaveLength(1);
  await expect.poll(async () => (await stored(page)).length).toBe(0);
});

test('accepted reply attachment survives failed local acknowledgement cleanup without a second message', async ({ page }) => {
  const source = (await requestJson(demo.url, demo.ownerToken, '/messages', { conversationId: scope.conversationId, threadId: scope.threadId, text: '持久回执来源', clientEventId: 'ack-source' })).message;
  const bodies = []; await page.route('**/messages', route => { bodies.push(route.request().postDataJSON()); return route.continue(); });
  await connect(page); await page.locator(`[data-action="reply-${source.id}"]`).click();
  await page.evaluate(async () => {
    const { PendingStore } = await import('/pending-store.js');
    PendingStore.prototype.remove = async () => { throw new Error('pending_storage_unavailable'); };
  });
  await page.locator('#attachment-file').setInputFiles({ name: 'receipt.md', mimeType: 'text/markdown', buffer: Buffer.from('回执附件内容') });
  await page.locator('#message').fill('回执清理失败仍只发送一次'); await page.locator('#send').click();
  await expect(page.locator('#message')).toHaveValue(''); await expect(page.locator('#outbox')).toBeEmpty();
  const [record] = await stored(page); expect(record.id).toBe(bodies[0].clientEventId);
  const sent = [...demo.engine.state.messages.values()].find(message => message.text === bodies[0].text);
  expect(sent.replyToMessageId).toBe(source.id);
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#message')).toBeEnabled(); await expect(page.locator('#outbox')).toBeEmpty();
  await expect.poll(async () => (await stored(page)).length).toBe(0); expect(bodies).toHaveLength(1);
  expect([...demo.engine.state.messages.values()].filter(message => message.text === bodies[0].text)).toHaveLength(1);
  const attachment = await requestJson(demo.url, demo.ownerToken, `/attachments?${new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId, messageId: sent.id, expectedMembershipGeneration: bodies[0].expectedMembershipGeneration })}`);
  expect(attachment.attachment.name).toBe('receipt.md'); expect(attachment.text).toBe('回执附件内容');
});

async function recoveryThread(title, event) {
  return (await requestJson(demo.url, demo.ownerToken, '/threads', {
    conversationId: scope.conversationId, threadId: scope.threadId, title, clientEventId: event,
    expectedMembershipGeneration: demo.engine.state.membershipGeneration('demo-owner', scope),
  })).thread;
}
async function selectRecoveryThread(page, title) {
  await page.getByRole('button', { name: `${title} 讨论线程 · 恢复发送`, exact: true }).click();
  await expect(page.locator('#room-title')).toHaveText(title);
}

test('parent and sibling pending sends recover independently and retry only the selected thread payload', async ({ page }) => {
  const first = await recoveryThread('恢复甲', 'recovery-thread-a'), second = await recoveryThread('恢复乙', 'recovery-thread-b');
  const source = (await requestJson(demo.url, demo.ownerToken, '/messages', {
    conversationId: first.conversationId, threadId: first.threadId, text: '线程回复来源', clientEventId: 'thread-reply-source',
    expectedMembershipGeneration: demo.engine.state.membershipGeneration('demo-owner', first),
  })).message;
  const bodies = []; let drop = true;
  await page.route('**/messages', route => { bodies.push(route.request().postDataJSON()); return drop ? route.abort('failed') : route.continue(); });
  await connect(page); await pending(page, '父会话待确认');
  await selectRecoveryThread(page, '恢复甲'); await page.locator(`[data-action="reply-${source.id}"]`).click();
  await page.locator('#attachment-file').setInputFiles({ name: 'thread.txt', mimeType: 'text/plain', buffer: Buffer.from('只属于甲线程的附件') });
  await pending(page, '甲线程待确认');
  await selectRecoveryThread(page, '恢复乙'); await pending(page, '乙线程待确认');
  const records = await stored(page); expect(records).toHaveLength(3); expect(new Set(records.map(row => row.slot)).size).toBe(3);
  expect(bodies).toHaveLength(3); expect(new Set(bodies.map(body => body.clientEventId)).size).toBe(3);
  await page.reload(); await connect(page, demo.ownerToken, false);
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeEnabled(); await expect(page.locator('#message')).toHaveValue('父会话待确认');
  await selectRecoveryThread(page, '恢复乙'); await expect(page.locator('#message')).toHaveValue('乙线程待确认');
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeEnabled();
  await selectRecoveryThread(page, '恢复甲'); await expect(page.locator('#message')).toHaveValue('甲线程待确认');
  await expect(page.locator('#outbox [data-action=retry-send]')).toBeEnabled(); expect(bodies).toHaveLength(3);
  drop = false; await page.locator('#outbox [data-action=retry-send]').click(); await expect(page.locator('#outbox')).toBeEmpty();
  expect(bodies).toHaveLength(4); expect(bodies[3]).toEqual(bodies[1]); expect(bodies[3].replyToMessageId).toBe(source.id);
  expect(bodies[3].attachment).toEqual({ name: 'thread.txt', text: '只属于甲线程的附件' });
  await expect.poll(async () => (await stored(page)).length).toBe(2);
  const messages = [...demo.engine.state.messages.values()];
  expect(messages.filter(message => message.text === '甲线程待确认').map(message => message.threadId)).toEqual([first.threadId]);
  expect(messages.some(message => ['父会话待确认', '乙线程待确认'].includes(message.text))).toBe(false);
  expect((await stored(page)).map(row => row.id).sort()).toEqual([bodies[0].clientEventId, bodies[2].clientEventId].sort());
  await selectRecoveryThread(page, '恢复乙'); await expect(page.locator('#message')).toHaveValue('乙线程待确认');
  expect(bodies[2].threadId).toBe(second.threadId);
});

for (const change of ['read-revoked', 'membership-rejoined']) test(`parent ${change} clears observed child pending content without resending`, async ({ page }) => {
  const child = await recoveryThread('父会话授权恢复', 'parent-authority-recovery'), bodies = [];
  await page.route('**/messages', route => { bodies.push(route.request().postDataJSON()); return route.abort('failed'); });
  await connect(page); await selectRecoveryThread(page, '父会话授权恢复'); await pending(page, '旧父会话授权的待确认消息');
  expect(await stored(page)).toHaveLength(1);
  if (change === 'read-revoked') {
    demo.engine.state.config.grants.push({ conversationId: scope.conversationId, threadId: scope.threadId, memberId: 'demo-owner',
      id: 'deny-parent-recovery', revision: 1, actions: ['read'], effect: 'deny', revoked: false, expiresAt: demo.expiresAt });
    await expect(page.getByRole('button', { name: '父会话授权恢复 讨论线程 · 恢复发送', exact: true })).toHaveCount(0);
    // Read and send are independent permissions: read loss denies receipt lookup,
    // while this client clears the intent instead of attempting another send.
    const query = new URLSearchParams({ conversationId: child.conversationId, threadId: child.threadId, clientEventId: bodies[0].clientEventId });
    await expect(requestJson(demo.url, demo.ownerToken, `/messages/receipt?${query}`)).rejects.toMatchObject({ status: 403 });
  } else {
    demo.engine.state.config.grants.push({ ...authority, id: 'child-recovery-rejoin-source', memberId: 'demo-researcher',
      actions: ['manage_workspace', 'grant_permissions'], revision: 1, expiresAt: demo.expiresAt, revoked: false });
    demo.engine.commit(() => demo.engine.removeScopeMember('demo-researcher', 'demo-owner', scope, 1, 'remove-child-owner'));
    demo.engine.commit(() => demo.engine.addScopeMember('demo-researcher', 'demo-owner', scope, 2, 'rejoin-child-owner', { actions: ['read', 'send'], expiresAt: Date.now() + 120000 }));
    await expect(page.locator('#message')).toBeEnabled();
    expect(demo.engine.state.membershipGeneration('demo-owner', child)).not.toBe(bodies[0].expectedMembershipGeneration);
    await expect(requestJson(demo.url, demo.ownerToken, '/messages', bodies[0])).rejects.toMatchObject({ status: 409, code: 'membership_generation_conflict' });
  }
  await expect(page.locator('#outbox')).toBeEmpty(); await expect(page.locator('#message')).toHaveValue('');
  await expect.poll(async () => (await stored(page)).length).toBe(0); expect(bodies).toHaveLength(1);
  expect([...demo.engine.state.messages.values()].some(message => message.text === '旧父会话授权的待确认消息')).toBe(false);
});
