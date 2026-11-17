import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlConfig } from '../src/control/state.js';
import { DEV, developmentGrants, fixtureSources, members } from '../src/dev-fixture.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { OutboundWorker } from '../src/private/outbound-worker.js';
import { fixtureResult } from '../src/worker/fake.js';
import type { Execute } from '../src/worker/runtime.js';
import { close, listen, requestJson } from '../src/http.js';
import { scope, query, gate, waitFor } from './helpers.js';
import { terminal, type Message } from '../src/contracts.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'participation-reconnect-'));
  const path = join(directory, 'control.sqlite');
  const config: ControlConfig = { members: structuredClone(members), grants: developmentGrants(),
    tokens: { [DEV.humanToken]: 'alex', [DEV.agentToken]: 'sam' }, memberships: { alex: [scope], sam: [scope] },
    credentialExpiresAt: { alex: Date.now() + 3600000, sam: Date.now() + 3600000, guest: Date.now() + 3600000 },
    researchMemberId: 'sam', sources: fixtureSources,
    participationSubscriptions: [{ ...scope, memberId: 'sam', revision: 1, enabled: true,
      joinedAt: 1, membershipGeneration: 'initial', responsibilities: ['research'], maxMessages: 2, maxChars: 200 }] };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config);
  let service = privateService(engine), url = await listen(service);
  const workers: OutboundWorker[] = [];
  const api = {
    config, get engine() { return engine; }, get url() { return url; },
    post(text = 'please research protocol', key: string = crypto.randomUUID()) {
      return requestJson<{ message: Message }>(url, DEV.humanToken, '/messages', { ...scope, text, clientEventId: key });
    },
    worker(execute: Execute) {
      const worker = new OutboundWorker({ memberId: 'sam', token: DEV.agentToken, controlUrl: url, provider: 'fake', workspace: directory }, execute);
      workers.push(worker); return worker;
    },
    async restart() {
      const port = Number(new URL(url).port); await close(service); store.close();
      store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service, port);
      await waitFor(async () => { try { await requestJson(url, DEV.humanToken, '/health'); return true; } catch { return undefined; } });
    },
    async finish(worker: OutboundWorker) {
      return waitFor(async () => { await worker.step(); return [...engine.state.runs.values()].find(r => terminal(r.status)); }, 10000);
    },
  };
  t.after(async () => {
    for (const worker of workers) await worker.close();
    await close(service); store.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'participation-reconnect-')));
    await rm(directory, { recursive: true, force: true });
  });
  return api;
}

test('offline subscribed Agent replays only its bounded authorized context after control restart', async t => {
  const env = await setup(t);
  const older = await env.post('older outside window');
  const near = await env.post('nearest context');
  // Synthetic foreign-scope state tests the scope filter, not a real user's data.
  env.engine.commit(() => env.engine.state.messages.set('foreign', { ...near.message, id: 'foreign', conversationId: 'ungranted', text: 'foreign secret' }));
  const source = await env.post('please research protocol', 'source');
  await env.post('later outside source boundary');
  await env.restart();
  assert.equal((await env.post('please research protocol', 'source')).message.id, source.message.id);
  let executions = 0, observed: Message[] = [];
  const worker = env.worker(async (_work, _input, tools, _signal, output, applied) => {
    executions++; applied(); observed = await tools.readMessages(); await tools.claimTask();
    const result = fixtureResult(), receipt = await tools.sendMessage(result); output({ result, receiptId: receipt.receiptId });
  });
  const run = await env.finish(worker);
  assert.equal(run.status, 'completed'); assert.equal(executions, 1);
  assert.deepEqual(observed.map(m => m.id), [near.message.id, source.message.id]);
  assert.ok(!JSON.stringify(observed).includes(older.message.text)); assert.ok(!JSON.stringify(observed).includes('foreign secret'));
  assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1);
  const publications = [...env.engine.state.messages.values()].filter(m => m.origin === 'research');
  assert.equal(publications.length, 1); assert.equal(publications[0]!.sourceMessageId, source.message.id);
  assert.equal(publications[0]!.threadId, scope.threadId);
  assert.deepEqual(run.events.find(e => e.status === 'completed')!.data.tools, ['claim_task', 'read_messages', 'claim_task', 'send_message']);
  assert.equal(env.engine.state.snapshot().resultKeys.length, 1);
});

test('same Agent reconnect retries a lost event ACK without executing tools or publishing twice', async t => {
  const env = await setup(t), release = gate(); let ready = false, executions = 0;
  await env.post();
  const worker = env.worker(async (_work, _input, tools, _signal, output, applied) => {
    executions++; applied(); assert.equal((await tools.readMessages()).length, 1);
    output({ marker: 'before_disconnect' }); ready = true; await release.promise;
    await tools.claimTask(); const result = fixtureResult(), receipt = await tools.sendMessage(result); output({ result, receiptId: receipt.receiptId });
  });
  const original = globalThis.fetch;
  try {
    await worker.step(); await waitFor(() => ready);
    const batches: string[] = [];
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input) === env.url + '/worker/events') {
        batches.push(String(init?.body));
        if (batches.length === 1) { await response.text(); throw new Error('synthetic_ack_disconnected'); }
      }
      return response;
    };
    await assert.rejects(worker.step(), /synthetic_ack_disconnected/);
    const run = [...env.engine.state.runs.values()][0]!, count = run.events.length;
    assert.ok(run.events.some(e => e.data.marker === 'before_disconnect'));
    await worker.step(); assert.equal(batches[0], batches[1]); assert.equal(run.events.length, count); assert.equal(executions, 1);
    globalThis.fetch = original; release.release();
    const completed = await env.finish(worker);
    const receipt = completed.receiptId; assert.equal(completed.status, 'completed');
    assert.equal((await worker.step()).command, 'idle'); assert.equal(completed.receiptId, receipt);
    assert.equal(new Set(completed.events.map(e => e.id)).size, completed.events.length);
    assert.deepEqual(completed.events.find(e => e.status === 'completed')!.data.tools, ['claim_task', 'read_messages', 'claim_task', 'send_message']);
    assert.equal(env.engine.state.snapshot().resultKeys.length, 1);
    assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research').length, 1);
    assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1); assert.equal(executions, 1);
  } finally { globalThis.fetch = original; release.release(); await worker.close(); }
});

for (const revoke of ['subscription', 'read grant'] as const) test('offline Agent cannot replay after revoking ' + revoke, async t => {
  const env = await setup(t); await env.post(); const run = [...env.engine.state.runs.values()][0]!;
  if (revoke === 'subscription') env.config.participationSubscriptions![0]!.enabled = false;
  else env.config.grants.find(g => g.memberId === 'sam')!.revoked = true;
  await env.restart(); let executions = 0;
  const worker = env.worker(async () => { executions++; });
  if (revoke === 'subscription') assert.equal((await worker.step()).command, 'idle');
  else await assert.rejects(worker.step(), /worker_poll_denied/);
  await assert.rejects(requestJson(env.url, DEV.agentToken, '/messages?' + query + '&runId=' + run.id));
  await assert.rejects(requestJson(env.url, DEV.agentToken, '/tools/send', { runId: run.id, result: fixtureResult() }));
  await env.post('please research another source');
  assert.equal(executions, 0); assert.equal(env.engine.state.tasks.size, 1);
  assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research').length, 0);
});

test('in-flight subscribed Agent reconnect observes revocation and cannot read or publish again', async t => {
  const env = await setup(t), release = gate(); let ready = false, executions = 0, rejected = 0;
  await env.post();
  const worker = env.worker(async (_work, _input, tools, _signal, _output, applied) => {
    executions++; applied(); await tools.readMessages(); ready = true; await release.promise;
    await assert.rejects(tools.readMessages()); rejected++;
    await assert.rejects(tools.sendMessage(fixtureResult())); rejected++;
  });
  const original = globalThis.fetch;
  try {
    const delivery = await worker.step(); await waitFor(() => ready);
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(env.url + '/worker/')) throw new Error('synthetic_offline');
      return original(input, init);
    };
    await assert.rejects(worker.step(), /synthetic_offline/);
    env.config.participationSubscriptions![0]!.enabled = false; globalThis.fetch = original;
    assert.equal((await worker.step()).command, 'cancel');
    const headers = { 'x-coseat-instance': worker.instanceId, 'x-coseat-lease': delivery.leaseId! };
    await assert.rejects(requestJson(env.url, DEV.agentToken, '/messages?' + query + '&runId=' + delivery.runId, undefined, undefined, headers));
    await assert.rejects(requestJson(env.url, DEV.agentToken, '/tools/send', { runId: delivery.runId, result: fixtureResult() }, undefined, headers));
    release.release(); const run = await env.finish(worker);
    assert.equal(run.status, 'stopped'); assert.equal(executions, 1); assert.equal(rejected, 2);
    assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1);
    assert.equal(env.engine.state.snapshot().resultKeys.length, 0);
    assert.equal([...env.engine.state.messages.values()].filter(m => m.origin === 'research').length, 0);
  } finally { globalThis.fetch = original; release.release(); await worker.close(); }
});
