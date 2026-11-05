import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type Action, type Scope } from '../src/contracts.js';
import type { ControlConfig } from '../src/control/state.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const scope = { conversationId: 'pending-room', threadId: 'main' };
const other = { conversationId: 'pending-room', threadId: 'other' };
const authority = { conversationId: 'pending-admin', threadId: 'provisioning' };
interface RecoveryScope extends Scope { outboxKey: string; sendEpoch: string; outboxExpiresAt: number; membershipGeneration: string; permissions: Record<string, number> }
interface Session { scopes: RecoveryScope[] }
const findScope = (session: Session, target: Scope = scope) => {
  const found = session.scopes.find(s => s.conversationId === target.conversationId && s.threadId === target.threadId);
  assert.ok(found); return found;
};
const message = (sendEpoch: string, clientEventId = 'pending-message', target: Scope = scope) => ({ ...target, text: '恢复发送测试', clientEventId, expectedSendEpoch: sendEpoch });

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-pending-recovery-')), path = join(directory, 'state.sqlite');
  const expiresAt = Date.now() + 600000;
  const tokens = { owner: randomBytes(32).toString('hex'), ownerAlias: randomBytes(32).toString('hex'), peer: randomBytes(32).toString('hex'), manager: randomBytes(32).toString('hex') };
  const grant = (memberId: string, target: Scope, actions: Action[], suffix = '') => ({ ...target, id: `${memberId}-${target.conversationId}-${target.threadId}-${suffix}`, memberId, actions, revision: 1, expiresAt, revoked: false });
  const policy = defaultPolicy(); policy.disabledActions = policy.disabledActions.filter(a => a !== 'grant_permissions');
  const config: ControlConfig = {
    members: ['owner', 'peer', 'manager'].map(id => ({ id, name: id, kind: 'human' })),
    tokens: { [tokens.owner]: 'owner', [tokens.ownerAlias]: 'owner', [tokens.peer]: 'peer', [tokens.manager]: 'manager' },
    credentialExpiresAt: { owner: expiresAt, peer: expiresAt, manager: expiresAt },
    memberships: { owner: [scope, other, authority], peer: [scope, other], manager: [authority] },
    grants: [grant('owner', scope, ['read'], 'read'), grant('owner', scope, ['send'], 'send'), grant('owner', other, ['read', 'send']),
      grant('peer', scope, ['read', 'send']), grant('peer', other, ['read']), grant('manager', authority, ['manage_workspace', 'grant_permissions'])],
    researchMemberId: 'peer', sources: fixtureSources, policy,
    conversationCreation: { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource'], maxGrantDurationMs: 300000 },
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const raw = <T = any>(token: string, route: string, body?: unknown) => requestJson<T>(url, token, route, body);
  const api = <T = any>(actor: keyof typeof tokens, route: string, body?: unknown) => raw<T>(tokens[actor], route, body);
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-pending-recovery-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, tokens, api, raw, get engine() { return engine; }, get store() { return store; },
    async restart(restoredBackup = false) {
      await close(service); store.close(); store = new SnapshotStore(path);
      engine = new PrivateEngine(store, config, 10000, Date.now, restoredBackup); service = privateService(engine); url = await listen(service);
    },
  };
}

test('pending recovery key binds credential, actor and exact scope without persisting bearer material', async t => {
  const env = await setup(t), first = await env.api<Session>('owner', '/session'), initial = findScope(first);
  assert.match(initial.sendEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(initial.outboxKey, /^[0-9a-f]{64}$/);
  const alias = findScope(await env.api<Session>('ownerAlias', '/session'));
  assert.notEqual(alias.outboxKey, initial.outboxKey); assert.equal(alias.sendEpoch, initial.sendEpoch);
  assert.notEqual(findScope(first, other).outboxKey, initial.outboxKey);
  // Keep the credential bytes fixed and change only its authenticated actor.
  env.config.tokens[env.tokens.owner] = 'peer';
  const peer = findScope(await env.api<Session>('owner', '/session'));
  assert.notEqual(peer.outboxKey, initial.outboxKey);
  env.config.tokens[env.tokens.owner] = 'owner';
  await expectStatus(env.raw(initial.outboxKey, '/session'), 401, 'invalid_identity');
  await expectStatus(env.raw(initial.outboxKey, '/messages', message(initial.sendEpoch)), 401, 'invalid_identity');
  const serialized = JSON.stringify(env.store.load());
  assert.equal(env.engine.state.snapshot().storageEpoch, initial.sendEpoch);
  for (const secret of [...Object.values(env.tokens), initial.outboxKey, alias.outboxKey, peer.outboxKey]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('outboxKey'), false);
});

test('ordinary restart preserves recovery binding and an uncertain successful send deduplicates', async t => {
  const env = await setup(t), before = findScope(await env.api<Session>('owner', '/session'));
  const body = message(before.sendEpoch), sent = await env.api('owner', '/messages', body);
  await env.restart();
  const after = findScope(await env.api<Session>('owner', '/session'));
  assert.equal(after.sendEpoch, before.sendEpoch); assert.equal(after.outboxKey, before.outboxKey);
  const receipt = await env.api('owner', `/messages/receipt?${new URLSearchParams({ ...scope, clientEventId: body.clientEventId })}`);
  assert.equal(receipt.message.id, sent.message.id);
  const retry = await env.api('owner', '/messages', body);
  assert.equal(retry.duplicate, true); assert.equal(retry.message.id, sent.message.id);
  assert.equal(env.engine.state.messages.size, 1);
  const legacy = { ...scope, text: '兼容旧客户端', clientEventId: 'legacy' };
  assert.equal((await env.api('owner', '/messages', legacy)).duplicate, false);
});

test('an unsent reply attachment keeps its recovery binding across restart and deduplicates after acceptance', async t => {
  const env = await setup(t), before = findScope(await env.api<Session>('owner', '/session'));
  const source = await env.api('owner', '/messages', message(before.sendEpoch, 'reply-source'));
  const body = { ...message(before.sendEpoch, 'unsent-reply'), expectedMembershipGeneration: before.membershipGeneration,
    replyToMessageId: source.message.id, attachment: { name: 'restart.md', text: 'restart attachment content' } };
  const receiptPath = `/messages/receipt?${new URLSearchParams({ ...scope, clientEventId: body.clientEventId })}`;
  await env.restart();
  const after = findScope(await env.api<Session>('owner', '/session'));
  assert.equal(after.outboxKey, before.outboxKey); assert.equal(after.sendEpoch, before.sendEpoch);
  assert.equal(after.membershipGeneration, before.membershipGeneration);
  assert.equal((await env.api('owner', receiptPath)).message, null);
  assert.equal(env.engine.state.messages.size, 1);
  const sent = await env.api('owner', '/messages', body);
  assert.equal(sent.duplicate, false); assert.equal(sent.message.replyToMessageId, source.message.id);
  await env.restart();
  const receipt = await env.api('owner', receiptPath), retry = await env.api('owner', '/messages', body);
  assert.equal(receipt.message.id, sent.message.id); assert.equal(retry.message.id, sent.message.id);
  assert.equal(retry.duplicate, true); assert.equal(env.engine.state.messages.size, 2);
  assert.equal(retry.message.text, body.text); assert.equal(retry.message.replyToMessageId, body.replyToMessageId);
  const attachment = await env.api('owner', `/attachments?${new URLSearchParams({ ...scope, messageId: sent.message.id, expectedMembershipGeneration: before.membershipGeneration })}`);
  assert.equal(attachment.attachment.name, body.attachment.name); assert.equal(attachment.text, body.attachment.text);
});

test('restored backup rotates recovery binding and refuses old-epoch sends before deduplication', async t => {
  const env = await setup(t), before = findScope(await env.api<Session>('owner', '/session'));
  const body = message(before.sendEpoch); await env.api('owner', '/messages', body);
  await env.restart(true);
  const after = findScope(await env.api<Session>('owner', '/session'));
  assert.notEqual(after.sendEpoch, before.sendEpoch); assert.notEqual(after.outboxKey, before.outboxKey);
  await expectStatus(env.api('owner', '/messages', body), 409, 'send_epoch_conflict');
  await expectStatus(env.api('owner', '/messages', message(before.sendEpoch, 'not-previously-sent')), 409, 'send_epoch_conflict');
  assert.equal(env.engine.state.messages.size, 1);
  const reconciled = await env.api('owner', '/messages', { ...body, expectedSendEpoch: after.sendEpoch });
  assert.equal(reconciled.duplicate, true);
  await env.restart();
  assert.equal(findScope(await env.api<Session>('owner', '/session')).outboxKey, after.outboxKey);
});

test('recovery access follows read and credential deadlines while expired send still permits receipt lookup', async t => {
  const env = await setup(t), before = findScope(await env.api<Session>('owner', '/session'));
  const body = message(before.sendEpoch); const sent = await env.api('owner', '/messages', body);
  const read = env.config.grants.find(g => g.id.endsWith('-main-read'))!, send = env.config.grants.find(g => g.id.endsWith('-main-send'))!;
  read.expiresAt = Date.now() + 90000; env.config.credentialExpiresAt!.owner = Date.now() + 60000;
  send.expiresAt = Date.now() - 1;
  const readonly = findScope(await env.api<Session>('owner', '/session'));
  assert.equal(readonly.permissions.send, 0); assert.equal(readonly.outboxKey, before.outboxKey);
  assert.equal(readonly.outboxExpiresAt, env.config.credentialExpiresAt!.owner);
  read.expiresAt = Date.now() + 30000;
  assert.equal(findScope(await env.api<Session>('owner', '/session')).outboxExpiresAt, read.expiresAt);
  const receipt = await env.api('owner', `/messages/receipt?${new URLSearchParams({ ...scope, clientEventId: body.clientEventId })}`);
  assert.equal(receipt.message.id, sent.message.id);
  await expectStatus(env.api('owner', '/messages', { ...body, expectedSendEpoch: 'wrong' }), 403, 'scope_denied');
  read.revoked = true;
  const hidden = await env.api<Session>('owner', '/session');
  assert.equal(hidden.scopes.some(s => s.threadId === scope.threadId), false);
  assert.equal(JSON.stringify(hidden).includes(before.outboxKey), false);
  env.config.credentialExpiresAt!.owner = Date.now() - 1;
  await expectStatus(env.api('owner', '/session'), 401, 'credential_expired');
  await expectStatus(env.api('owner', '/messages', { ...body, expectedSendEpoch: 'wrong' }), 401, 'credential_expired');
});

test('remove and rejoin rotates only membership-bound recovery key and rejects an old membership send', async t => {
  const env = await setup(t);
  const { conversation } = await env.api('manager', '/conversations', {
    kind: 'group', title: 'Pending membership fixture', memberIds: ['manager', 'owner'], clientEventId: 'create-group',
    initialGrants: [{ targetMemberId: 'manager', actions: ['manage_resource'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'owner', actions: ['read', 'send'], expiresAt: Date.now() + 240000 }],
  });
  const target = { conversationId: conversation.conversationId, threadId: conversation.threadId };
  const before = findScope(await env.api<Session>('owner', '/session'), target);
  const unaffected = findScope(await env.api<Session>('owner', '/session'));
  await env.api('manager', '/memberships/remove', { ...target, targetMemberId: 'owner', expectedRevision: 1, clientEventId: 'remove' });
  assert.equal((await env.api<Session>('owner', '/session')).scopes.some(s => s.conversationId === target.conversationId), false);
  await env.api('manager', '/memberships/add', { ...target, targetMemberId: 'owner', expectedRevision: 2, clientEventId: 'rejoin', grant: { actions: ['read', 'send'], expiresAt: Date.now() + 180000 } });
  const after = findScope(await env.api<Session>('owner', '/session'), target);
  assert.notEqual(after.membershipGeneration, before.membershipGeneration); assert.notEqual(after.outboxKey, before.outboxKey);
  assert.equal(after.sendEpoch, before.sendEpoch);
  assert.equal(findScope(await env.api<Session>('owner', '/session')).outboxKey, unaffected.outboxKey);
  const body = { ...message(before.sendEpoch, 'membership-send', target), expectedMembershipGeneration: before.membershipGeneration };
  await expectStatus(env.api('owner', '/messages', body), 409, 'membership_generation_conflict');
  assert.equal((await env.api('owner', '/messages', { ...body, expectedMembershipGeneration: after.membershipGeneration })).duplicate, false);
  await env.restart(); assert.equal(findScope(await env.api<Session>('owner', '/session'), target).outboxKey, after.outboxKey);
});

test('failed storage writes roll back epoch changes and message receipts without changing the recovery key', async t => {
  const env = await setup(t), before = findScope(await env.api<Session>('owner', '/session'));
  const save = env.store.save.bind(env.store), body = message(before.sendEpoch);
  env.store.save = () => { throw new ApiError(507, 'trial_storage_limit'); };
  try {
    assert.throws(() => env.engine.commit(() => env.engine.state.resetDelivery()), (error: unknown) => error instanceof ApiError && error.code === 'trial_storage_limit');
    assert.equal(env.engine.state.sendEpoch(), before.sendEpoch);
    await expectStatus(env.api('owner', '/messages', body), 507, 'trial_storage_limit');
    assert.equal(env.engine.state.messages.size, 0);
  } finally { env.store.save = save; }
  await env.restart();
  const after = findScope(await env.api<Session>('owner', '/session'));
  assert.equal(after.outboxKey, before.outboxKey); assert.equal(after.sendEpoch, before.sendEpoch);
  assert.equal((await env.api('owner', `/messages/receipt?${new URLSearchParams({ ...scope, clientEventId: body.clientEventId })}`)).message, null);
  assert.equal((await env.api('owner', '/messages', body)).duplicate, false);
  assert.equal((await env.api('owner', '/messages', body)).duplicate, true);
  assert.equal(env.engine.state.messages.size, 1);
});
