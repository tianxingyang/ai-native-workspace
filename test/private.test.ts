import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { parseControlConfig, parseWorkerConfig, protectedOrigin } from '../src/private/config.js';
import { SnapshotStore } from '../src/private/store.js';
import { PrivateEngine, type Delivery } from '../src/private/engine.js';
import { privateService } from '../src/private/service.js';
import { OutboundWorker } from '../src/private/outbound-worker.js';
import { fakeExecution, fixtureResult } from '../src/worker/fake.js';
import { LocalRuntime } from '../src/worker/runtime.js';
import { ControlState } from '../src/control/state.js';
import { close, listen, requestJson } from '../src/http.js';
import { type Message, type Run, terminal } from '../src/contracts.js';
import { expectStatus, gate, waitFor } from './helpers.js';
import { defaultPolicy } from '../src/control/authorization.js';

test('configured templates and independent action grants execute through outbound HTTP tools', async t => {
  const env = await setup(t);
  env.config.control.policy = defaultPolicy();
  const original = env.config.control.grants.find(g => g.memberId === 'agent1')!;
  env.config.control.grants = env.config.control.grants.filter(g => g.id !== original.id);
  for (const action of original.actions) env.config.control.grants.push({ ...original, id: `split-${action}`, actions: [action] });
  const owner = env.config.control.grants.find(g => g.memberId === 'owner1')!;
  owner.actions = []; owner.roleIds = ['collaborator'];
  await env.post();
  const run = await env.run(env.worker());
  assert.equal(run.status, 'completed');
  assert.equal(new Set(run.work.authorization!.grants.map(g => g.id)).size, 4);
  assert.ok(env.engine.state.audit.some(a => a.policyVersion === 1 && a.reason === 'allowed'));
});

test('deny policy controls session hints and HTTP sending; cancellation remains independent', async t => {
  const env = await setup(t); await env.post();
  const owner = env.config.control.grants.find(g => g.memberId === 'owner1')!;
  env.config.control.grants.push({ ...owner, id: 'deny-owner-send', actions: ['send'], effect: 'deny' });
  const session = await requestJson<{ scopes: { permissions: { send: number; cancel: number } }[] }>(env.url, secrets.COSEAT_OWNER_TOKEN, '/session');
  assert.equal(session.scopes[0]!.permissions.send, 0); assert.ok(session.scopes[0]!.permissions.cancel > Date.now());
  await expectStatus(env.post('denied'), 403, 'scope_denied');
  const run = [...env.engine.state.runs.values()][0]!;
  const receipt = await requestJson<{ status: string }>(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${run.id}/cancel`, {});
  assert.equal(receipt.status, 'stopped');
  assert.ok(env.engine.store.loadAudit<ControlState['audit']>()!.some(a => a.reason === 'explicit_deny'));
});

test('policy changes reject late HTTP results and startup configuration changes have a credential-free audit', async t => {
  const env = await setup(t);
  const initial = env.engine.store.loadAuthorizationConfiguration()!;
  await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'policy-instance'));
  const run = env.engine.state.runs.get(delivery.runId!)!;
  env.config.control.policy = defaultPolicy();
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', { runId: run.id, result: fixtureResult() }, undefined, { 'x-coseat-instance': 'policy-instance', 'x-coseat-lease': delivery.leaseId! }), 409, 'policy_revision_changed');
  assert.equal(env.engine.state.messages.size, 1);
  assert.ok(env.engine.store.loadAudit<ControlState['audit']>()!.some(a => a.reason === 'policy_revision_changed' && a.grantRevisions!.length === 4));
  await env.restart();
  const changed = env.engine.store.loadAuthorizationConfiguration()!;
  assert.equal(changed.changes.length, 2); assert.equal(changed.changes[1]!.previousDigest, initial.digest);
  assert.deepEqual(changed.changes[0]!.configuration, initial.configuration);
  for (const secret of Object.values(secrets)) assert.equal(JSON.stringify(changed).includes(secret), false);
  assert.equal(JSON.stringify(changed).includes('tokens'), false);
  await env.restart(); assert.equal(env.engine.store.loadAuthorizationConfiguration()!.changes.length, 2);
});

test('configuration accepts composed roles and denies, rejects malformed authorization data', async t => {
  const env = await setup(t), config = rawConfig(env.path);
  const grant = config.grants[0]!;
  const raw = { ...config, policy: defaultPolicy(), grants: [{ ...grant, actions: [], roleIds: ['read-only', 'resource-admin'], effect: 'allow' }, ...config.grants.slice(1)] };
  const state = new ControlState(parseControlConfig(raw, secrets).control);
  assert.equal(state.authorization('owner1', 'read', scope).allowed, true);
  assert.equal(state.authorization('owner1', 'send', scope).allowed, false);
  for (const change of [{ roleIds: ['missing'] }, { effect: 'denny' }, { revoked: 'true' }, { actions: ['typo'] }]) {
    assert.throws(() => parseControlConfig({ ...raw, grants: [{ ...raw.grants[0], ...change }, ...raw.grants.slice(1)] }, secrets));
  }
});

// Synthetic, process-local test values, never deployment credentials.
const secrets = { COSEAT_OWNER_TOKEN: randomBytes(32).toString('hex'), COSEAT_AGENT_TOKEN: randomBytes(32).toString('hex'), COSEAT_OTHER_TOKEN: randomBytes(32).toString('hex') };
const scope = { conversationId: 'trial-room', threadId: 'research-thread' };
test('message changes enforce author/read/send, optimistic versions and durable idempotent retries', async t => {
  const env = await setup(t), { message } = await env.post();
  const path = `/messages/${message.id}/edit`;
  const body = { expectedRevision: 1, clientEventId: 'edit-once', text: '请调研新的上下文' };
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, path, body), 403, 'message_change_denied');
  const owner = env.config.control.grants.find(g => g.memberId === 'owner1')!;
  const actions = [...owner.actions]; owner.actions = ['read', 'cancel'];
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, body), 403, 'scope_denied');
  owner.actions = ['send'];
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, body), 403, 'scope_denied');
  owner.actions = actions;
  const responses = await Promise.all(Array.from({ length: 4 }, () => requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, path, body)));
  assert.equal(responses.filter(r => !r.duplicate).length, 1);
  assert.equal(new Set(responses.map(r => r.change.id)).size, 1);
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, { ...body, text: 'different' }), 409, 'idempotency_key_conflict');
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, { ...body, clientEventId: 'stale' }), 409, 'message_revision_conflict');
  await env.restart();
  const retry = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, path, body);
  assert.equal(retry.duplicate, true); assert.equal(retry.message.revision, 2);
  assert.equal(env.engine.state.changes.size, 1);
  owner.actions = ['read'];
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, body), 403);
});

test('editing loaded sibling context fences late output and rebuilds a fresh session after stop evidence', async t => {
  const hold = gate(); t.after(() => { hold.release(); return Promise.resolve(); });
  const env = await setup(t);
  let count = 0;
  const worker = env.worker(async (...args) => {
    count++;
    if (count === 1) { args[5](); await hold.promise; }
    await fakeExecution(0)(...args);
  });
  const sibling = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages', { ...scope, text: '参考旧背景', clientEventId: 'sibling' });
  await env.post(); const delivery = await worker.step();
  await waitFor(() => count === 1);
  const original = env.engine.state.runs.get(delivery.runId!)!;
  const response = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages/${sibling.message.id}/edit`, { expectedRevision: 1, clientEventId: 'sibling-edit', text: '新的背景' });
  assert.ok(response.change.affectedRunIds.includes(original.id));
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', { runId: original.id, result: fixtureResult() }, undefined, { 'x-coseat-instance': worker.instanceId, 'x-coseat-lease': delivery.leaseId! }), 409, 'lease_not_executable');
  assert.equal((await worker.step()).command, 'cancel');
  assert.equal(env.engine.state.runs.size, 1); assert.equal(count, 1);
  hold.release();
  const completed = await waitFor(async () => {
    await worker.step();
    return [...env.engine.state.runs.values()].find(r => r.id !== original.id && r.status === 'completed');
  }, 10000);
  const settled = env.engine.state.runs.get(original.id)!;
  assert.equal(settled.status, 'stopped');
  assert.ok(settled.events.some(e => e.kind === 'stopped' && e.data.executionSettled === true));
  assert.notEqual(completed.sessionId, settled.sessionId);
  assert.equal(completed.work.contextRevision, 2); assert.equal(completed.work.source.revision, 1);
  assert.equal(count, 2);
  assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research' && !m.invalidated).length, 1);
});

test('retraction fences leased work across restart, redacts reads and never reruns its source', async t => {
  const env = await setup(t), { message } = await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'disconnected'));
  const path = `/messages/${message.id}/retract`, body = { expectedRevision: 1, clientEventId: 'retract-1' };
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, path, body);
  await env.restart();
  const other = env.engine.commit(() => env.engine.poll('agent1', 'new-worker'));
  assert.equal(other.command, 'blocked');
  assert.equal(env.engine.state.runs.size, 1);
  const read = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages?${new URLSearchParams(scope)}`);
  assert.equal(read.messages[0].retracted, true); assert.equal(read.messages[0].text, '');
  assert.equal((await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, path, body)).duplicate, true);
  const command = env.engine.commit(() => env.engine.poll('agent1', 'disconnected'));
  assert.equal(command.command, 'cancel');
  env.engine.commit(() => env.engine.notStarted('agent1', 'disconnected', delivery.leaseId!));
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'disconnected')).command, 'idle');
  assert.equal(env.engine.state.runs.size, 1);
});

test('expired lease after edit stays unknown and blocks replacements until actual reconciliation', async t => {
  let now = Date.now(); const env = await setup(t, () => now), { message } = await env.post();
  env.engine.commit(() => env.engine.poll('agent1', 'lost'));
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'lost-edit', text: '请调研新的要求' });
  now += 11000; env.engine.commit(() => env.engine.sweep());
  assert.equal([...env.engine.state.runs.values()][0]!.status, 'unknown');
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'replacement')).command, 'blocked');
  assert.equal(env.engine.state.runs.size, 1);
});

test('publishing before retraction retains receipt but removes obsolete result content from reads', async t => {
  const env = await setup(t), { message } = await env.post();
  const run = await env.run(env.worker()); assert.ok(run.receiptId);
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages/${message.id}/retract`, { expectedRevision: 1, clientEventId: 'after-publish' });
  const read = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages?${new URLSearchParams(scope)}`);
  assert.ok(read.messages.every((m: Message) => m.text === '' && !m.result));
  assert.equal(read.messages[1].invalidated, true); assert.ok(run.receiptId);
  for (const path of [`/runs?${new URLSearchParams(scope)}`, `/runs/${run.id}`]) {
    const view = await requestJson<any>(env.url, secrets.COSEAT_OWNER_TOKEN, path);
    assert.equal(JSON.stringify(view).includes(fixtureResult().conclusion), false);
    const projected = view.runs?.[0] ?? view;
    assert.equal(projected.contextInvalidated, true); assert.equal(projected.receiptId, run.receiptId);
  }
  assert.ok(JSON.stringify(run.events).includes(fixtureResult().conclusion), 'internal replay ledger stays intact');
  assert.equal(env.engine.state.runs.size, 1);
});

test('new research accepted while stale execution is stopping survives restart and remains queued', async t => {
  const env = await setup(t), { message } = await env.post();
  const old = env.engine.commit(() => env.engine.poll('agent1', 'busy'));
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'queued-edit', text: '请调研修改后的请求' });
  const next = await env.post('new-intent');
  const queued = [...env.engine.state.runs.values()].find(r => r.sourceMessageId === next.message.id)!;
  assert.ok(queued); assert.equal(queued.status, 'queued'); assert.equal(queued.sessionId, undefined);
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'busy')).command, 'cancel');
  await env.restart();
  assert.equal(env.engine.state.runs.get(queued.id)!.status, 'queued');
  env.engine.commit(() => env.engine.notStarted('agent1', 'busy', old.leaseId!));
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'busy'));
  assert.equal(delivery.command, 'execute'); assert.equal(delivery.runId, queued.id);
});

test('editing after a user cancellation does not revive the cancelled task', async t => {
  const env = await setup(t), { message } = await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'user-cancel'));
  env.engine.commit(() => env.engine.cancel('owner1', delivery.runId!));
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'cancel-edit', text: '请调研新的要求' });
  env.engine.commit(() => env.engine.notStarted('agent1', 'user-cancel', delivery.leaseId!));
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'user-cancel')).command, 'idle');
  assert.equal(env.engine.state.runs.size, 1);
});
function rawConfig(path: string) {
  return { version: 2, mode: 'private-mock', databasePath: path, port: 0, researchMemberId: 'agent1',
    members: [ ['owner1', 'human', 'COSEAT_OWNER_TOKEN'], ['agent1', 'agent', 'COSEAT_AGENT_TOKEN'], ['agent2', 'agent', 'COSEAT_OTHER_TOKEN'] ].map(([id, kind, tokenEnv]) => ({ id, kind, name: id, tokenEnv, tokenExpiresAt: Date.now() + 3600000, scopes: [scope] })),
    grants: ['owner1', 'agent1', 'agent2'].map(memberId => ({ id: `grant-${memberId}`, memberId, ...scope, revision: 1, actions: ['read', 'send', 'claim', 'request_approval', 'cancel'], expiresAt: Date.now() + 3600000 })) };
}
async function setup(t: { after: (fn: () => Promise<void>) => void }, clock?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-private-'));
  const path = join(directory, 'control.sqlite');
  const config = parseControlConfig(rawConfig(path), secrets);
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config.control, 10000, clock);
  let service = privateService(engine), url = await listen(service);
  const workers: OutboundWorker[] = [];
  const api = {
    directory, path, config, get engine() { return engine; }, get url() { return url; },
    worker(execute = fakeExecution(0), memberId = 'agent1') {
      const worker = new OutboundWorker({ memberId, token: memberId === 'agent1' ? secrets.COSEAT_AGENT_TOKEN : secrets.COSEAT_OTHER_TOKEN, controlUrl: url, provider: 'fake', workspace: directory }, execute);
      workers.push(worker); return worker;
    },
    async post(key = 'source-1') { return requestJson<{ message: Message }>(url, secrets.COSEAT_OWNER_TOKEN, '/messages', { ...scope, text: '请调研一下插件协议', clientEventId: key }); },
    async restart(restored = false) {
      const port = Number(new URL(url).port); await close(service); store.close();
      store = new SnapshotStore(path); engine = new PrivateEngine(store, config.control, 10000, clock, restored);
      service = privateService(engine); url = await listen(service, port);
      // A restart can reset a pooled socket. Only retry the read-only health probe.
      await waitFor(async () => { try { await requestJson(url, secrets.COSEAT_OWNER_TOKEN, '/health'); return true; } catch { return undefined; } });
    },
    async run(worker: OutboundWorker) {
      return waitFor(async () => {
        try { await worker.step(); } catch { return undefined; } // Poll/events are idempotent; execution is not retried.
        return [...engine.state.runs.values()].find(r => terminal(r.status));
      }, 10000);
    },
  };
  t.after(async () => {
    for (const worker of workers) await worker.close();
    await close(service); store.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'coseat-private-')));
    await rm(directory, { recursive: true, force: true });
  });
  return api;
}

test('private configuration refuses missing auth, public fixture identities and unsafe transport without leaking secrets', async t => {
  const env = await setup(t);
  assert.throws(() => parseControlConfig(rawConfig(env.path), {}));
  assert.throws(() => parseControlConfig(rawConfig(env.path), { ...secrets, COSEAT_AGENT_TOKEN: 'dev-fixture-sam' }));
  assert.throws(() => parseControlConfig(rawConfig(env.path), { ...secrets, COSEAT_AGENT_TOKEN: 'synthetic-demo-agent-0000000000000000' }));
  const fixture = rawConfig(env.path); fixture.members[0]!.id = 'alex';
  assert.throws(() => parseControlConfig(fixture, secrets));
  assert.throws(() => protectedOrigin('http://service.example.invalid'));
  assert.throws(() => protectedOrigin('https://user:password@service.example.invalid'));
  assert.equal(protectedOrigin('https://service.example.invalid'), 'https://service.example.invalid');
  assert.throws(() => parseWorkerConfig({ version: 1, mode: 'private-mock', provider: 'live' }, secrets));
  const invalidPath = join(env.directory, 'bad-config.json');
  await writeFile(invalidPath, secrets.COSEAT_AGENT_TOKEN);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/private/control-main.js', import.meta.url))], { env: { ...process.env, COSEAT_CONFIG: invalidPath }, windowsHide: true, encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stdout, /startup_failed/);
  assert.equal((child.stdout + child.stderr).includes(secrets.COSEAT_AGENT_TOKEN), false);
});

test('outbound worker opens no inbound port and completes durable source-thread publication', async t => {
  const env = await setup(t), worker = env.worker(); await env.post();
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = function () { throw new Error('worker_must_not_listen'); } as typeof originalListen;
  let run: Run;
  try { run = await env.run(worker); } finally { Server.prototype.listen = originalListen; }
  assert.equal(run.status, 'completed'); assert.ok(run.receiptId);
  const receiptId = run.receiptId;
  await env.restart();
  assert.equal(env.engine.state.runs.get(run.id)?.receiptId, receiptId);
  assert.equal(env.engine.state.messages.size, 2);
  await env.post(); // Durable client key still returns the original message.
  assert.equal(env.engine.state.messages.size, 2); assert.equal(env.engine.state.runs.size, 1);
  const bytes = await readFile(env.path);
  for (const secret of Object.values(secrets)) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('private control configuration requires explicit independent credential deadlines', async t => {
  const env = await setup(t), config = rawConfig(env.path);
  const { credentialExpiresAt: _credentials, ...withoutCredentials } = env.config.control;
  assert.throws(() => new PrivateEngine(env.engine.store, withoutCredentials), /private_credential_expiry_required/);
  assert.throws(() => parseControlConfig({ ...config, version: 1 }, secrets), /private_configuration_v2_required/);
  const { tokenExpiresAt: _expiry, ...missingExpiry } = config.members[0]!;
  assert.throws(() => parseControlConfig({ ...config, members: [missingExpiry, ...config.members.slice(1)] }, secrets), /explicit_token_expiry_required/);
  for (const tokenExpiresAt of [0, -1, Infinity]) {
    assert.throws(() => parseControlConfig({ ...config, members: [{ ...config.members[0], tokenExpiresAt }, ...config.members.slice(1)] }, secrets), /explicit_token_expiry_required/);
  }
  config.members[0]!.tokenExpiresAt += 1000;
  assert.equal(parseControlConfig(config, secrets).control.credentialExpiresAt!.owner1, config.members[0]!.tokenExpiresAt);
  assert.notEqual(config.members[0]!.tokenExpiresAt, config.grants[0]!.expiresAt);
  // An expired entry must remain denied after restart without preventing other identities from starting.
  config.members[0]!.tokenExpiresAt = Date.now() - 1;
  config.grants[0]!.expiresAt = Date.now() - 1;
  const restarted = new ControlState(parseControlConfig(config, secrets).control);
  assert.throws(() => restarted.authenticate(secrets.COSEAT_OWNER_TOKEN), /credential_expired/);
  assert.equal(restarted.authenticate(secrets.COSEAT_AGENT_TOKEN), 'agent1');
});

test('credential expiry rejects both identities on all 11 HTTP route forms at the boundary (44 checks)', async t => {
  let now = Date.now(); const deadline = now + 5000, env = await setup(t, () => now);
  env.config.control.credentialExpiresAt!.owner1 = deadline;
  env.config.control.credentialExpiresAt!.agent1 = deadline;
  const query = new URLSearchParams(scope);
  const routes: [string, unknown?][] = [
    [`/messages?${query}`], [`/runs?${query}`], ['/runs/probe'], ['/messages', {}], ['/runs/probe/cancel', {}],
    ['/worker/poll', { instanceId: 'expiry-boot' }], ['/worker/events', {}], ['/worker/not-started', {}],
    ['/tools/send', {}], ['/tools/confirm-claim', {}], ['/tools/request-approval', {}],
  ];
  now = deadline - 1;
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages?${query}`);
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' })).command, 'idle');
  const before = env.engine.state.snapshot();
  for (const at of [deadline, deadline + 1]) {
    now = at;
    for (const token of [secrets.COSEAT_OWNER_TOKEN, secrets.COSEAT_AGENT_TOKEN]) {
      for (const [path, body] of routes) await expectStatus(requestJson(env.url, token, path, body), 401, 'credential_expired');
    }
  }
  assert.deepEqual(env.engine.state.snapshot(), before);
  await expectStatus(requestJson(env.url, 'invalid', '/worker/poll', {}), 401, 'invalid_identity');
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/poll', { instanceId: 'unexpired-member' })).command, 'idle');
  await requestJson(env.url, '', '/health'); // Health carries no identity or business facts.
});

test('idle long poll rechecks credential expiry after awaiting, before returning work or idle', async t => {
  let now = Date.now(); const deadline = now + 5000, env = await setup(t, () => now);
  env.config.control.credentialExpiresAt!.agent1 = deadline;
  const poll = env.engine.poll.bind(env.engine);
  t.mock.method(env.engine, 'poll', (actor: string, instance: string) => {
    const value = poll(actor, instance); now = deadline; return value;
  });
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' }), 401, 'credential_expired');
});

test('idle worker polling requires a current execution grant, including after the long-poll wait', async t => {
  let now = Date.now(); const deadline = now + 5000, env = await setup(t, () => now);
  env.config.control.grants.find(g => g.memberId === 'agent1')!.expiresAt = deadline;
  now = deadline - 1;
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' })).command, 'idle');
  const poll = env.engine.poll.bind(env.engine);
  const mocked = t.mock.method(env.engine, 'poll', (actor: string, instance: string) => {
    const value = poll(actor, instance); now = deadline; return value;
  });
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' }), 403, 'worker_poll_denied');
  mocked.mock.restore();
  for (const at of [deadline, deadline + 1]) {
    now = at;
    await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' }), 403, 'worker_poll_denied');
    assert.equal(env.engine.state.authenticate(secrets.COSEAT_AGENT_TOKEN), 'agent1');
    await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages?${new URLSearchParams(scope)}`);
  }
});

test('expired run grant denies events, results and stop reports without an expiry cleanup exception', async t => {
  let now = Date.now(); const deadline = now + 5000, env = await setup(t, () => now);
  env.config.control.grants.find(g => g.memberId === 'agent1')!.expiresAt = deadline;
  await env.post();
  const delivery = await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'expiry-boot' });
  const headers = { 'x-coseat-instance': 'expiry-boot', 'x-coseat-lease': delivery.leaseId! };
  const source = env.engine.state.runs.get(delivery.runId!)!.work.source;
  const report = { instanceId: 'expiry-boot', leaseId: delivery.leaseId };
  const event = { id: 'expiry-session:1', sequence: 1, sessionId: 'expiry-session', runId: delivery.runId, kind: 'stopped', status: 'stopped', at: now, data: { executionSettled: true } };
  const routes: [string, unknown?][] = [
    [`/messages?${new URLSearchParams(scope)}&runId=${delivery.runId}`],
    ['/tools/send', { runId: delivery.runId, result: fixtureResult() }],
    ['/tools/confirm-claim', { runId: delivery.runId, sourceMessageId: source.messageId, sourceRevision: source.revision }],
    ['/tools/request-approval', { runId: delivery.runId, action: 'read', reason: 'synthetic' }],
    ['/worker/events', { ...report, events: [event] }], ['/worker/not-started', report],
  ];
  now = deadline - 1;
  await requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/events', { ...report, events: [] });
  for (const at of [deadline, deadline + 1]) {
    now = at;
    for (const [path, body] of routes) await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, path, body, undefined, headers), 403);
  }
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.events.length, 0);
  assert.equal(env.engine.state.messages.size, 1);
  // Owner cancellation still uses the owner's independent, live read/cancel grant and is audited.
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${delivery.runId}/cancel`, {});
  assert.ok(env.engine.state.audit.some(a => a.actorId === 'owner1' && a.action === 'cancel' && a.allowed));
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/not-started', report), 403);
  now += 11000;
  assert.equal((await requestJson<Run>(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${delivery.runId}`)).status, 'unknown');
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.stopEvidence, undefined);
});

test('one expired grant does not disable another authorized resource or replace a run-bound grant', async t => {
  let now = Date.now(); const deadline = now + 5000, env = await setup(t, () => now);
  const other = { conversationId: 'other-room', threadId: 'research' };
  for (const member of ['owner1', 'agent1']) {
    const grant = env.config.control.grants.find(g => g.memberId === member)!;
    env.config.control.grants.push({ ...grant, ...other, id: `${grant.id}-other` });
    grant.expiresAt = deadline;
    env.config.control.memberships[member]!.push(other);
  }
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages', { ...other, text: '请调研协议', clientEventId: 'other-source' });
  const delivery = await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'other-boot' });
  assert.deepEqual(delivery.work!.route, other);
  now = deadline;
  for (const token of [secrets.COSEAT_OWNER_TOKEN, secrets.COSEAT_AGENT_TOKEN]) {
    await expectStatus(requestJson(env.url, token, `/messages?${new URLSearchParams(scope)}`), 403);
    await requestJson(env.url, token, `/messages?${new URLSearchParams(other)}`);
  }
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'other-boot' })).command, 'execute');
  const headers = { 'x-coseat-instance': 'other-boot', 'x-coseat-lease': delivery.leaseId! };
  await requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', { runId: delivery.runId, result: fixtureResult() }, undefined, headers);
  // A fresh grant in the same scope cannot silently renew an older WorkPackage's deadline.
  const bound = env.config.control.grants.find(g => g.id === delivery.work!.grant.id)!;
  env.config.control.grants.push({ ...bound, id: 'new-independent-grant' });
  bound.expiresAt = now;
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/events', { instanceId: 'other-boot', leaseId: delivery.leaseId, events: [] }), 403);
  await requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, `/messages?${new URLSearchParams(other)}`);
});

test('cross-member lease access and body identity spoofing are rejected', async t => {
  const env = await setup(t); await env.post();
  const delivery = await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'boot-1' });
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/events', { instanceId: 'boot-1', leaseId: delivery.leaseId, events: [] }), 403, 'lease_denied');
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/poll', { instanceId: 'boot-2', memberId: 'agent1' }), 400);
  // A human with the same execution grants may use a worker, but cannot consume another member's lease.
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_OWNER_TOKEN, '/worker/poll', { instanceId: 'boot-3' })).command, 'idle');
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/worker/events', { instanceId: 'boot-1', leaseId: delivery.leaseId, events: [] }), 403, 'lease_denied');
  env.config.control.grants.find(g => g.memberId === 'owner1')!.actions = ['read'];
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/worker/poll', { instanceId: 'boot-3' }), 403, 'worker_poll_denied');
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, '/tools/send', { runId: delivery.runId, result: fixtureResult() }, undefined, { 'x-coseat-lease': delivery.leaseId!, 'x-coseat-instance': 'boot-1' }), 403);
  assert.equal((await requestJson<Delivery>(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/poll', { instanceId: 'boot-2' })).command, 'idle');
});

test('duplicate deliveries and competing instances never start parallel work', async t => {
  const hold = gate(); t.after(async () => { hold.release(); });
  const env = await setup(t); let executions = 0;
  const worker = env.worker(async (...args) => { executions++; await hold.promise; await fakeExecution(0)(...args); });
  await env.post(); await worker.step(); await waitFor(() => executions === 1 ? true : undefined);
  await worker.step(); await worker.step();
  const competitor = env.worker(); assert.equal((await competitor.step()).command, 'blocked');
  assert.equal(executions, 1);
  hold.release(); assert.equal((await env.run(worker)).status, 'completed');
});

test('lease expiry fences late results and never reassigns unknown work', async t => {
  let now = Date.now(); const env = await setup(t, () => now); await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'original'));
  now += 11000;
  assert.equal((await requestJson<Run>(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${delivery.runId}`)).status, 'unknown');
  const competitor = env.engine.commit(() => env.engine.poll('agent1', 'replacement'));
  assert.equal(competitor.command, 'blocked');
  assert.equal(env.engine.state.runs.get(delivery.runId!)?.status, 'unknown');
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', { runId: delivery.runId, result: fixtureResult() }, undefined, { 'x-coseat-lease': delivery.leaseId!, 'x-coseat-instance': 'original' }), 409);
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'original')).command, 'cancel');
  assert.equal(env.engine.state.runs.size, 1);
});

test('lost assignment response expires and the original worker confirms it never created a session', async t => {
  let now = Date.now(), executions = 0, notStartedRequests = 0;
  const env = await setup(t, () => now), worker = env.worker(async () => { executions++; });
  const createSession = t.mock.method(LocalRuntime.prototype, 'createSession');
  await env.post();
  const runId = [...env.engine.state.runs.keys()][0]!;
  const originalFetch = globalThis.fetch;
  let lostDelivery: Delivery | undefined;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const path = new URL(String(input)).pathname;
    if (path === '/worker/poll' && !lostDelivery) {
      assert.equal(response.status, 200);
      lostDelivery = await response.json() as Delivery;
      assert.equal(lostDelivery.command, 'execute');
      throw new TypeError('injected_assignment_response_loss');
    }
    if (path === '/worker/not-started') notStartedRequests++;
    return response;
  };
  try {
    await assert.rejects(worker.step(), /injected_assignment_response_loss/);
    const saved = env.engine.store.load<{ leases: [string, { runId: string; instanceId: string }][] }>()!;
    assert.equal(saved.leases.length, 1);
    assert.equal(saved.leases[0]![0], lostDelivery!.leaseId);
    assert.equal(saved.leases[0]![1].instanceId, worker.instanceId);
    assert.equal(saved.leases[0]![1].runId, runId);
    assert.equal(createSession.mock.callCount(), 0);
    assert.equal(executions, 0);
    now += 11000;
    assert.equal((await requestJson<Run>(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${runId}`)).status, 'unknown');
    const cancellation = await worker.step();
    assert.equal(cancellation.command, 'cancel');
    assert.equal(cancellation.leaseId, lostDelivery!.leaseId);
    const stopped = env.engine.state.runs.get(runId)!;
    assert.equal(stopped.status, 'stopped');
    assert.deepEqual(stopped.stopEvidence, { scope: 'worker_acknowledged_not_started', executionStarted: false });
    assert.equal(stopped.sessionId, undefined); assert.equal(stopped.receiptId, undefined);
    assert.equal(stopped.events.length, 0);
    assert.equal((await worker.step()).command, 'idle');
    assert.equal(notStartedRequests, 1); assert.equal(createSession.mock.callCount(), 0);
    assert.equal(executions, 0); assert.equal(env.engine.state.runs.size, 1);
  } finally { globalThis.fetch = originalFetch; }
  await env.restart();
  assert.equal(env.engine.state.runs.get(runId)?.status, 'stopped');
  assert.equal(env.engine.state.messages.size, 1);
});

test('lost event acknowledgements replay complete batches without duplicate events or receipts and allow renewal', async t => {
  const hold = gate(); t.after(async () => { hold.release(); });
  let now = Date.now(), executions = 0, ready = false;
  let emit: ((data: Record<string, unknown>) => void) | undefined;
  const env = await setup(t, () => now);
  const worker = env.worker(async (_work, _input, tools, _signal, output) => {
    executions++; emit = output;
    await tools.sendMessage(fixtureResult()); ready = true;
    await hold.promise;
  });
  await env.post(); await worker.step(); await waitFor(() => ready ? true : undefined);
  const runId = [...env.engine.state.runs.keys()][0]!, receiptId = env.engine.state.runs.get(runId)!.receiptId;
  assert.ok(receiptId);
  emit!({ marker: 'deterministic_pending_event' });
  const originalFetch = globalThis.fetch;
  const batches: string[] = [];
  let loseNext = true;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === '/worker/events') {
      assert.equal(response.status, 200);
      batches.push(String(init!.body));
      if (loseNext) {
        loseNext = false; await response.arrayBuffer();
        throw new TypeError('injected_event_ack_loss');
      }
    }
    return response;
  };
  try {
    now += 9000;
    await assert.rejects(worker.step(), /injected_event_ack_loss/);
    const persisted = env.engine.store.load<{ state: { runs: [string, Run][] } }>()!.state.runs.find(([id]) => id === runId)![1];
    assert.ok(persisted.events.some(e => e.data.marker === 'deterministic_pending_event'));
    assert.equal(persisted.receiptId, receiptId);
    const count = persisted.events.length;
    assert.equal((await worker.step()).command, 'execute');
    assert.equal(batches[1], batches[0]); // Full request including every event is retransmitted unchanged.
    assert.equal(env.engine.state.runs.get(runId)!.events.length, count);
    now += 2000; // Beyond the original lease; the post-retry poll must have renewed it.
    assert.equal((await worker.step()).command, 'execute');
    assert.equal(env.engine.state.runs.get(runId)!.status, 'running');
    assert.equal(executions, 1); assert.equal(env.engine.state.messages.size, 2);

    // Lose the terminal batch acknowledgement too, after the publication receipt is already durable.
    hold.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    loseNext = true;
    const terminalBatch = batches.length;
    await assert.rejects(worker.step(), /injected_event_ack_loss/);
    const completed = env.engine.state.runs.get(runId)!;
    assert.equal(completed.status, 'completed');
    const finalCount = completed.events.length;
    assert.equal((await worker.step()).command, 'idle');
    assert.equal(batches[terminalBatch + 1], batches[terminalBatch]);
    assert.equal(completed.events.length, finalCount);
    assert.equal(new Set(completed.events.map(e => e.id)).size, finalCount);
    assert.equal(completed.receiptId, receiptId);
    assert.equal(executions, 1); assert.equal(env.engine.state.messages.size, 2);
  } finally { globalThis.fetch = originalFetch; hold.release(); }
  await env.restart();
  assert.equal(env.engine.state.runs.get(runId)?.receiptId, receiptId);
  assert.equal(env.engine.state.runs.get(runId)?.status, 'completed');
  assert.equal(env.engine.state.messages.size, 2);
});

test('cancel survives a control restart and reconnecting worker converges without repeating execution', async t => {
  const hold = gate(); t.after(async () => { hold.release(); });
  const env = await setup(t); let executions = 0;
  const worker = env.worker(async () => { executions++; await hold.promise; });
  await env.post(); await worker.step(); await waitFor(() => executions === 1 ? true : undefined);
  const runId = [...env.engine.state.runs.keys()][0]!;
  await requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${runId}/cancel`, {});
  // No worker polls while control is stopped: persisted cancellation must be delivered later.
  await env.restart(); assert.equal(env.engine.state.runs.get(runId)?.status, 'cancel_requested');
  const command = await waitFor(async () => { try { return await worker.step(); } catch { return undefined; } });
  assert.equal(command.command, 'cancel');
  hold.release(); const run = await env.run(worker);
  assert.equal(run.status, 'stopped'); assert.equal(executions, 1);
  assert.equal(env.engine.state.messages.size, 1);
});

test('restart running work is fenced until original worker reconciles; new boot does not replay', async t => {
  const env = await setup(t); await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'original'));
  await env.restart();
  assert.equal(env.engine.state.runs.get(delivery.runId!)?.status, 'unknown');
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'new-boot')).command, 'blocked');
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'original')).command, 'cancel');
  await expectStatus(requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', { runId: delivery.runId, result: fixtureResult() }, undefined, { 'x-coseat-lease': delivery.leaseId!, 'x-coseat-instance': 'original' }), 409);
});

test('durable duplicate events/results are idempotent, unknown result is inspected rather than reexecuted', async t => {
  const env = await setup(t); await env.post();
  const delivery = env.engine.commit(() => env.engine.poll('agent1', 'original'));
  const headers = { 'x-coseat-lease': delivery.leaseId!, 'x-coseat-instance': 'original' };
  const payload = { runId: delivery.runId, result: fixtureResult() };
  const first = await requestJson<{ receiptId: string }>(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', payload, undefined, headers);
  const second = await requestJson<{ receiptId: string }>(env.url, secrets.COSEAT_AGENT_TOKEN, '/tools/send', payload, undefined, headers);
  assert.equal(first.receiptId, second.receiptId);
  const event = { id: 'session:1', sequence: 1, sessionId: 'session', runId: delivery.runId, kind: 'status', status: 'completed', at: Date.now(), data: { receiptId: first.receiptId } };
  const report = { instanceId: 'original', leaseId: delivery.leaseId, events: [event] };
  await requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/events', report);
  await env.restart(); await requestJson(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/events', report);
  assert.equal(env.engine.state.runs.get(delivery.runId!)?.events.length, 1);
  assert.equal(env.engine.state.messages.size, 2);
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'new')).command, 'idle');
});

test('SQLite rolls back failed commits and rejects a second service; backup restore fences queued work', async t => {
  const env = await setup(t); await env.post();
  assert.throws(() => new SnapshotStore(env.path));
  const before = env.engine.state.messages.size;
  assert.throws(() => env.engine.commit(() => { env.engine.state.createMessage('owner1', scope, 'temporary', 'rolled-back'); throw new Error('injected_failure'); }));
  assert.equal(env.engine.state.messages.size, before);
  await env.restart(true);
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'new')).command, 'idle');
  assert.equal([...env.engine.state.runs.values()][0]?.status, 'unknown');
  const runId = [...env.engine.state.runs.keys()][0]!;
  assert.equal(env.engine.commit(() => env.engine.cancel('owner1', runId)).status, 'unknown');
});

test('denied HTTP reads, sends and cancellations retain audit while business state rolls back', async t => {
  const env = await setup(t); await env.post();
  env.config.control.grants.find(g => g.memberId === 'owner1')!.actions = ['read', 'send'];
  const runId = [...env.engine.state.runs.keys()][0]!;
  const forbidden = { conversationId: 'forbidden-room', threadId: 'private' };
  const { audit: _beforeAudit, ...before } = env.engine.state.snapshot();
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/messages?${new URLSearchParams(forbidden)}`), 403);
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages', { ...forbidden, text: 'must not persist', clientEventId: 'denied-send' }), 403);
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, `/runs/${runId}/cancel`, {}), 403);
  const { audit, ...after } = env.engine.state.snapshot();
  assert.deepEqual(after, before);
  assert.deepEqual(audit.filter(a => !a.allowed).map(a => a.action), ['read', 'send', 'cancel']);
  for (const entry of audit) assert.deepEqual(Object.keys(entry.resource).sort(), ['conversationId', 'threadId']);
  assert.deepEqual(env.engine.store.loadAudit(), audit);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, audit);
  const { audit: _restoredAudit, ...restored } = env.engine.state.snapshot();
  assert.deepEqual(restored, before);
});

test('denial after business mutations rolls back messages, claims and leases but retains bounded audit', async t => {
  const env = await setup(t);
  env.engine.commit(() => {
    for (let at = 0; at < 1000; at++) env.engine.state.audit.push({ actorId: 'owner1', action: 'read', allowed: true, resource: scope, at });
  });
  const { audit: _oldAudit, ...before } = env.engine.state.snapshot();
  assert.throws(() => env.engine.commit(() => {
    const { message } = env.engine.state.createMessage('owner1', scope, '请调研协议', 'rolled-back-source');
    env.engine.state.claim('agent1', message.id);
    assert.equal(env.engine.poll('agent1', 'rolled-back-boot').command, 'execute');
    env.engine.state.authorize('owner1', 'send', { conversationId: 'forbidden', threadId: 'private' });
  }), /scope_denied/);
  const { audit, ...after } = env.engine.state.snapshot();
  assert.deepEqual(after, before);
  assert.equal(audit.length, 1000); assert.equal(audit.at(-1)!.allowed, false);
  assert.deepEqual(env.engine.store.loadAudit(), audit);
  assert.deepEqual(env.engine.store.load<{ leases: unknown[] }>()!.leases, []);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, audit);
  assert.equal(env.engine.state.messages.size, 0); assert.equal(env.engine.state.runs.size, 0);
});

test('authorization audit commits independently when the business snapshot exceeds its storage limit', async t => {
  const env = await setup(t); const { message } = await env.post();
  const { audit: beforeAudit, ...before } = env.engine.state.snapshot();
  assert.throws(() => env.engine.commit(() => {
    env.engine.state.authorize('owner1', 'read', scope);
    env.engine.state.messages.get(message.id)!.text = 'x'.repeat(9 * 1024 * 1024);
  }), /trial_storage_limit/);
  const { audit, ...after } = env.engine.state.snapshot();
  assert.deepEqual(after, before); assert.equal(audit.length, beforeAudit.length + 1);
  assert.deepEqual(env.engine.store.loadAudit(), audit);
  const saved = env.engine.store.load<{ state: ReturnType<ControlState['snapshot']> }>()!;
  assert.equal(saved.state.messages.find(([id]) => id === message.id)![1].text, message.text);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, audit);
  const { audit: _restoredAudit, ...restored } = env.engine.state.snapshot();
  assert.deepEqual(restored, before);
});

test('audit storage failure reports 503 and rolls back business while retaining pending audit in memory', async t => {
  const env = await setup(t); await env.post();
  const { audit: beforeAudit, ...before } = env.engine.state.snapshot();
  const failure = t.mock.method(env.engine.store, 'saveAudit', () => { throw new Error('injected_audit_storage_failure'); });
  try {
    await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages?conversationId=forbidden&threadId=private'), 503, 'audit_persistence_failed');
    await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages', { ...scope, text: 'must roll back', clientEventId: 'audit-down' }), 503, 'audit_persistence_failed');
    const { audit, ...after } = env.engine.state.snapshot();
    assert.deepEqual(after, before);
    assert.equal(audit.filter(a => !a.allowed).length, 1);
    assert.deepEqual(env.engine.store.loadAudit(), beforeAudit); // No false claim of durability on failed I/O.
  } finally { failure.mock.restore(); }
  const pending = structuredClone(env.engine.state.audit);
  env.engine.commit(() => undefined); // A subsequent transaction flushes retained checks before business can commit.
  assert.deepEqual(env.engine.store.loadAudit(), pending);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, pending);
  const { audit: _restoredAudit, ...restored } = env.engine.state.snapshot();
  assert.deepEqual(restored, before);
});

test('legacy snapshot audit is recovered and stripped to scope identifiers before independent persistence', async t => {
  const env = await setup(t);
  const legacy = env.engine.state.snapshot();
  legacy.audit.push({ actorId: 'owner1', action: 'read', allowed: true, at: 1, resource: { ...scope, text: 'synthetic legacy message body' } as typeof scope });
  env.engine.store.save({ state: legacy, leases: [] });
  assert.equal(env.engine.store.loadAudit(), undefined);
  await env.restart();
  assert.deepEqual(env.engine.state.audit[0]!.resource, scope);
  assert.throws(() => env.engine.commit(() => env.engine.state.authorize('owner1', 'read', { conversationId: 'forbidden', threadId: 'private' })), /scope_denied/);
  const audit = env.engine.store.loadAudit<ControlState['audit']>()!;
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes('synthetic legacy message body'), false);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, audit);
});

test('first rejected request retains audit across restart before any business snapshot exists', async t => {
  const env = await setup(t);
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/messages?conversationId=forbidden&threadId=private'), 403);
  assert.equal(env.engine.store.load(), undefined);
  const audit = structuredClone(env.engine.state.audit);
  assert.equal(audit.length, 1); assert.equal(audit[0]!.allowed, false);
  assert.deepEqual(env.engine.store.loadAudit(), audit);
  await env.restart();
  assert.deepEqual(env.engine.state.audit, audit);
});

test('publication response loss keeps its durable receipt and never replays the uncertain action', async t => {
  const env = await setup(t); let executions = 0, sends = 0;
  const worker = env.worker(async (...args) => { executions++; await fakeExecution(0)(...args); });
  await env.post();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(String(input)).pathname === '/tools/send') {
      sends++;
      await response.arrayBuffer(); // The transaction committed; its HTTP reply is lost to the caller.
      throw new TypeError('injected_response_loss');
    }
    return response;
  };
  let run: Run;
  try { run = await env.run(worker); } finally { globalThis.fetch = originalFetch; }
  assert.equal(run.status, 'failed'); assert.ok(run.receiptId);
  assert.equal(executions, 1); assert.equal(sends, 1);
  await env.restart();
  assert.equal((await env.worker().step()).command, 'idle');
  assert.equal(env.engine.state.runs.get(run.id)?.receiptId, run.receiptId);
  assert.equal(env.engine.state.messages.size, 2);
  assert.equal(executions, 1); assert.equal(sends, 1);
});

test('offline SQLite backup restores the same committed snapshot without overwriting the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-private-backup-'));
  const source = join(directory, 'source.sqlite'), destination = join(directory, 'backup.sqlite');
  try {
    const store = new SnapshotStore(source); store.save({ evidence: 'synthetic', receipt: 'receipt-1' }); store.close();
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, destination); } finally { db.close(); }
    const restored = new SnapshotStore(destination);
    try { assert.deepEqual(restored.load(), { evidence: 'synthetic', receipt: 'receipt-1' }); } finally { restored.close(); }
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'coseat-private-backup-')));
    await rm(directory, { recursive: true, force: true });
  }
});
