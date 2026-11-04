import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlState, type ControlConfig } from '../src/control/state.js';
import type { Action, Scope } from '../src/contracts.js';
import type { Conversation, ConversationInput } from '../src/control/conversations.js';
import { creationRuleValue } from '../src/control/conversations.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { fixtureResult } from '../src/worker/fake.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const authority = { conversationId: 'workspace-authority', threadId: 'provisioning' };
const other = { conversationId: 'unrelated', threadId: 'main' };
const route = (path: string, scope: Scope) => `${path}?${new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId })}`;
type Created = { conversation: Conversation; duplicate: boolean };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-conversations-')), path = join(directory, 'state.sqlite');
  const ids = ['manager', 'reader', 'worker', 'outsider'], expiry = Date.now() + 600000;
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString('hex')]));
  const grant = (memberId: string, resource: Scope, actions: Action[]) => ({ ...resource, id: `${memberId}-${resource.conversationId}`, memberId, actions, revision: 1, expiresAt: expiry, revoked: false });
  const policy = defaultPolicy(); policy.disabledActions = policy.disabledActions.filter(action => action !== 'grant_permissions');
  const config: ControlConfig = {
    members: ids.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(ids.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(ids.map(id => [id, expiry])),
    memberships: { manager: [authority], reader: [authority], worker: [authority], outsider: [other] },
    grants: [grant('manager', authority, ['manage_workspace', 'grant_permissions']), grant('outsider', other, ['manage_workspace', 'grant_permissions', 'read'])],
    researchMemberId: 'worker', sources: fixtureSources, policy,
    conversationCreation: { authorityScope: authority, allowedActions: ['read', 'send', 'cancel', 'claim', 'request_approval', 'manage_resource'], maxGrantDurationMs: 300000 },
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, path: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, path, body, undefined, headers);
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-conversations-'))); await rm(directory, { recursive: true, force: true }); });
  const input = (id = 'create-one'): ConversationInput => ({ kind: 'direct', title: 'Private pair', memberIds: ['reader', 'worker'], clientEventId: id,
    initialGrants: [{ targetMemberId: 'reader', actions: ['read', 'send', 'manage_resource'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'worker', actions: ['read', 'send', 'claim', 'request_approval'], expiresAt: Date.now() + 240000 }] });
  return { config, api, input, get engine() { return engine; },
    create: (body: ConversationInput = input(), actor = 'manager') => api<Created>(actor, '/conversations', body),
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('creation requires the configured authority, explicit issuance permission and eligible members', async t => {
  const env = await setup(t), rule = env.config.conversationCreation!;
  delete env.config.conversationCreation;
  await expectStatus(env.create(), 403, 'conversation_creation_disabled'); env.config.conversationCreation = rule;
  await expectStatus(env.create(env.input(), 'outsider'), 403, 'scope_denied');
  await expectStatus(env.create(env.input(), 'reader'), 403, 'scope_denied');
  env.config.policy!.disabledActions.push('grant_permissions');
  await expectStatus(env.create(), 403, 'scope_denied');
  const empty = env.input('membership-only'); empty.initialGrants = [];
  const { conversation } = await env.create(empty);
  await expectStatus(env.api('reader', route('/messages', conversation)), 403, 'scope_denied');
  await expectStatus(env.api('manager', route('/memberships', conversation)), 403, 'scope_denied');
  env.config.policy!.disabledActions = env.config.policy!.disabledActions.filter(a => a !== 'grant_permissions');
  const invalid = env.input(); invalid.memberIds = ['reader', 'outsider']; invalid.initialGrants = [];
  await expectStatus(env.create(invalid), 403, 'conversation_member_unavailable');
  env.config.grants.push({ ...env.config.grants[0]!, id: 'explicit-deny', actions: ['manage_workspace'], effect: 'deny' });
  await expectStatus(env.create(), 403, 'scope_denied');
});

test('direct and group creation have no implicit creator access, persist and use the normal IM paths', async t => {
  const env = await setup(t), before = structuredClone(env.config), request = env.input();
  const created = await env.create(request), scope = created.conversation;
  assert.equal(scope.kind, 'direct'); assert.equal(scope.threadId, 'main'); assert.notEqual(scope.conversationId, scope.title);
  assert.deepEqual(scope.memberIds, ['reader', 'worker']); assert.deepEqual(env.config, before);
  await expectStatus(env.api('manager', route('/messages', scope)), 403, 'scope_denied');
  await expectStatus(env.api('manager', route('/memberships', scope)), 403, 'scope_denied');
  await expectStatus(env.api('outsider', route('/sync', scope)), 403, 'scope_denied');
  const message = await env.api('reader', '/messages', { ...scope, text: 'ordinary private conversation', clientEventId: 'first-message' });
  assert.equal((await env.api('worker', route('/messages', scope))).messages[0].id, message.message.id);
  const session = await env.api('reader', '/session'); assert.equal(session.scopes.length, 1); assert.equal(session.scopes[0].title, 'Private pair');
  const group = env.input('group'); group.kind = 'group'; group.memberIds.push('manager');
  const grouped = await env.create(group);
  await expectStatus(env.api('manager', route('/messages', grouped.conversation)), 403, 'scope_denied');
  await env.restart();
  assert.equal((await env.create(request)).conversation.conversationId, scope.conversationId);
  assert.equal((await env.create(request)).duplicate, true);
  assert.equal((await env.api('reader', route('/sync', scope))).messages[0].text, 'ordinary private conversation');
  assert.equal((await env.api('reader', '/session')).scopes.length, 2);
});

test('creation rejects excess actions, deadlines, malformed pairs and client identity spoofing', async t => {
  const env = await setup(t);
  for (const action of ['grant_permissions', 'manage_workspace', 'external_send', 'permanent_delete', 'continuous_run'] as Action[]) {
    const input = env.input(); input.initialGrants[0]!.actions = [action];
    await expectStatus(env.create(input), 403, 'conversation_action_not_grantable');
    assert.throws(() => creationRuleValue({ ...env.config.conversationCreation, allowedActions: [action] }), /invalid_conversation_actions/);
  }
  for (const expiresAt of [Date.now() - 1, Date.now() + 400000, env.config.grants[0]!.expiresAt + 1]) {
    const input = env.input(); input.initialGrants[0]!.expiresAt = expiresAt;
    await expectStatus(env.create(input), 400, 'conversation_grant_expiry_out_of_bounds');
  }
  env.config.grants[0]!.expiresAt = Date.now() + 10000;
  await expectStatus(env.create(), 400, 'conversation_grant_expiry_out_of_bounds');
  for (const memberIds of [['reader'], ['reader', 'reader'], ['reader', 'worker', 'manager']]) {
    await expectStatus(env.create({ ...env.input(), memberIds }), 400, 'invalid_conversation_members');
  }
  await expectStatus(env.api('manager', '/conversations', { ...env.input(), memberId: 'reader' }), 400, 'identity_is_authenticated');
  assert.equal(env.engine.state.snapshot().conversations.conversations.length, 0);
});

test('concurrent creation, conflicting retries and failed persistence never create duplicate or partial resources', async t => {
  const env = await setup(t), input = env.input();
  const save = env.engine.store.save.bind(env.engine.store); env.engine.store.save = () => { throw new Error('synthetic failure'); };
  await expectStatus(env.create(input), 500, 'internal_error'); env.engine.store.save = save;
  assert.equal(env.engine.state.snapshot().conversations.conversations.length, 0);
  assert.equal(env.engine.state.memberScopes('reader').length, 1);
  const values = await Promise.all([env.create(input), env.create(input), env.create(input)]);
  assert.equal(values.filter(v => !v.duplicate).length, 1); assert.equal(new Set(values.map(v => v.conversation.conversationId)).size, 1);
  await expectStatus(env.create({ ...input, title: 'different' }), 409, 'conversation_request_conflict');
  env.config.grants[0]!.revoked = true;
  await expectStatus(env.create(input), 403, 'scope_denied');
});

test('source revocation, revision changes, policy and rule changes invalidate derived permissions after restart', async t => {
  for (const change of ['revoked', 'revision', 'digest', 'policy', 'rule', 'removed-rule', 'membership', 'deny'] as const) {
    const env = await setup(t), { conversation } = await env.create();
    assert.ok(env.engine.state.authorization('reader', 'read', conversation).allowed);
    if (change === 'revoked') env.config.grants[0]!.revoked = true;
    if (change === 'revision') env.config.grants[0]!.revision++;
    if (change === 'digest') env.config.grants[0]!.expiresAt--;
    if (change === 'policy') env.config.policy!.version++;
    if (change === 'rule') env.config.conversationCreation!.maxGrantDurationMs++;
    if (change === 'removed-rule') delete env.config.conversationCreation;
    if (change === 'membership') env.config.memberships.manager = [];
    if (change === 'deny') env.config.grants.push({ ...env.config.grants[0]!, id: 'deny-issuer', effect: 'deny' });
    await expectStatus(env.api('reader', route('/messages', conversation)), 403, 'scope_denied');
    await env.restart();
    await expectStatus(env.api('reader', route('/sync', conversation)), 403, 'scope_denied');
    if (change === 'revision') {
      // A new issuance Grant cannot replace the old source binding.
      env.config.grants.push({ ...env.config.grants[0]!, id: 'new-authority' });
      await expectStatus(env.api('worker', route('/messages', conversation)), 403, 'scope_denied');
    }
  }
});

test('dynamic grants bind worker execution, revocation fences old tools and member removal persists', async t => {
  const env = await setup(t), { conversation } = await env.create();
  await env.api('reader', '/messages', { ...conversation, text: '请调研一下创建协议', clientEventId: 'research' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'worker-device' });
  assert.equal(delivery.command, 'execute'); assert.equal(delivery.work.route.conversationId, conversation.conversationId);
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'other-device' })).command, 'blocked');
  const headers = { 'x-coseat-instance': 'worker-device', 'x-coseat-lease': delivery.leaseId };
  env.config.grants[0]!.revoked = true;
  await expectStatus(env.api('worker', '/tools/send', { runId: delivery.runId, result: fixtureResult() }, headers), 409);
  assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research').length, 0);
  const second = await setup(t), made = (await second.create()).conversation;
  await second.api('reader', '/memberships/remove', { ...made, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'remove-worker' });
  await second.restart(); await expectStatus(second.api('worker', route('/messages', made)), 403, 'scope_denied');
  assert.equal((await second.api('reader', route('/memberships', made))).members.length, 1);
});

test('Agent and human creators use identical authority and legacy snapshots retain existing scopes', async t => {
  const env = await setup(t);
  env.config.grants.push({ ...env.config.grants[0]!, id: 'agent-issuer', memberId: 'worker' });
  assert.equal((await env.create(env.input('agent-created'), 'worker')).conversation.createdBy, 'worker');
  const saved = env.engine.store.load<{ state: Record<string, unknown> }>()!; delete saved.state.conversations;
  env.engine.store.save(saved); await env.restart();
  assert.deepEqual(env.engine.state.memberScopes('reader'), [authority]);
  assert.equal((await env.create(env.input('after-legacy'))).duplicate, false);
});

test('expiry crossing during audit resolution does not throw or lose the authorization audit', async t => {
  const env = await setup(t); env.config.grants[0]!.expiresAt = 20000;
  let ticking = false, calls = 0;
  const state = new ControlState(env.config, () => ticking && ++calls >= 2 ? 20000 : 19999);
  const input = env.input(); for (const grant of input.initialGrants) grant.expiresAt = 20000;
  const { conversation } = state.createConversation('manager', input);
  ticking = true;
  assert.ok(state.authorize('reader', 'read', conversation).id);
  assert.equal(state.audit.at(-1)!.allowed, true);
  assert.ok(state.audit.at(-1)!.grantRevisions?.length);
  assert.throws(() => state.authorize('reader', 'read', conversation), /scope_denied/);
});

test('explicit resource administration grants no read or creation power and follows source denial', async t => {
  const env = await setup(t), input = env.input(); input.initialGrants[0]!.actions = ['manage_resource'];
  const { conversation } = await env.create(input);
  await expectStatus(env.api('reader', route('/messages', conversation)), 403, 'scope_denied');
  await expectStatus(env.create(env.input('forbidden-child'), 'reader'), 403, 'scope_denied');
  assert.equal((await env.api('reader', route('/memberships', conversation))).members.length, 2);
  await env.api('reader', '/memberships/remove', { ...conversation, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'admin-removal' });
  await expectStatus(env.api('worker', route('/messages', conversation)), 403, 'scope_denied');
  env.config.grants.push({ ...env.config.grants[0]!, id: 'deny-granting', actions: ['grant_permissions'], effect: 'deny' });
  await expectStatus(env.api('reader', route('/memberships', conversation)), 403, 'scope_denied');
});

test('persistent removal from the source authority disables all derived grants without reviving on restart', async t => {
  const env = await setup(t);
  env.config.grants.push({ ...env.config.grants[0]!, id: 'source-management', actions: ['manage_resource'] });
  const { conversation } = await env.create();
  await env.api('manager', '/memberships/remove', { ...authority, targetMemberId: 'manager', expectedRevision: 1, clientEventId: 'remove-issuer' });
  await expectStatus(env.api('reader', route('/messages', conversation)), 403, 'scope_denied');
  await env.restart(); await expectStatus(env.api('worker', route('/messages', conversation)), 403, 'scope_denied');
});

async function managedGroup(env: Awaited<ReturnType<typeof setup>>) {
  const input = env.input('managed-group'); input.kind = 'group'; input.memberIds = ['manager', 'reader'];
  input.initialGrants = [{ targetMemberId: 'manager', actions: ['manage_resource'], expiresAt: Date.now() + 240000 }, input.initialGrants[0]!];
  return (await env.create(input)).conversation;
}
const addedGrant = (actions: Action[] = ['read', 'send', 'claim', 'request_approval']) => ({ actions, expiresAt: Date.now() + 180000 });
test('group add and rejoin issue new generations without reviving old grants or replayed removals', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  const remove = { ...scope, targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'remove-reader' };
  await env.api('reader', '/messages', { ...scope, text: 'history remains readable only with a fresh grant', clientEventId: 'history' });
  await env.api('manager', '/memberships/remove', remove);
  env.config.grants.push({ ...scope, id: 'old-static', memberId: 'reader', actions: ['send', 'manage_resource'], revision: 1, expiresAt: Date.now() + 200000, revoked: false });
  const request = { ...scope, targetMemberId: 'reader', expectedRevision: 2, clientEventId: 'rejoin', grant: addedGrant(['read']) };
  const added = await env.api('manager', '/memberships/add', request);
  assert.equal(added.change.revision, 3);
  assert.equal((await env.api('manager', '/memberships/add', request)).duplicate, true);
  assert.equal((await env.api('manager', '/memberships/remove', remove)).duplicate, true);
  assert.equal((await env.api('reader', route('/messages', scope))).messages.length, 1);
  await expectStatus(env.api('reader', '/messages', { ...scope, text: 'old send cannot return', clientEventId: 'forbidden' }), 403);
  await expectStatus(env.api('reader', route('/memberships', scope)), 403);
  await expectStatus(env.api('manager', '/memberships/add', { ...request, grant: addedGrant(['send']) }), 409, 'membership_request_conflict');
  await env.restart();
  assert.equal((await env.api('reader', '/session')).scopes[0].membershipGeneration, added.change.id);
  assert.equal((await env.api('manager', route('/memberships', scope))).revision, 3);
  env.config.grants.push({ ...scope, id: 'persistent-deny', memberId: 'reader', actions: ['read'], effect: 'deny', revision: 1, expiresAt: Date.now() + 200000, revoked: false });
  await expectStatus(env.api('reader', route('/messages', scope)), 403);
  await env.api('manager', '/memberships/remove', { ...remove, expectedRevision: 3, clientEventId: 'remove-again' });
  await env.api('manager', '/memberships/add', { ...request, expectedRevision: 4, clientEventId: 'rejoin-again' });
  await expectStatus(env.api('reader', route('/messages', scope)), 403);
});

test('membership-only addition grants no actions, directories require source authority and management needs no read', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  const managerSession = await env.api('manager', '/session');
  assert.deepEqual(managerSession.scopes, []); assert.equal(managerSession.management.scopes.length, 1);
  const options = await env.api('manager', '/conversations/options');
  assert.deepEqual(options.members.map((m: any) => m.id), ['manager', 'reader', 'worker']);
  await expectStatus(env.api('reader', '/conversations/options'), 403);
  await env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'membership-only' });
  await expectStatus(env.api('worker', route('/messages', scope)), 403);
  await expectStatus(env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'cannot-issue', grant: addedGrant() }), 403);
  await expectStatus(env.api('manager', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'already-present' }), 409, 'scope_member_already_present');
  await expectStatus(env.api('manager', route('/messages', scope)), 403);
});

test('add transactions roll back grants, membership generations, revision and old execution invalidation', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  const request = { ...scope, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'atomic-add', grant: addedGrant() };
  const save = env.engine.store.save.bind(env.engine.store), before = env.engine.state.snapshot();
  env.engine.store.save = () => { throw new Error('injected failure'); };
  await expectStatus(env.api('manager', '/memberships/add', request), 500); env.engine.store.save = save;
  assert.deepEqual(env.engine.state.snapshot().memberships, before.memberships);
  assert.deepEqual(env.engine.state.snapshot().conversations, before.conversations);
  assert.equal(env.engine.state.contextRevision(scope), 1);
  const results = await Promise.allSettled([env.api('manager', '/memberships/add', request), env.api('manager', '/memberships/remove', { ...scope, targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'racing-remove' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'membership_revision_conflict');
});

test('worker rejoin never reuses an old lease, result or pending rebuild', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  const join = { ...scope, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'worker-add', grant: addedGrant() };
  await env.api('manager', '/memberships/add', join);
  await env.api('reader', '/messages', { ...scope, text: '请调研一下成员版本', clientEventId: 'research-membership' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'old-device' });
  assert.equal(delivery.command, 'execute');
  await env.api('manager', '/memberships/remove', { ...scope, targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'worker-remove' });
  await env.api('manager', '/memberships/add', { ...join, expectedRevision: 3, clientEventId: 'worker-rejoin' });
  const run = env.engine.state.runs.get(delivery.runId)!;
  assert.equal(run.status, 'unknown'); assert.equal(run.rebuildAfterInvalidation, false);
  await expectStatus(env.api('worker', '/tools/send', { runId: run.id, result: fixtureResult() }, { 'x-coseat-instance': 'old-device', 'x-coseat-lease': delivery.leaseId }), 409);
  await expectStatus(env.api('worker', '/worker/not-started', { instanceId: 'old-device', leaseId: delivery.leaseId }), 409);
  await env.restart(); assert.equal(env.engine.state.runs.get(run.id)!.status, 'unknown');
  await expectStatus(env.api('worker', '/worker/poll', { instanceId: 'new-device' }), 409, 'grant_revision_changed');
  assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research').length, 0);
});

test('direct membership keeps its original pair and legacy authority is recovered only from evidence', async t => {
  const env = await setup(t), input = env.input();
  // reader can manage membership but cannot issue permissions.
  const scope = (await env.create(input)).conversation;
  await expectStatus(env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'manager', expectedRevision: 1, clientEventId: 'third' }), 409, 'direct_members_fixed');
  await env.api('reader', '/memberships/remove', { ...scope, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'pair-remove' });
  await env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 2, clientEventId: 'pair-rejoin' });
  await expectStatus(env.api('worker', route('/messages', scope)), 403);
  const saved = env.engine.store.load<{ state: { conversations: { authorities?: unknown } } }>()!;
  delete saved.state.conversations.authorities; env.engine.store.save(saved); await env.restart();
  await env.api('reader', '/memberships/remove', { ...scope, targetMemberId: 'worker', expectedRevision: 3, clientEventId: 'pair-remove-again' });
  await env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 4, clientEventId: 'pair-rejoin-again' });
  env.config.conversationCreation!.authorityScope = other;
  // Even static target management cannot move this resource to a new authority.
  env.config.grants.push({ ...scope, id: 'static-manager', memberId: 'reader', actions: ['manage_resource'], revision: 1, expiresAt: Date.now() + 200000, revoked: false });
  await expectStatus(env.api('reader', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 5, clientEventId: 'wrong-source' }), 409, 'conversation_membership_unavailable');
});

test('old-generation send, edit, retract and read intents cannot execute under freshly issued permissions', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  const message = (await env.api('reader', '/messages', { ...scope, text: 'original', clientEventId: 'before-generation' })).message;
  await env.api('manager', '/memberships/remove', { ...scope, targetMemberId: 'reader', expectedRevision: 1, clientEventId: 'intent-remove' });
  const joined = await env.api('manager', '/memberships/add', { ...scope, targetMemberId: 'reader', expectedRevision: 2, clientEventId: 'intent-rejoin', grant: addedGrant(['read', 'send']) });
  const expectedMembershipGeneration = joined.change.id;
  for (const old of [undefined, 'initial']) {
    const body = old === undefined ? {} : { expectedMembershipGeneration: old };
    await expectStatus(env.api('reader', '/messages', { ...scope, text: 'held old send', clientEventId: 'held-send', ...body }), 409, 'membership_generation_conflict');
    await expectStatus(env.api('reader', '/read-position', { ...scope, messageId: message.id, ...body }), 409, 'membership_generation_conflict');
    for (const kind of ['edit', 'retract']) await expectStatus(env.api('reader', `/messages/${message.id}/${kind}`, { expectedRevision: 1, clientEventId: 'held-change', text: 'old edit', ...body }), 409, 'membership_generation_conflict');
  }
  assert.equal(env.engine.state.readPosition('reader', scope), null); assert.equal(env.engine.state.messages.get(message.id)!.text, 'original');
  await env.api('reader', '/messages', { ...scope, text: 'new intent', clientEventId: 'fresh-send', expectedMembershipGeneration });
  await env.api('reader', '/read-position', { ...scope, messageId: message.id, expectedMembershipGeneration });
  await env.api('reader', `/messages/${message.id}/edit`, { text: 'fresh edit', expectedRevision: 1, clientEventId: 'fresh-edit', expectedMembershipGeneration });
  assert.equal(env.engine.state.messages.get(message.id)!.text, 'fresh edit');
});

test('adding a new audience member cancels existing work and blocks its late publication', async t => {
  const env = await setup(t), scope = await managedGroup(env);
  await env.api('manager', '/memberships/add', { ...scope, targetMemberId: 'worker', expectedRevision: 1, clientEventId: 'start-worker', grant: addedGrant() });
  await env.api('reader', '/messages', { ...scope, text: '请调研一下新受众', clientEventId: 'audience-work' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'audience-device' });
  env.config.memberships.outsider!.push(authority);
  await env.api('manager', '/memberships/add', { ...scope, targetMemberId: 'outsider', expectedRevision: 2, clientEventId: 'new-audience', grant: addedGrant(['read']) });
  const run = env.engine.state.runs.get(delivery.runId)!;
  assert.equal(run.status, 'cancel_requested'); assert.equal(run.rebuildAfterInvalidation, false);
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'audience-device' })).command, 'cancel');
  await expectStatus(env.api('worker', '/tools/send', { runId: run.id, result: fixtureResult() }, { 'x-coseat-instance': 'audience-device', 'x-coseat-lease': delivery.leaseId }), 409);
  assert.equal((await env.api('outsider', route('/messages', scope))).messages.length, 1);
  assert.equal(env.engine.state.contextRevision(scope), 3);
});
