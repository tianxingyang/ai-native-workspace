import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { type Run, type Task, validateWork } from '../src/contracts.js';
import { type ControlConfig, ControlState } from '../src/control/state.js';
import { claimInput, researchIdentity, SLOT_INSTRUCTIONS } from '../src/control/work-identity.js';
import { ContextCompiler } from '../src/worker/context-compiler.js';
import { fixtureSources } from '../src/dev-fixture.js';
import { fixtureResult } from '../src/worker/fake.js';
import { PrivateEngine } from '../src/private/engine.js';
import { SnapshotStore } from '../src/private/store.js';
import { privateService } from '../src/private/service.js';
import { close, listen, requestJson } from '../src/http.js';
import { expectStatus } from './helpers.js';

const scope = { conversationId: 'claim-room', threadId: 'claim-thread' };
type Claim = { task: Task & { status: Run['status'] }; run: Run; duplicate: boolean; ownedByActor: boolean; blockedByCompletion?: true; blockedByInvalidation?: true; requestedWorkKey?: string; reconciliationRequired?: true };
type Saved = { state: ReturnType<ControlState['snapshot']>; leases: unknown[] };
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-work-claims-')), path = join(directory, 'control.sqlite');
  const tokens = { owner: randomBytes(32).toString('hex'), agent1: randomBytes(32).toString('hex'), agent2: randomBytes(32).toString('hex') };
  const config: ControlConfig = { members: [{ id: 'owner', kind: 'human', name: 'Owner' }, { id: 'agent1', kind: 'agent', name: 'First' }, { id: 'agent2', kind: 'agent', name: 'Second' }],
    memberships: { owner: [scope], agent1: [scope], agent2: [scope] }, researchMemberId: 'agent1', sources: fixtureSources,
    tokens: Object.fromEntries(Object.entries(tokens).map(([id, token]) => [token, id])),
    credentialExpiresAt: Object.fromEntries(Object.keys(tokens).map(id => [id, Date.now() + 3600000])),
    grants: Object.keys(tokens).map(memberId => ({ id: `grant-${memberId}`, revision: 1, memberId, ...scope,
      actions: ['read', 'send', 'claim', 'request_approval', 'cancel'], expiresAt: Date.now() + 3600000, revoked: false })) };
  let store = new SnapshotStore(path), engine = new PrivateEngine(store, config), service = privateService(engine), url = await listen(service);
  const api = { path, config, tokens, get url() { return url; }, get engine() { return engine; },
    source(key = 'source', text = '请调研合成协议') { return engine.commit(() => engine.state.createMessage('owner', scope, text, key)).message; },
    claim(messageId: string, actor: keyof typeof tokens = 'agent1', sourceRevision = 1, slot = 'research') {
      return requestJson<Claim>(url, tokens[actor], '/tools/claim', { sourceMessageId: messageId, sourceRevision, intent: 'research', slot });
    },
    async restart() { await close(service); store.close(); store = new SnapshotStore(path); engine = new PrivateEngine(store, config); service = privateService(engine); url = await listen(service); },
  };
  t.after(async () => { await close(service); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'coseat-work-claims-'))); await rm(directory, { recursive: true, force: true }); });
  return api;
}
async function child(script: string, input: unknown): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '--eval', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    process.stdout.on('data', value => { output += value; }); process.stderr.on('data', value => { error += value; });
    process.once('error', reject); process.once('close', code => resolve({ code, output, error }));
    process.stdin.end(JSON.stringify(input));
  });
}

test('work identity is versioned, scope/revision/slot bound and cannot be agent text or a body hash', () => {
  const source = { ...scope, messageId: 'message:1/中文', revision: 1 }, key = researchIdentity(source).key;
  assert.deepEqual(JSON.parse(key), ['coseat.work.v1', scope.conversationId, scope.threadId, source.messageId, 1, 'research', 'research']);
  for (const other of [{ ...source, conversationId: 'other' }, { ...source, threadId: 'other' }, { ...source, messageId: 'other' }, { ...source, revision: 2 }]) assert.notEqual(researchIdentity(other).key, key);
  assert.notEqual(researchIdentity(source, 'source_verification').key, key);
  const input = { sourceMessageId: source.messageId, sourceRevision: 1, intent: 'research' };
  assert.equal(claimInput(input).slot, 'research');
  for (const bad of [{ ...input, sourceRevision: undefined }, { ...input, sourceRevision: 1.1 }, { ...input, slot: 'agent custom plan' }, { ...input, slot: null }, { ...input, workKey: key }, { ...input, intent: 'publish' }]) assert.throws(() => claimInput(bad));
});

test('concurrent authorized members atomically share one durable Task/Run/pending dispatch', async t => {
  const env = await setup(t), source = env.source();
  const claims = await Promise.all(Array.from({ length: 24 }, (_, index) => env.claim(source.id, index % 2 ? 'agent1' : 'agent2')));
  assert.equal(claims.filter(value => !value.duplicate).length, 1);
  assert.equal(new Set(claims.map(value => value.task.id)).size, 1); assert.equal(new Set(claims.map(value => value.run.id)).size, 1);
  for (const value of claims) { assert.equal(value.task.ownerId, value.run.memberId); assert.equal(value.task.status, 'queued'); assert.equal(value.task.workKey, value.run.work.workIdentity!.key); }
  assert.ok(claims.some(value => value.ownedByActor)); assert.ok(claims.some(value => !value.ownedByActor));
  const saved = env.engine.store.load<Saved>()!;
  assert.equal(saved.state.tasks.length, 1); assert.equal(saved.state.claims.length, 1); assert.equal(saved.state.runs.length, 1);
  assert.deepEqual(saved.state.pendingDispatches, [[claims[0]!.run.id, { taskId: claims[0]!.task.id, runId: claims[0]!.run.id, workKey: claims[0]!.task.workKey }]]);
  await env.restart();
  const retried = await env.claim(source.id);
  assert.equal(retried.task.id, claims[0]!.task.id); assert.equal(retried.run.id, claims[0]!.run.id); assert.ok(retried.duplicate);
  const nonOwner = retried.run.memberId === 'agent1' ? 'agent2' : 'agent1';
  assert.throws(() => env.engine.state.currentRun(nonOwner, retried.run.id, 'claim'), /run_denied/);
  env.config.grants.find(grant => grant.memberId === nonOwner)!.revoked = true;
  await expectStatus(env.claim(source.id, nonOwner), 403, 'scope_denied');
});

test('complementary controlled slots are distinct work with bound instructions; equal text is not global deduplication', async t => {
  const env = await setup(t), first = env.source('first'), equalText = env.source('same-text');
  const primary = await env.claim(first.id), verification = await env.claim(first.id, 'agent2', 1, 'source_verification'), independent = await env.claim(equalText.id);
  assert.equal(new Set([primary.task.id, verification.task.id, independent.task.id]).size, 3);
  for (const value of [primary, verification]) {
    validateWork(value.run.work);
    const compiled = new ContextCompiler().compile(value.run.work, { id: 'input', text: 'untrusted data', contextRevision: value.run.work.contextRevision }, new AbortController().signal);
    assert.ok(compiled.systemPrompt.includes(SLOT_INSTRUCTIONS[value.task.slot]));
    assert.ok(compiled.systemPrompt.includes(value.task.workKey.replaceAll('"', '\\"')));
    const altered = structuredClone(value.run.work); altered.workIdentity!.key = primary.task.workKey === altered.workIdentity!.key ? verification.task.workKey : primary.task.workKey;
    assert.throws(() => validateWork(altered), /invalid_work_identity/);
  }
  await expectStatus(env.claim(first.id, 'agent2', 1, 'invent another key'), 400, 'unsupported_work_slot');
  assert.equal(env.engine.state.tasks.size, 3);
});

test('a failed durable commit rolls back claim, Task, Run and dispatch before retry', async t => {
  const env = await setup(t), source = env.source(), before = env.engine.store.load<Saved>()!;
  const save = env.engine.store.save;
  env.engine.store.save = () => { throw new Error('synthetic_claim_disk_failure'); };
  try { await expectStatus(env.claim(source.id), 500); }
  finally { env.engine.store.save = save; }
  assert.equal(env.engine.state.tasks.size, 0); assert.equal(env.engine.state.runs.size, 0); assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
  assert.deepEqual(env.engine.store.load<Saved>()!.state.tasks, before.state.tasks);
  assert.deepEqual(env.engine.store.load<Saved>()!.state.claims, before.state.claims);
  const retry = await env.claim(source.id); assert.equal(retry.duplicate, false);
  await env.restart(); assert.equal((await env.claim(source.id)).task.id, retry.task.id);
});

test('source/context rebuild retains one Task and version-key history; stale revision and retraction cannot dispatch', async t => {
  const env = await setup(t), source = env.source(), sibling = env.source('background', '普通背景');
  const first = await env.claim(source.id);
  env.engine.commit(() => env.engine.changeMessage('owner', sibling.id, 'edit', 1, 'background-edit', '修改后的背景'));
  const task = env.engine.state.tasks.get(first.task.id)!;
  assert.equal(task.runIds.length, 2); assert.notEqual(task.currentRunId, first.run.id);
  assert.equal(env.engine.state.runs.get(task.currentRunId)!.taskId, first.task.id);
  assert.equal(env.engine.state.runs.get(first.run.id)!.status, 'stopped');
  assert.ok(env.engine.state.runs.get(first.run.id)!.invalidatedBy);
  const rebuiltId = task.currentRunId;
  await env.restart();
  const same = await env.claim(source.id); assert.equal(same.run.id, rebuiltId); assert.equal(same.task.id, first.task.id);
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'source-edit', '请调研修改后的问题'));
  await expectStatus(env.claim(source.id), 409, 'source_revision_changed');
  const revised = await env.claim(source.id, 'agent1', 2);
  assert.equal(revised.task.id, first.task.id); assert.equal(revised.run.work.source.revision, 2); assert.equal(revised.task.source.revision, 2);
  assert.deepEqual(revised.task.workKeys, [first.task.workKey, revised.task.workKey]);
  assert.equal(env.engine.state.tasks.size, 1);
  assert.ok(env.engine.state.snapshot().claims.every(([, taskId]) => taskId === first.task.id));
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'retract', 2, 'source-retract'));
  await expectStatus(env.claim(source.id, 'agent2', 3), 409, 'message_retracted');
  assert.equal(env.engine.state.pendingRuns().length, 0);
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'after-retract')).command, 'idle');
});

test('new-revision claims cannot transfer an unconfirmed old execution to another owner, including after restart', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id);
  const old = env.engine.commit(() => env.engine.poll('agent1', 'original-worker'));
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'leased-edit', '请调研新版问题'));
  const contender = await env.claim(source.id, 'agent2', 2);
  assert.equal(contender.task.id, first.task.id); assert.equal(contender.task.ownerId, 'agent1'); assert.equal(contender.run.id, first.run.id);
  assert.equal(contender.blockedByInvalidation, true); assert.equal(contender.ownedByActor, false);
  assert.equal(env.engine.commit(() => env.engine.poll('agent2', 'contending-worker')).command, 'idle');
  assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1);
  await env.restart();
  assert.equal((await env.claim(source.id, 'agent2', 2)).blockedByInvalidation, true);
  assert.equal(env.engine.commit(() => env.engine.poll('agent2', 'contending-worker')).command, 'idle');
  assert.equal(env.engine.state.runs.get(first.run.id)!.status, 'cancel_requested');
  assert.equal(env.engine.state.runs.get(first.run.id)!.stopEvidence, undefined);
  env.engine.commit(() => env.engine.notStarted('agent1', 'original-worker', old.leaseId!));
  const replacement = env.engine.commit(() => env.engine.poll('agent1', 'original-worker'));
  assert.equal(replacement.command, 'execute'); assert.notEqual(replacement.runId, first.run.id);
  assert.equal(replacement.work!.taskId, first.task.id); assert.equal(replacement.work!.source.revision, 2);
  const task = env.engine.state.tasks.get(first.task.id)!;
  assert.equal(task.ownerId, 'agent1'); assert.equal(task.runIds.length, 2); assert.equal(task.workKeys.length, 2);
  assert.equal(env.engine.state.tasks.size, 1);
});

test('explicit user cancellation is not revived by a source edit or another member initial claim', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id);
  env.engine.commit(() => env.engine.cancel('owner', first.run.id));
  const cancelled = env.engine.state.runs.get(first.run.id)!;
  assert.equal(cancelled.status, 'stopped'); assert.equal(cancelled.invalidatedBy, undefined); assert.equal(cancelled.rebuildAfterInvalidation, false);
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'cancelled-source-edit', '请调研新版本问题'));
  const retry = await env.claim(source.id, 'agent2', 2);
  assert.equal(retry.task.id, first.task.id); assert.equal(retry.run.id, first.run.id); assert.equal(retry.task.status, 'stopped');
  assert.equal(retry.blockedByInvalidation, true); assert.equal(retry.ownedByActor, false);
  assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1);
  assert.equal(env.engine.commit(() => env.engine.poll('agent2', 'cancelled-contender')).command, 'idle');
  assert.equal(env.engine.commit(() => env.engine.poll('agent1', 'cancelled-owner')).command, 'idle');
  await env.restart();
  assert.equal((await env.claim(source.id, 'agent2', 2)).run.id, first.run.id);
  assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
});

test('publication fences completed work across sibling and source edits, sanitizes old events and survives restart', async t => {
  const env = await setup(t), source = env.source(), sibling = env.source('background', '背景');
  const first = await env.claim(source.id);
  env.engine.commit(() => {
    const run = env.engine.state.runs.get(first.run.id)!;
    env.engine.state.publish('agent1', run.id, fixtureResult()); run.status = 'completed';
    run.events.push({ id: 'obsolete-event', sequence: 1, sessionId: 'historical-session', runId: run.id, kind: 'output', status: 'completed', at: Date.now(), data: { text: 'WITHDRAWN_SECRET' } });
  });
  env.engine.commit(() => env.engine.changeMessage('owner', sibling.id, 'edit', 1, 'completed-background-edit', '新背景'));
  const afterContext = await env.claim(source.id, 'agent2');
  assert.equal(afterContext.run.id, first.run.id); assert.equal(afterContext.task.status, 'completed'); assert.ok(afterContext.duplicate);
  assert.equal(JSON.stringify(afterContext).includes('WITHDRAWN_SECRET'), false);
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'completed-source-edit', '请调研新的正文'));
  await expectStatus(env.claim(source.id), 409, 'source_revision_changed');
  await env.restart();
  const afterRevision = await env.claim(source.id, 'agent2', 2);
  assert.equal(afterRevision.blockedByCompletion, true); assert.equal(afterRevision.task.id, first.task.id); assert.equal(afterRevision.run.id, first.run.id);
  assert.deepEqual(afterRevision.task.workKeys, [first.task.workKey]); assert.equal(env.engine.state.snapshot().claims.length, 1);
  assert.equal(JSON.stringify(afterRevision).includes('WITHDRAWN_SECRET'), false);
  assert.ok(afterRevision.run.receiptId); assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1); assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
});

test('a complementary owner rebuilds under its own current authority, not the configured automatic research member', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id, 'agent2', 1, 'source_verification');
  env.config.grants.find(grant => grant.memberId === 'agent1')!.revoked = true;
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'independent-owner-edit', '请调研新版本的证据'));
  const next = await env.claim(source.id, 'agent2', 2, 'source_verification');
  assert.equal(next.task.id, first.task.id); assert.notEqual(next.run.id, first.run.id); assert.equal(next.task.ownerId, 'agent2');
  assert.equal(next.run.work.workIdentity!.slot, 'source_verification'); assert.equal(next.task.workKeys.length, 2);
  assert.equal(env.engine.state.currentRun('agent2', next.run.id, 'claim').id, next.run.id);
  await expectStatus(env.claim(source.id, 'agent1', 2, 'source_verification'), 403, 'scope_denied');
});

test('legacy snapshot migration retains original task/run IDs, owner and completed receipt without execution replay', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id);
  env.engine.commit(() => { env.engine.state.publish('agent1', first.run.id, fixtureResult()); env.engine.state.runs.get(first.run.id)!.status = 'completed'; });
  const legacy = env.engine.store.load<Saved>()!;
  const raw = legacy.state as unknown as Record<string, unknown>;
  delete raw.tasks; delete raw.pendingDispatches;
  for (const [, run] of legacy.state.runs) delete run.work.workIdentity;
  raw.claims = [[JSON.stringify([source.id, 1, 'research', 1]), first.run.id]];
  env.engine.store.save(legacy); await env.restart();
  const migrated = await env.claim(source.id, 'agent2');
  assert.equal(migrated.task.id, first.task.id); assert.equal(migrated.run.id, first.run.id); assert.equal(migrated.run.memberId, 'agent1');
  assert.equal(migrated.run.work.taskId, first.task.id); assert.ok(migrated.run.receiptId); assert.equal(migrated.task.status, 'completed');
  assert.equal(env.engine.state.tasks.size, 1); assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
});

test('ambiguous legacy key collisions retain every owner/receipt and fail closed instead of selecting a new executor', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id);
  env.engine.commit(() => { env.engine.state.publish('agent1', first.run.id, fixtureResult()); env.engine.state.runs.get(first.run.id)!.status = 'completed'; });
  const legacy = env.engine.store.load<Saved>()!, original = legacy.state.runs[0]![1];
  const conflicting = structuredClone(original);
  conflicting.id = 'legacy-conflicting-run'; conflicting.taskId = 'legacy-conflicting-task'; conflicting.memberId = 'agent2';
  conflicting.work.runId = conflicting.id; conflicting.work.taskId = conflicting.taskId; conflicting.work.memberId = conflicting.memberId;
  conflicting.status = 'queued'; delete conflicting.receiptId;
  delete original.work.workIdentity; delete conflicting.work.workIdentity;
  legacy.state.runs.push([conflicting.id, conflicting]);
  const raw = legacy.state as unknown as Record<string, unknown>; delete raw.tasks; delete raw.pendingDispatches;
  raw.claims = [[JSON.stringify([source.id, 1, 'research', 1]), original.id], [JSON.stringify([source.id, 1, 'research', 2]), conflicting.id]];
  env.engine.store.save(legacy); await env.restart();
  const migrated = await env.claim(source.id);
  assert.equal(migrated.reconciliationRequired, true); assert.equal(migrated.task.ownerId, null); assert.equal(migrated.ownedByActor, false);
  assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 2);
  assert.equal(env.engine.state.runs.get(original.id)!.taskId, original.taskId); assert.equal(env.engine.state.runs.get(original.id)!.memberId, 'agent1');
  assert.equal(env.engine.state.runs.get(original.id)!.receiptId, original.receiptId);
  assert.equal(env.engine.state.runs.get(conflicting.id)!.taskId, conflicting.taskId); assert.equal(env.engine.state.runs.get(conflicting.id)!.memberId, 'agent2');
  assert.equal(env.engine.state.runs.get(conflicting.id)!.status, 'unknown'); assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
  assert.equal(env.engine.commit(() => env.engine.poll('agent2', 'legacy-worker')).command, 'idle');
});

test('legacy replacement chains across source revisions migrate to their root Task without rewriting active wire identities', async t => {
  const env = await setup(t), source = env.source(), first = await env.claim(source.id);
  env.engine.commit(() => env.engine.changeMessage('owner', source.id, 'edit', 1, 'legacy-revision-edit', '请调研另一个版本'));
  const legacy = env.engine.store.load<Saved>()!, replacementId = env.engine.state.tasks.get(first.task.id)!.currentRunId;
  for (const [, run] of legacy.state.runs) {
    delete run.work.workIdentity;
    if (run.id === replacementId) { run.taskId = 'legacy-replacement-task'; run.work.taskId = run.taskId; }
  }
  const raw = legacy.state as unknown as Record<string, unknown>; delete raw.tasks; delete raw.pendingDispatches;
  raw.claims = legacy.state.runs.map(([, run]) => [JSON.stringify([source.id, run.work.source.revision, 'research', run.work.contextRevision]), run.id]);
  env.engine.store.save(legacy); await env.restart();
  const migrated = await env.claim(source.id, 'agent2', 2);
  assert.equal(migrated.task.id, first.task.id); assert.equal(migrated.task.currentRunId, replacementId); assert.equal(migrated.task.ownerId, 'agent1');
  assert.equal(migrated.task.source.revision, 2); assert.equal(migrated.task.workKeys.length, 2); assert.deepEqual(migrated.task.legacyTaskIds, ['legacy-replacement-task']);
  assert.equal(migrated.run.taskId, 'legacy-replacement-task'); assert.equal(migrated.run.work.taskId, 'legacy-replacement-task');
  assert.equal(migrated.reconciliationRequired, undefined); assert.equal(env.engine.state.tasks.size, 1);
  assert.ok(env.engine.state.snapshot().claims.every(([, taskId]) => taskId === first.task.id));
  await expectStatus(env.claim(source.id, 'agent1', 1), 409, 'source_revision_changed');
});

test('independent OS clients contend through the one controller; a second SQLite controller is rejected without changing a live lease', async t => {
  const env = await setup(t), source = env.source();
  const client = `let raw=''; for await (const part of process.stdin) raw += part;
    const input=JSON.parse(raw); const values=await Promise.all(Array.from({length:5},async()=>{
      const response=await fetch(input.url+'/tools/claim',{method:'POST',headers:{Authorization:'Bearer '+input.token,'Content-Type':'application/json'},body:JSON.stringify(input.body)});
      if(!response.ok) throw Error('claim status '+response.status); const value=await response.json();
      return {taskId:value.task.id,runId:value.run.id,duplicate:value.duplicate};})); console.log(JSON.stringify(values));`;
  const results = await Promise.all(['agent1', 'agent2', 'agent1'].map(actor => child(client, { url: env.url, token: env.tokens[actor as 'agent1' | 'agent2'], body: { sourceMessageId: source.id, sourceRevision: 1, intent: 'research' } })));
  for (const result of results) assert.equal(result.code, 0, result.error);
  const values = results.flatMap(result => JSON.parse(result.output) as { taskId: string; runId: string; duplicate: boolean }[]);
  assert.equal(new Set(values.map(value => value.taskId)).size, 1); assert.equal(values.filter(value => !value.duplicate).length, 1);
  const owner = env.engine.state.runs.get(values[0]!.runId)!.memberId;
  const delivery = env.engine.commit(() => env.engine.poll(owner, 'live-worker'));
  assert.equal(delivery.command, 'execute');
  const before = env.engine.store.load();
  const competitor = await child(`let raw=''; for await(const part of process.stdin) raw+=part; const input=JSON.parse(raw);
    const {SnapshotStore}=await import(input.module); try { const store=new SnapshotStore(input.path); store.close(); process.exitCode=2; }
    catch(error) { console.log(error.message); }`, { path: env.path, module: new URL('../src/private/store.js', import.meta.url).href });
  assert.equal(competitor.code, 0, competitor.error); assert.match(competitor.output, /locked/);
  assert.deepEqual(env.engine.store.load(), before); assert.equal(env.engine.state.runs.get(delivery.runId!)!.status, 'queued');
  await env.restart();
  const redelivery = env.engine.commit(() => env.engine.poll(owner, 'live-worker'));
  assert.equal(redelivery.command, 'cancel'); assert.equal(redelivery.runId, delivery.runId);
  assert.equal(env.engine.state.runs.get(delivery.runId!)!.status, 'unknown'); assert.deepEqual(env.engine.state.snapshot().pendingDispatches, []);
  assert.equal(env.engine.state.tasks.size, 1); assert.equal(env.engine.state.runs.size, 1);
});
