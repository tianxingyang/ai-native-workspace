import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { type Run, type Task } from '../src/contracts.js';
import { ControlState, type ControlConfig } from '../src/control/state.js';
import { controlService } from '../src/control/service.js';
import { RuntimeClient } from '../src/control/runtime-client.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { close, listen, requestJson } from '../src/http.js';
import { PrivateEngine } from '../src/private/engine.js';
import { privateService } from '../src/private/service.js';
import { SnapshotStore } from '../src/private/store.js';
import { expectStatus, gate } from './helpers.js';

const scope = { conversationId: 'integration-room', threadId: 'integration-thread' };
type Claim = { task: Task & { status: Run['status'] }; run: Run; duplicate: boolean; ownedByActor: boolean };
async function environment(t: { after(fn: () => Promise<void>): void }, kind: 'development' | 'private', now = Date.now) {
  const tokens = { owner: randomBytes(32).toString('hex'), other: randomBytes(32).toString('hex'), guest: randomBytes(32).toString('hex') };
  const config: ControlConfig = { members: [{ id: 'owner', kind: 'human', name: 'Owner' }, { id: 'other', kind: 'agent', name: 'Other' }, { id: 'guest', kind: 'human', name: 'Guest' }],
    tokens: Object.fromEntries(Object.entries(tokens).map(([actor, token]) => [token, actor])),
    credentialExpiresAt: { owner: now() + 3600000, other: now() + 3600000, guest: now() + 3600000 },
    memberships: { owner: [scope], other: [scope], guest: [] }, researchMemberId: 'other', sources: fixtureSources,
    grants: ['owner', 'other'].map(memberId => ({ id: `integration-grant-${memberId}`, revision: 1, memberId, ...scope,
      actions: ['read', 'send', 'claim', 'request_approval', 'cancel'], expiresAt: now() + 3600000, revoked: false })) };
  const directory = kind === 'private' ? await mkdtemp(join(tmpdir(), 'coseat-pr39-pr40-')) : undefined;
  const path = directory ? join(directory, 'control.sqlite') : undefined;
  let store = path ? new SnapshotStore(path) : undefined;
  let engine = store ? new PrivateEngine(store, config, 10000, now) : undefined;
  let state = engine?.state ?? new ControlState(config, now);
  const app = kind === 'development' ? controlService(state, new RuntimeClient('http://127.0.0.1:1', 'unused-synthetic-runtime'), { autoDispatch: false }) : undefined;
  let service = app?.service ?? privateService(engine!);
  let audit = engine?.requestAudit ?? app!.requestAudit, url = await listen(service);
  t.after(async () => {
    if (app) { app.stop(); await app.drain(); }
    await close(service); store?.close();
    if (directory) {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); assert.ok(directory.includes('coseat-pr39-pr40-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { tokens, config, get state() { return state; }, get audit() { return audit; }, get store() { return store; }, get url() { return url; },
    source() { const create = () => state.createMessage('owner', scope, '请调研本地合成协议', 'integration-source').message; return engine ? engine.commit(create) : create(); },
    async restart() {
      assert.ok(path && store && engine && !app);
      await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config, 10000, now);
      state = engine.state; audit = engine.requestAudit; service = privateService(engine); url = await listen(service);
    } };
}
function input(sourceMessageId: string) { return { sourceMessageId, sourceRevision: 1, intent: 'research' }; }

test('combined development claim keeps strict input and presentClaim response while recording only controlled rejection data', async t => {
  const env = await environment(t, 'development'), source = env.source();
  await expectStatus(requestJson(env.url, env.tokens.owner, '/tools/claim', { ...input(source.id), workKey: 'private-integration-work-key' }), 400, 'invalid_claim_request');
  assert.equal(env.state.tasks.size, 0); assert.equal(env.state.runs.size, 0);
  assert.deepEqual(env.audit.snapshot().map(({ actorId, route, category, status }) => ({ actorId, route, category, status })),
    [{ actorId: 'owner', route: 'tool_claim', category: 'invalid_request', status: 400 }]);
  const first = await requestJson<Claim>(env.url, env.tokens.owner, '/tools/claim', input(source.id));
  assert.equal(first.task.slot, 'research'); assert.equal(first.task.ownerId, 'owner'); assert.equal(first.task.status, 'queued');
  assert.equal(first.task.id, first.run.taskId); assert.equal(first.ownedByActor, true); assert.equal(first.duplicate, false);
  const duplicate = await requestJson<Claim>(env.url, env.tokens.other, '/tools/claim', input(source.id));
  assert.equal(duplicate.task.id, first.task.id); assert.equal(duplicate.run.id, first.run.id); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.ownedByActor, false);
  const verification = await requestJson<Claim>(env.url, env.tokens.other, '/tools/claim', { ...input(source.id), slot: 'source_verification' });
  assert.notEqual(verification.task.id, first.task.id); assert.equal(verification.task.slot, 'source_verification');
  assert.equal(env.state.tasks.size, 2); assert.equal(env.state.runs.size, 2); assert.equal(env.audit.snapshot().length, 1);
  const serialized = JSON.stringify(env.audit.snapshot());
  for (const value of [...Object.values(env.tokens), source.id, first.task.workKey, 'private-integration-work-key']) assert.equal(serialized.includes(value), false);
});

test('combined private claim rejection and successful Task/Run identity survive independent audit persistence and restart', async t => {
  const env = await environment(t, 'private'), source = env.source();
  await expectStatus(requestJson(env.url, env.tokens.owner, '/tools/claim', { sourceMessageId: source.id, intent: 'research' }), 400, 'invalid_source_revision');
  await expectStatus(requestJson(env.url, env.tokens.owner, '/tools/claim', { ...input(source.id), sourceRevision: 2 }), 409, 'source_revision_changed');
  assert.equal(env.state.tasks.size, 0); assert.equal(env.state.runs.size, 0); assert.equal(env.state.snapshot().pendingDispatches.length, 0);
  const entries = env.audit.snapshot(); assert.deepEqual(env.store!.loadRequestAudit(), entries);
  const first = await requestJson<Claim>(env.url, env.tokens.owner, '/tools/claim', input(source.id));
  assert.equal(first.task.status, 'queued'); assert.equal(first.ownedByActor, true);
  await env.restart();
  assert.deepEqual(env.audit.snapshot(), entries);
  const duplicate = await requestJson<Claim>(env.url, env.tokens.other, '/tools/claim', input(source.id));
  assert.equal(duplicate.task.id, first.task.id); assert.equal(duplicate.run.id, first.run.id); assert.equal(duplicate.ownedByActor, false); assert.equal(duplicate.duplicate, true);
  assert.equal(env.state.tasks.size, 1); assert.equal(env.state.runs.size, 1); assert.equal(env.state.snapshot().pendingDispatches.length, 1);
});

test('combined private audit outage blocks claim creation and recovery flushes only audit, not a second task or dispatch', async t => {
  const env = await environment(t, 'private'), source = env.source();
  const failure = t.mock.method(env.store!, 'saveRequestAudit', () => { throw new Error('synthetic_integration_audit_failure'); });
  await expectStatus(requestJson(env.url, env.tokens.owner, '/tools/claim', { ...input(source.id), workKey: 'private-integration-work-key' }), 503, 'request_audit_persistence_failed');
  await expectStatus(requestJson(env.url, env.tokens.owner, '/tools/claim', input(source.id)), 503, 'request_audit_persistence_failed');
  assert.equal(env.state.tasks.size, 0); assert.equal(env.state.runs.size, 0); assert.equal(env.state.snapshot().pendingDispatches.length, 0);
  assert.equal(env.store!.loadRequestAudit(), undefined); const pending = env.audit.snapshot(); assert.equal(pending.length, 2);
  failure.mock.restore();
  await requestJson(env.url, env.tokens.owner, '/health');
  assert.deepEqual(env.store!.loadRequestAudit(), pending); assert.equal(env.state.tasks.size, 0); assert.equal(env.state.runs.size, 0);
  const first = await requestJson<Claim>(env.url, env.tokens.owner, '/tools/claim', input(source.id));
  assert.equal(first.duplicate, false); assert.equal(env.state.tasks.size, 1); assert.equal(env.state.runs.size, 1);
  await env.restart();
  assert.deepEqual(env.audit.snapshot(), pending);
  const duplicate = await requestJson<Claim>(env.url, env.tokens.owner, '/tools/claim', input(source.id));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.task.id, first.task.id); assert.equal(duplicate.run.id, first.run.id);
  assert.equal(env.state.snapshot().pendingDispatches.length, 1);
});

for (const kind of ['development', 'private'] as const) for (const mode of ['expiry', 'revocation', 'remapping'] as const) {
  test(`combined ${kind} segmented claim rejects ${mode} before Task/Run creation and keeps concurrent audit actors separate`, async t => {
    let now = Date.now(); const env = await environment(t, kind, () => now), source = env.source(), entered = gate();
    env.config.credentialExpiresAt!.owner = now + 1000;
    const authenticate = env.state.authenticate.bind(env.state);
    t.mock.method(env.state, 'authenticate', (token: string) => { const actor = authenticate(token); if (actor === 'owner') entered.release(); return actor; });
    const claim = t.mock.method(env.state, 'claim');
    let pending!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number; error: string }>((resolve, reject) => {
      pending = httpRequest(env.url, { path: '/tools/claim', method: 'POST', headers: { authorization: `Bearer ${env.tokens.owner}`, 'content-type': 'application/json' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, error: (JSON.parse(Buffer.concat(chunks).toString()) as { error: string }).error }));
        response.on('error', reject);
      });
      pending.on('error', reject); pending.setTimeout(5000, () => pending.destroy(new Error('test_request_timeout'))); pending.write('{');
    });
    await entered.promise;
    await expectStatus(requestJson(env.url, env.tokens.other, '/tools/claim', { ...input(source.id), workKey: 'private-concurrent-key' }), 400, 'invalid_claim_request');
    if (mode === 'expiry') now += 1000;
    else if (mode === 'revocation') delete env.config.tokens[env.tokens.owner];
    else env.config.tokens[env.tokens.owner] = 'guest';
    pending.end(JSON.stringify(input(source.id)).slice(1));
    assert.deepEqual(await result, { status: 401, error: mode === 'expiry' ? 'credential_expired' : 'invalid_identity' });
    assert.equal(claim.mock.callCount(), 0); assert.equal(env.state.tasks.size, 0); assert.equal(env.state.runs.size, 0); assert.equal(env.state.snapshot().pendingDispatches.length, 0);
    assert.deepEqual(env.audit.snapshot().map(({ actorId, route, category }) => ({ actorId, route, category })),
      [{ actorId: 'other', route: 'tool_claim', category: 'invalid_request' },
        { actorId: null, route: 'tool_claim', category: mode === 'expiry' ? 'credential_expired' : 'invalid_identity' }]);
    const serialized = JSON.stringify(env.audit.snapshot());
    for (const value of [...Object.values(env.tokens), source.id, 'private-concurrent-key']) assert.equal(serialized.includes(value), false);
  });
}
