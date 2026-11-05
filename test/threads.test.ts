import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, Message, Scope } from '../src/contracts.js';
import type { ControlConfig } from '../src/control/state.js';
import type { DiscussionThread } from '../src/control/threads.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { fixtureResult } from '../src/worker/fake.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const parent = { conversationId: 'group', threadId: 'main' }, other = { conversationId: 'other', threadId: 'main' };
const authority = { conversationId: 'authority', threadId: 'provision' };
const scopeOf = ({ conversationId, threadId }: Scope) => ({ conversationId, threadId });
const route = (path: string, scope: Scope) => `${path}?${new URLSearchParams(scopeOf(scope))}`;
const collaboration: Action[] = ['read', 'send', 'claim', 'request_approval', 'cancel'];
type Created = { thread: DiscussionThread; duplicate: boolean };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-threads-')), path = join(directory, 'state.sqlite');
  const ids = ['owner', 'reader', 'worker', 'member', 'admin', 'outsider', 'issuer'], expiresAt = Date.now() + 600000;
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString('hex')]));
  const grant = (memberId: string, scope: Scope, actions: Action[]) => ({ ...scope, id: `${memberId}-${scope.conversationId}`, memberId, actions, revision: 1, expiresAt, revoked: false });
  const policy = defaultPolicy(); policy.disabledActions = policy.disabledActions.filter(action => action !== 'grant_permissions');
  const config: ControlConfig = {
    members: ids.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(ids.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(ids.map(id => [id, expiresAt])),
    memberships: Object.fromEntries(ids.map(id => [id, id === 'outsider' ? [other] : [parent, authority]])),
    grants: [grant('owner', parent, [...collaboration, 'manage_resource']), grant('owner', other, ['read', 'send']), grant('reader', parent, ['read']),
      grant('worker', parent, collaboration), grant('admin', parent, ['manage_resource']), grant('outsider', other, ['read', 'send']), grant('issuer', authority, ['manage_workspace', 'grant_permissions', 'read', 'send'])],
    researchMemberId: 'worker', sources: fixtureSources, policy,
    conversationCreation: { authorityScope: authority, allowedActions: [...collaboration, 'manage_resource'], maxGrantDurationMs: 300000 },
  };
  config.memberships.owner!.push(other);
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, path: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, path, body, undefined, headers);
  const input = (id = 'thread-create', scope = parent) => ({ ...scopeOf(scope), title: 'Discussion', clientEventId: id, expectedMembershipGeneration: engine.state.membershipGeneration('owner', scope) });
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-threads-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, api, input, get engine() { return engine; },
    create: (body = input(), actor = 'owner') => api<Created>(actor, '/threads', body),
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('thread creation and discovery require current per-action parent grants, never membership or management alone', async t => {
  const env = await setup(t), before = structuredClone(env.config);
  for (const actor of ['reader', 'member', 'admin', 'outsider']) await expectStatus(env.create(env.input(`denied-${actor}`), actor), 403);
  const { thread } = await env.create();
  assert.deepEqual(env.config, before); assert.deepEqual(thread.parent, parent); assert.notEqual(thread.threadId, parent.threadId);
  const session = await env.api('reader', '/session'), visible = session.scopes.find((scope: Scope) => scope.threadId === thread.threadId);
  assert.equal(visible.kind, 'thread'); assert.equal(visible.title, 'Discussion'); assert.deepEqual(visible.parent, parent);
  assert.equal(visible.canLeave, false); assert.equal(visible.createThreadUntil, 0); assert.equal(visible.permissions.send, 0);
  await expectStatus(env.api('member', route('/messages', thread)), 403);
  await expectStatus(env.api('admin', route('/messages', thread)), 403);
  await expectStatus(env.api('outsider', route('/sync', thread)), 403);
  assert.equal((await env.create(env.input('agent-thread'), 'worker')).thread.createdBy, 'worker');
  env.config.grants.push({ ...env.config.grants[0]!, id: 'read-deny', actions: ['read'], effect: 'deny' });
  await expectStatus(env.create(), 403);
  await expectStatus(env.api('owner', route('/messages', thread)), 403);
  assert.equal((await env.api('owner', '/session')).scopes.some((scope: Scope) => scope.threadId === thread.threadId), false);
});

test('thread scopes cannot mint descendants, independent membership, management or high-risk authority', async t => {
  const env = await setup(t), { thread } = await env.create();
  await expectStatus(env.create(env.input('descendant', thread)), 403);
  await expectStatus(env.create(env.input('authority-thread', authority), 'issuer'), 403);
  await expectStatus(env.api('owner', route('/memberships', thread)), 403);
  for (const action of ['manage_resource', 'manage_workspace', 'grant_permissions', 'external_send', 'permanent_delete', 'continuous_run'] as Action[]) assert.equal(env.engine.state.authorization('owner', action, thread).allowed, false);
  for (const path of ['/memberships/add', '/memberships/remove']) await expectStatus(env.api('owner', path, { ...scopeOf(thread), targetMemberId: 'worker', expectedRevision: 1, clientEventId: path }), 403);
  await assert.rejects(env.api('owner', '/memberships/leave', { ...scopeOf(thread), expectedMembershipGeneration: 'initial', clientEventId: 'child-leave' }));
  for (const extra of [{ grants: [] }, { memberIds: ['owner'] }, { private: true }, { parent: other }]) await expectStatus(env.create({ ...env.input('injected'), ...extra }), 400);
  assert.deepEqual(env.engine.state.membershipGeneration('worker', parent), 'initial');
  assert.equal((await env.api('owner', '/session')).management.scopes.some((scope: Scope) => scope.threadId === thread.threadId), false);
});

test('concurrent creation, immutable retries and transaction rollback persist one result without granting permissions', async t => {
  const env = await setup(t), input = env.input(), before = env.engine.state.snapshot();
  const save = env.engine.store.save.bind(env.engine.store); env.engine.store.save = () => { throw new Error('synthetic disk failure'); };
  try { await expectStatus(env.create(input), 500); } finally { env.engine.store.save = save; }
  assert.deepEqual(env.engine.state.snapshot().threads, before.threads);
  assert.equal(env.engine.state.memberScopes('owner').filter(scope => scope.conversationId === parent.conversationId).length, 1);
  const results = await Promise.all([env.create(input), env.create(input), env.create(input)]);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(results.map(result => result.thread.threadId)).size, 1);
  const first = results[0]!;
  await expectStatus(env.create({ ...input, title: 'Conflict' }), 409);
  await expectStatus(env.create({ ...input, ...other }), 409);
  await env.restart(); const replay = await env.create(input);
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.thread, first.thread);
  env.config.grants.find(grant => grant.id === 'owner-group')!.revoked = true;
  await expectStatus(env.create(input), 403);
  await expectStatus(env.api('owner', route('/messages', first.thread)), 403);
  await env.restart(); await expectStatus(env.create(input), 403);
});

test('source provenance is an authorized live parent message reference, never copied source content', async t => {
  const env = await setup(t);
  const send = (scope: Scope, clientEventId: string) => env.api<{ message: Message }>('owner', '/messages', { ...scopeOf(scope), text: `private source ${clientEventId}`, clientEventId });
  const source = (await send(parent, 'parent-message')).message, foreign = (await send(other, 'other-message')).message;
  await expectStatus(env.create({ ...env.input('foreign-source'), sourceMessageId: foreign.id } as ReturnType<typeof env.input>), 404);
  const request = { ...env.input(), sourceMessageId: source.id }, { thread } = await env.create(request);
  assert.equal(thread.sourceMessageId, source.id); assert.equal(JSON.stringify(thread).includes(source.text), false);
  assert.equal((await env.api('owner', route('/messages', thread))).messages.length, 0);
  await env.api('owner', `/messages/${source.id}/edit`, { expectedRevision: 1, clientEventId: 'source-edit', text: 'Updated parent source', expectedMembershipGeneration: 'initial' });
  assert.equal((await env.api('owner', route('/messages', parent))).messages[0].text, 'Updated parent source');
  await env.api('owner', `/messages/${source.id}/retract`, { expectedRevision: 2, clientEventId: 'source-retract', expectedMembershipGeneration: 'initial' });
  await expectStatus(env.create({ ...request, clientEventId: 'withdrawn-source' }), 404);
  assert.equal(JSON.stringify((await env.api('owner', '/session')).scopes).includes(source.text), false);
});

test('thread messages, reply targets, cursors and personal read positions remain scope isolated through restart', async t => {
  const env = await setup(t), a = (await env.create()).thread, b = (await env.create(env.input('second'))).thread;
  const send = (scope: Scope, id: string, replyToMessageId?: string) => env.api<{ message: Message }>('owner', '/messages', { ...scopeOf(scope), text: id, clientEventId: id, expectedMembershipGeneration: 'initial', ...(replyToMessageId ? { replyToMessageId } : {}) });
  const parentMessage = (await send(parent, 'parent-text')).message, first = (await send(a, 'first-thread-text')).message, second = (await send(b, 'second-thread-text')).message;
  await expectStatus(send(a, 'foreign-parent-reply', parentMessage.id), 404);
  await expectStatus(send(a, 'foreign-sibling-reply', second.id), 404);
  const reply = (await send(a, 'in-thread-reply', first.id)).message;
  const initial = await env.api('owner', route('/sync', a));
  assert.deepEqual(initial.messages.map((message: Message) => message.id), [first.id, reply.id]);
  await expectStatus(env.api('owner', `${route('/sync', b)}&cursor=${encodeURIComponent(initial.cursor)}`), 400);
  await env.api('owner', '/read-position', { ...scopeOf(a), messageId: reply.id, expectedMembershipGeneration: 'initial' });
  await expectStatus(env.api('owner', '/read-position', { ...scopeOf(b), messageId: reply.id, expectedMembershipGeneration: 'initial' }), 404);
  await env.restart();
  assert.equal((await env.api('owner', route('/sync', a))).readThroughMessageId, reply.id);
  assert.equal((await env.api('reader', route('/sync', a))).readThroughMessageId, null);
  assert.equal((await env.api('owner', route('/sync', b))).readThroughMessageId, null);
  assert.deepEqual((await env.api('owner', route('/messages', parent))).messages.map((message: Message) => message.id), [parentMessage.id]);
  assert.equal((await env.api('owner', `${route('/sync', a)}&cursor=${encodeURIComponent(initial.cursor)}`)).reset, false);
});

test('parent membership removal invalidates child work and rejoin cannot revive old generation, receipts or read position', async t => {
  const env = await setup(t), expiresAt = Date.now() + 240000;
  const { conversation } = await env.api('issuer', '/conversations', { kind: 'group', title: 'Dynamic parent', memberIds: ['owner', 'worker', 'issuer'], clientEventId: 'dynamic-group',
    initialGrants: [{ targetMemberId: 'owner', actions: [...collaboration, 'manage_resource'], expiresAt }, { targetMemberId: 'worker', actions: collaboration, expiresAt }, { targetMemberId: 'issuer', actions: ['manage_resource'], expiresAt }] });
  const createdInput = env.input('dynamic-thread', conversation), { thread } = await env.create(createdInput);
  const { message } = await env.api('worker', '/messages', { ...scopeOf(thread), text: 'worker ordinary message', clientEventId: 'worker-child', expectedMembershipGeneration: 'initial' });
  await env.api('worker', '/read-position', { ...scopeOf(thread), messageId: message.id, expectedMembershipGeneration: 'initial' });
  await env.api('owner', '/messages', { ...scopeOf(thread), text: '请调研一下线程授权', clientEventId: 'research-thread', expectedMembershipGeneration: 'initial' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'thread-device' });
  assert.equal(delivery.command, 'execute'); assert.deepEqual(delivery.work.route, scopeOf(thread));
  const beforeContext = env.engine.state.contextRevision(thread);
  await env.api('owner', '/memberships/remove', { ...scopeOf(conversation), targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'remove-worker' });
  assert.ok(env.engine.state.contextRevision(thread) > beforeContext);
  const run = env.engine.state.runs.get(delivery.runId)!; assert.equal(run.status, 'unknown'); assert.ok(run.invalidatedBy);
  await expectStatus(env.api('worker', route('/messages', thread)), 403);
  const headers = { 'x-coseat-instance': 'thread-device', 'x-coseat-lease': delivery.leaseId };
  await expectStatus(env.api('worker', '/tools/send', { runId: delivery.runId, result: fixtureResult() }, headers), 409);
  await env.api('issuer', '/memberships/add', { ...scopeOf(conversation), targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'rejoin-worker', grant: { actions: collaboration, expiresAt } });
  const generation = env.engine.state.membershipGeneration('worker', thread);
  assert.notEqual(generation, 'initial'); assert.equal(generation, env.engine.state.membershipGeneration('worker', conversation));
  assert.equal((await env.api('worker', route('/sync', thread))).readThroughMessageId, null);
  await expectStatus(env.api('worker', '/messages', { ...scopeOf(thread), text: 'worker ordinary message', clientEventId: 'worker-child', expectedMembershipGeneration: 'initial' }), 409);
  await expectStatus(env.api('worker', '/read-position', { ...scopeOf(thread), messageId: message.id, expectedMembershipGeneration: 'initial' }), 409);
  await expectStatus(env.create({ ...createdInput, clientEventId: 'old-create' }, 'worker'), 409);
  await env.restart();
  assert.equal(env.engine.state.membershipGeneration('worker', thread), generation);
  assert.throws(() => env.engine.state.publish('worker', delivery.runId, fixtureResult()));
  assert.equal([...env.engine.state.messages.values()].some(item => item.origin === 'research'), false);
});

test('child execution binds current parent grants and revocation, denial, expiry or policy changes fence old results', async t => {
  for (const change of ['revoked', 'deny', 'expired', 'revision', 'policy'] as const) {
    const env = await setup(t), { thread } = await env.create();
    await env.api('owner', '/messages', { ...scopeOf(thread), text: '请调研一下权限失效', clientEventId: 'research', expectedMembershipGeneration: 'initial' });
    const delivery = await env.api('worker', '/worker/poll', { instanceId: 'device' });
    assert.equal(delivery.command, 'execute'); assert.deepEqual(delivery.work.route, scopeOf(thread));
    assert.ok(delivery.work.authorization.grants.every((binding: { id: string }) => binding.id === 'worker-group'));
    const parentGrant = env.config.grants.find(grant => grant.id === 'worker-group')!;
    if (change === 'revoked') parentGrant.revoked = true;
    if (change === 'deny') env.config.grants.push({ ...parentGrant, id: 'worker-denied', actions: ['send'], effect: 'deny' });
    if (change === 'expired') parentGrant.expiresAt = Date.now() - 1;
    if (change === 'revision') parentGrant.revision++;
    if (change === 'policy') env.config.policy!.version++;
    assert.throws(() => env.engine.state.publish('worker', delivery.runId, fixtureResult()));
    const audit = env.engine.state.audit.at(-1)!;
    assert.equal(audit.allowed, false); assert.deepEqual(audit.resource, scopeOf(thread));
    assert.equal([...env.engine.state.messages.values()].some(message => message.origin === 'research'), false);
  }
});

test('revoking dynamic parent issuance authority immediately hides its child threads and fences bound results', async t => {
  const env = await setup(t), expiresAt = Date.now() + 240000;
  const { conversation } = await env.api('issuer', '/conversations', { kind: 'group', title: 'Delegated parent', memberIds: ['owner', 'worker'], clientEventId: 'delegated-group',
    initialGrants: [{ targetMemberId: 'owner', actions: ['read', 'send'], expiresAt }, { targetMemberId: 'worker', actions: collaboration, expiresAt }] });
  const { thread } = await env.create(env.input('delegated-thread', conversation));
  await env.api('owner', '/messages', { ...scopeOf(thread), text: '请调研一下委托来源撤销', clientEventId: 'delegated-research', expectedMembershipGeneration: 'initial' });
  const run = [...env.engine.state.runs.values()][0]!;
  assert.ok(run); assert.deepEqual(run.work.route, scopeOf(thread));
  assert.equal(env.engine.state.authorization('worker', 'read', thread).allowed, true);
  env.config.grants.find(grant => grant.id === 'issuer-authority')!.revoked = true;
  for (const scope of [conversation, thread]) {
    await expectStatus(env.api('owner', route('/messages', scope)), 403);
    await expectStatus(env.api('worker', route('/sync', scope)), 403);
  }
  assert.equal((await env.api('owner', '/session')).scopes.some((scope: Scope) => scope.conversationId === conversation.conversationId), false);
  assert.throws(() => env.engine.state.publish('worker', run.id, fixtureResult()));
  await env.restart();
  await expectStatus(env.api('owner', route('/messages', thread)), 403);
  assert.throws(() => env.engine.state.publish('worker', run.id, fixtureResult()));
  assert.equal([...env.engine.state.messages.values()].some(message => message.origin === 'research'), false);
});

test('unknown restored thread authorization fails closed and invalidates the original work policy digest', async t => {
  const env = await setup(t), { thread } = await env.create();
  await env.api('owner', '/messages', { ...scopeOf(thread), text: '请调研一下授权版本恢复', clientEventId: 'version-research', expectedMembershipGeneration: 'initial' });
  const run = [...env.engine.state.runs.values()][0]!;
  assert.ok(run); const originalDigest = run.work.authorization!.policyDigest;
  const saved = env.engine.store.load<{ state: ReturnType<typeof env.engine.state.snapshot>; leases: unknown[] }>()!;
  const restoredThread = saved.state.threads.threads.find(item => item.threadId === thread.threadId)!;
  Object.assign(restoredThread, { authorization: 'unrecognized-future-policy' });
  env.engine.store.save(saved); await env.restart();
  const decision = env.engine.state.authorization('owner', 'read', thread);
  assert.equal(decision.allowed, false); assert.equal(decision.reason, 'policy_disabled'); assert.notEqual(decision.policyDigest, originalDigest);
  assert.equal(env.engine.state.authorization('owner', 'read', parent).allowed, true);
  await expectStatus(env.api('owner', route('/messages', thread)), 403);
  assert.equal((await env.api('owner', '/session')).scopes.some((scope: Scope) => scope.threadId === thread.threadId), false);
  const restoredRun = env.engine.state.runs.get(run.id)!;
  assert.throws(() => env.engine.state.authorizeRunGrant('worker', restoredRun, ['send']), /policy_revision_changed/);
  assert.throws(() => env.engine.state.publish('worker', run.id, fixtureResult()), /policy_revision_changed/);
  assert.equal([...env.engine.state.messages.values()].some(message => message.origin === 'research'), false);
});
