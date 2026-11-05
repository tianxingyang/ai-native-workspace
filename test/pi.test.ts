import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piExecution } from '../src/worker/pi.js';
import { fixturePiModel } from '../src/worker/pi-fixture-model.js';
import { DEV } from '../src/dev-fixture.js';
import { requestJson } from '../src/http.js';
import { environment, gate, runResult, waitFor } from './helpers.js';

test('real pi 1.4.0 SDK executes a four-turn mock-model loop through HTTP tools with no external fetch', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'coseat-pi-'));
  await mkdir(join(folder, '.pi'));
  await writeFile(join(folder, 'AGENTS.md'), 'Ambient instructions must not enter this session.');
  await writeFile(join(folder, '.pi', 'settings.json'), JSON.stringify({ defaultTools: ['bash'], enableAnalytics: true }));
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, '127.0.0.1', `unexpected SDK egress: ${url.origin}`);
    requests.push(url.pathname);
    return originalFetch(input, init);
  };
  const env = await environment(piExecution(fixturePiModel(), folder));
  t.after(async () => {
    await env.dispose(); globalThis.fetch = originalFetch;
    assert.ok(folder.startsWith(join(tmpdir(), 'coseat-pi-')));
    await rm(folder, { recursive: true, force: true });
  });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => ['completed', 'failed', 'unknown'].includes(r.status)), 10000);
  assert.equal(run.status, 'completed', JSON.stringify(run.events));
  assert.equal(runResult(env.state, run).length, 1);
  const applied = run.events.filter(e => e.kind === 'input_applied');
  assert.equal(applied.length, 1);
  const output = run.events.find(e => e.kind === 'output')!;
  assert.ok(applied[0]!.sequence < output.sequence);
  assert.equal((output.data.sdkEvents as string[]).filter(e => e === 'user_message_end').length, 1);
  assert.equal(output.data.modelCalls, 4);
  assert.deepEqual(output.data.activeTools, ['claim_task', 'read_messages', 'request_approval', 'send_message']);
  assert.equal((output.data.sdkEvents as string[]).filter(e => e === 'tool_execution_end').length, 3);
  assert.ok((output.data.sdkEvents as string[]).includes('agent_settled'));
  assert.ok(requests.includes('/tools/send'));
  assert.ok(requests.includes('/tools/confirm-claim'));
  assert.deepEqual((await readdir(folder)).sort(), ['.pi', 'AGENTS.md']);
});

test('real SDK mock model can be cancelled before publication and confirms settled execution', async t => {
  const env = await environment(piExecution(fixturePiModel(1000), process.cwd()));
  t.after(() => env.dispose());
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await waitFor(() => env.state.audit.filter(a => a.actorId === 'sam' && a.action === 'claim').length >= 2 ? true : undefined);
  const receipt = await requestJson<{ cancellation: { stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(receipt.cancellation.stopped, false);
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  assert.equal(runResult(env.state, run).length, 0);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
});

test('pi factory initialization failure never reports input application', async t => {
  const env = await environment(piExecution(async () => { throw new Error('model_init_failed'); }, process.cwd()));
  t.after(() => env.dispose());
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'failed'));
  assert.equal(run.events.filter(e => e.kind === 'input_received').length, 1);
  assert.equal(run.events.some(e => e.kind === 'input_applied'), false);
});

test('real SDK prompt preflight rejection never reports input application', async t => {
  let authChecked = false;
  let modelCalls = () => -1;
  const env = await environment(piExecution(async () => {
    const config = await fixturePiModel()();
    modelCalls = config.callCount!;
    config.runtime.hasConfiguredAuth = () => false;
    config.runtime.checkAuth = async () => { authChecked = true; return undefined; };
    return config;
  }, process.cwd()));
  t.after(() => env.dispose());
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'failed'));
  assert.equal(authChecked, true);
  assert.equal(modelCalls(), 0);
  assert.equal(run.events.filter(e => e.kind === 'input_received').length, 1);
  assert.equal(run.events.some(e => e.kind === 'input_applied'), false);
});

test('pi cancellation while the model factory initializes never applies input', async t => {
  const entered = gate();
  const hold = gate();
  let modelCalls = () => -1;
  const env = await environment(piExecution(async () => {
    entered.release();
    await hold.promise;
    const config = await fixturePiModel()();
    modelCalls = config.callCount!;
    return config;
  }, process.cwd()));
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await entered.promise;
  const result = await requestJson<{ cancellation: { stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(result.cancellation.stopped, false);
  hold.release();
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  assert.equal(modelCalls(), 0);
  assert.equal(run.events.some(e => e.kind === 'input_applied'), false);
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
});

test('pi cancellation during SDK auth preflight prevents model work and preserves raced application evidence', { timeout: 10000 }, async t => {
  const entered = gate();
  const hold = gate();
  let modelCalls = () => -1;
  const env = await environment(piExecution(async () => {
    const config = await fixturePiModel()();
    modelCalls = config.callCount!;
    config.runtime.hasConfiguredAuth = () => false;
    config.runtime.checkAuth = async () => { entered.release(); await hold.promise; return { type: 'api_key' }; };
    return config;
  }, process.cwd()));
  t.after(async () => { hold.release(); await env.dispose(); });
  await env.post();
  const run = await waitFor(() => [...env.state.runs.values()].find(r => r.status === 'running'));
  await entered.promise;
  const auditBeforeCancel = env.state.audit.length;
  const result = await requestJson<{ cancellation: { stopped: boolean } }>(env.url, DEV.humanToken, `/runs/${run.id}/cancel`, {});
  assert.equal(result.cancellation.stopped, false);
  hold.release();
  await waitFor(() => run.status === 'stopped' ? run : undefined);
  assert.equal(modelCalls(), 0);
  assert.equal(env.state.audit.slice(auditBeforeCancel).some(a => a.actorId === 'sam'), false);
  // pi 1.4.0 appends the starting message even when agent_start aborts the run.
  const applied = run.events.filter(e => e.kind === 'input_applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.status, 'cancel_requested');
  assert.equal(run.events.find(e => e.kind === 'stopped')?.data.executionSettled, true);
  assert.equal(runResult(env.state, run).length, 0);
});
