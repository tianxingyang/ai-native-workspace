import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piExecution } from '../src/worker/pi.js';
import { fixturePiModel } from '../src/worker/pi-fixture-model.js';
import { DEV } from '../src/dev-fixture.js';
import { requestJson } from '../src/http.js';
import { environment, runResult, waitFor } from './helpers.js';

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
  const output = run.events.find(e => e.kind === 'output')!;
  assert.equal(output.data.modelCalls, 4);
  assert.deepEqual(output.data.activeTools, ['claim_task', 'read_messages', 'request_approval', 'send_message']);
  assert.equal((output.data.sdkEvents as string[]).filter(e => e === 'tool_execution_end').length, 3);
  assert.ok((output.data.sdkEvents as string[]).includes('agent_settled'));
  assert.ok(requests.includes('/tools/send'));
  assert.ok(requests.includes('/tools/claim'));
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
