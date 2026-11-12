import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CHECK_IDS, assertComplete, assertEvidenceDirectory, checkoutIdentity, ciPaths, eventIdentity, git, readContext, stageEvidence, verifyComplete, verifyLogs, verifyStaged, writeContext } from './ci-quality.mjs';
import { preparationPlan, RUST_TOOLCHAIN } from './ci-prepare.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), TREE = 'd'.repeat(40), BASE_TREE = 'e'.repeat(40);
const REPO = 'tianxingyang/ai-native-workspace';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { base: A, head: B, baseTree: BASE_TREE, tree: TREE };
const RUNTIME_ENV = {
  PLAYWRIGHT_BROWSERS_PATH: '${{ runner.temp }}\\coseat-quality-${{ github.run_id }}-${{ github.run_attempt }}\\browsers',
  CARGO_TARGET_DIR: '${{ runner.temp }}\\coseat-quality-${{ github.run_id }}-${{ github.run_attempt }}\\cargo-target',
};

// Fixed-workflow semantic contract, not a general YAML/Actions validator.
// GitHub's availability table excludes runner/env/steps/job at job.env, but
// allows runner at step.env. This test runs before npm dependencies exist.
// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
function assertRuntimeEnvironmentScopes(workflow) {
  const lines = workflow.replaceAll('\r\n', '\n').split('\n');
  const block = (input, header, indent) => {
    const start = input.findIndex(line => line === `${' '.repeat(indent)}${header}`);
    assert.notEqual(start, -1, `Missing workflow block: ${header}`);
    const end = input.findIndex((line, index) => index > start && line.trim() && line.search(/\S/) <= indent);
    return input.slice(start + 1, end < 0 ? undefined : end);
  };
  const job = block(lines, 'complete-windows-gate:', 2);
  const jobEnv = block(job, 'env:', 4).join('\n');
  const allowed = new Set(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs']);
  for (const [, expression] of jobEnv.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const unquoted = expression.replace(/'(?:''|[^'])*'/g, "''");
    for (const [, context] of unquoted.matchAll(/(?<![.\w-])([a-z_][\w-]*)\s*(?:\.|\[)/gi)) {
      assert.ok(allowed.has(context.toLowerCase()), `Context ${context} is unavailable at job.env`);
    }
  }
  assert.doesNotMatch(jobEnv, /\b(?:PLAYWRIGHT_BROWSERS_PATH|CARGO_TARGET_DIR):/, 'Runtime paths must be step scoped');
  for (const id of ['prepare', 'gate']) {
    const start = job.findIndex(line => line === `        id: ${id}`);
    assert.notEqual(start, -1, `Missing step: ${id}`);
    const end = job.findIndex((line, index) => index > start && /^      - /.test(line));
    const stepEnv = block(job.slice(start, end < 0 ? undefined : end), 'env:', 8);
    const paths = Object.fromEntries(stepEnv.map(line => /^          ([A-Z_]+): (.*)$/.exec(line)).filter(match => match && Object.hasOwn(RUNTIME_ENV, match[1])).map(([, key, value]) => [key, value]));
    assert.deepEqual(paths, RUNTIME_ENV, `Missing or inconsistent runtime paths in step.env: ${id}`);
  }
}
const startedAt = '2026-11-11T01:00:00.000Z', finishedAt = '2026-11-11T01:00:01.000Z';
const push = (before = A, after = B) => ({ repository: { full_name: REPO }, ref: 'refs/heads/main', before, after, deleted: false });
const pr = () => ({ repository: { full_name: REPO }, action: 'synchronize', number: 7, pull_request: { base: { sha: A, ref: 'main', repo: { full_name: REPO } }, head: { sha: C, repo: { full_name: 'fork/project' } } } });
const passManifest = () => ({
  schemaVersion: 1, startedAt, finishedAt, host: { platform: 'win32', arch: 'x64' }, overallStatus: 'PASS', exitCode: 0,
  source: { ...identity, verifiedAtEnd: true }, setupErrors: [], integrityErrors: [], sourceEvents: [], tools: {},
  checks: CHECK_IDS.map(id => ({ id, required: true, status: 'PASS', exitCode: 0, startedAt, finishedAt, error: null, signal: null, timedOut: false,
    logs: ['stdout', 'stderr'].map(channel => ({ path: `${id}.${channel}.log`, sha256: hash(''), bytes: 0 })) })),
});

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'coseat-ci-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function windowsShortPath(path) {
  const command = String.raw`$ErrorActionPreference='Stop'; Add-Type 'using System.Text; using System.Runtime.InteropServices; public static class CoSeatPathTest { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint length); }'; $b=New-Object System.Text.StringBuilder 8192; if([CoSeatPathTest]::GetShortPathName($env:COSEAT_PATH_TEST,$b,8192) -eq 0){throw 'GetShortPathName failed'}; [Console]::Write('__SHORT_PATH__'+$b.ToString())`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, COSEAT_PATH_TEST: path }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const marker = result.stdout.lastIndexOf('__SHORT_PATH__');
  assert.ok(marker >= 0, result.stdout);
  const alias = result.stdout.slice(marker + '__SHORT_PATH__'.length).trim();
  assert.notEqual(alias.toLowerCase(), path.toLowerCase(), 'A genuine Windows short-name alias is required for this regression');
  return alias;
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

test('event contract: actual PR merge SHA, fork head, and push before/after only', () => {
  assert.deepEqual(eventIdentity('push', push(), B, REPO, 'refs/heads/main'), { eventName: 'push', repository: REPO, ref: 'refs/heads/main', base: A, head: B });
  assert.equal(eventIdentity('pull_request', pr(), B, REPO, 'refs/pull/7/merge').pullRequestHead, C);
  const rejects = [
    () => eventIdentity('pull_request_target', pr(), B, REPO, 'refs/pull/7/merge'),
    () => eventIdentity('workflow_dispatch', push(), B, REPO, 'refs/heads/main'),
    () => eventIdentity('push', push('0'.repeat(40)), B, REPO, 'refs/heads/main'),
    () => eventIdentity('push', { ...push(), deleted: true }, B, REPO, 'refs/heads/main'),
    () => eventIdentity('push', push(), C, REPO, 'refs/heads/main'),
    () => eventIdentity('push', push(), 'main; echo unsafe', REPO, 'refs/heads/main'),
    () => eventIdentity('push', push(), B.toUpperCase(), REPO, 'refs/heads/main'),
    () => eventIdentity('push', push(), B, 'another/repository', 'refs/heads/main'),
    () => eventIdentity('push', push(), B, REPO, 'refs/heads/topic'),
    () => eventIdentity('pull_request', pr(), C, REPO, 'refs/pull/7/merge'),
    () => eventIdentity('pull_request', pr(), B, REPO, 'refs/pull/7/head'),
    () => eventIdentity('pull_request', { ...pr(), action: 'closed' }, B, REPO, 'refs/pull/7/merge'),
  ];
  for (const reject of rejects) assert.throws(reject);
});

test('real Git: multi-commit ancestry, exact merge parents, wrong head and dirty checkout', async t => {
  const root = await temp(t);
  git(root, ['init', '--initial-branch', 'main']);
  await writeFile(join(root, 'base.txt'), 'base\n');
  const base = commit(root, 'base');
  await writeFile(join(root, 'one.txt'), 'one\n'); commit(root, 'one');
  await writeFile(join(root, 'two.txt'), 'two\n');
  const head = commit(root, 'two');
  assert.equal(checkoutIdentity(root, { base, head, eventName: 'push' }).head, head);
  assert.throws(() => checkoutIdentity(root, { base: head, head: base, eventName: 'push' }));
  git(root, ['checkout', '-b', 'feature']);
  await writeFile(join(root, 'feature.txt'), 'feature\n');
  const feature = commit(root, 'feature');
  git(root, ['checkout', 'main']);
  await writeFile(join(root, 'main.txt'), 'main\n');
  const main = commit(root, 'main');
  git(root, ['-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', 'merge', '--no-ff', 'feature', '-m', 'synthetic merge fixture']);
  const merge = git(root, ['rev-parse', 'HEAD']);
  assert.equal(checkoutIdentity(root, { base: main, head: merge, eventName: 'pull_request', pullRequestHead: feature }).head, merge);
  assert.throws(() => checkoutIdentity(root, { base: head, head: merge, eventName: 'pull_request', pullRequestHead: feature }), /parents/);
  assert.throws(() => checkoutIdentity(root, { base: main, head: merge, eventName: 'pull_request', pullRequestHead: main }), /parents/);
  await writeFile(join(root, 'untracked.txt'), 'dirty');
  assert.throws(() => checkoutIdentity(root, { base: main, head: merge, eventName: 'push' }), /clean/);
});

test('Windows short-name root is the same physical repository; nested/other repo/HEAD/dirty still reject', { skip: process.platform !== 'win32' }, async t => {
  const root = await temp(t);
  git(root, ['init', '--initial-branch', 'main']);
  await writeFile(join(root, 'proof.txt'), 'canonical root\n');
  const first = commit(root, 'canonical root');
  const canonical = realpathSync.native(root), alias = windowsShortPath(canonical);
  assert.equal(realpathSync.native(alias), canonical);
  assert.equal(checkoutIdentity(alias, { base: first, head: first, eventName: 'push' }).head, first);
  await mkdir(join(root, 'nested'));
  assert.throws(() => checkoutIdentity(join(alias, 'nested'), { base: first, head: first, eventName: 'push' }), /Expected the repository root/);
  const other = await temp(t);
  git(other, ['init', '--initial-branch', 'main']);
  await writeFile(join(other, 'other.txt'), 'different physical repository\n'); commit(other, 'other repository');
  assert.throws(() => checkoutIdentity(other, { base: first, head: first, eventName: 'push' }), /git rev-parse|Pinned commit/);
  await writeFile(join(root, 'proof.txt'), 'next version\n');
  const second = commit(root, 'next version');
  assert.throws(() => checkoutIdentity(alias, { base: first, head: first, eventName: 'push' }), /Checkout differs/);
  assert.equal(checkoutIdentity(alias, { base: first, head: second, eventName: 'push' }).head, second);
  await writeFile(join(root, 'dirty.txt'), 'untracked\n');
  assert.throws(() => checkoutIdentity(alias, { base: first, head: second, eventName: 'push' }), /not clean/);
});

test('Windows output aliases inside the checkout reject before writing; outside contexts still work', { skip: process.platform !== 'win32' }, async t => {
  const home = await temp(t), repo = join(home, 'repo'); await mkdir(repo);
  git(repo, ['init', '--initial-branch', 'main']);
  await writeFile(join(repo, '.gitignore'), 'ignored-evidence/\n');
  const head = commit(repo, 'output boundary fixture');
  await mkdir(join(repo, 'ignored-evidence'));
  const canonical = realpathSync.native(repo), alias = windowsShortPath(canonical);
  const env = { GITHUB_WORKSPACE: canonical, GITHUB_RUN_ID: '134', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head, GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(home, 'event.json'), GITHUB_OUTPUT: join(home, 'outputs') };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(push(head, head)));
  for (const suffix of ['', 'not-created/nested']) {
    const invalid = { ...env, RUNNER_TEMP: join(alias, 'ignored-evidence', suffix) };
    let error;
    try { await writeContext(invalid); } catch (caught) { error = caught; }
    assert.equal(existsSync(join(invalid.RUNNER_TEMP, 'coseat-quality-134-1')), false, 'No context directory may be created inside the checkout');
    assert.match(error?.message ?? '', /outside/);
    assert.throws(() => ciPaths(invalid), /outside/);
  }
  assert.equal(existsSync(join(repo, 'ignored-evidence/not-created')), false);
  assert.doesNotThrow(() => ciPaths({ ...env, RUNNER_TEMP: join(home, 'future/external/nested') }));
  const external = { ...env, RUNNER_TEMP: home };
  assert.equal((await writeContext(external)).head, head);
  assert.ok(existsSync(ciPaths(external).context));
});

test('complete manifest: all non-PASS, missing, unfinished and mismatched states reject', () => {
  assert.doesNotThrow(() => assertComplete(passManifest(), identity)); // Synthetic contract fixture only.
  const mutations = [
    m => { m.checks.pop(); },
    m => { m.checks[6] = m.checks[0]; },
    m => { m.checks[0].id = 'unknown'; },
    m => { m.overallStatus = 'FAIL'; },
    m => { m.exitCode = 1; },
    m => { m.finishedAt = null; },
    m => { m.finishedAt = 'invalid'; },
    m => { m.source.verifiedAtEnd = false; },
    m => { m.source.base = C; },
    m => { m.source.tree = C; },
    m => { m.host.platform = 'linux'; },
    m => { m.setupErrors.push('setup'); },
    m => { delete m.integrityErrors; },
    m => { m.sourceEvents.push({ path: 'file' }); },
    m => { m.checks[0].required = false; },
    m => { m.checks[0].exitCode = 1; },
    m => { m.checks[0].error = 'failed to start'; },
    m => { m.checks[0].signal = 'SIGTERM'; },
    m => { m.checks[0].timedOut = true; },
    m => { m.checks[0].finishedAt = null; },
    m => { m.checks[0].logs.pop(); },
    m => { m.checks[0].logs[1] = m.checks[0].logs[0]; },
    ...['FAIL', 'SKIPPED', 'NOT-RUN', 'SETUP-ERROR'].map(status => m => { m.checks[0].status = status; }),
  ];
  for (const mutate of mutations) { const manifest = passManifest(); mutate(manifest); assert.throws(() => assertComplete(manifest, identity)); }
});

test('log evidence: real bytes/hashes, truncation, traversal and missing files', async t => {
  const output = await temp(t), manifest = passManifest();
  for (const check of manifest.checks) for (const log of check.logs) await writeFile(join(output, log.path), '');
  await verifyLogs(manifest, output);
  await writeFile(join(output, 'unit.stdout.log'), 'tampered');
  await assert.rejects(verifyLogs(manifest, output), /hash/);
  await writeFile(join(output, 'unit.stdout.log'), '');
  manifest.checks[0].logs[0].path = '../secret.log';
  await assert.rejects(verifyLogs(manifest, output), /reference/);
  manifest.checks[0].logs[0].path = 'unit.stdout.log';
  await rm(join(output, 'unit.stdout.log'));
  await assert.rejects(verifyLogs(manifest, output));
});

test('artifact allowlist: partial failure evidence only, regular directory and link-rejection policy', async t => {
  const root = await temp(t), env = { RUNNER_TEMP: root, GITHUB_WORKSPACE: join(root, 'repo'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const paths = ciPaths(env);
  await mkdir(paths.gate, { recursive: true });
  await writeFile(join(paths.gate, 'manifest.json'), JSON.stringify({ overallStatus: 'NOT-RUN' }));
  await writeFile(join(paths.gate, 'unit.stdout.log'), 'partial stdout');
  await writeFile(join(paths.gate, 'private-config.json'), 'must never be uploaded');
  await assert.rejects(stageEvidence(env), /Unexpected/);
  await rm(join(paths.gate, 'private-config.json'));
  await stageEvidence(env);
  assert.deepEqual((await readdir(paths.artifact)).sort(), ['manifest.json', 'unit.stdout.log']);
  await assert.rejects(stageEvidence(env)); // Existing artifact never overwritten.
  await rm(paths.gate, { recursive: true });
  await writeFile(paths.gate, 'not a directory');
  await assert.rejects(stageEvidence(env), /links/);
  // Exercise link policy without requiring Windows symlink privileges. An
  // actual junction creation is forbidden by some managed local sandboxes.
  assert.throws(() => assertEvidenceDirectory({ isDirectory: () => true, isSymbolicLink: () => true }), /links/);
  assert.throws(() => ciPaths({ ...env, GITHUB_RUN_ID: '../escape' }));
  assert.throws(() => ciPaths({ ...env, GITHUB_WORKSPACE: root }), /outside/);
});

test('end-to-end adapter: real context and synthetic manifest, then failed/skipped/canceled/missing outcomes', async t => {
  const root = await temp(t), repo = join(root, 'repo'); await mkdir(repo);
  git(repo, ['init', '--initial-branch', 'main']);
  const inputNames = ['.node-version', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  await mkdir(join(repo, 'src-tauri'));
  for (const name of inputNames) await writeFile(join(repo, name), `${name}\n`);
  const head = commit(repo, 'inputs');
  const env = { RUNNER_TEMP: root, GITHUB_WORKSPACE: repo, GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head, GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_OUTPUT: join(root, 'outputs') };
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(push(head, head)));
  const context = await writeContext(env), paths = ciPaths(env);
  assert.equal((await readContext(env)).identity.head, head);
  await assert.rejects(writeContext(env)); // No stale run reuse.
  const manifest = passManifest(); manifest.source = { ...context, verifiedAtEnd: true, inputs: {} };
  for (const name of inputNames) manifest.source.inputs[name] = hash(await readFile(join(repo, name)));
  await mkdir(paths.gate);
  for (const check of manifest.checks) for (const log of check.logs) await writeFile(join(paths.gate, log.path), '');
  await writeFile(join(paths.gate, 'manifest.json'), JSON.stringify(manifest));
  await stageEvidence(env);
  for (const step of ['PREPARE', 'GATE', 'STAGE', 'BUNDLE', 'UPLOAD']) env[`QUALITY_${step}_OUTCOME`] = 'success';
  await verifyComplete(env); // Verifies an explicitly synthetic test fixture, not a real gate result.
  await writeFile(join(paths.artifact, 'unit.stdout.log'), 'staged copy changed');
  await assert.rejects(verifyStaged(env), /differs/); // Pre-upload path must block too.
  await assert.rejects(verifyComplete(env), /differs/);
  await writeFile(join(paths.artifact, 'unit.stdout.log'), '');
  await writeFile(join(paths.artifact, 'private-config.json'), 'must not be uploaded');
  await assert.rejects(verifyComplete(env), /file set/);
  await rm(join(paths.artifact, 'private-config.json'));
  await writeFile(join(paths.artifact, 'manifest.json'), '{}');
  await assert.rejects(verifyComplete(env), /Staged file/);
  await writeFile(join(paths.artifact, 'manifest.json'), JSON.stringify(manifest));
  for (const step of ['PREPARE', 'GATE', 'STAGE', 'BUNDLE', 'UPLOAD']) for (const outcome of ['failure', 'skipped', 'cancelled', '']) {
    await assert.rejects(verifyComplete({ ...env, [`QUALITY_${step}_OUTCOME`]: outcome }), /not successful/);
  }
  manifest.source.inputs['package.json'] = '0'.repeat(64);
  await writeFile(join(paths.gate, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(paths.artifact, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyComplete(env), /Input hash/);
  await rm(join(paths.gate, 'manifest.json'));
  await assert.rejects(verifyComplete(env));
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(push(A, head)));
  await assert.rejects(readContext(env));
});

test('preparation is fixed, locked, script-free npm install, pinned Rust and separate from gate', () => {
  const plan = preparationPlan('node.exe', 'npm-cli.js', 'C:/repo', 'C:/temp');
  assert.equal(RUST_TOOLCHAIN, '1.95.0-x86_64-pc-windows-msvc');
  assert.deepEqual(plan[0][1].slice(0, 3), ['toolchain', 'install', RUST_TOOLCHAIN]);
  assert.ok(plan[1][1].includes('--ignore-scripts'));
  assert.ok(plan[1][1].includes('--registry=https://registry.npmjs.org'));
  assert.ok(plan[3][1].includes('--locked'));
  assert.equal(plan[4][2].CARGO_NET_OFFLINE, 'true');
  assert.ok(!JSON.stringify(plan).includes('quality:gate'));
});

test('workflow safety contract: exact commits, read-only hosted Windows and no green fallbacks', async () => {
  const workflow = await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\s*\n  contents: read\s*\n/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /set-safe-directory: false/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /retention-days: 3/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /exit \$LASTEXITCODE/);
  assert.match(workflow, /ci-quality\.mjs verify/);
  assert.match(workflow, /ci-quality\.mjs bundle/);
  assert.match(workflow, /steps\.bundle\.outcome == 'success'/);
  for (const match of workflow.matchAll(/uses: ([^\s#]+)/g)) assert.match(match[1], /^actions\/(checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
  assert.equal([...workflow.matchAll(/uses: /g)].length, 3);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|self-hosted|continue-on-error|secrets[.[]|id-token:|contents: write|pull-requests: write|paths-ignore:|--only|--skip|workflow_dispatch/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{/); // No event values interpolated into shell code.
  assert.match(workflow, /!cancelled\(\)/);
});

test('workflow context availability: runner runtime paths belong to prepare/gate step.env', async () => {
  assertRuntimeEnvironmentScopes(await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8'));
});

test('workflow context regression rejects unavailable job contexts and inconsistent runtime paths', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  for (const expression of ['runner.temp', "runner['temp']", 'steps.context.outputs.output', 'env.RUNNER_TEMP', 'job.status']) {
    const invalid = workflow.replace("      CI: 'true'", "      CI: 'true'\n      INVALID_CONTEXT: " + '${{ ' + expression + ' }}');
    assert.throws(() => assertRuntimeEnvironmentScopes(invalid), /unavailable at job.env/);
  }
  const missing = workflow.replace(`          PLAYWRIGHT_BROWSERS_PATH: ${RUNTIME_ENV.PLAYWRIGHT_BROWSERS_PATH}\n`, '');
  assert.notEqual(missing, workflow);
  assert.throws(() => assertRuntimeEnvironmentScopes(missing), /runtime paths/);
  const mismatched = workflow.replace(`          CARGO_TARGET_DIR: ${RUNTIME_ENV.CARGO_TARGET_DIR}`, '          CARGO_TARGET_DIR: another-run-directory');
  assert.notEqual(mismatched, workflow);
  assert.throws(() => assertRuntimeEnvironmentScopes(mismatched), /runtime paths/);
});
