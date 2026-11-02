import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEV } from '../src/dev-fixture.js';
import { requestJson } from '../src/http.js';
import { CoSeatTools } from '../src/worker/coseat-tools.js';
import { fakeExecution } from '../src/worker/fake.js';
import { environment, gate, scope, waitFor } from './helpers.js';

test('cancel resumes reconciliation after dispatcher polling failed, without another user click', async t => {
  const hold = gate(), started = gate();
  const env = await environment(async () => { started.release(); await hold.promise; });
  t.after(async () => { hold.release(); await env.dispose(); });
  const originalEvents = env.runtimeClient.events.bind(env.runtimeClient);
  let first = true;
  env.runtimeClient.events = async (...args) => {
    if (first) { first = false; await started.promise; throw new Error('temporary_poll_failure'); }
    return originalEvents(...args);
  };
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'unknown'));
  await env.app.drain();
  const response = await requestJson<{ status: string }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(response.status, 'cancel_requested');
  hold.release();
  await waitFor(() => env.runtime.status(run.sessionId!).status === 'stopped' ? true : undefined);
  await waitFor(() => run.status === 'stopped' ? true : undefined, 1000);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
  assert.equal(run.error, undefined);
});

test('concurrent cancellation shares one RPC and one in-flight event read with the dispatcher', async t => {
  const hold = gate();
  const env = await environment(async () => { await hold.promise; });
  t.after(async () => { hold.release(); await env.dispose(); });
  let cancellations = 0, activeReads = 0, maxReads = 0;
  const originalCancel = env.runtimeClient.cancel.bind(env.runtimeClient);
  const originalEvents = env.runtimeClient.events.bind(env.runtimeClient);
  env.runtimeClient.cancel = async id => { cancellations++; await delay(10); return originalCancel(id); };
  env.runtimeClient.events = async (...args) => {
    activeReads++; maxReads = Math.max(maxReads, activeReads);
    try { await delay(10); return await originalEvents(...args); } finally { activeReads--; }
  };
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await Promise.all(Array.from({ length: 6 }, () => requestJson(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {})));
  assert.equal(cancellations, 1);
  assert.equal(maxReads, 1);
  assert.equal(run.status, 'cancel_requested');
  hold.release(); await waitFor(() => run.status === 'stopped' ? true : undefined);
  assert.equal(cancellations, 1);
  assert.equal(maxReads, 1);
});

test('cancellation reconciliation expires as unknown when no stop evidence can be read', async t => {
  const hold = gate();
  const env = await environment(async () => { await hold.promise; }, true, 100);
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  let reads = 0;
  env.runtimeClient.events = async () => { reads++; throw new Error('offline'); };
  await waitFor(() => run.status === 'unknown' ? true : undefined); await env.app.drain();
  await requestJson(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  await waitFor(() => run.status === 'unknown' ? true : undefined, 1000); await env.app.drain();
  assert.equal(run.error, 'runtime_stop_unconfirmed');
  assert.equal(run.events.some(e => e.kind === 'stopped'), false);
  const readsAtExpiry = reads; await delay(60); assert.equal(reads, readsAtExpiry);
  hold.release(); await waitFor(() => env.runtime.status(run.sessionId!).status === 'stopped' ? true : undefined);
  assert.equal(run.status, 'unknown'); // An unread remote outcome cannot be claimed locally.
});

test('cancel while capabilities are pending confirms no runtime session was created', async t => {
  const env = await environment();
  const hold = gate(), entered = gate();
  let creations = 0;
  const originalCreate = env.runtimeClient.createSession.bind(env.runtimeClient);
  env.runtimeClient.createSession = async work => { creations++; return originalCreate(work); };
  env.runtimeClient.capabilities = async () => { entered.release(); await hold.promise; return env.runtime.capabilities(); };
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post(); await entered.promise;
  const run = [...env.state.runs.values()][0]!;
  const response = await requestJson<{ status: string; cancellationOutcome: string; stopEvidence: unknown }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  hold.release(); await env.app.drain();
  assert.equal(response.status, 'stopped');
  assert.equal(response.cancellationOutcome, 'stopped_before_session');
  assert.deepEqual(response.stopEvidence, { scope: 'runtime_session_not_created', executionStarted: false });
  assert.equal(run.status, 'stopped');
  assert.equal(run.events.length, 0);
  assert.equal(creations, 0);
});

test('cancel reconciles a completed worker before its completion events were consumed', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const { run } = env.state.claim('sam', message.id);
  const { sessionId } = await env.runtime.createSession(run.work);
  run.sessionId = sessionId; run.status = 'running';
  await env.runtime.submitInput(sessionId, { id: 'first', text: 'research', contextRevision: 1 });
  await waitFor(() => env.runtime.status(sessionId).status === 'completed' ? true : undefined);
  assert.equal(run.events.length, 0);
  assert.ok(run.receiptId);
  const response = await requestJson<{ status: string; cancellationOutcome: string; cancellation: { accepted: boolean; stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(response.status, 'completed');
  assert.equal(response.cancellationOutcome, 'too_late_completed');
  assert.deepEqual(response.cancellation, { accepted: false, stopped: false });
  assert.ok(run.events.some(e => e.status === 'completed'));
  assert.equal(run.status, 'completed');
});

test('cancel during an in-flight session creation waits for provider confirmation', async t => {
  const env = await environment();
  const hold = gate(), entered = gate();
  const originalCreate = env.runtimeClient.createSession.bind(env.runtimeClient);
  env.runtimeClient.createSession = async work => { entered.release(); await hold.promise; return originalCreate(work); };
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post(); await entered.promise;
  const run = [...env.state.runs.values()][0]!;
  const response = await requestJson<{ status: string; stopEvidence: unknown; cancellation: { stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(response.status, 'cancel_requested');
  assert.equal(response.cancellation.stopped, false);
  assert.equal(response.stopEvidence, null);
  hold.release(); await env.app.drain();
  assert.equal(run.status, 'stopped');
  assert.ok(run.sessionId);
  assert.equal(run.events.some(e => e.kind === 'input_applied'), false);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.scope, 'input_not_started');
});

test('old run claim confirmation cannot create or dispatch work for a new source revision', async t => {
  let executions = 0;
  const env = await environment(async (...args) => { executions++; await fakeExecution(0)(...args); });
  t.after(() => env.dispose());
  // Seed without the message dispatcher: the only possible dispatch is the stale tool call.
  const { message } = env.state.createMessage('alex', scope, '请调研一下插件', 'seed');
  const { run } = env.state.claim('sam', message.id);
  message.revision++;
  const tools = new CoSeatTools(env.url, DEV.agentToken, run.work, new AbortController().signal, () => {});
  let error: unknown;
  try { await tools.claimTask(); } catch (caught) { error = caught; }
  await env.app.drain();
  assert.equal(env.state.runs.size, 1);
  assert.equal(executions, 0);
  assert.equal((error as { code: string })?.code, 'source_revision_changed');
});
