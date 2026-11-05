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
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const authority = { conversationId: 'title-authority', threadId: 'provisioning' };
const other = { conversationId: 'outside', threadId: 'main' };
const scoped = (scope: Scope) => ({ conversationId: scope.conversationId, threadId: scope.threadId });
const route = (path: string, scope: Scope) => `${path}?${new URLSearchParams(scoped(scope))}`;
const rename = (scope: Scope, title = 'Renamed group', expectedTitleRevision = 1, clientEventId = 'rename-one', expectedMembershipGeneration = 'initial') =>
  ({ ...scoped(scope), title, expectedTitleRevision, expectedMembershipGeneration, clientEventId });

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-title-')), path = join(directory, 'state.sqlite');
  const ids = ['manager', 'reader', 'worker', 'outsider'], expiresAt = Date.now() + 600000;
  const tokens = Object.fromEntries(ids.map(id => [id, randomBytes(32).toString('hex')]));
  const grant = (memberId: string, scope: Scope, actions: Action[]) => ({ ...scope, id: `${memberId}-${scope.conversationId}`, memberId, actions, revision: 1, expiresAt, revoked: false });
  const policy = defaultPolicy(); policy.disabledActions = policy.disabledActions.filter(action => action !== 'grant_permissions');
  const config: ControlConfig = {
    members: ids.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(ids.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(ids.map(id => [id, expiresAt])),
    memberships: { manager: [authority], reader: [authority], worker: [authority], outsider: [other] },
    grants: [grant('manager', authority, ['manage_workspace', 'grant_permissions', 'manage_resource']), grant('outsider', other, ['read', 'manage_resource'])],
    researchMemberId: 'worker', sources: fixtureSources, policy,
    conversationCreation: { authorityScope: authority, allowedActions: ['read', 'send', 'manage_resource', 'claim', 'request_approval'], maxGrantDurationMs: 300000 },
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, path: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, path, body, undefined, headers);
  const input = (id = 'create-group'): ConversationInput => ({ kind: 'group', title: 'Original group', memberIds: ['manager', 'reader', 'worker'], clientEventId: id,
    initialGrants: [{ targetMemberId: 'manager', actions: ['manage_resource'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'reader', actions: ['read', 'send'], expiresAt: Date.now() + 240000 },
      { targetMemberId: 'worker', actions: ['read', 'send', 'manage_resource', 'claim', 'request_approval'], expiresAt: Date.now() + 240000 }] });
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-title-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, api, input, get engine() { return engine; }, get store() { return store; },
    create: (body = input()) => api<{ conversation: Conversation; duplicate: boolean }>('manager', '/conversations', body),
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('group title management requires the exact resource grant, not reading, and treats Agent members equally', async t => {
  const env = await setup(t), { conversation } = await env.create();
  assert.equal((await env.api('manager', route('/memberships', conversation))).titleRevision, 1);
  await expectStatus(env.api('manager', route('/messages', conversation)), 403);
  await expectStatus(env.api('reader', '/conversations/rename', rename(conversation)), 403, 'scope_denied');
  await expectStatus(env.api('outsider', '/conversations/rename', rename(conversation)), 403, 'scope_denied');
  await expectStatus(env.api('manager', '/conversations/rename', rename({ ...scoped(conversation), threadId: 'different' })), 403, 'scope_denied');
  const human = await env.api('manager', '/conversations/rename', rename(conversation, '  Team <b>notes</b>  '));
  assert.deepEqual(human, { change: { ...scoped(conversation), title: 'Team <b>notes</b>', titleRevision: 2 }, duplicate: false });
  const agent = await env.api('worker', '/conversations/rename', rename(conversation, '共同讨论 🧪', 2));
  assert.deepEqual(agent.change, { ...scoped(conversation), title: '共同讨论 🧪', titleRevision: 3 });
  const session = await env.api('reader', '/session');
  assert.equal(session.scopes.find((s: any) => s.conversationId === conversation.conversationId).title, '共同讨论 🧪');
  assert.equal((await env.api('manager', route('/memberships', conversation))).revision, 1);
});

test('direct and static resources cannot be renamed even by their authorized manager', async t => {
  const env = await setup(t), input = env.input('direct');
  input.kind = 'direct'; input.memberIds = ['manager', 'worker']; input.initialGrants = input.initialGrants.filter(g => g.targetMemberId !== 'reader');
  const { conversation } = await env.create(input);
  await expectStatus(env.api('manager', '/conversations/rename', rename(conversation)), 403, 'conversation_rename_unavailable');
  await expectStatus(env.api('manager', '/conversations/rename', rename(authority)), 403, 'conversation_rename_unavailable');
  await expectStatus(env.api('outsider', '/conversations/rename', rename(conversation)), 403, 'scope_denied');
  assert.equal((await env.api('manager', route('/memberships', conversation))).title, input.title);
});

test('rename validates titles, versions and the exact request schema without creating receipts', async t => {
  const env = await setup(t), { conversation } = await env.create();
  for (const title of ['', '   ', 'a'.repeat(129), 'line\nbreak', '\ttab', 'nul\0byte', 'del\x7f', '\ud800', 7, null]) {
    await expectStatus(env.api('manager', '/conversations/rename', { ...rename(conversation), title }), 400, 'invalid_conversation_title');
  }
  for (const expectedTitleRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    await expectStatus(env.api('manager', '/conversations/rename', { ...rename(conversation), expectedTitleRevision }), 400, 'invalid_title_revision');
  }
  for (const extra of [{ targetMemberId: 'worker' }, { memberId: 'worker' }, { authorId: 'worker' }, { expectedRevision: 1 }, { grant: {} }]) {
    await expectStatus(env.api('manager', '/conversations/rename', { ...rename(conversation), ...extra }), 400);
  }
  const missingGeneration: any = rename(conversation); delete missingGeneration.expectedMembershipGeneration;
  await expectStatus(env.api('manager', '/conversations/rename', missingGeneration), 400);
  const good = await env.api('manager', '/conversations/rename', rename(conversation, 'a'.repeat(128)));
  assert.equal(good.duplicate, false); assert.equal(good.change.titleRevision, 2);
});

test('concurrent different renames use title CAS while identical retries create one immutable receipt', async t => {
  const env = await setup(t), { conversation } = await env.create();
  const results = await Promise.allSettled([
    env.api('manager', '/conversations/rename', rename(conversation, 'A', 1, 'a')),
    env.api('worker', '/conversations/rename', rename(conversation, 'B', 1, 'b')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'conversation_title_conflict');
  const request = rename(conversation, 'Shared retry', 2, 'concurrent-retry');
  const retries = await Promise.all([env.api('manager', '/conversations/rename', request), env.api('manager', '/conversations/rename', request)]);
  assert.equal(retries.filter(result => !result.duplicate).length, 1);
  assert.deepEqual(retries[0].change, retries[1].change);
  assert.equal((await env.api('manager', route('/memberships', conversation))).titleRevision, 3);
});

test('lost-response retry and restart return the original rename receipt without rolling back a later title', async t => {
  const env = await setup(t), input = env.input(), { conversation } = await env.create(input);
  const request = rename(conversation, 'First new title'), first = await env.api('manager', '/conversations/rename', request);
  await env.api('worker', '/conversations/rename', rename(conversation, 'Latest title', 2, 'latest'));
  await env.restart();
  const recovered = await env.api('manager', '/conversations/rename', request);
  assert.equal(recovered.duplicate, true); assert.deepEqual(recovered.change, first.change);
  assert.equal((await env.api('manager', route('/memberships', conversation))).title, 'Latest title');
  assert.equal((await env.create(input)).conversation.title, input.title);
  const normalized = await env.api('manager', '/conversations/rename', { ...request, title: '  First new title  ' });
  assert.equal(normalized.duplicate, true);
  await expectStatus(env.api('manager', '/conversations/rename', { ...request, title: 'Changed retry' }), 409, 'conversation_request_conflict');
  await expectStatus(env.api('manager', '/conversations/rename', { ...request, expectedTitleRevision: 2 }), 409, 'conversation_request_conflict');
  const second = (await env.create(env.input('second-group'))).conversation;
  await expectStatus(env.api('manager', '/conversations/rename', { ...request, ...scoped(second) }), 409, 'conversation_request_conflict');
});

test('create and rename share a request conflict domain for the authenticated actor', async t => {
  const env = await setup(t), input = env.input(), { conversation } = await env.create(input);
  await expectStatus(env.api('manager', '/conversations/rename', rename(conversation, 'Conflict', 1, input.clientEventId)), 409, 'conversation_request_conflict');
  await env.api('manager', '/conversations/rename', rename(conversation, 'Accepted', 1, 'rename-or-create'));
  await expectStatus(env.create(env.input('rename-or-create')), 409, 'conversation_request_conflict');
  assert.equal(env.engine.state.snapshot().conversations.conversations.length, 1);
});

test('authorization and membership generation are checked before returning an old rename receipt', async t => {
  const env = await setup(t);
  env.config.grants.push({ ...env.config.grants[0]!, id: 'worker-source', memberId: 'worker' });
  const { conversation } = await env.create(), request = rename(conversation);
  await env.api('manager', '/conversations/rename', request);
  const deny = { ...scoped(conversation), id: 'deny-rename', memberId: 'manager', actions: ['manage_resource'] as Action[], revision: 1, expiresAt: Date.now() + 100000, revoked: false, effect: 'deny' as const };
  env.config.grants.push(deny);
  await expectStatus(env.api('manager', '/conversations/rename', request), 403, 'scope_denied');
  env.config.grants.pop();
  const expiry = env.config.grants[0]!.expiresAt; env.config.grants[0]!.expiresAt = Date.now() - 1;
  await expectStatus(env.api('manager', '/conversations/rename', request), 403, 'scope_denied');
  env.config.grants[0]!.expiresAt = expiry;
  const credentialExpiry = env.config.credentialExpiresAt!.manager!; env.config.credentialExpiresAt!.manager = Date.now() - 1;
  await expectStatus(env.api('manager', '/conversations/rename', request), 401, 'credential_expired');
  env.config.credentialExpiresAt!.manager = credentialExpiry;
  await env.api('worker', '/memberships/remove', { ...scoped(conversation), targetMemberId: 'manager', expectedRevision: 1, clientEventId: 'remove-manager' });
  await expectStatus(env.api('manager', '/conversations/rename', request), 403, 'scope_denied');
  const rejoined = await env.api('worker', '/memberships/add', { ...scoped(conversation), targetMemberId: 'manager', expectedRevision: 2, clientEventId: 'rejoin-granted-manager', grant: { actions: ['manage_resource'], expiresAt: Date.now() + 180000 } });
  await expectStatus(env.api('manager', '/conversations/rename', request), 409, 'membership_generation_conflict');
  await expectStatus(env.api('manager', '/conversations/rename', { ...request, expectedMembershipGeneration: rejoined.change.id }), 409, 'conversation_request_conflict');
  const changed = await env.api('manager', '/conversations/rename', rename(conversation, 'Fresh generation', 2, 'fresh-rename', rejoined.change.id));
  assert.equal(changed.change.titleRevision, 3);
});

test('rename storage failure rolls back both the title version and its retry receipt', async t => {
  const env = await setup(t), { conversation } = await env.create(), request = rename(conversation), save = env.store.save.bind(env.store);
  env.store.save = () => { throw new ApiError(507, 'trial_storage_limit'); };
  await expectStatus(env.api('manager', '/conversations/rename', request), 507, 'trial_storage_limit');
  env.store.save = save;
  const roster = await env.api('manager', route('/memberships', conversation));
  assert.equal(roster.title, conversation.title); assert.equal(roster.titleRevision, 1);
  await env.restart();
  const result = await env.api('manager', '/conversations/rename', request);
  assert.equal(result.duplicate, false); assert.equal(result.change.titleRevision, 2);
});

test('legacy saved conversations without title versions or rename receipts start at version one', async t => {
  const env = await setup(t), { conversation } = await env.create();
  const saved = env.store.load<any>();
  for (const item of saved.state.conversations.conversations) delete item.titleRevision;
  for (const [, request] of saved.state.conversations.requests) if (request.receipt) delete request.receipt.titleRevision;
  delete saved.state.conversations.renameRequests;
  env.store.save(saved);
  await env.restart();
  assert.equal((await env.api('manager', route('/memberships', conversation))).titleRevision, 1);
  const result = await env.api('manager', '/conversations/rename', rename(conversation));
  assert.equal(result.change.titleRevision, 2); assert.equal(result.duplicate, false);
});

test('renaming changes no membership, authorization, message context or active worker execution', async t => {
  const env = await setup(t), { conversation } = await env.create();
  await env.api('reader', '/messages', { ...scoped(conversation), text: '请调研一下群聊名称', clientEventId: 'research' });
  const delivery = await env.api('worker', '/worker/poll', { instanceId: 'title-device' });
  assert.equal(delivery.command, 'execute');
  const before = env.engine.state.snapshot(), config = structuredClone(env.config), revision = env.engine.state.contextRevision(conversation);
  await env.api('manager', '/conversations/rename', rename(conversation));
  const after = env.engine.state.snapshot();
  assert.deepEqual(after.memberships, before.memberships); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.conversations.grants, before.conversations.grants); assert.deepEqual(env.config, config);
  assert.equal(env.engine.state.contextRevision(conversation), revision);
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'title-device' })).command, 'execute');
  const result = await env.api('worker', '/tools/send', { runId: delivery.runId, result: fixtureResult() }, { 'x-coseat-instance': 'title-device', 'x-coseat-lease': delivery.leaseId });
  assert.equal(result.message.origin, 'research');
  const chat = await env.api('reader', '/messages', { ...scoped(conversation), text: 'The same room remains usable', clientEventId: 'after-rename' });
  assert.equal(chat.message.conversationId, conversation.conversationId);
});
