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

test('malformed, cross-run and unconfirmed stop events cannot mutate run state', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post(); const { run } = env.state.claim('sam', message.id); run.sessionId = 'session-a';
  const event = { id: 'event', sequence: 1, sessionId: 'session-a', runId: run.id, kind: 'stopped' as const, status: 'stopped' as const, at: Date.now(), data: {} };
  assert.throws(() => env.state.recordEvent(run, { ...event, runId: 'other' }), /event_binding_mismatch/);
  assert.throws(() => env.state.recordEvent(run, event), /missing_stop_confirmation/);
  assert.equal(run.status, 'queued');
  assert.equal(run.events.length, 0);
});
