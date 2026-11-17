import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlState } from '../src/control/state.js';
import { members, developmentGrants, DEV, fixtureSources } from '../src/dev-fixture.js';
import { decideParticipation } from '../src/participation.js';
import { OfflineHandbookPreparation, type OfflinePreparationDependencies } from '../src/research/handbook-preparation.js';

function setup() {
  const scope = { conversationId: DEV.conversationId, threadId: DEV.threadId };
  const state = new ControlState({ members: structuredClone(members), grants: developmentGrants(), tokens: {},
    memberships: { alex: [scope], sam: [scope] }, researchMemberId: 'sam', sources: fixtureSources });
  const { message } = state.createMessage('alex', scope, '比较一下 TypeScript type 和 interface 的区别', crypto.randomUUID());
  assert.equal(decideParticipation(message, 'human').participate, true);
  const { run } = state.claim('sam', message.id);
  let modelCalls = 0;
  const deps: OfflinePreparationDependencies = {
    mode: 'offline-fixture',
    transport: {
      resolveIPv4: async () => ['93.184.215.14'],
      openPinned: async () => ({status: 200, headers: {'content-type': 'text/plain; charset=utf-8'},
        body: (async function* () { yield Buffer.from('Fixture: interfaces describe object shapes.'); })(), close() {} }),
    },
    extractText: text => text,
    assertCurrent: work => {
      const current = state.currentRun('sam', work.runId, 'send');
      assert.deepEqual(current.work, work);
    },
    model: async input => {
      modelCalls++;
      assert.deepEqual(Object.keys(input).sort(), ['receiptId', 'text']);
      return { conclusion: 'Fixture-only comparison.', claims: [{receiptId: input.receiptId, excerpt: 'interfaces describe object shapes'}] };
    },
  };
  return { scope, state, message, run, deps, calls: () => modelCalls };
}
test('natural group message → background preparation → bound citations, not publication', async () => {
  const s = setup();
  const result = await new OfflineHandbookPreparation(s.deps).prepare(s.run.work);
  assert.equal(result.state, 'prepared-not-published');
  assert.equal(result.evidence, 'offline-handbook-fixture');
  assert.deepEqual(result.route, s.scope);
  assert.equal(result.binding.sourceMessageId, s.message.id);
  assert.equal(result.citations[0]!.excerpt, 'interfaces describe object shapes');
  assert.throws(() => s.state.publish('sam', s.run.id, result), /fixture_evidence_required/);
  assert.equal([...s.state.messages.values()].filter(m => m.origin === 'research').length, 0);
});
test('revoked controller grant rejects before transport/model', async () => {
  const s = setup(); s.state.config.grants.find(g => g.memberId === 'sam')!.revoked = true;
  s.deps.transport.resolveIPv4 = async () => { throw Error('must not collect'); };
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work));
  assert.equal(s.calls(), 0);
});
test('source edit during model prevents prepared output', async () => {
  const s = setup(); const model = s.deps.model;
  s.deps.model = async (input, signal) => {
    s.state.changeMessage('alex', s.message.id, 'edit', 1, crypto.randomUUID(), '比较一下其他问题');
    return model(input, signal);
  };
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work));
});
test('cancelled run during model prevents prepared output', async () => {
  const s = setup(); const model = s.deps.model;
  s.deps.model = async (input, signal) => { s.state.cancel('alex', s.run.id); return model(input, signal); };
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work));
});
test('forged citation and extra routing fields rejected', async () => {
  for (const proposal of [{conclusion: 'x', claims: [{receiptId: 'fake', excerpt: 'x'}]}, {conclusion: 'x', claims: [], route: {threadId: 'other'}}]) {
    const s = setup(); s.deps.model = async () => proposal;
    await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work));
  }
});
test('model deadline fails closed and late result is discarded', async () => {
  const s = setup(); s.run.work.budget.maxDurationMs = 20;
  let finish!: (value: unknown) => void;
  s.deps.model = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work), /aborted/);
  finish?.({conclusion:'late',claims:[]});
  assert.equal([...s.state.messages.values()].filter(m => m.origin === 'research').length, 0);
});
test('oversized extraction never reaches model; failed run cannot retry', async () => {
  const s = setup(); s.deps.extractText = () => 'x'.repeat(65537);
  const preparation = new OfflineHandbookPreparation(s.deps);
  await assert.rejects(preparation.prepare(s.run.work), /invalid_extracted_text/);
  s.deps.extractText = text => text;
  await assert.rejects(preparation.prepare(s.run.work), /preparation_attempt_denied/);
  assert.equal(s.calls(), 0);
});
test('pre-aborted preparation performs no transport', async () => {
  const s = setup(); const controller = new AbortController(); controller.abort();
  s.deps.transport.resolveIPv4 = async () => { throw Error('must not collect'); };
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work, controller.signal), /aborted/);
});

test('second attempt is rejected before any transport or extraction', async () => {
  const s = setup(); const preparation = new OfflineHandbookPreparation(s.deps);
  await preparation.prepare(s.run.work);
  s.deps.transport.resolveIPv4 = async () => { assert.fail('must not resolve twice'); };
  s.deps.extractText = () => { assert.fail('must not extract twice'); };
  await assert.rejects(preparation.prepare(s.run.work), /preparation_attempt_denied/);
  assert.equal(s.calls(), 1);
});
test('bounded attempt guard seals rather than evicting old attempts', async () => {
  const s = setup(); s.deps.assertCurrent = () => { throw Error('denied'); };
  const preparation = new OfflineHandbookPreparation(s.deps);
  for (let i=0; i<128; i++) await assert.rejects(preparation.prepare({...s.run.work, runId: String(i)}), /denied/);
  await assert.rejects(preparation.prepare({...s.run.work, runId: 'new'}), /preparation_capacity/);
  await assert.rejects(preparation.prepare({...s.run.work, runId: '0'}), /preparation_attempt_denied/);
  assert.equal(s.calls(), 0);
});
test('admission rejection aborts model signal and never returns output', async () => {
  const s = setup(); let observed: AbortSignal | undefined;
  const model = s.deps.model;
  s.deps.model = async (input, signal) => {
    observed = signal;
    s.state.config.grants.find(g => g.memberId === 'sam')!.revoked = true;
    return model(input, signal);
  };
  await assert.rejects(new OfflineHandbookPreparation(s.deps).prepare(s.run.work));
  assert.equal(observed?.aborted, true);
});
