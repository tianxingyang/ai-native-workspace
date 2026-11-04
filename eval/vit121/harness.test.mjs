import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPlan, simulate, validateResults, summarize, blindPacket } from './harness.mjs';

const protocol = JSON.parse(await readFile(new URL('./protocol.json', import.meta.url), 'utf8'));
const tasks = JSON.parse(await readFile(new URL('./tasks.json', import.meta.url), 'utf8'));
const plan = buildPlan(protocol, tasks);
const records = simulate(plan);
const clone = value => structuredClone(value);

test('complete balanced reproducible matrix; exact role and workflow factorial', () => {
  assert.equal(plan.runs.length, 288);
  assert.deepEqual(buildPlan(protocol, tasks), plan);
  const rows = plan.runs.filter(r => r.taskId === tasks[0].id && r.mode === 'personal' && r.repeat === 0);
  const prompt = arm => rows.find(r => r.arm === arm).system;
  const role = protocol.prompts.role.replace('{role}', tasks[0].role);
  const workflow = protocol.prompts.workflow.replace('{procedure}', tasks[0].procedure);
  assert.equal(prompt('B'), `${prompt('A')}\n${role}`);
  assert.equal(prompt('C'), `${prompt('A')}\n${workflow}`);
  assert.equal(prompt('D'), `${prompt('A')}\n${role}\n${workflow}`);
  assert.ok(rows.every(r => !('acceptance' in r) && !('participation' in r)));
  assert.ok(rows.every(r => JSON.stringify(r.controls) === JSON.stringify(rows[0].controls)));
});

test('real models, malformed task sets and missing budget caps fail closed', () => {
  const live = clone(protocol); live.syntheticOnly = false;
  assert.throws(() => buildPlan(live, tasks), /synthetic fixtures only/);
  const snapshot = clone(protocol); snapshot.snapshots = ['latest'];
  assert.throws(() => buildPlan(snapshot, tasks), /Synthetic snapshots/);
  const caps = clone(protocol); delete caps.controls.budget.calls;
  assert.throws(() => buildPlan(caps, tasks), /Invalid cap/);
  assert.throws(() => buildPlan(protocol, [...tasks, tasks[0]]), /Unique/);
});

test('missing, duplicated, unknown, real and invalid records are rejected', () => {
  assert.throws(() => validateResults(plan, records.slice(1)), /Incomplete/);
  const duplicate = clone(records); duplicate[1] = duplicate[0];
  assert.throws(() => validateResults(plan, duplicate), /duplicate/);
  for (const [key, value] of [['runId', 'unknown'], ['synthetic', false], ['score', NaN], ['evidenceSupported', 999], ['humanInterventions', -1], ['status', 'skipped']]) {
    const changed = clone(records); changed[0][key] = value;
    assert.throws(() => validateResults(plan, changed));
  }
  const missingUsage = clone(records); delete missingUsage[0].usage.costMicros;
  assert.throws(() => validateResults(plan, missingUsage), /usage/);
});

test('over-budget records fail or become retained zero-quality failures', () => {
  const over = clone(records); over[0].usage.calls = 9;
  assert.throws(() => validateResults(plan, over), /budget failure/);
  over[0].status = 'budget_exceeded'; over[0].score = 0;
  validateResults(plan, over);
  const summary = summarize(plan, over);
  assert.equal(summary.strata.reduce((n, s) => n + s.arms.reduce((m, a) => m + a.runs, 0), 0), 288);
  const failed = clone(records); failed[0].status = 'failed'; failed[0].score = 3;
  assert.throws(() => validateResults(plan, failed), /zero ITT/);
});

test('blind packet has no assignment, identity, prompt or fake-score metadata', () => {
  const { packet, key } = blindPacket(plan, records);
  assert.equal(packet.items.length, 288);
  assert.equal(new Set(packet.items.map(i => i.blindId)).size, 288);
  assert.equal(key.mappings.length, 288);
  assert.equal(key.manifestHash, plan.manifestHash);
  const allowed = ['acceptance', 'blindId', 'evidenceNotes', 'output', 'rubricScore', 'sources', 'status', 'task'].sort();
  for (const item of packet.items) {
    assert.deepEqual(Object.keys(item).sort(), allowed);
    assert.equal(item.rubricScore, null);
    assert.ok(key.mappings.some(k => k.blindId === item.blindId));
  }
  const second = blindPacket(plan, records);
  assert.notDeepEqual(key.mappings.map(k => k.runId), second.key.mappings.map(k => k.runId), 'Packet order must not be reconstructible from the public seed');
});

test('snapshots and modes stay separate; undefined denominators are null', () => {
  const p = clone(protocol); p.snapshots.push('synthetic-fixture-v2');
  const two = buildPlan(p, tasks);
  const report = summarize(two, simulate(two));
  assert.equal(report.strata.length, 8);
  assert.equal(report.realModelCalls, 0);
  assert.equal(report.measuredModelCost, null);
  for (const stratum of report.strata) for (const arm of stratum.arms) {
    assert.equal(arm.runs, 18);
    assert.equal(arm.falseWake.denominator, stratum.cohort === 'work' ? 0 : 12);
    assert.equal(arm.missedEngagement.denominator, stratum.cohort === 'work' ? 18 : 6);
    if (stratum.mode === 'personal') assert.equal(arm.handoffs, null);
  }
  const empty = clone(records);
  for (const row of empty) { row.status = 'failed'; row.score = 0; row.evidenceClaims = 0; row.evidenceSupported = 0; }
  const zero = summarize(plan, empty).strata[0].arms[0];
  assert.equal(zero.evidence.rate, null);
  assert.equal(zero.costMicrosPerAccepted, null);
});

test('paired task bootstrap recovers known factorial effects without pooling repeats', () => {
  const fixed = clone(records);
  for (const row of fixed) {
    const run = plan.runs.find(r => r.runId === row.runId);
    row.status = 'ok'; row.score = { A: 1, B: 2, C: 2, D: 4 }[run.arm];
  }
  const report = summarize(plan, fixed);
  for (const stratum of report.strata) {
    assert.deepEqual(stratum.contrasts.roleWithoutWorkflow.interval95, [1, 1]);
    assert.equal(stratum.contrasts.roleWithWorkflow.estimate, 2);
    assert.equal(stratum.contrasts.interaction.estimate, 1);
    assert.equal(stratum.contrasts.interaction.independentTasks, 6);
  }
  const neutral = summarize(plan, records);
  assert.equal(neutral.strata[0].contrasts.combinedVersusGeneric.estimate, 0);
});

test('opposing work and participation effects cannot cancel in a pooled contrast', () => {
  const changed = clone(records);
  for (const row of changed) {
    const run = plan.runs.find(r => r.runId === row.runId);
    const task = tasks.find(t => t.id === run.taskId);
    row.status = 'ok';
    row.score = 2 + (run.arm === 'B' ? (task.family === 'participation' ? -1 : 1) : 0);
  }
  const report = summarize(plan, changed);
  assert.equal(report.strata.length, 4);
  for (const stratum of report.strata) {
    const expected = stratum.cohort === 'work' ? 1 : -1;
    assert.equal(stratum.contrasts.roleWithoutWorkflow.estimate, expected);
    assert.deepEqual(stratum.contrasts.roleWithoutWorkflow.interval95, [expected, expected]);
  }
});

test('manifest changes when prompts, controls or task evidence change', () => {
  const changed = clone(protocol); changed.prompts.role += ' Additional label.';
  assert.notEqual(buildPlan(changed, tasks).manifestHash, plan.manifestHash);
  const evidence = clone(tasks); evidence[0].sources[0] += ' revised';
  assert.notEqual(buildPlan(protocol, evidence).manifestHash, plan.manifestHash);
});

test('records from a different prompt, evidence or budget manifest cannot be reused', () => {
  const prompt = clone(protocol); prompt.prompts.role += ' revised';
  const budget = clone(protocol); budget.controls.budget.calls += 1;
  const evidence = clone(tasks); evidence[0].sources[0] += ' revised';
  for (const updated of [buildPlan(prompt, tasks), buildPlan(budget, tasks), buildPlan(protocol, evidence)]) {
    assert.throws(() => validateResults(updated, records), /Unknown/);
  }
});
