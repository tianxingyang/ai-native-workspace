import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ApiError, type Message } from '../src/contracts.js';
import { ControlState, type ControlConfig } from '../src/control/state.js';
import { controlService } from '../src/control/service.js';
import { RuntimeClient } from '../src/control/runtime-client.js';
import { developmentGrants, fixtureSources, members } from '../src/dev-fixture.js';
import { close, listen, requestJson, respond, server } from '../src/http.js';
import { PrivateEngine } from '../src/private/engine.js';
import { privateService } from '../src/private/service.js';
import { SnapshotStore } from '../src/private/store.js';
import { REQUEST_AUDIT_LIMIT, RequestRejectionAudit, requestContext, type RequestRejection } from '../src/request-audit.js';
import { gate, scope } from './helpers.js';

const tokens = { alex: 'synthetic-audit-alex-token', sam: 'synthetic-audit-sam-token', guest: 'synthetic-audit-guest-token' };
function configuration(now: number): ControlConfig {
  return { members: structuredClone(members), grants: developmentGrants(), tokens: Object.fromEntries(Object.entries(tokens).map(([actor, token]) => [token, actor])),
    credentialExpiresAt: { alex: now + 3600000, sam: now + 3600000, guest: now + 3600000 },
    memberships: { alex: [scope], sam: [scope], guest: [] }, researchMemberId: 'sam', sources: fixtureSources };
}
async function privateEnvironment(t: { after(fn: () => Promise<void>): void }, clock = Date.now, web = false) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-request-audit-')), path = join(directory, 'control.sqlite');
  const config = configuration(clock());
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config, 10000, clock);
  let service = privateService(engine, { web }), url = await listen(service);
  t.after(async () => {
    await close(service); store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(directory.includes('coseat-request-audit-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, get engine() { return engine; }, get store() { return store; }, get url() { return url; },
    async restart() {
      await close(service); store.close();
      store = new SnapshotStore(path); engine = new PrivateEngine(store, config, 10000, clock);
      service = privateService(engine, { web }); url = await listen(service);
    } };
}
function raw(url: string, path: string, options: { token?: string; contentType?: string; body?: string; method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), path,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.contentType ? { 'content-type': options.contentType } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('test_request_timeout')));
    request.end(options.body);
  });
}
function last(audit: RequestRejectionAudit) { return audit.snapshot().at(-1)!; }
function assertPrivate(entries: RequestRejection[], forbidden: string[] = []) {
  const allowedKeys = ['actorId', 'at', 'category', 'method', 'requestId', 'route', 'status'];
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), allowedKeys);
    assert.match(entry.requestId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.ok(Number.isSafeInteger(entry.at));
  }
  const serialized = JSON.stringify(entries);
  for (const text of [...Object.values(tokens), ...forbidden]) assert.equal(serialized.includes(text), false);
}

test('private HTTP boundary audits missing, wrong and expired auth, invalid bodies and spoofing without request data', async t => {
  let now = Date.now(); const env = await privateEnvironment(t, () => now);
  const cases = [
    { path: '/messages', options: {}, status: 401, category: 'authentication_required', actorId: null },
    { path: '/messages', options: { token: 'untrusted-token-private-sentinel' }, status: 401, category: 'invalid_identity', actorId: null },
    { path: '/messages', options: { token: tokens.alex, body: 'body-private-sentinel', contentType: 'text/plain' }, status: 415, category: 'json_required', actorId: 'alex' },
    { path: '/messages', options: { token: tokens.alex, body: '{"private-body-sentinel":', contentType: 'application/json' }, status: 400, category: 'invalid_json', actorId: 'alex' },
    { path: '/messages', options: { token: tokens.alex, body: '[]', contentType: 'application/json' }, status: 400, category: 'invalid_request', actorId: 'alex' },
    { path: '/messages', options: { token: tokens.alex, body: JSON.stringify({ memberId: 'spoofed-private-actor', text: 'private-text' }), contentType: 'application/json' }, status: 400, category: 'identity_spoofing', actorId: 'alex' },
    { path: '/messages', options: { token: tokens.alex, body: JSON.stringify({ text: 'x'.repeat(65536) }), contentType: 'application/json' }, status: 413, category: 'body_too_large', actorId: 'alex' },
    { path: '/unknown-path-private-sentinel?secret=query-private-sentinel', options: { token: tokens.alex }, status: 404, category: 'not_found', actorId: 'alex' },
    { path: '/runs/dynamic-run-private-sentinel?secret=query-private-sentinel', options: { token: tokens.alex }, status: 404, category: 'not_found', actorId: 'alex' },
  ];
  for (const item of cases) {
    assert.equal((await raw(env.url, item.path, item.options)).status, item.status);
    const entry = last(env.engine.requestAudit);
    assert.equal(entry.status, item.status); assert.equal(entry.category, item.category); assert.equal(entry.actorId, item.actorId);
  }
  env.config.credentialExpiresAt!.alex = now;
  assert.equal((await raw(env.url, '/messages', { token: tokens.alex })).status, 401);
  assert.equal(last(env.engine.requestAudit).category, 'credential_expired'); assert.equal(last(env.engine.requestAudit).actorId, null);
  assert.equal(env.engine.requestAudit.snapshot()[7]!.route, 'unknown'); assert.equal(env.engine.requestAudit.snapshot()[8]!.route, 'run');
  assert.equal(env.engine.state.messages.size, 0); assert.equal(env.engine.state.runs.size, 0);
  const entries = env.engine.requestAudit.snapshot();
  assert.deepEqual(env.store.loadRequestAudit(), entries); assert.equal(new Set(entries.map(e => e.requestId)).size, entries.length);
  assertPrivate(entries, ['untrusted-token-private-sentinel', 'body-private-sentinel', 'private-body-sentinel', 'spoofed-private-actor', 'private-text',
    'unknown-path-private-sentinel', 'query-private-sentinel', 'dynamic-run-private-sentinel']);
  now++;
  await env.restart();
  assert.deepEqual(env.engine.requestAudit.snapshot(), entries);
});

test('first auth rejection persists before a business snapshot; successful health is not a rejection', async t => {
  const env = await privateEnvironment(t);
  assert.equal((await raw(env.url, '/health')).status, 200); assert.equal(env.engine.requestAudit.snapshot().length, 0);
  assert.equal((await raw(env.url, '/messages')).status, 401); assert.equal(env.store.load(), undefined);
  const entries = env.engine.requestAudit.snapshot();
  await env.restart(); assert.deepEqual(env.engine.requestAudit.snapshot(), entries);
  assert.equal(env.store.load(), undefined);
});

test('request rejection survives business rollback and remains separate from allowed authorization checks', async t => {
  const env = await privateEnvironment(t), before = env.engine.state.snapshot();
  const createMessage = env.engine.state.createMessage.bind(env.engine.state);
  t.mock.method(env.engine.state, 'createMessage', (...args: Parameters<ControlState['createMessage']>) => {
    createMessage(...args); throw new ApiError(409, 'private-exception-code-and-message-sentinel');
  });
  assert.equal((await raw(env.url, '/messages', { token: tokens.alex, contentType: 'application/json',
    body: JSON.stringify({ ...scope, text: 'private-message-rollback-sentinel', clientEventId: 'rollback' }) })).status, 409);
  const { audit, ...after } = env.engine.state.snapshot(), { audit: _beforeAudit, ...businessBefore } = before;
  assert.deepEqual(after, businessBefore); assert.ok(audit.some(entry => entry.allowed));
  assert.equal(last(env.engine.requestAudit).category, 'conflict');
  const entries = env.engine.requestAudit.snapshot(); assert.deepEqual(env.store.loadRequestAudit(), entries);
  assertPrivate(entries, ['private-exception-code-and-message-sentinel', 'private-message-rollback-sentinel']);
  await env.restart(); assert.deepEqual(env.engine.requestAudit.snapshot(), entries); assert.equal(env.engine.state.messages.size, 0);
});

test('private authorization, lease and protocol rejections have controlled categories without changing run history', async t => {
  const env = await privateEnvironment(t);
  const denied = await raw(env.url, `/messages?${new URLSearchParams(scope)}`, { token: tokens.guest });
  assert.equal(denied.status, 403); assert.equal(last(env.engine.requestAudit).category, 'authorization_denied');
  await requestJson(env.url, tokens.alex, '/messages', { ...scope, text: '请调研协议', clientEventId: 'lease-source' });
  const delivery = env.engine.commit(() => env.engine.poll('sam', 'worker-private-instance'));
  assert.equal(delivery.command, 'execute');
  assert.equal((await raw(env.url, '/worker/events', { token: tokens.alex, contentType: 'application/json', body: JSON.stringify({
    instanceId: 'worker-private-instance', leaseId: delivery.leaseId, events: [] }) })).status, 403);
  assert.equal(last(env.engine.requestAudit).category, 'lease_rejected'); assert.equal(last(env.engine.requestAudit).actorId, 'alex');
  const run = env.engine.state.runs.get(delivery.runId!)!, before = structuredClone(run);
  assert.equal((await raw(env.url, '/worker/events', { token: tokens.sam, contentType: 'application/json', body: JSON.stringify({
    instanceId: 'worker-private-instance', leaseId: delivery.leaseId, events: [{ id: 'private-event-id', sessionId: 'private-session-id',
      runId: 'private-wrong-run', sequence: 1, at: Date.now(), kind: 'status', status: 'running', data: {} }] }) })).status, 409);
  assert.equal(last(env.engine.requestAudit).category, 'protocol_rejected'); assert.deepEqual(env.engine.state.runs.get(run.id), before);
  assertPrivate(env.engine.requestAudit.snapshot(), ['worker-private-instance', delivery.leaseId!, delivery.runId!, 'private-event-id', 'private-session-id', 'private-wrong-run']);
});

test('audit I/O outage returns explicit 503, blocks new business, then flushes pending facts without replay', async t => {
  const env = await privateEnvironment(t), failure = t.mock.method(env.store, 'saveRequestAudit', () => { throw new Error('private-disk-error-sentinel'); });
  assert.deepEqual(await raw(env.url, '/messages'), { status: 503, body: '{"error":"request_audit_persistence_failed"}' });
  assert.equal(env.store.loadRequestAudit(), undefined); assert.equal(last(env.engine.requestAudit).category, 'authentication_required');
  const body = JSON.stringify({ ...scope, text: 'must-never-replay-private-sentinel', clientEventId: 'audit-down' });
  assert.equal((await raw(env.url, '/messages', { token: tokens.alex, contentType: 'application/json', body })).status, 503);
  assert.equal(env.engine.state.messages.size, 0); assert.equal(env.store.load(), undefined);
  assert.equal(last(env.engine.requestAudit).actorId, null); assert.equal(last(env.engine.requestAudit).category, 'storage_unavailable');
  const pending = env.engine.requestAudit.snapshot();
  failure.mock.restore(); assert.equal((await raw(env.url, '/health')).status, 200);
  assert.deepEqual(env.store.loadRequestAudit(), pending); assert.equal(env.engine.state.messages.size, 0);
  assertPrivate(pending, ['private-disk-error-sentinel', 'must-never-replay-private-sentinel']);
  await env.restart(); assert.deepEqual(env.engine.requestAudit.snapshot(), pending); assert.equal(env.engine.state.messages.size, 0);
});

test('pending rejection flood is bounded during storage failure and restores only the latest fixed records', () => {
  let fail = true, saved: readonly RequestRejection[] | undefined, now = 0;
  const audit = new RequestRejectionAudit({ loadRequestAudit() { return undefined; }, saveRequestAudit(entries) { if (fail) throw new Error('offline'); saved = entries; } }, () => ++now);
  for (let i = 0; i < 1020; i++) assert.throws(() => audit.record(requestContext('ATTACKER-METHOD'), new ApiError(403, `private-denial-${i}`)), /request_audit_persistence_failed/);
  assert.equal(audit.snapshot().length, REQUEST_AUDIT_LIMIT); assert.equal(audit.snapshot()[0]!.at, 21); assert.equal(last(audit).method, 'OTHER');
  fail = false; audit.flush(); assert.deepEqual(saved, audit.snapshot());
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 500000); assertPrivate(audit.snapshot(), ['private-denial-', 'ATTACKER-METHOD']);
  const poisoned = saved!.map(entry => ({ ...entry, rawBody: 'private-legacy-body' }));
  const restored = new RequestRejectionAudit({ loadRequestAudit() { return poisoned; }, saveRequestAudit() {} });
  assertPrivate(restored.snapshot(), ['private-legacy-body']);
  assert.throws(() => new RequestRejectionAudit({ loadRequestAudit() { return [{ ...saved![0], route: '/private-path' }]; }, saveRequestAudit() {} }), /request_audit_corrupt/);
});

test('development HTTP rejection flood bounds both request and pre-existing authorization ledgers', async t => {
  const state = new ControlState(configuration(Date.now()));
  const app = controlService(state, new RuntimeClient('http://127.0.0.1:1', 'unused-synthetic-runtime'), { autoDispatch: false });
  const url = await listen(app.service); t.after(async () => { app.stop(); await app.drain(); await close(app.service); });
  for (let i = 0; i < 1008; i++) assert.equal((await raw(url, `/messages?${new URLSearchParams(scope)}`, { token: tokens.guest })).status, 403);
  assert.equal(app.requestAudit.snapshot().length, 1000); assert.equal(state.audit.length, 1000);
  assert.equal(last(app.requestAudit).category, 'authorization_denied'); assert.equal(last(app.requestAudit).actorId, 'guest');
  assert.ok(state.audit.every(entry => !entry.allowed)); assert.equal(state.messages.size, 0); assert.equal(state.runs.size, 0);
});

test('development body-reading routes reauthenticate after segmented input expires or is revoked before any action', async t => {
  let now = Date.now(), entered = gate(); const state = new ControlState(configuration(now), () => now);
  const app = controlService(state, new RuntimeClient('http://127.0.0.1:1', 'unused-synthetic-runtime'), { autoDispatch: false });
  const url = await listen(app.service); t.after(async () => { app.stop(); await app.drain(); await close(app.service); });
  const authenticate = state.authenticate.bind(state);
  t.mock.method(state, 'authenticate', (token: string) => { const actor = authenticate(token); entered.release(); return actor; });
  const attempts = ['createMessage', 'claim', 'confirmClaim', 'publish', 'requestApproval', 'advanceReadPosition', 'changeMessage'] as const;
  const guards = attempts.map(method => t.mock.method(state, method, () => { throw new Error('operation_before_late_auth'); }));
  const paths = ['/messages', '/tools/claim', '/tools/confirm-claim', '/tools/send', '/tools/request-approval', '/read-position', '/messages/private-target/edit', '/messages/private-target/retract'];
  for (const mode of ['expires', 'revoked'] as const) for (const path of paths) {
    entered = gate(); state.config.tokens[tokens.alex] = 'alex'; state.config.credentialExpiresAt!.alex = now + 1000;
    let pending!: ReturnType<typeof httpRequest>;
    const result = new Promise<number>((resolve, reject) => {
      pending = httpRequest(url, { path, method: 'POST', headers: { authorization: `Bearer ${tokens.alex}`, 'content-type': 'application/json' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!)); response.on('error', reject);
      });
      pending.on('error', reject); pending.setTimeout(5000, () => pending.destroy(new Error('test_request_timeout'))); pending.write('{');
    });
    await entered.promise;
    if (mode === 'expires') now += 1000; else delete state.config.tokens[tokens.alex];
    pending.end(JSON.stringify({ ...scope, text: 'private-segmented-text', clientEventId: 'late', sourceMessageId: 'private-source',
      sourceRevision: 1, runId: 'private-run', result: {}, action: 'read', reason: 'private-reason', messageId: 'private-message' }).slice(1));
    assert.equal(await result, 401, `${mode} ${path}`);
    assert.equal(last(app.requestAudit).actorId, null);
    assert.equal(last(app.requestAudit).category, mode === 'expires' ? 'credential_expired' : 'invalid_identity');
  }
  assert.ok(guards.every(guard => guard.mock.callCount() === 0));
  assert.equal(state.messages.size, 0); assert.equal(state.runs.size, 0); assert.equal(state.approvals.size, 0);
  assertPrivate(app.requestAudit.snapshot(), ['private-segmented-text', 'private-source', 'private-run', 'private-reason', 'private-message', 'private-target']);
});

test('private SQLite request ledger remains capped across a denial flood and restart', async t => {
  const env = await privateEnvironment(t);
  for (let i = 0; i < 1012; i++) env.engine.requestAudit.record(requestContext('GET'), new ApiError(401, 'authentication_required'));
  const entries = env.engine.requestAudit.snapshot(); assert.equal(entries.length, 1000);
  assert.deepEqual(env.store.loadRequestAudit(), entries); assert.ok(Buffer.byteLength(JSON.stringify(env.store.loadRequestAudit())) < 500000);
  await env.restart(); assert.deepEqual(env.engine.requestAudit.snapshot(), entries);
});

test('HTTP boundary categorizes native errors and untrusted ApiError codes without logging error text', async t => {
  const audit = new RequestRejectionAudit();
  const service = server(async (_request, _response, url) => {
    if (url.searchParams.has('native')) throw new Error('private-native-path-C:\\secret\\file-and-stack');
    throw new ApiError(400, 'private-untrusted-code-with-token-and-path');
  }, audit);
  const url = await listen(service); t.after(() => close(service));
  assert.equal((await raw(url, '/unknown-private-path?native=private-query')).status, 500);
  assert.equal((await raw(url, '/messages/private-id/edit', { method: 'PATCH' })).status, 400);
  assert.equal(last(audit).method, 'PATCH'); assert.equal(last(audit).route, 'message_edit');
  assert.deepEqual(audit.snapshot().map(entry => entry.category), ['internal_failure', 'invalid_request']);
  assertPrivate(audit.snapshot(), ['private-native-path', 'secret', 'file-and-stack', 'private-untrusted-code', 'unknown-private-path', 'private-query', 'private-id']);
});

test('malformed request target accepted by Node gets one bounded protocol rejection and service stays live', async t => {
  const env = await privateEnvironment(t);
  assert.equal((await raw(env.url, 'http://[private-invalid-target/')).status, 400);
  assert.deepEqual({ route: last(env.engine.requestAudit).route, category: last(env.engine.requestAudit).category, actorId: last(env.engine.requestAudit).actorId },
    { route: 'unknown', category: 'protocol_rejected', actorId: null });
  assert.equal((await raw(env.url, '/health')).status, 200); assert.equal(env.engine.requestAudit.snapshot().length, 1);
  assertPrivate(env.engine.requestAudit.snapshot(), ['private-invalid-target']);
});

test('completed or disconnected responses do not become rejection records or trigger a second response', async t => {
  const audit = new RequestRejectionAudit();
  const service = server(async (_request, response, url) => {
    if (url.searchParams.has('disconnect')) response.destroy();
    else respond(response, 201, { committed: true });
    throw new Error('private-after-commit-error');
  }, audit);
  const url = await listen(service); t.after(() => close(service));
  assert.equal((await raw(url, '/messages')).status, 201);
  await assert.rejects(raw(url, '/messages?disconnect=1'));
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(audit.snapshot().length, 0);
});

test('body-read credential expiry is recorded with null actor and concurrent requests keep separate actors', async t => {
  let now = Date.now(); const env = await privateEnvironment(t, () => now), entered = gate();
  env.config.credentialExpiresAt!.alex = now + 1000;
  const authenticate = env.engine.state.authenticate.bind(env.engine.state);
  t.mock.method(env.engine.state, 'authenticate', (token: string) => { const actor = authenticate(token); if (actor === 'alex') entered.release(); return actor; });
  let pending!: ReturnType<typeof httpRequest>;
  const result = new Promise<number>((resolve, reject) => {
    pending = httpRequest(env.url, { path: '/messages', method: 'POST', headers: { authorization: `Bearer ${tokens.alex}`, 'content-type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!)); response.on('error', reject);
    });
    pending.on('error', reject); pending.write('{');
  });
  await entered.promise;
  assert.equal((await raw(env.url, '/messages', { token: tokens.sam, contentType: 'text/plain', body: 'private-other-body' })).status, 415);
  now += 1000;
  pending.end(JSON.stringify({ ...scope, text: 'private-expired-body', clientEventId: 'late' }).slice(1));
  assert.equal(await result, 401);
  assert.deepEqual(env.engine.requestAudit.snapshot().map(({ actorId, category }) => ({ actorId, category })),
    [{ actorId: 'sam', category: 'json_required' }, { actorId: null, category: 'credential_expired' }]);
  assert.equal(env.engine.state.messages.size, 0); assertPrivate(env.engine.requestAudit.snapshot(), ['private-expired-body', 'private-other-body']);
});

test('idle long-poll expiry is a request rejection, never stop evidence or a new assignment', async t => {
  let now = Date.now(); const env = await privateEnvironment(t, () => now), deadline = now + 1000;
  env.config.credentialExpiresAt!.sam = deadline;
  const poll = env.engine.poll.bind(env.engine);
  t.mock.method(env.engine, 'poll', (actor: string, instance: string) => { const delivery = poll(actor, instance); now = deadline; return delivery; });
  assert.equal((await raw(env.url, '/worker/poll', { token: tokens.sam, contentType: 'application/json', body: '{"instanceId":"private-idle-instance"}' })).status, 401);
  assert.equal(last(env.engine.requestAudit).actorId, null); assert.equal(last(env.engine.requestAudit).category, 'credential_expired');
  assert.equal(env.engine.state.runs.size, 0); assertPrivate(env.engine.requestAudit.snapshot(), ['private-idle-instance']);
});

test('private segmented body cannot keep the first actor after its token maps to another valid member', async t => {
  const env = await privateEnvironment(t), entered = gate();
  const authenticate = env.engine.state.authenticate.bind(env.engine.state);
  t.mock.method(env.engine.state, 'authenticate', (token: string) => { const actor = authenticate(token); if (actor === 'alex') entered.release(); return actor; });
  let pending!: ReturnType<typeof httpRequest>;
  const result = new Promise<number>((resolve, reject) => {
    pending = httpRequest(env.url, { path: '/messages', method: 'POST', headers: { authorization: `Bearer ${tokens.alex}`, 'content-type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!)); response.on('error', reject);
    });
    pending.on('error', reject); pending.setTimeout(5000, () => pending.destroy(new Error('test_request_timeout'))); pending.write('{');
  });
  await entered.promise;
  env.config.tokens[tokens.alex] = 'guest'; // Only this isolated fixture, never a real credential or deadline.
  pending.end(JSON.stringify({ ...scope, text: 'private-rebound-body', clientEventId: 'rebound' }).slice(1));
  assert.equal(await result, 401); assert.equal(last(env.engine.requestAudit).category, 'invalid_identity');
  assert.equal(last(env.engine.requestAudit).actorId, null); assert.equal(env.engine.state.messages.size, 0); assert.equal(env.engine.state.runs.size, 0);
  assertPrivate(env.engine.requestAudit.snapshot(), ['private-rebound-body']);
});

test('private idle long poll cannot continue as its first actor after token remapping', async t => {
  const env = await privateEnvironment(t), poll = env.engine.poll.bind(env.engine);
  t.mock.method(env.engine, 'poll', (actor: string, instance: string) => {
    const delivery = poll(actor, instance); env.config.tokens[tokens.sam] = 'guest'; return delivery;
  });
  assert.equal((await raw(env.url, '/worker/poll', { token: tokens.sam, contentType: 'application/json', body: '{"instanceId":"private-rebound-instance"}' })).status, 401);
  assert.equal(last(env.engine.requestAudit).category, 'invalid_identity'); assert.equal(last(env.engine.requestAudit).actorId, null);
  assert.equal(env.engine.state.runs.size, 0); assertPrivate(env.engine.requestAudit.snapshot(), ['private-rebound-instance']);
});

test('opt-in private web origin rejection is captured before auth without persisting origin or host', async t => {
  const env = await privateEnvironment(t, Date.now, true);
  assert.equal((await raw(env.url, '/messages', { headers: { origin: 'https://private-origin.invalid' } })).status, 403);
  assert.equal(last(env.engine.requestAudit).actorId, null); assert.equal(last(env.engine.requestAudit).category, 'authorization_denied');
  assertPrivate(env.engine.requestAudit.snapshot(), ['private-origin.invalid']);
});
