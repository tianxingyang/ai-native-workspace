import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// VIT-134: CI adapter for the VIT-133 gate, not another implementation of it.
export const CHECK_IDS = Object.freeze(['unit', 'web', 'eval', 'browser', 'rust-fmt', 'rust-test', 'rust-clippy']);
const TOOL_IDS = ['git', 'node', 'npm', 'chromium', 'cargo', 'rustc', 'rustfmt', 'clippy', 'cargo-cache'];
const INPUTS = ['.node-version', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const LOG_NAMES = new Set([...CHECK_IDS, ...TOOL_IDS.map(id => `setup-${id}`), ...TOOL_IDS.filter(id => id !== 'cargo-cache').map(id => `final-${id}`)]
  .flatMap(id => [`${id}.stdout.log`, `${id}.stderr.log`]));
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0{40}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const date = value => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  insist(!result.error && result.status === 0, `git ${args[0]} failed: ${result.error?.message ?? result.stderr?.trim()}`);
  return result.stdout.trim();
}

export function eventIdentity(eventName, event, githubSha, repository, ref) {
  insist(sha(githubSha), 'GITHUB_SHA must be a full nonzero lowercase commit SHA');
  insist(typeof repository === 'string' && repository === event.repository?.full_name, 'Event repository does not match GITHUB_REPOSITORY');
  if (eventName === 'pull_request') {
    const pr = event.pull_request;
    insist(['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'].includes(event.action), 'Unsupported pull request action');
    insist(Number.isSafeInteger(event.number) && event.number > 0 && ref === `refs/pull/${event.number}/merge`, 'Expected the pull request merge ref');
    insist(pr?.base?.ref === 'main' && pr.base.repo?.full_name === repository, 'Expected a pull request targeting this repository main');
    insist(sha(pr.base.sha) && sha(pr.head?.sha) && githubSha !== pr.head.sha, 'Expected exact PR base/head and a synthetic merge SHA');
    return { eventName, repository, ref, base: pr.base.sha, head: githubSha, pullRequestHead: pr.head.sha, pullRequestNumber: event.number };
  }
  insist(eventName === 'push', 'Only push and pull_request events are supported');
  insist(ref === 'refs/heads/main' && event.ref === ref, 'Expected a push to main');
  insist(event.deleted !== true && sha(event.before) && sha(event.after), 'Deleted branches and zero-SHA first pushes are unsupported; no baseline fallback');
  insist(event.after === githubSha, 'Push after SHA does not match GITHUB_SHA');
  return { eventName, repository, ref, base: event.before, head: githubSha };
}

export function checkoutIdentity(root, identity) {
  insist(samePath(resolve(git(root, ['rev-parse', '--show-toplevel'])), resolve(root)), 'Expected the repository root');
  for (const commit of [identity.base, identity.head]) {
    insist(sha(commit) && git(root, ['rev-parse', '--verify', `${commit}^{commit}`]) === commit, 'Pinned commit is unavailable or mismatched');
  }
  insist(git(root, ['rev-parse', 'HEAD']) === identity.head, 'Checkout differs from event SHA');
  git(root, ['merge-base', '--is-ancestor', identity.base, identity.head]);
  if (identity.eventName === 'pull_request') {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', identity.head]).split(' ');
    insist(parents.length === 3 && parents[1] === identity.base && parents[2] === identity.pullRequestHead, 'Synthetic merge parents do not exactly match event base/head');
  }
  insist(!git(root, ['status', '--porcelain=v1', '--untracked-files=all']), 'CI checkout is not clean');
  return { ...identity, baseTree: git(root, ['rev-parse', `${identity.base}^{tree}`]), tree: git(root, ['rev-parse', `${identity.head}^{tree}`]) };
}

export function ciPaths(env = process.env) {
  insist(isAbsolute(env.RUNNER_TEMP ?? '') && isAbsolute(env.GITHUB_WORKSPACE ?? ''), 'Absolute runner temp and workspace paths are required');
  insist(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Expected numeric run ID and attempt');
  const root = resolve(env.RUNNER_TEMP, `coseat-quality-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  const inside = relative(resolve(env.GITHUB_WORKSPACE), root);
  insist(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside), 'Evidence must be outside the checkout');
  return { root, context: join(root, 'context.json'), gate: join(root, 'gate'), artifact: join(root, 'artifact') };
}

async function regularFile(path, maxBytes = 256 * 1024 * 1024) {
  const stat = await lstat(path);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes, 'Evidence must be a bounded regular file, not a link');
  return readFile(path);
}

export function assertEvidenceDirectory(stat) {
  insist(stat.isDirectory() && !stat.isSymbolicLink(), 'Evidence directories cannot be links');
}

async function evidenceDirectory(paths, child = 'gate') {
  for (const path of [paths.root, paths[child]]) {
    const stat = await lstat(path);
    assertEvidenceDirectory(stat);
  }
  insist(samePath(resolve(await realpath(paths[child])), resolve(await realpath(paths.root), child)), 'Evidence escaped the designated run directory');
}

export async function writeContext(env = process.env) {
  const paths = ciPaths(env);
  const event = JSON.parse(await regularFile(env.GITHUB_EVENT_PATH, 2 * 1024 * 1024));
  const identity = checkoutIdentity(env.GITHUB_WORKSPACE, eventIdentity(env.GITHUB_EVENT_NAME, event, env.GITHUB_SHA, env.GITHUB_REPOSITORY, env.GITHUB_REF));
  await mkdir(paths.root); // A rerun gets a new attempt; existing evidence is never reused.
  await writeFile(paths.context, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
  await appendFile(env.GITHUB_OUTPUT, `base=${identity.base}\nhead=${identity.head}\noutput=${paths.gate}\n`);
  return identity;
}

export async function readContext(env = process.env) {
  const paths = ciPaths(env);
  const identity = JSON.parse(await regularFile(paths.context, 64 * 1024));
  // Re-derive from the runner's event, not just an editable saved context.
  const event = JSON.parse(await regularFile(env.GITHUB_EVENT_PATH, 2 * 1024 * 1024));
  const current = checkoutIdentity(env.GITHUB_WORKSPACE, eventIdentity(env.GITHUB_EVENT_NAME, event, env.GITHUB_SHA, env.GITHUB_REPOSITORY, env.GITHUB_REF));
  insist(JSON.stringify(current) === JSON.stringify(identity), 'Saved source context no longer matches the event and checkout');
  return { paths, identity };
}

export function assertComplete(manifest, identity) {
  insist(manifest.schemaVersion === 1 && manifest.overallStatus === 'PASS' && manifest.exitCode === 0, 'Gate did not report a complete PASS');
  insist(date(manifest.startedAt) && date(manifest.finishedAt) && Date.parse(manifest.finishedAt) >= Date.parse(manifest.startedAt), 'Gate is unfinished or has invalid times');
  insist(manifest.host?.platform === 'win32' && manifest.host?.arch === 'x64', 'Complete gate requires Windows x64');
  for (const name of ['setupErrors', 'integrityErrors', 'sourceEvents']) insist(Array.isArray(manifest[name]) && manifest[name].length === 0, `Nonempty or missing ${name}`);
  for (const key of ['base', 'baseTree', 'head', 'tree']) insist(manifest.source?.[key] === identity[key], `Gate source ${key} does not match the pinned checkout`);
  insist(manifest.source.verifiedAtEnd === true, 'Source was not verified at completion');
  insist(Array.isArray(manifest.checks) && manifest.checks.length === CHECK_IDS.length && new Set(manifest.checks.map(check => check.id)).size === CHECK_IDS.length, 'Incomplete or duplicate check catalog');
  for (const id of CHECK_IDS) {
    const check = manifest.checks.find(item => item.id === id);
    insist(check?.required === true && check.status === 'PASS' && check.exitCode === 0 && !check.error && !check.signal && !check.timedOut, `Required check is not a complete PASS: ${id}`);
    insist(date(check.startedAt) && date(check.finishedAt) && Date.parse(check.finishedAt) >= Date.parse(check.startedAt), `Missing completion times: ${id}`);
    insist(Array.isArray(check.logs) && check.logs.length === 2 && check.logs[0].path === `${id}.stdout.log` && check.logs[1].path === `${id}.stderr.log`, `Missing stdout/stderr evidence: ${id}`);
  }
}

function evidenceRecords(manifest) {
  return [...manifest.checks, ...Object.values(manifest.tools ?? {}).flatMap(tool => [tool, ...(tool.finalProbe ? [tool.finalProbe] : [])])];
}

export async function verifyLogs(manifest, output) {
  const records = evidenceRecords(manifest);
  for (const record of records) {
    for (const log of record.logs ?? []) {
      insist(LOG_NAMES.has(log.path) && /^[a-f0-9]{64}$/.test(log.sha256 ?? '') && Number.isSafeInteger(log.bytes) && log.bytes >= 0, 'Invalid evidence log reference');
      const bytes = await regularFile(join(output, log.path));
      insist(bytes.length === log.bytes && digest(bytes) === log.sha256, `Log bytes/hash mismatch: ${log.path}`);
    }
  }
}

export async function verifyComplete(env = process.env) {
  for (const step of ['PREPARE', 'GATE', 'STAGE', 'BUNDLE', 'UPLOAD']) insist(env[`QUALITY_${step}_OUTCOME`] === 'success', `${step} step was not successful`);
  const { paths, identity } = await readContext(env);
  await verifyStaged(env);
  const manifestBytes = await regularFile(join(paths.gate, 'manifest.json'), 2 * 1024 * 1024);
  const artifactBytes = await regularFile(join(paths.artifact, 'manifest.json'), 2 * 1024 * 1024);
  insist(manifestBytes.equals(artifactBytes), 'Staged manifest differs from gate evidence');
  const manifest = JSON.parse(manifestBytes);
  assertComplete(manifest, identity);
  for (const file of INPUTS) insist(manifest.source.inputs?.[file] === digest(await readFile(join(env.GITHUB_WORKSPACE, file))), `Input hash mismatch: ${file}`);
  const expectedNames = ['manifest.json', ...new Set(evidenceRecords(manifest).flatMap(record => (record.logs ?? []).map(log => log.path)))].sort();
  for (const output of [paths.gate, paths.artifact]) {
    insist(JSON.stringify((await readdir(output)).sort()) === JSON.stringify(expectedNames), 'Gate or staged artifact file set differs from the manifest');
    await verifyLogs(manifest, output);
  }
  console.log(`Complete Windows gate verified: ${identity.head} tree ${identity.tree}`);
}

export async function stageEvidence(env = process.env) {
  const paths = ciPaths(env);
  await evidenceDirectory(paths);
  // Explicit flat allowlist only, including partial logs on failure. Never glob
  // the checkout, runtime, Cargo target, Playwright profile, or environment.
  const names = await readdir(paths.gate);
  insist(names.includes('manifest.json'), 'Gate manifest is missing');
  insist(names.every(name => name === 'manifest.json' || LOG_NAMES.has(name)), 'Unexpected file in gate output; refusing artifact upload');
  let total = 0;
  for (const name of names) total += (await regularFile(join(paths.gate, name), name === 'manifest.json' ? 2 * 1024 * 1024 : undefined)).length;
  insist(total <= 256 * 1024 * 1024, 'Evidence exceeds the 256 MiB artifact limit');
  await mkdir(paths.artifact);
  for (const name of names) await copyFile(join(paths.gate, name), join(paths.artifact, name), 1); // COPYFILE_EXCL
  await verifyStaged(env);
  console.log(`Staged ${names.length} allowlisted gate files (${total} bytes)`);
}

export async function verifyStaged(env = process.env) {
  const paths = ciPaths(env);
  await evidenceDirectory(paths);
  await evidenceDirectory(paths, 'artifact');
  const names = (await readdir(paths.gate)).sort();
  insist(names.includes('manifest.json') && names.every(name => name === 'manifest.json' || LOG_NAMES.has(name)), 'Unexpected or missing gate evidence file');
  insist(JSON.stringify((await readdir(paths.artifact)).sort()) === JSON.stringify(names), 'Staged artifact file set differs from gate evidence');
  let total = 0;
  for (const name of names) {
    const maxBytes = name === 'manifest.json' ? 2 * 1024 * 1024 : undefined;
    const original = await regularFile(join(paths.gate, name), maxBytes);
    const staged = await regularFile(join(paths.artifact, name), maxBytes);
    total += staged.length;
    insist(original.equals(staged), `Staged file differs from gate evidence: ${name}`);
  }
  insist(total <= 256 * 1024 * 1024, 'Evidence exceeds the 256 MiB artifact limit');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    insist(extra.length === 0 && ['context', 'stage', 'bundle', 'verify'].includes(mode), 'Usage: node scripts/ci-quality.mjs context|stage|bundle|verify');
    await ({ context: writeContext, stage: stageEvidence, bundle: verifyStaged, verify: verifyComplete })[mode]();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
