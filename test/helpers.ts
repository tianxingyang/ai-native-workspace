import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEV, developmentGrants, fixtureSources, members } from '../src/dev-fixture.js';
import type { Message, Run } from '../src/contracts.js';
import { close, listen, requestJson } from '../src/http.js';
import { ControlState } from '../src/control/state.js';
import { controlService } from '../src/control/service.js';
import { RuntimeClient } from '../src/control/runtime-client.js';
import { LocalRuntime, type Execute } from '../src/worker/runtime.js';
import { fakeExecution } from '../src/worker/fake.js';
import { workerService } from '../src/worker/service.js';

export const scope = { conversationId: DEV.conversationId, threadId: DEV.threadId };
export const query = new URLSearchParams(scope).toString();
export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn(); if (value !== undefined && value !== false) return value;
    await delay(10);
  }
  throw new Error('condition_not_reached');
}
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
export async function environment(execute: Execute = fakeExecution(), autoDispatch = true, cancellationReconcileMs = 5000) {
  const state = new ControlState({ members: structuredClone(members), grants: developmentGrants(), tokens: { [DEV.humanToken]: 'alex', [DEV.agentToken]: 'sam', [DEV.strangerToken]: 'guest' }, memberships: { alex: [scope], sam: [scope], guest: [] }, researchMemberId: 'sam', sources: fixtureSources });
  const config = { provider: 'test', version: '0.1.0', memberId: 'sam', controlUrl: '', memberToken: DEV.agentToken, execute };
  const runtime = new LocalRuntime(config);
  const worker = workerService(runtime, DEV.runtimeToken);
  const workerUrl = await listen(worker);
  const runtimeClient = new RuntimeClient(workerUrl, DEV.runtimeToken);
  const app = controlService(state, runtimeClient, { autoDispatch, cancellationReconcileMs });
  const url = await listen(app.service);
  config.controlUrl = url;
  return {
    state, runtime, runtimeClient, app, url, workerUrl,
    post(text = '请调研一下运行时插件的取消语义', key: string = crypto.randomUUID()) { return requestJson<{ message: Message; duplicate: boolean }>(url, DEV.humanToken, '/messages', { ...scope, text, clientEventId: key }); },
    async completed() { return waitFor(() => [...state.runs.values()].find(r => r.status === 'completed'), 8000); },
    async dispose() { await runtime.close(); app.stop(); await app.drain(); await close(app.service); await close(worker); },
  };
}
export async function expectStatus(promise: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(promise, (error: unknown) => {
    const e = error as { status: number; code: string };
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return true;
  });
}
export function runResult(state: ControlState, run: Run) {
  return [...state.messages.values()].filter(m => m.sourceMessageId === run.sourceMessageId && m.origin === 'research');
}
