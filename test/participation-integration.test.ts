import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlState, type ControlConfig } from '../src/control/state.js';
import { DEV, developmentGrants, fixtureSources, members } from '../src/dev-fixture.js';
import { type ParticipationSubscription } from '../src/control/participation-prefilter.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { environment, scope, query, runResult } from './helpers.js';
import type { Message } from '../src/contracts.js';
const sub = (memberId = 'sam'): ParticipationSubscription => ({ ...scope, memberId, revision: 1, enabled: true, joinedAt: 1, membershipGeneration: 'initial', responsibilities: ['research'] });
function config(): ControlConfig { return { members: structuredClone(members), grants: developmentGrants(), tokens: { [DEV.humanToken]: 'alex', [DEV.agentToken]: 'sam' }, memberships: { alex: [scope], sam: [scope] }, credentialExpiresAt: { alex: Date.now() + 3600000, sam: Date.now() + 3600000, guest: Date.now() + 3600000 }, researchMemberId: 'sam', sources: fixtureSources, participationSubscriptions: [sub()] }; }
function setup() { return new ControlState(config(), () => 100); }
function post(state: ControlState, text = 'please research protocol', key = crypto.randomUUID()) { return state.createMessage('alex', scope, text, key).message; }
test('unmentioned eligible source claims once; ordinary, negative intent, disabled and denied are quiet', () => {
  const state = setup();
  for (const text of ['hello', 'do not research']) assert.deepEqual(state.claimChatWork(post(state, text).id), []);
  const message = post(state), runs = state.claimChatWork(message.id); assert.equal(runs.length, 1);
  assert.equal(runs[0]!.memberId, 'sam'); assert.deepEqual(state.claimChatWork(message.id), []); assert.equal(state.tasks.size, 1);
  state.config.participationSubscriptions![0]!.enabled = false; assert.deepEqual(state.claimChatWork(post(state).id), []);
  state.config.participationSubscriptions![0]!.enabled = true; state.config.grants[1]!.revoked = true;
  assert.deepEqual(state.claimChatWork(post(state).id), []);
});
test('empty opt-in is quiet, absent field retains legacy behavior', () => {
  const state = setup(); state.config.participationSubscriptions = []; assert.equal(state.claimChatWork(post(state).id).length, 0);
  delete state.config.participationSubscriptions; assert.equal(state.claimChatWork(post(state).id).length, 1);
});
test('bounded worker context survives snapshot and reads do not append candidate decisions', () => {
  const state = setup(); post(state, 'private earlier context'); const message = post(state); const [run] = state.claimChatWork(message.id);
  const restored = setup(); restored.restore(state.snapshot()); const before = structuredClone(restored.participationDecisions);
  assert.deepEqual(restored.readMessages('sam', scope, run!.id).map(m => m.id), [message.id]);
  restored.currentRun('sam', run!.id, 'read'); assert.deepEqual(restored.participationDecisions, before);
  assert.equal(restored.readMessages('sam', scope).length, 2);
  assert.throws(() => restored.readAttachment('sam', scope, message.id, 'initial', run!.id), /participation_attachment_unavailable/);
});
for (const mutation of ['disable', 'revision', 'remove', 'revoke'] as const) test(`${mutation} fences a bound run without unrelated candidate audit`, () => {
  const state = setup(), [run] = state.claimChatWork(post(state).id), before = structuredClone(state.participationDecisions);
  if (mutation === 'disable') state.config.participationSubscriptions![0]!.enabled = false;
  if (mutation === 'revision') state.config.participationSubscriptions![0]!.revision++;
  if (mutation === 'remove') delete state.config.participationSubscriptions;
  if (mutation === 'revoke') state.config.grants[1]!.revoked = true;
  assert.throws(() => state.currentRun('sam', run!.id, 'read')); assert.deepEqual(state.participationDecisions, before);
});
test('same-slot candidates share one Task and missing execution permission does not starve next agent', () => {
  for (const firstAllowed of [true, false]) {
    const state = setup(); state.config.members.push({ id: 'other', name: 'Other', kind: 'agent' });
    state.config.memberships.other = [scope]; state.config.grants.push({ ...state.config.grants[1]!, id: 'other-grant', memberId: 'other' });
    state.config.participationSubscriptions!.push(sub('other'));
    if (!firstAllowed) state.config.grants[1]!.actions = ['read'];
    const runs = state.claimChatWork(post(state).id); assert.equal(runs.length, 1); assert.equal(state.tasks.size, 1);
    assert.equal(runs[0]!.memberId, firstAllowed ? 'sam' : 'other');
  }
});
test('complementary responsibilities claim separate canonical slots', () => {
  const state = setup(); state.config.participationSubscriptions![0]!.responsibilities.push('source_verification');
  assert.equal(state.claimChatWork(post(state).id).length, 2); assert.equal(state.tasks.size, 2);
});
test('dev HTTP dispatch completes fixture into source thread once', async t => {
  const env = await environment(); t.after(() => env.dispose()); env.state.config.participationSubscriptions = [sub()];
  const sent = await env.post('please research a protocol', 'one'); const run = await env.completed();
  assert.equal(run.sourceMessageId, sent.message.id); assert.equal(runResult(env.state, run).length, 1);
  await env.post('please research a protocol', 'one'); assert.equal(env.state.tasks.size, 1);
});
test('private ingress persists claim/binding atomically and rejects lease-bearing unbound reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vit138-')), store = new SnapshotStore(join(dir, 'test.db'));
  const engine = new PrivateEngine(store, config()), app = privateService(engine), url = await listen(app);
  t.after(async () => { await close(app); store.close(); await rm(dir, { recursive: true, force: true }); });
  const send = (text: string, key: string) => requestJson<{ message: Message }>(url, DEV.humanToken, '/messages', { ...scope, text, clientEventId: key });
  await send('earlier context', 'earlier'); const { message } = await send('please research protocol', 'one');
  assert.equal(engine.state.tasks.size, 1); assert.equal(engine.state.snapshot().participationBindings.length, 1);
  for (const headers of [{ 'x-coseat-instance': 'worker' }, { 'x-coseat-lease': 'lease' }, { 'x-coseat-instance': 'worker', 'x-coseat-lease': 'lease' }]) {
    const response = await fetch(`${url}/messages?${query}`, { headers: { Authorization: `Bearer ${DEV.agentToken}`, ...headers } });
    assert.equal(response.status, 400); assert.match(await response.text(), /run_required/);
  }
  const normal = await requestJson<{ messages: Message[] }>(url, DEV.agentToken, `/messages?${query}`); assert.equal(normal.messages.length, 2);
  const delivery = engine.commit(() => engine.poll('sam', 'worker'));
  assert.equal(delivery.command, 'execute');
  const bounded = await requestJson<{ messages: Message[] }>(url, DEV.agentToken, `/messages?${query}&runId=${delivery.runId}`, undefined, undefined,
    { 'x-coseat-instance': 'worker', 'x-coseat-lease': delivery.leaseId! });
  assert.deepEqual(bounded.messages.map(m => m.id), [message.id]);
  const save = store.save; store.save = () => { throw new Error('synthetic_disk_failure'); };
  await assert.rejects(send('please research rollback', 'rollback')); store.save = save;
  assert.equal(engine.state.tasks.size, 1); assert.equal(engine.state.messages.size, 2); assert.ok(engine.state.messages.has(message.id));
  const restored = setup(); restored.restore(engine.state.snapshot()); assert.equal(restored.snapshot().participationBindings.length, 1);
});

test('enabling opt-in fences legacy unbound active runs and snapshots', () => {
  const state = setup(); delete state.config.participationSubscriptions;
  const [run] = state.claimChatWork(post(state).id), saved = state.snapshot();
  state.config.participationSubscriptions = [];
  assert.throws(() => state.readMessages('sam', scope, run!.id), /participation_binding_required/);
  const restored = setup(); restored.restore(saved);
  assert.throws(() => restored.currentRun('sam', run!.id, 'read'), /participation_binding_required/);
});
test('fresh read grant after removal/re-add cannot reactivate an old subscription', () => {
  const state = setup(); const manager = state.config.grants[0]!;
  manager.actions.push('manage_workspace', 'grant_permissions', 'manage_resource');
  state.config.policy = { version: 1, roles: [], disabledActions: [] };
  state.config.conversationCreation = { authorityScope: scope, allowedActions: ['read', 'send', 'manage_resource', 'claim', 'request_approval'], maxGrantDurationMs: 300000 };
  const { conversation } = state.createConversation('alex', { kind: 'group', title: 'Group', memberIds: ['alex', 'sam'], clientEventId: 'group',
    initialGrants: [{ targetMemberId: 'alex', actions: ['read', 'send', 'manage_resource'], expiresAt: 100000 }, { targetMemberId: 'sam', actions: ['read'], expiresAt: 100000 }] });
  state.config.participationSubscriptions = [{ ...sub(), conversationId: conversation.conversationId, threadId: conversation.threadId }];
  state.removeScopeMember('alex', 'sam', conversation, 1, 'remove');
  state.addScopeMember('alex', 'sam', conversation, 2, 'readd', { actions: ['read'], expiresAt: 100000 });
  assert.equal(state.visible('sam', conversation), true);
  const message = state.createMessage('alex', conversation, 'please research', 'after').message;
  assert.equal(state.participationContexts(message.id)[0]!.decision.reason, 'membership_changed');
  const restored = new ControlState(state.config, () => 100); restored.restore(state.snapshot());
  assert.equal(restored.visible('sam', conversation), true);
  assert.equal(restored.participationContexts(message.id)[0]!.decision.reason, 'membership_changed');
});

test('opt-in edit activates quiet dev input; duplicate edit and retract never reexecute', async t => {
  const env = await environment(); t.after(() => env.dispose()); env.state.config.participationSubscriptions = [sub()];
  const { message } = await env.post('ordinary context');
  const edit = { expectedRevision: 1, clientEventId: 'edit', text: 'please research protocol' };
  await requestJson(env.url, DEV.humanToken, `/messages/${message.id}/edit`, edit);
  await env.completed(); assert.equal(env.state.tasks.size, 1);
  await requestJson(env.url, DEV.humanToken, `/messages/${message.id}/edit`, edit);
  await requestJson(env.url, DEV.humanToken, `/messages/${message.id}/retract`, { expectedRevision: 2, clientEventId: 'retract' });
  assert.equal(env.state.runs.size, 1);
});
