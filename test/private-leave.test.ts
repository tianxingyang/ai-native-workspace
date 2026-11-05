import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, type Action, type Scope } from '../src/contracts.js';
import type { ControlConfig } from '../src/control/state.js';
import type { Conversation, ConversationInput } from '../src/control/conversations.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { fixtureResult } from '../src/worker/fake.js';
import { LocalRuntime, type Execute } from '../src/worker/runtime.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus, waitFor } from './helpers.js';

const authority = { conversationId: 'leave-authority', threadId: 'provisioning' };
const other = { conversationId: 'outside', threadId: 'main' };
const scoped = (scope: Scope) => ({ conversationId: scope.conversationId, threadId: scope.threadId });
const route = (path: string, scope: Scope) => `${path}?${new URLSearchParams(scoped(scope))}`;
const leave = (scope: Scope, clientEventId = 'leave-one', expectedMembershipGeneration = 'initial') => ({ ...scoped(scope), expectedMembershipGeneration, clientEventId });

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-leave-')), path = join(directory, 'state.sqlite');
  const ids = ['manager', 'reader', 'worker', 'outsider'], expiresAt = Date.now() + 600000;
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString('hex')]));
  const grant = (memberId: string, scope: Scope, actions: Action[]) => ({ ...scope, id: `${memberId}-${scope.conversationId}`, memberId, actions, revision: 1, expiresAt, revoked: false });
  const policy = defaultPolicy(); policy.disabledActions = policy.disabledActions.filter(action => action !== 'grant_permissions');
  const config: ControlConfig = {
    members: ids.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(ids.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(ids.map(id => [id, expiresAt])),
    memberships: { manager: [authority], reader: [authority], worker: [authority], outsider: [other] },
    grants: [grant('manager', authority, ['manage_workspace', 'grant_permissions']), grant('outsider', other, ['read'])],
    researchMemberId: 'worker', sources: fixtureSources, policy,
    conversationCreation: { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource', 'claim', 'request_approval'], maxGrantDurationMs: 300000 },
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, path: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, path, body, undefined, headers);
  const input = (id = 'group'): ConversationInput => ({ kind: 'group', title: 'Leave fixture', memberIds: ['manager', 'reader', 'worker'], clientEventId: id,
    initialGrants: [{ targetMemberId: 'manager', actions: ['manage_resource'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'reader', actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'worker', actions: ['read', 'send', 'claim', 'request_approval'], expiresAt: Date.now() + 240000 }] });
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-leave-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, api, input, get engine() { return engine; }, get store() { return store; },
    runtime: (execute: Execute, toolHeaders: Record<string, string>) => new LocalRuntime({ provider: 'leave-integration', version: '0', memberId: 'worker', controlUrl: url, memberToken: tokens.worker!, execute, toolHeaders }),
    create: (body = input()) => api<{ conversation: Conversation }>('manager', '/conversations', body),
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('human and Agent members may leave group or direct conversations without read, send or management grants', async t => {
  const env = await setup(t);
  for (const kind of ['group', 'direct'] as const) {
    const input = env.input(kind); input.kind = kind; input.memberIds = ['reader', 'worker']; input.initialGrants = [];
    const { conversation } = await env.create(input);
    for (const actor of ['reader', 'worker']) {
      await expectStatus(env.api(actor, route('/messages', conversation)), 403);
      const result = await env.api(actor, '/memberships/leave', leave(conversation, `${kind}-${actor}`));
      assert.equal(result.duplicate, false); assert.equal(result.change.actorId, actor); assert.equal(result.change.targetMemberId, actor);
      assert.deepEqual(Object.keys(result).sort(), ['change', 'duplicate']);
      assert.equal(env.engine.state.memberScopes(actor).some(s => s.conversationId === conversation.conversationId), false);
    }
  }
});

test('leaving remains available after grants expire or the creation rule disappears but credentials must be current', async t => {
  const env = await setup(t), { conversation } = await env.create();
  const source = env.config.grants[0]!; source.expiresAt = Date.now() - 1;
  delete env.config.conversationCreation;
  await expectStatus(env.api('reader', route('/messages', conversation)), 403);
  const credentialExpiry = env.config.credentialExpiresAt!.reader!;
  env.config.credentialExpiresAt!.reader = Date.now() - 1;
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation)), 401, 'credential_expired');
  assert.equal(env.engine.state.memberScopes('reader').some(s => s.conversationId === conversation.conversationId), true);
  env.config.credentialExpiresAt!.reader = credentialExpiry;
  assert.equal((await env.api('reader', '/memberships/leave', leave(conversation))).duplicate, false);
});

test('leave rejects identity injection, extra fields, static scopes and nonmembers without changing membership', async t => {
  const env = await setup(t), { conversation } = await env.create(), original = env.engine.state.snapshot().memberships;
  for (const extra of [{ targetMemberId: 'worker' }, { memberId: 'worker' }, { authorId: 'worker' }, { expectedRevision: 1 }, { grant: { actions: ['read'] } }]) {
    await expectStatus(env.api('reader', '/memberships/leave', { ...leave(conversation), ...extra }), 400);
  }
  await expectStatus(env.api('outsider', '/memberships/leave', leave(conversation)), 404, 'scope_member_not_found');
  await expectStatus(env.api('reader', '/memberships/leave', leave(authority)), 403, 'conversation_leave_unavailable');
  await expectStatus(env.api('reader', '/memberships/leave', leave({ ...scoped(conversation), threadId: 'unrelated-thread' })), 404, 'scope_member_not_found');
  await expectStatus(env.api('reader', '/memberships/leave', leave({ conversationId: 'unrelated-room', threadId: 'main' })), 404, 'scope_member_not_found');
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation, 'bad-generation', 'stale')), 409, 'membership_generation_conflict');
  await expectStatus(env.api('invalid-token', '/memberships/leave', leave(conversation)), 401);
  assert.deepEqual(env.engine.state.snapshot().memberships, original);
});

test('concurrent exact leave retries persist one removal and remain idempotent after restart', async t => {
  const env = await setup(t), { conversation } = await env.create(), request = leave(conversation);
  const results = await Promise.all([env.api('reader', '/memberships/leave', request), env.api('reader', '/memberships/leave', request)]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal(results[0].change.id, results[1].change.id);
  assert.equal(results[0].change.revision, 2);
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation, 'new-after-exit')), 404, 'scope_member_not_found');
  await env.restart();
  const retried = await env.api('reader', '/memberships/leave', request);
  assert.equal(retried.duplicate, true); assert.equal(retried.change.id, results[0].change.id);
  assert.equal(env.engine.state.snapshot().memberships.removals.length, 1);
  await expectStatus(env.api('reader', route('/messages', conversation)), 403);
  const roster = await env.api('manager', route('/memberships', conversation));
  assert.equal(roster.revision, 2); assert.equal(roster.members.some((m: any) => m.id === 'reader'), false);
});

test('leave shares the membership request conflict domain with remove, add and another conversation', async t => {
  const env = await setup(t), { conversation } = await env.create();
  await env.api('reader', '/memberships/remove', { ...scoped(conversation), targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'remove-or-leave' });
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation, 'remove-or-leave')), 409, 'membership_request_conflict');
  await env.api('reader', '/memberships/add', { ...scoped(conversation), targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'add-or-leave' });
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation, 'add-or-leave')), 409, 'membership_request_conflict');
  const second = (await env.create(env.input('second'))).conversation;
  await env.api('reader', '/memberships/leave', leave(conversation, 'same-leave-key'));
  await expectStatus(env.api('reader', '/memberships/leave', leave(second, 'same-leave-key')), 409, 'membership_request_conflict');
  assert.equal(env.engine.state.memberScopes('reader').some(s => s.conversationId === second.conversationId), true);
});

test('simultaneous voluntary leave and administrator removal commit only one membership change', async t => {
  const env = await setup(t), { conversation } = await env.create();
  const results = await Promise.allSettled([
    env.api('reader', '/memberships/leave', leave(conversation)),
    env.api('manager', '/memberships/remove', { ...scoped(conversation), targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'admin-remove' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(['membership_revision_conflict', 'scope_member_not_found'].includes(rejected.reason.code));
  assert.equal(env.engine.state.snapshot().memberships.removals.length, 1);
  assert.equal((await env.api('manager', route('/memberships', conversation))).revision, 2);
});

test('rejoining changes the generation before leave receipt lookup, preventing replayed departures', async t => {
  const env = await setup(t), { conversation } = await env.create(), oldRequest = leave(conversation);
  await env.api('reader', '/memberships/leave', oldRequest);
  const added = await env.api('manager', '/memberships/add', { ...scoped(conversation), targetMemberId: 'reader', expectedRevision: 2, clientEventId: 'rejoin', grant: { actions: ['read'], expiresAt: Date.now() + 180000 } });
  await expectStatus(env.api('reader', '/memberships/leave', oldRequest), 409, 'membership_generation_conflict');
  await expectStatus(env.api('reader', '/memberships/leave', leave(conversation, 'leave-one', added.change.id)), 409, 'membership_request_conflict');
  assert.equal((await env.api('reader', route('/messages', conversation))).messages.length, 0);
  await env.restart();
  await expectStatus(env.api('reader', '/memberships/leave', oldRequest), 409, 'membership_generation_conflict');
  const current = await env.api('reader', '/memberships/leave', leave(conversation, 'new-generation-leave', added.change.id));
  assert.equal(current.duplicate, false); assert.equal(current.change.revision, 4);
});

test('departing worker becomes unknown, cannot publish late results and has no automatic rebuild after rejoin', async t => {
  const env = await setup(t), { conversation } = await env.create();
  await env.api('reader', '/messages', { ...scoped(conversation), text: '请调研一下退出会话', clientEventId: 'research' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'departing-device' });
  assert.equal(delivery.command, 'execute');
  const headers = { 'x-coseat-instance': 'departing-device', 'x-coseat-lease': delivery.leaseId };
  await env.api('worker', '/memberships/leave', leave(conversation));
  const run = env.engine.state.runs.get(delivery.runId)!;
  assert.equal(run.status, 'unknown'); assert.equal(run.rebuildAfterInvalidation, false);
  assert.equal(run.error, 'membership_removed_reconciliation_required');
  await expectStatus(env.api('worker', '/tools/send', { runId: run.id, result: fixtureResult() }, headers), 409);
  await env.api('manager', '/memberships/add', { ...scoped(conversation), targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'rejoin-worker', grant: { actions: ['read', 'send', 'claim', 'request_approval'], expiresAt: Date.now() + 180000 } });
  await expectStatus(env.api('worker', '/tools/send', { runId: run.id, result: fixtureResult() }, headers), 409);
  await expectStatus(env.api('worker', '/worker/not-started', { instanceId: 'departing-device', leaseId: delivery.leaseId }), 409);
  assert.equal(env.engine.state.runs.size, 1);
  assert.equal([...env.engine.state.messages.values()].some(m => m.origin === 'research'), false);
});

test('failed leave persistence restores membership, context, receipt and the held worker lease before retry', async t => {
  const env = await setup(t), { conversation } = await env.create();
  await env.api('reader', '/messages', { ...scoped(conversation), text: '请调研一下事务回滚', clientEventId: 'research' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'rollback-device' });
  assert.equal(delivery.command, 'execute');
  const before = structuredClone(env.engine.state.runs.get(delivery.runId)!);
  const revision = env.engine.state.contextRevision(conversation), save = env.store.save.bind(env.store), request = leave(conversation);
  env.store.save = () => { throw new ApiError(507, 'trial_storage_limit'); };
  await expectStatus(env.api('worker', '/memberships/leave', request), 507, 'trial_storage_limit');
  env.store.save = save;
  assert.deepEqual(env.engine.state.runs.get(delivery.runId), before);
  assert.equal(env.engine.state.contextRevision(conversation), revision);
  assert.equal(env.engine.state.snapshot().memberships.removals.length, 0);
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'rollback-device' })).command, 'execute');
  assert.equal((await env.api('worker', '/memberships/leave', request)).duplicate, false);
  assert.equal(env.engine.state.runs.get(delivery.runId)!.status, 'unknown');
  await env.restart();
  assert.equal((await env.api('worker', '/memberships/leave', request)).duplicate, true);
  assert.equal(env.engine.state.runs.get(delivery.runId)!.status, 'unknown');
});

for (const departing of ['reader', 'worker']) test(`runtime preflight refuses admitted work after ${departing} leaves the conversation`, async t => {
  const env = await setup(t), { conversation } = await env.create();
  const text = '请调研一下退出与启动前校验';
  await env.api('reader', '/messages', { ...scoped(conversation), text, clientEventId: 'preflight-source' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'preflight-device' });
  assert.equal(delivery.command, 'execute');
  let executions = 0;
  const runtime = env.runtime(async () => { executions++; }, { 'x-coseat-instance': 'preflight-device', 'x-coseat-lease': delivery.leaseId });
  try {
    const { sessionId } = await runtime.createSession(delivery.work);
    await env.api(departing, '/memberships/leave', leave(conversation));
    await runtime.submitInput(sessionId, { id: 'preflight-input', text, contextRevision: delivery.work.contextRevision });
    await waitFor(() => runtime.status(sessionId).status === 'failed' ? true : undefined);
    assert.equal(executions, 0);
    const events = runtime.events(sessionId, 0);
    assert.equal(events.some(event => event.kind === 'input_applied'), false);
    assert.equal(events.find(event => event.kind === 'failed')?.data.code, 'lease_not_executable');
    assert.equal([...env.engine.state.messages.values()].some(message => message.origin === 'research'), false);
  } finally { await runtime.close(); }
});
