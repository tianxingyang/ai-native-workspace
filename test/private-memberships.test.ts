import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlConfig } from '../src/control/state.js';
import type { Action, Message, RuntimeEvent } from '../src/contracts.js';
import type { MembershipRemoval } from '../src/control/memberships.js';
import { defaultPolicy } from '../src/control/authorization.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { fixtureResult } from '../src/worker/fake.js';
import { PrivateEngine, type Delivery } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const scope = { conversationId: 'group', threadId: 'main' }, other = { conversationId: 'private', threadId: 'main' };
const query = new URLSearchParams(scope).toString();
type Removal = { change: MembershipRemoval; duplicate: boolean };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-memberships-')), path = join(directory, 'state.sqlite');
  const identities = ['manager', 'member', 'worker', 'outsider'];
  const tokens = Object.fromEntries(identities.map(id => [id, randomBytes(32).toString('hex')]));
  const expiry = Date.now() + 600000;
  const grant = (memberId: string, resource: typeof scope, actions: Action[]) => ({ ...resource, id: `${memberId}-${resource.conversationId}`, memberId, actions, revision: 1, expiresAt: expiry, revoked: false });
  const config: ControlConfig = {
    members: identities.map(id => ({ id, name: id, kind: id === 'worker' ? 'agent' : 'human' })),
    tokens: Object.fromEntries(identities.map(id => [tokens[id]!, id])), credentialExpiresAt: Object.fromEntries(identities.map(id => [id, expiry])),
    memberships: { manager: [scope, other], member: [scope, other], worker: [scope], outsider: [other] },
    grants: [grant('manager', scope, ['manage_resource']), grant('manager', other, ['read', 'manage_resource']),
      grant('member', scope, ['read', 'send', 'cancel']), grant('member', other, ['read', 'send']),
      grant('worker', scope, ['read', 'send', 'claim', 'request_approval', 'cancel']), grant('outsider', scope, ['read']), grant('outsider', other, ['read'])],
    researchMemberId: 'worker', sources: fixtureSources, policy: defaultPolicy(),
  };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = <T = any>(actor: string, route: string, body?: unknown, headers?: Record<string, string>) => requestJson<T>(url, tokens[actor]!, route, body, undefined, headers);
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-memberships-'))); await rm(directory, { recursive: true, force: true }); });
  return { config, api, get engine() { return engine; },
    remove: (targetMemberId: string, expectedRevision = 1, clientEventId = 'remove-member', actor = 'manager') => api<Removal>(actor, '/memberships/remove', { ...scope, targetMemberId, expectedRevision, clientEventId }),
    post: () => api<{ message: Message }>('member', '/messages', { ...scope, text: '请调研一下协议', clientEventId: 'research-source' }),
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
}

test('resource management without read removes only scoped membership and persists through restart', async t => {
  const env = await setup(t);
  await expectStatus(env.api('manager', `/messages?${query}`), 403, 'scope_denied');
  await expectStatus(env.api('outsider', `/messages?${query}`), 403, 'scope_denied');
  await expectStatus(env.api('member', `/memberships?${query}`), 403, 'scope_denied');
  const before = await env.api('manager', `/memberships?${query}`);
  assert.equal(before.revision, 1); assert.equal(before.members.length, 3);
  const result = await env.remove('member'); assert.equal(result.change.revision, 2);
  assert.deepEqual(Object.keys(result).sort(), ['change', 'duplicate']);
  assert.deepEqual(env.config.memberships.member, [scope, other]); // No config/identity/Grant mutation.
  assert.ok(env.config.members.some(m => m.id === 'member')); assert.equal(env.config.grants.find(g => g.id === 'member-group')!.revoked, false);
  for (const path of [`/messages?${query}`, `/sync?${query}`, `/messages/receipt?${query}&clientEventId=prior`, `/messages/change-receipt?${query}&clientEventId=prior`]) {
    await expectStatus(env.api('member', path), 403, 'scope_denied');
  }
  await expectStatus(env.api('member', '/read-position', { ...scope, messageId: 'any' }), 403, 'scope_denied');
  const session = await env.api('member', '/session'); assert.deepEqual(session.scopes.map((s: any) => s.conversationId), [other.conversationId]);
  assert.equal((await env.api('worker', '/session')).scopes[0].members.some((m: any) => m.id === 'member'), false);
  await env.restart();
  await expectStatus(env.api('member', `/sync?${query}`), 403, 'scope_denied');
  assert.equal((await env.remove('member')).duplicate, true);
  assert.equal((await env.api('manager', `/memberships?${query}`)).revision, 2);
  await expectStatus(env.api('manager', `/messages?${query}`), 403, 'scope_denied');
});

test('membership changes enforce conflicts, explicit management denial and human/agent parity', async t => {
  const env = await setup(t);
  await expectStatus(env.remove('worker', 1, 'forbidden', 'member'), 403, 'scope_denied');
  const results = await Promise.allSettled([env.remove('member', 1, 'one'), env.remove('worker', 1, 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const denied = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(denied.reason.code, 'membership_revision_conflict');
  const successful = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Removal>).value;
  const id = successful.change.targetMemberId === 'member' ? 'one' : 'two';
  const target = successful.change.targetMemberId;
  assert.equal((await env.remove(target, 1, id)).change.id, successful.change.id);
  await expectStatus(env.remove('outsider', 2, id), 409, 'membership_request_conflict');
  env.config.grants.push({ ...env.config.grants[0]!, id: 'deny-manager', effect: 'deny' });
  await expectStatus(env.api('manager', `/memberships?${query}`), 403, 'scope_denied');
  const otherEnv = await setup(t);
  otherEnv.config.grants.find(g => g.memberId === 'worker')!.actions.push('manage_resource');
  assert.equal((await otherEnv.remove('member', 1, 'agent-manager', 'worker')).change.actorId, 'worker');
  assert.ok(otherEnv.config.policy!.disabledActions.includes('grant_permissions'));
});

test('failed membership persistence rolls back authorization, context and lease cancellation', async t => {
  const env = await setup(t); await env.post();
  const delivery = await env.api<Delivery>('worker', '/worker/poll', { instanceId: 'device-one' });
  const save = env.engine.store.save.bind(env.engine.store); env.engine.store.save = () => { throw new Error('injected save failure'); };
  await expectStatus(env.remove('worker'), 500, 'internal_error'); env.engine.store.save = save;
  assert.equal((await env.api('manager', `/memberships?${query}`)).revision, 1);
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'device-one' })).command, 'execute');
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.invalidatedBy, undefined);
  assert.equal((await env.remove('worker')).duplicate, false);
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.status, 'unknown');
});

test('removing a leased worker blocks old tools and stop reports without fabricating termination', async t => {
  const env = await setup(t); await env.post();
  const delivery = await env.api<Delivery>('worker', '/worker/poll', { instanceId: 'device-one' });
  const event: RuntimeEvent = { id: 'running', sequence: 1, sessionId: 'runtime-one', runId: delivery.runId!, kind: 'status', status: 'running', at: Date.now(), data: {} };
  await env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [event] });
  await env.remove('worker');
  const run = env.engine.state.runs.get(delivery.runId!)!;
  assert.equal(run.status, 'unknown'); assert.equal(run.stopEvidence, undefined); assert.equal(run.rebuildAfterInvalidation, false);
  await expectStatus(env.api('worker', '/worker/poll', { instanceId: 'device-one' }), 403, 'worker_poll_denied');
  await expectStatus(env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [] }), 403, 'scope_denied');
  await expectStatus(env.api('worker', '/worker/not-started', { instanceId: 'device-one', leaseId: delivery.leaseId }), 403, 'scope_denied');
  await expectStatus(env.api('worker', '/tools/send', { runId: run.id, result: fixtureResult() }, { 'x-coseat-instance': 'device-one', 'x-coseat-lease': delivery.leaseId! }), 409, 'lease_not_executable');
  await env.restart(); assert.equal(env.engine.state.runs.get(run.id)!.status, 'unknown');
  assert.equal(env.engine.state.rebuildInvalidated().length, 0);
});

test('removing another member cancels stale context and requires a real stop receipt without restarting', async t => {
  const env = await setup(t); await env.post();
  const delivery = await env.api<Delivery>('worker', '/worker/poll', { instanceId: 'device-one' });
  const first: RuntimeEvent = { id: 'running', sequence: 1, sessionId: 'runtime-one', runId: delivery.runId!, kind: 'status', status: 'running', at: Date.now(), data: {} };
  await env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [first] });
  await env.remove('member'); assert.equal(env.engine.state.runs.get(delivery.runId!)!.status, 'cancel_requested');
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'device-one' })).command, 'cancel');
  const stopped: RuntimeEvent = { ...first, id: 'stopped', sequence: 2, kind: 'stopped', status: 'stopped', data: { executionSettled: true } };
  await env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [stopped] });
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.status, 'stopped');
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'device-one' })).command, 'idle');
  assert.equal(env.engine.state.runs.size, 1);
});

test('queued work has not-started evidence and published output is invalidated on membership change', async t => {
  const queued = await setup(t); await queued.post(); await queued.remove('worker');
  const unleased = [...queued.engine.state.runs.values()][0]!;
  assert.equal(unleased.status, 'stopped'); assert.equal(unleased.stopEvidence!.executionStarted, false);
  const env = await setup(t); await env.post();
  const delivery = await env.api<Delivery>('worker', '/worker/poll', { instanceId: 'device-one' });
  await env.api('worker', '/tools/send', { runId: delivery.runId, result: fixtureResult() }, { 'x-coseat-instance': 'device-one', 'x-coseat-lease': delivery.leaseId! });
  assert.equal(env.engine.state.messages.size, 2);
  await env.remove('member');
  const sync = await env.api('worker', `/sync?${query}`);
  assert.ok(sync.messages.find((m: Message) => m.origin === 'research').invalidated);
  assert.equal(sync.messages.find((m: Message) => m.origin === 'research').text, '');
  assert.equal(JSON.stringify(sync).includes(fixtureResult().conclusion), false);
});

test('membership removal clears a stopped run waiting to rebuild after an earlier edit', async t => {
  const env = await setup(t), { message } = await env.post();
  const delivery = await env.api<Delivery>('worker', '/worker/poll', { instanceId: 'device-one' });
  const first: RuntimeEvent = { id: 'running', sequence: 1, sessionId: 'runtime-one', runId: delivery.runId!, kind: 'status', status: 'running', at: Date.now(), data: {} };
  await env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [first] });
  await env.api('member', `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'edit-before-removal', text: '请调研修改后的协议' });
  const stopped: RuntimeEvent = { ...first, id: 'stopped', sequence: 2, kind: 'stopped', status: 'stopped', data: { executionSettled: true } };
  await env.api('worker', '/worker/events', { instanceId: 'device-one', leaseId: delivery.leaseId, events: [stopped] });
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.rebuildAfterInvalidation, true);
  await env.remove('member');
  assert.equal((await env.api('worker', '/worker/poll', { instanceId: 'device-one' })).command, 'idle');
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.rebuildAfterInvalidation, false);
  assert.equal(env.engine.state.runs.size, 1);
});
