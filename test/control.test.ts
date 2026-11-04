import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { DEV } from '../src/dev-fixture.js';
import { requestJson } from '../src/http.js';
import { fakeExecution, fixtureResult } from '../src/worker/fake.js';
import type { Run } from '../src/contracts.js';
import { environment, expectStatus, gate, query, runResult, scope, waitFor } from './helpers.js';

test('development transport cancels stale sessions and creates a new session for edited input', async t => {
  const hold = gate(); let starts = 0;
  const env = await environment(async (...args) => { starts++; if (starts === 1) { args[5](); await hold.promise; } await fakeExecution(0)(...args); });
  t.after(async () => { hold.release(); await env.dispose(); });
  const { message } = await env.post();
  const original = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await requestJson(env.url, DEV.humanToken, `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'edit-dev', text: '请调研新的版本' });
  await expectStatus(requestJson(env.url, DEV.agentToken, '/tools/send', { runId: original.id, result: fixtureResult() }), 409, 'source_revision_changed');
  assert.equal(env.state.runs.size, 1);
  const next = await env.post('请调研等待期间收到的新请求');
  const queued = await waitFor(() => [...env.state.runs.values()].find(r => r.sourceMessageId === next.message.id));
  assert.equal(queued.status, 'queued'); assert.equal(queued.sessionId, undefined); assert.equal(starts, 1);
  hold.release();
  const replacement = await env.completed();
  assert.notEqual(replacement.id, original.id); assert.notEqual(replacement.sessionId, original.sessionId);
  assert.equal(original.status, 'stopped'); assert.equal(replacement.work.contextRevision, 2);
  await waitFor(() => [...env.state.runs.values()].filter(r => r.status === 'completed').length === 2);
  assert.equal(env.state.runs.get(original.replacementRunId!)!.work.source.revision, 2);
});

test('development edit during createSession fences input and waits for confirmed stop before rebuilding', async t => {
  const env = await environment(), hold = gate();
  t.after(async () => { hold.release(); await env.dispose(); });
  const create = env.runtimeClient.createSession.bind(env.runtimeClient);
  let creating = false;
  env.runtimeClient.createSession = async work => { if (!creating) { creating = true; await hold.promise; } return create(work); };
  const { message } = await env.post(); await waitFor(() => creating);
  const original = [...env.state.runs.values()][0]!;
  await requestJson(env.url, DEV.humanToken, `/messages/${message.id}/edit`, { expectedRevision: 1, clientEventId: 'edit-create', text: '请调研新指令' });
  assert.equal(original.status, 'cancel_requested'); assert.equal(original.stopEvidence, undefined); assert.equal(env.state.runs.size, 1);
  hold.release();
  const replacement = await env.completed();
  assert.notEqual(replacement.id, original.id); assert.equal(original.status, 'stopped');
  assert.equal(original.events.some(e => e.kind === 'input_applied'), false);
});

test('unmentioned research runs in background; chat remains responsive and result returns to source', async t => {
  const hold = gate();
  const env = await environment(async (...args) => { await hold.promise; await fakeExecution(0)(...args); });
  t.after(async () => { hold.release(); await env.dispose(); });
  const first = await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  const chat = await env.post('午饭吃什么？');
  assert.equal(chat.message.text, '午饭吃什么？');
  assert.equal(run.status, 'running');
  assert.equal(runResult(env.state, run).length, 0);
  await tick();
  assert.equal(env.state.runs.size, 1);
  assert.ok(env.state.decisions.some(d => d.messageId === chat.message.id && !d.participate));
  hold.release();
  await env.completed();
  const [reply] = runResult(env.state, run);
  assert.equal(reply?.sourceMessageId, first.message.id);
  assert.equal(reply?.threadId, first.message.threadId);
  assert.equal(reply?.authorId, DEV.agentId);
  assert.equal(reply?.result?.sources.length, 2);
  assert.equal(reply?.result?.evidence, 'synthetic-fixture');
  assert.ok(reply?.result?.limitations.length);
  assert.ok(run.events.some(e => e.kind === 'input_received'));
  assert.ok(run.events.some(e => e.kind === 'input_applied'));
  assert.ok(run.events.some(e => e.kind === 'output'));
  assert.ok(run.receiptId);
});

test('duplicate inbound events create one message, claim, runtime execution and publication', async t => {
  const env = await environment(); t.after(() => env.dispose());
  const responses = await Promise.all(Array.from({ length: 8 }, () => env.post('请调研一下插件', 'same-event')));
  assert.equal(new Set(responses.map(r => r.message.id)).size, 1);
  assert.equal(responses.filter(r => !r.duplicate).length, 1);
  const run = await env.completed();
  assert.equal(env.state.runs.size, 1);
  assert.equal(runResult(env.state, run).length, 1);
  const eventCount = run.events.length;
  for (const event of [...run.events]) env.state.recordEvent(run, event);
  assert.equal(run.events.length, eventCount);
  assert.equal(runResult(env.state, run).length, 1);
  await expectStatus(env.post('不同内容', 'same-event'), 409, 'idempotency_key_conflict');
});

test('authentication cannot be supplied in the body; both humans and agents need scoped grants', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  await expectStatus(requestJson(env.url, '', `/messages?${query}`), 401);
  for (const path of [`/messages?${query}`, `/runs?${query}`]) await expectStatus(requestJson(env.url, DEV.strangerToken, path), 403);
  await expectStatus(requestJson(env.url, DEV.humanToken, '/messages', { ...scope, text: 'hi', clientEventId: 'spoof', authorId: 'sam' }), 400, 'identity_is_authenticated');
  for (const token of [DEV.humanToken, DEV.agentToken]) {
    await expectStatus(requestJson(env.url, token, '/messages', { conversationId: 'private', threadId: 'secret', text: 'hi', clientEventId: 'denied' }), 403);
    await expectStatus(requestJson(env.url, token, '/messages?conversationId=private&threadId=secret'), 403);
  }
  await expectStatus(requestJson(env.workerUrl, DEV.agentToken, '/capabilities'), 401);
  assert.ok(env.state.audit.some(e => !e.allowed && e.actorId === 'sam'));
});

test('invisible messages never enter participation evaluation or the runtime queue', async t => {
  const env = await environment(); t.after(() => env.dispose());
  const privateScope = { conversationId: 'private', threadId: 'secret' };
  env.state.config.memberships.alex!.push(privateScope);
  env.state.config.grants.push({ ...env.state.config.grants[0]!, ...privateScope, id: 'private-grant' });
  const hidden = await requestJson<{ message: { id: string } }>(env.url, DEV.humanToken, '/messages', { ...privateScope, text: '请调研保密项目', clientEventId: 'hidden' });
  await tick();
  assert.equal(env.state.decisions.some(d => d.messageId === hidden.message.id), false);
  assert.equal(env.state.runs.size, 0);
});

test('concurrent claims share one task/run; another member cannot take the same claim', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const claim = { sourceMessageId: message.id, intent: 'research' };
  const values = await Promise.all(Array.from({ length: 12 }, () => requestJson<{ run: Run; duplicate: boolean }>(env.url, DEV.agentToken, '/tools/claim', claim)));
  assert.equal(new Set(values.map(v => v.run.id)).size, 1);
  assert.equal(values.filter(v => !v.duplicate).length, 1);
  assert.equal(env.state.runs.size, 1);
  await expectStatus(requestJson(env.url, DEV.humanToken, '/tools/claim', claim), 409, 'already_claimed');
  await expectStatus(requestJson(env.url, DEV.strangerToken, '/tools/claim', claim), 403);
});

test('result publication is idempotent per run and cannot redirect or spoof an author', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const { run } = env.state.claim('sam', message.id);
  const payload = { runId: run.id, result: fixtureResult() };
  const values = await Promise.all(Array.from({ length: 6 }, () => requestJson<{ receiptId: string; duplicate: boolean }>(env.url, DEV.agentToken, '/tools/send', payload)));
  assert.equal(new Set(values.map(v => v.receiptId)).size, 1);
  assert.equal(values.filter(v => !v.duplicate).length, 1);
  assert.equal(runResult(env.state, run).length, 1);
  await expectStatus(requestJson(env.url, DEV.humanToken, '/tools/send', payload), 403, 'run_denied');
  await expectStatus(requestJson(env.url, DEV.agentToken, '/tools/send', { ...payload, conversationId: 'private' }), 400);
  await expectStatus(requestJson(env.url, DEV.agentToken, '/tools/send', { ...payload, authorId: 'alex' }), 400);
  await expectStatus(requestJson(env.url, DEV.agentToken, '/tools/send', { ...payload, result: { ...fixtureResult(), conclusion: 'different' } }), 409, 'result_conflict');
});

test('source and grant revisions, revocation, expiry and membership are rechecked before read/send', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const { run } = env.state.claim('sam', message.id);
  const publish = () => requestJson(env.url, DEV.agentToken, '/tools/send', { runId: run.id, result: fixtureResult() });
  const read = () => requestJson(env.url, DEV.agentToken, `/messages?${query}&runId=${run.id}`);
  env.state.messages.get(message.id)!.revision++;
  await expectStatus(publish(), 409, 'source_revision_changed'); await expectStatus(read(), 409);
  env.state.messages.get(message.id)!.revision--;
  const grant = env.state.config.grants.find(g => g.memberId === 'sam')!;
  grant.revision++; await expectStatus(publish(), 409); grant.revision--;
  grant.revoked = true; await expectStatus(publish(), 403); await expectStatus(read(), 403); grant.revoked = false;
  const expiresAt = grant.expiresAt; grant.expiresAt = 0; await expectStatus(publish(), 403); grant.expiresAt = expiresAt;
  env.state.config.memberships.sam = []; await expectStatus(publish(), 403); await expectStatus(read(), 403);
  assert.equal(runResult(env.state, run).length, 0);
});

test('approval requests stay pending and do not grant or broaden access', async t => {
  const env = await environment(undefined, false); t.after(() => env.dispose());
  const { message } = await env.post();
  const { run } = env.state.claim('sam', message.id);
  const before = structuredClone(env.state.config.grants);
  const request = { runId: run.id, action: 'external_research', reason: 'Need separately approved data and budget.' };
  const approval = await requestJson<{ status: string; id: string }>(env.url, DEV.agentToken, '/tools/request-approval', request);
  assert.equal(approval.status, 'pending');
  assert.deepEqual(env.state.config.grants, before);
  await expectStatus(requestJson(env.url, DEV.strangerToken, '/tools/request-approval', request), 403);
  await expectStatus(requestJson(env.url, DEV.agentToken, '/approvals/approve', { id: approval.id }), 404);
});

test('negative intent and Agent-origin text remain quiet', async t => {
  const env = await environment(); t.after(() => env.dispose());
  await env.post('今天不用调研，先聊天');
  await requestJson(env.url, DEV.agentToken, '/messages', { ...scope, text: '请调研一下这个结论', clientEventId: 'agent-output' });
  await tick();
  assert.equal(env.state.runs.size, 0);
  assert.deepEqual(env.state.decisions.map(d => d.reason), ['explicit_no_research', 'agent_output_does_not_trigger_research']);
});
