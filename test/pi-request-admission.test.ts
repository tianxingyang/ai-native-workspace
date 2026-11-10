import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCredentialStore, InMemoryModelsStore, fauxAssistantMessage, fauxProvider, type ProviderHeaders } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { DEV } from '../src/dev-fixture.js';
import { CoSeatTools } from '../src/worker/coseat-tools.js';
import { fixtureResult } from '../src/worker/fake.js';
import { fixturePiModel } from '../src/worker/pi-fixture-model.js';
import { withPiRequestAdmission } from '../src/worker/pi-request-admission.js';
import { environment, gate } from './helpers.js';

for (const mutation of ['revoked', 'cancelled', 'receipt', 'budget'] as const) {
  test(`asynchronous request headers finish before authority admission: ${mutation}`, { timeout: 10000 }, async t => {
    const env = await environment(undefined, false); t.after(() => env.dispose());
    const entered = gate(), hold = gate(); t.after(() => hold.release());
    const { message } = await env.post(); const { run } = env.state.claim('sam', message.id);
    const tools = new CoSeatTools(env.url, DEV.agentToken, run.work, new AbortController().signal, () => {}, {}, 'header-session');
    const model = await fixturePiModel()();
    const runtime = withPiRequestAdmission(model.runtime, () => tools.prepareExecution());
    const completion = runtime.streamSimple(model.model, { messages: [{ role: 'user', content: 'synthetic source', timestamp: Date.now() }] }, {
      transformHeaders: async headers => { entered.release(); await hold.promise; return headers; },
    }).result();
    await entered.promise;
    assert.equal(tools.calls.length, 0); assert.equal(model.callCount!(), 0);
    if (mutation === 'revoked') env.state.config.grants.find(grant => grant.id === run.work.grant.id)!.revoked = true;
    if (mutation === 'cancelled') env.state.cancel('alex', run.id);
    if (mutation === 'receipt') env.state.publish('sam', run.id, fixtureResult());
    if (mutation === 'budget') run.work.budget.maxToolCalls = 1;
    hold.release();
    const result = await completion;
    assert.equal(model.callCount!(), 0);
    assert.equal(result.stopReason, 'error');
    assert.equal(env.state.approvals.size, 0);
    assert.equal([...env.state.messages.values()].filter(item => item.origin === 'research').length, mutation === 'receipt' ? 1 : 0);
    if (mutation === 'receipt') assert.equal(tools.receiptId, run.receiptId);
  });
}

test('request admission preserves SDK headers, runtime identity and shared runtime methods', async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: 'headers-fixture', models: [{ id: 'headers', contextWindow: 32000, maxTokens: 4000 }], tokensPerSecond: 0 });
  runtime.registerNativeProvider(faux.provider);
  const order: string[] = []; let received: ProviderHeaders | undefined;
  faux.setResponses([(context, options) => {
    order.push('provider'); received = options?.headers;
    assert.equal(context.messages.at(-1)!.role, 'user');
    return fauxAssistantMessage('synthetic request accepted');
  }]);
  const originalStream = runtime.streamSimple;
  const facade = withPiRequestAdmission(runtime, async () => { order.push('admission'); });
  const result = await facade.streamSimple(faux.getModel(), { messages: [{ role: 'user', content: 'synthetic source', timestamp: Date.now() }] }, {
    headers: { 'x-fixture-original': 'retained' },
    transformHeaders: async headers => {
      order.push('headers'); await Promise.resolve();
      return { ...headers, 'x-fixture-transformed': 'retained' };
    },
  }).result();
  assert.deepEqual(order, ['headers', 'admission', 'provider']);
  assert.equal(received?.['x-fixture-original'], 'retained');
  assert.equal(received?.['x-fixture-transformed'], 'retained');
  assert.equal(result.stopReason, 'stop'); assert.equal(faux.state.callCount, 1);
  assert.equal(runtime.streamSimple, originalStream);
  assert.equal(facade.getModel(faux.provider.id, 'headers')?.id, 'headers');
});

test('failed SDK header transformation cannot be bypassed by admission', async () => {
  const model = await fixturePiModel()(); let admissions = 0;
  const runtime = withPiRequestAdmission(model.runtime, async () => { admissions++; });
  const result = await runtime.streamSimple(model.model, { messages: [{ role: 'user', content: 'synthetic source', timestamp: Date.now() }] }, {
    transformHeaders: async () => { throw new Error('synthetic_headers_failed'); },
  }).result();
  assert.equal(result.stopReason, 'error'); assert.equal(model.callCount!(), 0); assert.equal(admissions, 0);
});

for (const phase of ['headers', 'admission'] as const) test(`SDK request abort during ${phase} prevents provider dispatch`, async () => {
  const model = await fixturePiModel()(), controller = new AbortController(); let admissions = 0;
  const runtime = withPiRequestAdmission(model.runtime, async () => {
    admissions++;
    if (phase === 'admission') { await Promise.resolve(); controller.abort(new Error('synthetic_sdk_cancelled')); }
  });
  const result = await runtime.streamSimple(model.model, { messages: [{ role: 'user', content: 'synthetic source', timestamp: Date.now() }] }, {
    signal: controller.signal,
    transformHeaders: async headers => {
      if (phase === 'headers') { await Promise.resolve(); controller.abort(new Error('synthetic_sdk_cancelled')); }
      return headers;
    },
  }).result();
  assert.equal(model.callCount!(), 0);
  assert.notEqual(result.stopReason, 'stop');
  assert.equal(admissions, phase === 'headers' ? 0 : 1);
});
