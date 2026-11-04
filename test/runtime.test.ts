import assert from 'node:assert/strict';
import test from 'node:test';
import { DEV } from '../src/dev-fixture.js';
import { requestJson } from '../src/http.js';
import { fixtureResult, fakeExecution } from '../src/worker/fake.js';
import type { RuntimeCapabilities } from '../src/contracts.js';
import { environment, expectStatus, gate, runResult, waitFor } from './helpers.js';

test('cancel acceptance stays pending until execution settles; late result is fenced', async t => {
  const hold = gate();
  const env = await environment(async (_work, _input, tools) => { await tools.readMessages(); await hold.promise; await tools.sendMessage(fixtureResult()); });
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await expectStatus(requestJson(env.url, DEV.strangerToken, `/runs/${run.id}/cancel`, {}), 403);
  const cancellation = await requestJson<{ status: string; cancellation: { accepted: boolean; stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(cancellation.status, 'cancel_requested');
  assert.deepEqual(cancellation.cancellation, { accepted: true, stopped: false });
  assert.equal(env.runtime.status(run.sessionId!).status, 'cancel_requested');
  assert.equal(run.events.some(e => e.kind === 'stopped'), false);
  await expectStatus(requestJson(env.url, DEV.agentToken, '/tools/send', { runId: run.id, result: fixtureResult() }), 409, 'run_not_active');
  hold.release();
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  assert.equal(runResult(env.state, run).length, 0);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
});

test('runtime capabilities reject unsupported operations; session/input retries are idempotent', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const { run } = env.state.claim('sam', message.id);
  const capabilities = await requestJson<RuntimeCapabilities>(env.workerUrl, DEV.runtimeToken, '/capabilities');
  assert.equal(capabilities.appendInput, false); assert.equal(capabilities.resume, false);
  const first = await env.runtime.createSession(run.work);
  assert.deepEqual(await env.runtime.createSession(run.work), first);
  await expectStatus(env.runtime.createSession({ ...run.work, contextRevision: 2 }), 409, 'session_conflict');
  await expectStatus(env.runtime.submitInput(first.sessionId, { id: 'input', text: 'research', contextRevision: 2 }), 409);
  const input = { id: 'input', text: 'research', contextRevision: 1 };
  assert.deepEqual(await env.runtime.submitInput(first.sessionId, input), { accepted: true });
  assert.deepEqual(await env.runtime.submitInput(first.sessionId, input), { accepted: true });
  await expectStatus(env.runtime.submitInput(first.sessionId, { ...input, text: 'different' }), 409, 'input_conflict');
  for (const action of ['append', 'pause', 'resume']) await expectStatus(requestJson(env.workerUrl, DEV.runtimeToken, `/sessions/${first.sessionId}/${action}`, {}), 501);
  assert.throws(() => env.runtime.resume({ provider: 'other', providerVersion: '1', sessionId: first.sessionId, opaqueRef: 'opaque' }), /resume_not_supported/);
  await waitFor(() => env.runtime.status(first.sessionId).status === 'completed' ? true : undefined);
  assert.equal(env.runtime.events(first.sessionId, 0).filter(e => e.kind === 'input_applied').length, 1);
});

test('approval requests produce protocol events without granting authority', async t => {
  const env = await environment(async (...args) => {
    await args[2].requestApproval('external_research', 'Fixture only; ask before fetching real sources.');
    await fakeExecution(0)(...args);
  });
  t.after(() => env.dispose());
  await env.post(); const run = await env.completed();
  const approval = run.events.find(e => e.kind === 'approval_requested');
  assert.equal(approval?.data.status, 'pending');
  assert.equal(env.state.approvals.size, 1);
  assert.equal(env.state.config.grants.some(g => g.actions.some(a => (a as string) === 'external_research')), false);
});

test('cancel before input application confirms nothing was started', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post(); const { run } = env.state.claim('sam', message.id);
  const { sessionId } = await env.runtime.createSession(run.work);
  assert.deepEqual(env.runtime.cancel(sessionId), { accepted: true, stopped: true });
  assert.equal(env.runtime.events(sessionId, 0).find(e => e.kind === 'stopped')?.data.scope, 'input_not_started');
  await expectStatus(env.runtime.submitInput(sessionId, { id: 'late', text: 'research', contextRevision: 1 }), 409);
});

test('provider initialization failure acknowledges receipt but never application', async t => {
  const env = await environment(async () => { throw new Error('initialization_failed'); });
  t.after(() => env.dispose());
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'failed'));
  assert.equal(run.events.filter(e => e.kind === 'input_received').length, 1);
  assert.equal(run.events.filter(e => e.kind === 'input_applied').length, 0);
  assert.ok(run.events.some(e => e.kind === 'status' && e.status === 'running'));
});

test('provider acknowledgment follows initialization and is emitted exactly once', async t => {
  const hold = gate();
  let acknowledge: (() => void) | undefined;
  const env = await environment(async (...args) => {
    acknowledge = args[5];
    await hold.promise;
    await fakeExecution(0)(...args);
    acknowledge();
  });
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  assert.equal(env.runtime.events(run.sessionId!, 0).some(e => e.kind === 'input_applied'), false);
  hold.release();
  await env.completed();
  acknowledge!(); // A retained callback cannot emit after execution settles either.
  const events = env.runtime.events(run.sessionId!, 0);
  const applied = events.filter(e => e.kind === 'input_applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.data.inputId, events.find(e => e.kind === 'input_received')!.data.inputId);
  assert.ok(applied[0]!.sequence < events.find(e => e.kind === 'output')!.sequence);
});

test('cancellation during initialization waits for settlement without application', async t => {
  const hold = gate();
  const env = await environment(async (_work, _input, _tools, signal, _output, acknowledge) => {
    await hold.promise;
    signal.throwIfAborted();
    acknowledge();
  });
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  const cancellation = await requestJson<{ cancellation: { stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(cancellation.cancellation.stopped, false);
  hold.release();
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  assert.equal(run.events.some(e => e.kind === 'input_applied'), false);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
});

test('actual application racing cancellation remains visible until execution settles', async t => {
  const hold = gate();
  const env = await environment(async (_work, _input, _tools, _signal, _output, acknowledge) => {
    await hold.promise;
    acknowledge(); // Simulate a provider that applied input as cancellation arrived.
    acknowledge();
  });
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await requestJson(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  hold.release();
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  const applied = run.events.filter(e => e.kind === 'input_applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.status, 'cancel_requested');
  assert.ok(applied[0]!.sequence < run.events.find(e => e.kind === 'stopped')!.sequence);
});

test('cancellation after receipt but before scheduling never starts the provider', async t => {
  let started = false;
  const env = await environment(async () => { started = true; }, false);
  t.after(() => env.dispose());
  const { message } = await env.post(); const { run } = env.state.claim('sam', message.id);
  const { sessionId } = await env.runtime.createSession(run.work);
  assert.deepEqual(await env.runtime.submitInput(sessionId, { id: 'queued', text: 'research', contextRevision: 1 }), { accepted: true });
  assert.deepEqual(env.runtime.cancel(sessionId), { accepted: true, stopped: true });
  await env.runtime.close();
  assert.equal(started, false);
  assert.deepEqual(env.runtime.events(sessionId, 0).map(e => e.kind), ['input_received', 'status', 'stopped']);
});

test('malformed, cross-run and unconfirmed stop events cannot mutate run state', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post(); const { run } = env.state.claim('sam', message.id); run.sessionId = 'session-a';
  const event = { id: 'event', sequence: 1, sessionId: 'session-a', runId: run.id, kind: 'stopped' as const, status: 'stopped' as const, at: Date.now(), data: {} };
  assert.throws(() => env.state.recordEvent(run, { ...event, runId: 'other' }), /event_binding_mismatch/);
  assert.throws(() => env.state.recordEvent(run, event), /missing_stop_confirmation/);
  assert.equal(run.status, 'queued');
  assert.equal(run.events.length, 0);
});
