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
import { close, listen, requestJson } from '../src/http.js';
import { type Message, type Run, terminal } from '../src/contracts.js';
import { expectStatus, gate, waitFor } from './helpers.js';

// Synthetic, process-local test values, never deployment credentials.
const secrets = { COSEAT_OWNER_TOKEN: randomBytes(32).toString('hex'), COSEAT_AGENT_TOKEN: randomBytes(32).toString('hex'), COSEAT_OTHER_TOKEN: randomBytes(32).toString('hex') };
const scope = { conversationId: 'trial-room', threadId: 'research-thread' };
function rawConfig(path: string) {
  return { version: 1, mode: 'private-mock', databasePath: path, port: 0, researchMemberId: 'agent1',
    members: [ ['owner1', 'human', 'COSEAT_OWNER_TOKEN'], ['agent1', 'agent', 'COSEAT_AGENT_TOKEN'], ['agent2', 'agent', 'COSEAT_OTHER_TOKEN'] ].map(([id, kind, tokenEnv]) => ({ id, kind, name: id, tokenEnv, scopes: [scope] })),
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

test('cross-member lease access and body identity spoofing are rejected', async t => {
  const env = await setup(t); await env.post();
  const delivery = await requestJson<Delivery>(env.url, secrets.COSEAT_AGENT_TOKEN, '/worker/poll', { instanceId: 'boot-1' });
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/events', { instanceId: 'boot-1', leaseId: delivery.leaseId, events: [] }), 403, 'lease_denied');
  await expectStatus(requestJson(env.url, secrets.COSEAT_OTHER_TOKEN, '/worker/poll', { instanceId: 'boot-2', memberId: 'agent1' }), 400);
  await expectStatus(requestJson(env.url, secrets.COSEAT_OWNER_TOKEN, '/worker/poll', { instanceId: 'boot-3' }), 403);
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
