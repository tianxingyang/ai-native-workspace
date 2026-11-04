import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISCLAIMER = 'SYNTHETIC PIPELINE CHECK ONLY — no model evaluation or measured arm advantage.';
const ARMS = ['A', 'B', 'C', 'D'];
const METERS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'calls', 'toolCalls', 'wallMs', 'costMicros'];
const STATUSES = ['ok', 'failed', 'timeout', 'budget_exceeded'];
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const ratio = (a, b) => b ? a / b : null;
const integer = n => Number.isSafeInteger(n) && n >= 0;

export function rng(seed) {
  let n = seed >>> 0;
  return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 2 ** 32; };
}

function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function validateProtocol(protocol, tasks) {
  assert(protocol.syntheticOnly === true, 'This harness supports synthetic fixtures only; live execution is not implemented.');
  assert(Number.isSafeInteger(protocol.seed) && protocol.seed >= 0, 'Invalid seed');
  assert(Number.isInteger(protocol.repeats) && protocol.repeats >= 2, 'Need at least two repeats');
  assert(JSON.stringify(protocol.arms) === JSON.stringify(ARMS), 'Exactly four ordered arms A/B/C/D required');
  assert(Array.isArray(protocol.snapshots) && protocol.snapshots.length > 0 && new Set(protocol.snapshots).size === protocol.snapshots.length && protocol.snapshots.every(s => /^synthetic-[\w-]+$/.test(s)), 'Synthetic snapshots must be unique and explicitly labelled');
  assert(JSON.stringify(protocol.modes) === JSON.stringify(['personal', 'collaboration']), 'Separate personal and collaboration modes required');
  assert(protocol.controls.members.personal === 1 && protocol.controls.members.collaboration === 3, 'Fixed member counts required');
  for (const meter of METERS) assert(integer(protocol.controls.budget[meter]) && protocol.controls.budget[meter] > 0, `Invalid cap ${meter}`);
  assert(tasks.length > 0 && new Set(tasks.map(t => t.id)).size === tasks.length, 'Unique nonempty task set required');
  for (const task of tasks) {
    assert(/^[a-z0-9-]+$/.test(task.id), 'Invalid task ID');
    assert(['development', 'research', 'product', 'participation'].includes(task.family), 'Invalid family');
    assert(['engage', 'quiet'].includes(task.participation), 'Invalid participation label');
    for (const key of ['role', 'procedure', 'prompt']) assert(typeof task[key] === 'string' && task[key].length > 0, `Missing task ${key}`);
    for (const key of ['sources', 'acceptance']) assert(Array.isArray(task[key]) && task[key].length > 0 && task[key].every(s => typeof s === 'string'), `Invalid task ${key}`);
  }
}

export function buildPlan(protocol, tasks) {
  validateProtocol(protocol, tasks);
  const manifestHash = hash({ protocol, tasks });
  const random = rng(protocol.seed);
  const runs = [];
  for (const snapshot of protocol.snapshots) for (const mode of protocol.modes) {
    for (const task of shuffle(tasks, random)) for (let repeat = 0; repeat < protocol.repeats; repeat++) {
      for (const arm of shuffle(ARMS, random)) {
        const role = protocol.prompts.role.replace('{role}', task.role);
        const workflow = protocol.prompts.workflow.replace('{procedure}', task.procedure);
        const system = [protocol.prompts.common, ...(['B', 'D'].includes(arm) ? [role] : []), ...(['C', 'D'].includes(arm) ? [workflow] : [])].join('\n');
        const fields = { snapshot, mode, taskId: task.id, repeat, arm };
        runs.push({ ...fields, runId: hash({ manifestHash, ...fields }).slice(0, 24), system, task: task.prompt, sources: task.sources, controls: protocol.controls });
      }
    }
  }
  return { disclaimer: DISCLAIMER, manifestHash, protocol, tasks, runs };
}

// Pure in-process fixture: no SDK, credentials, subprocess, network, or real-model adapter.
// Deliberately arm-independent. Equal fake scores demonstrate plumbing, not equivalence.
export function simulate(plan) {
  return plan.runs.map(run => {
    const task = plan.tasks.find(t => t.id === run.taskId);
    const sample = parseInt(hash({ taskId: run.taskId, repeat: run.repeat, mode: run.mode }).slice(0, 8), 16);
    const status = sample % 13 === 0 ? 'timeout' : 'ok';
    const responded = status === 'ok' && (task.participation === 'engage' ? sample % 7 !== 0 : sample % 11 === 0);
    return {
      runId: run.runId, synthetic: true, status,
      output: status === 'ok' ? (responded ? 'Synthetic deliverable placeholder; not a model answer.' : '') : '',
      responded, score: status === 'ok' ? (responded === (task.participation === 'engage') ? 3 : 1) : 0,
      evidenceSupported: status === 'ok' && responded ? 2 : 0,
      evidenceClaims: responded ? 3 : 0,
      unauthorizedAttempts: sample % 17 === 0 ? 1 : 0,
      unauthorizedExecuted: 0, duplicateActions: sample % 19 === 0 ? 1 : 0,
      handoffs: run.mode === 'collaboration' && responded ? 2 : 0,
      validHandoffs: run.mode === 'collaboration' && responded ? 1 : 0,
      loopEvents: run.mode === 'collaboration' && sample % 23 === 0 ? 1 : 0,
      humanInterventions: status === 'ok' ? 0 : 1,
      usage: { inputTokens: 500, outputTokens: 100, reasoningTokens: 60, calls: run.mode === 'personal' ? 1 : 3, toolCalls: 2, wallMs: status === 'timeout' ? 120000 : 100, costMicros: 0 }
    };
  });
}

export function validateResults(plan, results) {
  assert(Array.isArray(results) && results.length === plan.runs.length, 'Incomplete run matrix; do not drop failures');
  const expected = new Map(plan.runs.map(r => [r.runId, r]));
  const seen = new Set();
  for (const row of results) {
    assert(expected.has(row.runId) && !seen.has(row.runId), 'Unknown or duplicate run');
    seen.add(row.runId);
    assert(row.synthetic === true, 'Only synthetic records accepted');
    assert(STATUSES.includes(row.status), 'Invalid status');
    assert(typeof row.output === 'string' && typeof row.responded === 'boolean', 'Invalid output or response flag');
    assert(Number.isFinite(row.score) && row.score >= 0 && row.score <= 4, 'Invalid quality score');
    assert(row.status === 'ok' || row.score === 0, 'Failures must retain zero ITT quality');
    for (const key of ['evidenceSupported', 'evidenceClaims', 'unauthorizedAttempts', 'unauthorizedExecuted', 'duplicateActions', 'handoffs', 'validHandoffs', 'loopEvents', 'humanInterventions']) assert(integer(row[key]), `Invalid count ${key}`);
    assert(row.evidenceSupported <= row.evidenceClaims && row.validHandoffs <= row.handoffs, 'Numerator exceeds denominator');
    assert(row.unauthorizedExecuted <= row.unauthorizedAttempts, 'Executed unauthorized actions exceed attempts');
    if (expected.get(row.runId).mode === 'personal') assert(row.handoffs === 0 && row.validHandoffs === 0 && row.loopEvents === 0, 'Personal mode cannot contain member coordination');
    for (const key of METERS) {
      assert(integer(row.usage?.[key]), `Missing or invalid usage ${key}`);
      if (row.usage[key] > plan.protocol.controls.budget[key]) assert(row.status === 'budget_exceeded', `Exceeded ${key} must be a budget failure`);
    }
  }
}

// Blind packet intentionally contains neither arm, snapshot, mode, repeat, runId,
// system prompt nor synthetic numeric grade. Custodian alone retains key.json.
export function blindPacket(plan, results) {
  validateResults(plan, results);
  const key = [];
  // Public scheduling seeds must never reveal blinded assignment by position.
  const items = shuffle(results, () => randomInt(2 ** 32) / 2 ** 32).map(row => {
    const run = plan.runs.find(r => r.runId === row.runId);
    const task = plan.tasks.find(t => t.id === run.taskId);
    const blindId = randomUUID();
    key.push({ blindId, runId: run.runId });
    return { blindId, task: task.prompt, sources: task.sources, acceptance: task.acceptance, output: row.output, status: row.status, rubricScore: null, evidenceNotes: '' };
  });
  return { packet: { disclaimer: DISCLAIMER, items }, key: { manifestHash: plan.manifestHash, mappings: key } };
}

// Paired task-cluster bootstrap: average repeats first, then sample tasks within
// each family. All four arms travel together. Modes and snapshots never pool.
function contrast(rows, tasks, weights, seed) {
  const taskValues = tasks.map(task => {
    const score = arm => mean(rows.filter(r => r.taskId === task.id && r.arm === arm).map(r => r.score));
    return { family: task.family, value: ARMS.reduce((sum, arm, i) => sum + weights[i] * score(arm), 0) };
  });
  const strata = [...new Set(taskValues.map(t => t.family))].map(f => taskValues.filter(t => t.family === f));
  const random = rng(seed);
  const distribution = Array.from({ length: 2000 }, () => mean(strata.flatMap(s => s.map(() => s[Math.floor(random() * s.length)].value)))).sort((a, b) => a - b);
  return { estimate: mean(taskValues.map(t => t.value)), interval95: [distribution[49], distribution[1949]], independentTasks: taskValues.length, warning: 'Illustrative synthetic interval; tiny convenience sample; no significance, equivalence or population claim.' };
}

export function summarize(plan, results) {
  validateResults(plan, results);
  const joined = results.map(row => ({ ...row, ...plan.runs.find(r => r.runId === row.runId) }));
  const strata = [];
  for (const snapshot of plan.protocol.snapshots) for (const mode of plan.protocol.modes) for (const cohort of ['work', 'participation']) {
    const cohortTasks = plan.tasks.filter(t => (t.family === 'participation') === (cohort === 'participation'));
    if (!cohortTasks.length) continue;
    const taskIds = new Set(cohortTasks.map(t => t.id));
    const rows = joined.filter(r => r.snapshot === snapshot && r.mode === mode && taskIds.has(r.taskId));
    const arms = ARMS.map(arm => {
      const rs = rows.filter(r => r.arm === arm);
      const sum = field => rs.reduce((n, r) => n + r[field], 0);
      const quiet = rs.filter(r => plan.tasks.find(t => t.id === r.taskId).participation === 'quiet');
      const engage = rs.filter(r => plan.tasks.find(t => t.id === r.taskId).participation === 'engage');
      const passed = rs.filter(r => r.status === 'ok' && r.score >= 3 && r.unauthorizedAttempts === 0).length;
      const cost = rs.reduce((n, r) => n + r.usage.costMicros, 0);
      const durations = rs.map(r => r.usage.wallMs).sort((a, b) => a - b);
      return {
        arm, runs: rs.length, qualityITT: mean(rs.map(r => r.score)),
        qualityByFamily: Object.fromEntries([...new Set(cohortTasks.map(t => t.family))].map(f => [f, mean(rs.filter(r => plan.tasks.find(t => t.id === r.taskId).family === f).map(r => r.score))])),
        completed: rs.filter(r => r.status === 'ok').length, accepted: passed,
        falseWake: { numerator: quiet.filter(r => r.responded).length, denominator: quiet.length, rate: ratio(quiet.filter(r => r.responded).length, quiet.length) },
        missedEngagement: { numerator: engage.filter(r => !r.responded).length, denominator: engage.length, rate: ratio(engage.filter(r => !r.responded).length, engage.length) },
        evidence: { supported: sum('evidenceSupported'), claims: sum('evidenceClaims'), rate: ratio(sum('evidenceSupported'), sum('evidenceClaims')) },
        unauthorizedAttempts: sum('unauthorizedAttempts'), unauthorizedExecuted: sum('unauthorizedExecuted'),
        duplicateActions: sum('duplicateActions'), loopEvents: sum('loopEvents'), humanInterventions: sum('humanInterventions'),
        handoffs: mode === 'personal' ? null : { valid: sum('validHandoffs'), total: sum('handoffs'), rate: ratio(sum('validHandoffs'), sum('handoffs')) },
        usage: Object.fromEntries(METERS.map(k => [k, rs.reduce((n, r) => n + r.usage[k], 0)])),
        costMicrosPerAccepted: ratio(cost, passed), latencyP50Ms: durations[Math.ceil(durations.length * .5) - 1], latencyP95Ms: durations[Math.ceil(durations.length * .95) - 1]
      };
    });
    const contrasts = Object.fromEntries(Object.entries({ roleWithoutWorkflow: [-1, 1, 0, 0], workflowWithoutRole: [-1, 0, 1, 0], roleWithWorkflow: [0, 0, -1, 1], combinedVersusGeneric: [-1, 0, 0, 1], interaction: [1, -1, -1, 1] }).map(([name, weights]) => [name, contrast(rows, cohortTasks, weights, plan.protocol.seed)]));
    strata.push({ snapshot, mode, cohort, arms, contrasts });
  }
  return { disclaimer: DISCLAIMER, manifestHash: plan.manifestHash, evidenceType: 'synthetic', realModelCalls: 0, measuredModelCost: null, strata };
}

async function main() {
  const [command, output] = process.argv.slice(2);
  assert(command === 'demo' && output, 'Usage: node eval/vit121/harness.mjs demo <new-output-directory>');
  const protocol = JSON.parse(await readFile(new URL('./protocol.json', import.meta.url), 'utf8'));
  const tasks = JSON.parse(await readFile(new URL('./tasks.json', import.meta.url), 'utf8'));
  const plan = buildPlan(protocol, tasks);
  const results = simulate(plan);
  const report = summarize(plan, results);
  const blind = blindPacket(plan, results);
  // Refuse to overwrite an existing artifact directory, including a prior blind key.
  const directory = resolve(output);
  await mkdir(directory, { recursive: false });
  for (const [name, value] of Object.entries({ plan, results, report, 'blind-packet': blind.packet, 'custodian-key': blind.key })) await writeFile(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  console.log(`${DISCLAIMER}\n${plan.runs.length} synthetic runs; ${report.strata.length} separate strata; artifacts: ${directory}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
