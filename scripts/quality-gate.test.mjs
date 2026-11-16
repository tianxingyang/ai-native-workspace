import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECKS, auditSourceFiles, browserVersionCommand, parseArgs, runCommand, runGate, summarize } from './quality-gate.mjs';

const sha = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = (...extra) => parseArgs(['--base', sha, '--head', sha, ...extra]);
const passRows = () => CHECKS.map(({ id }) => ({ id, status: 'PASS', exitCode: 0, logs: [{ sha256: digest('') }, { sha256: digest('') }] }));

async function workspace(t) {
  const home = await mkdtemp(join(tmpdir(), 'coseat-quality-gate-'));
  assert.ok(resolve(home).startsWith(`${resolve(tmpdir())}${sep}`) && basename(home).startsWith('coseat-quality-gate-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { body = "console.log('synthetic evaluation fixture');", node = process.versions.node } = {}) {
  const home = await workspace(t), root = join(home, 'repo'), output = join(home, 'evidence');
  await mkdir(join(root, 'eval/vit121'), { recursive: true });
  await mkdir(join(root, 'src-tauri'));
  for (const [path, bytes] of Object.entries({
    '.node-version': `${node}\n`,
    '.gitignore': 'eval/generated-cache/\nnode_modules/\n',
    'package.json': JSON.stringify({ type: 'module', engines: { node: '>=24.14.0 <25' } }),
    'package-lock.json': '{}\n', 'src-tauri/Cargo.toml': '# synthetic fixture\n', 'src-tauri/Cargo.lock': '# synthetic fixture\n',
    'marker.txt': 'original', 'eval/vit121/harness.test.mjs': body,
  })) await writeFile(join(root, path), bytes);
  git(root, ['init', '-q']); git(root, ['add', '.']);
  git(root, ['-c', 'user.name=CoSeat quality-gate test', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic fixture']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const args = parseArgs(['--base', head, '--head', head, '--only', 'eval', '--output', output]);
  return { root, output, args, head };
}

function windowsShortPath(path) {
  const command = String.raw`$ErrorActionPreference='Stop'; Add-Type 'using System.Text; using System.Runtime.InteropServices; public static class CoSeatGatePathTest { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder output, uint length); }'; $b=New-Object System.Text.StringBuilder 8192; if([CoSeatGatePathTest]::GetShortPathName($env:COSEAT_PATH_TEST,$b,8192) -eq 0){throw 'GetShortPathName failed'}; [Console]::Write('__SHORT_PATH__'+$b.ToString())`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, COSEAT_PATH_TEST: path }, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const marker = result.stdout.lastIndexOf('__SHORT_PATH__');
  assert.ok(marker >= 0, result.stdout);
  const alias = result.stdout.slice(marker + '__SHORT_PATH__'.length).trim();
  assert.notEqual(alias.toLowerCase(), path.toLowerCase(), 'A genuine Windows short-name alias is required for this regression');
  return alias;
}

test('Windows short-name root runs checks with final identity; a nested directory still fails closed', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), alias = windowsShortPath(realpathSync.native(f.root));
  assert.equal(realpathSync.native(alias), realpathSync.native(f.root));
  const { manifest } = await runGate(f.args, alias);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.equal(manifest.source.verifiedAtEnd, true);
  assert.equal(manifest.overallStatus, 'NOT-RUN'); // Only eval was requested, never a full PASS.
  const nested = await runGate({ ...f.args, output: join(f.output, '..', 'nested-evidence') }, join(alias, 'eval'));
  assert.equal(nested.manifest.overallStatus, 'SETUP-ERROR');
  assert.match(nested.manifest.setupErrors.join('\n'), /repository root, not a nested directory/);
});

test('Windows output aliases inside the checkout reject before writing; external nested outputs still work', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), alias = windowsShortPath(realpathSync.native(f.root));
  await mkdir(join(f.root, 'node_modules'));
  const output = join(alias, 'node_modules/not-created/nested/evidence');
  let error;
  try { await runGate({ ...f.args, output }, realpathSync.native(f.root)); } catch (caught) { error = caught; }
  assert.equal(existsSync(join(f.root, 'node_modules/not-created')), false, 'No output ancestors may be created inside the checkout');
  assert.match(error?.message ?? '', /outside/);
  const external = await runGate({ ...f.args, output: join(f.output, 'new/nested/run') }, f.root);
  assert.equal(external.manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.equal(external.manifest.source.verifiedAtEnd, true);
  assert.equal(external.manifest.overallStatus, 'NOT-RUN');
});

test('catalog is fixed and includes every existing verification family', () => {
  assert.deepEqual(CHECKS.map(check => check.id), ['unit', 'web', 'eval', 'browser', 'rust-fmt', 'rust-test', 'rust-clippy']);
  assert.equal(CHECKS.find(check => check.id === 'unit').args[0], 'test');
  assert.ok(CHECKS.filter(check => ['rust-test', 'rust-clippy'].includes(check.id)).every(check => check.args.includes('--locked') && check.args.includes('--offline')));
  assert.ok(Object.isFrozen(CHECKS) && CHECKS.every(check => Object.isFrozen(check.args)));
});

test('CLI requires immutable full SHAs; rejects commands, duplicates and unsupported check IDs', () => {
  assert.equal(options().only.length, 7);
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const args of [[], ['--base', 'main', '--head', sha], ['--base', sha, '--head', sha.slice(0, 7)],
    ['--base', sha, '--head', sha, '--command', 'echo fake'], ['--base', sha, '--head', sha, '--head', sha]]) assert.throws(() => parseArgs(args));
  assert.throws(() => options('--only', 'eval,eval'));
  assert.throws(() => options('--only', 'eval,unknown'));
  assert.throws(() => options('--skip', 'browser='));
  assert.throws(() => options('--only', 'eval', '--skip', 'browser=no browser'));
  assert.throws(() => options('--skip', 'eval=first', '--skip', 'eval=second'));
  assert.equal(options('--skip', 'browser=Not installed').skip.browser, 'Not installed');
});

test('missing, duplicate, invalid and fabricated PASS records cannot become a full pass', () => {
  assert.deepEqual(summarize(passRows()), { overallStatus: 'PASS', exitCode: 0 });
  assert.throws(() => summarize(passRows().slice(1)), /catalog/);
  const duplicate = passRows(); duplicate[1] = duplicate[0]; assert.throws(() => summarize(duplicate), /catalog/);
  for (const patch of [{ status: 'unknown' }, { exitCode: 1 }, { signal: 'SIGTERM' }, { timedOut: true }, { error: 'failed' }, { logs: [] }]) {
    const rows = passRows(); Object.assign(rows[0], patch); assert.throws(() => summarize(rows));
  }
});

test('FAIL, SKIPPED, SETUP-ERROR and NOT-RUN remain distinct nonzero outcomes', () => {
  for (const status of ['FAIL', 'SKIPPED', 'SETUP-ERROR', 'NOT-RUN']) {
    const rows = passRows(); Object.assign(rows[0], { status, exitCode: null });
    assert.deepEqual(summarize(rows), { overallStatus: status, exitCode: status === 'SETUP-ERROR' ? 2 : 1 });
  }
  assert.deepEqual(summarize(passRows(), ['head changed']), { overallStatus: 'SETUP-ERROR', exitCode: 2 });
});

test('real child exit, timing and exact stdout/stderr hashes are retained', async t => {
  const output = await workspace(t);
  const result = await runCommand([process.execPath, '-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exitCode=7"], { cwd: output, output, name: 'red' });
  assert.equal(result.exitCode, 7); assert.equal(result.error, null); assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0 && result.startedAt <= result.finishedAt);
  for (const [index, bytes] of ['out\n', 'err\n'].entries()) {
    assert.equal(await readFile(join(output, result.logs[index].path), 'utf8'), bytes);
    assert.equal(result.logs[index].sha256, digest(bytes)); assert.equal(result.logs[index].bytes, Buffer.byteLength(bytes));
  }
});

test('missing executables and timeouts cannot produce a zero exit PASS', async t => {
  const output = await workspace(t);
  const missing = await runCommand([join(output, 'does-not-exist'), '--version'], { cwd: output, output, name: 'missing' });
  assert.equal(missing.exitCode, null); assert.match(missing.error, /ENOENT/);
  const timeout = await runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { cwd: output, output, name: 'timeout', timeoutMs: 100 });
  assert.equal(timeout.timedOut, true);
});

test('browser version probe supports both CJS and ESM Playwright entry shapes', async t => {
  const output = await workspace(t);
  const chromium = "{async launch(){return {version(){return 'synthetic-browser-version'},async close(){}}}}";
  for (const [extension, source] of [['cjs', `module.exports={chromium:${chromium}}`], ['mjs', `export const chromium=${chromium}`]]) {
    const path = join(output, `playwright.${extension}`); await writeFile(path, source);
    const result = await runCommand(browserVersionCommand(pathToFileURL(path).href), { cwd: output, output, name: extension });
    assert.equal(result.exitCode, 0);
    assert.equal((await readFile(join(output, result.logs[0].path), 'utf8')).trim(), 'synthetic-browser-version');
  }
});

test('NODE_OPTIONS test-name-pattern, test-skip-pattern and test-only never hide a failing test', async t => {
  const original = process.env.NODE_OPTIONS;
  try {
    for (const flag of ['--test-name-pattern=does-not-match-anything', '--test-skip-pattern=.*', '--test-only']) {
      const { root, output, args } = await fixture(t, { body: "import test from 'node:test'; import assert from 'node:assert/strict'; test('must execute',()=>assert.fail('synthetic failure must stay red'));" });
      process.env.NODE_OPTIONS = flag;
      const logs = join(root, '..', 'child-evidence'); await mkdir(logs);
      const child = await runCommand([process.execPath, '--test', 'eval/vit121/harness.test.mjs'], { cwd: root, output: logs, name: 'must-fail' });
      assert.equal(child.exitCode, 1, flag);
      assert.match(await readFile(join(logs, child.logs[0].path), 'utf8'), /synthetic failure must stay red/);
      const { manifest } = await runGate(args, root);
      assert.equal(manifest.exitCode, 2, flag); assert.equal(manifest.overallStatus, 'SETUP-ERROR');
      assert.ok(manifest.checks.every(check => check.status === 'NOT-RUN'));
      assert.match(manifest.setupErrors.join('\n'), /Nonempty NODE_OPTIONS/);
      assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).exitCode, 2);
    }
  } finally { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; }
});

// These integration tests execute only the fixed eval command in synthetic repos.
// Never call the real npm test from scripts/*.test.mjs: it would recurse.
test('partial real run writes all seven rows, hashes and immutable source identity; omitted checks do not pass', async t => {
  const { root, output, args, head } = await fixture(t);
  const { manifest } = await runGate(args, root);
  assert.equal(manifest.source.head, head); assert.equal(manifest.source.base, head);
  assert.match(manifest.source.tree, /^[a-f0-9]{40}$/); assert.equal(manifest.source.verifiedAtEnd, true);
  assert.equal(manifest.checks.length, 7);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.ok(manifest.checks.filter(check => check.id !== 'eval').every(check => check.status === 'NOT-RUN'));
  assert.equal(manifest.overallStatus, 'NOT-RUN'); assert.equal(manifest.exitCode, 1);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')), manifest);
  for (const log of manifest.checks.find(check => check.id === 'eval').logs) assert.equal(log.sha256, digest(await readFile(join(output, log.path))));
  await assert.rejects(runGate(args, root), /EEXIST/);
});

test('setup failure still saves a complete NOT-RUN catalog and actual tool probes', async t => {
  const { root, output, args } = await fixture(t, { node: '24.0.0' });
  const { manifest } = await runGate(args, root);
  assert.equal(manifest.overallStatus, 'SETUP-ERROR'); assert.equal(manifest.exitCode, 2);
  assert.ok(manifest.checks.every(check => check.status === 'NOT-RUN'));
  assert.match(manifest.setupErrors.join('\n'), /Node must match/);
  assert.equal(manifest.tools.node.version, process.version);
  assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).checks.length, 7);
});

test('wrong checked-out SHA or dirty source fails before executing checks, but retains a report', async t => {
  for (const mode of ['wrong-sha', 'dirty']) {
    const { root, args } = await fixture(t);
    if (mode === 'wrong-sha') args.head = 'f'.repeat(40);
    else await writeFile(join(root, 'marker.txt'), 'dirty');
    const { manifest } = await runGate(args, root);
    assert.equal(manifest.exitCode, 2); assert.ok(manifest.checks.every(check => check.status === 'NOT-RUN'));
    assert.equal(manifest.setupErrors.length, 1);
  }
});

test('tracked source edits invalidate passing commands, including edit-then-revert during a check', async t => {
  for (const restore of [false, true]) {
    const body = `import {writeFile} from 'node:fs/promises';
      const marker=new URL('../../marker.txt',import.meta.url);
      await writeFile(marker,'changed'); await new Promise(r=>setTimeout(r,75));
      ${restore ? "await writeFile(marker,'original'); await new Promise(r=>setTimeout(r,75));" : ''}`;
    const { root, args } = await fixture(t, { body });
    const { manifest } = await runGate(args, root);
    assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
    assert.equal(manifest.overallStatus, 'SETUP-ERROR'); assert.equal(manifest.exitCode, 2);
    assert.match(manifest.integrityErrors.join('\n'), /Source change observed/);
    assert.notEqual(manifest.source.verifiedAtEnd, true);
    if (restore) assert.equal(git(root, ['status', '--porcelain']), '');
  }
});

test('ignored output beneath a tracked directory and metadata-only changes do not invalidate source', async t => {
  const body = `import {mkdir,writeFile,utimes} from 'node:fs/promises';
    const cache=new URL('../generated-cache/',import.meta.url); await mkdir(cache,{recursive:true});
    await writeFile(new URL('output.txt',cache),'ignored synthetic output');
    await utimes(new URL('../../marker.txt',import.meta.url),new Date(),new Date());
    await new Promise(r=>setTimeout(r,100));`;
  const { root, args } = await fixture(t, { body });
  const { manifest } = await runGate(args, root);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.equal(manifest.source.verifiedAtEnd, true);
  assert.deepEqual(manifest.integrityErrors, []); assert.deepEqual(manifest.sourceEvents, []);
  assert.equal(manifest.overallStatus, 'NOT-RUN');
});

test('unidentified notifications audit every tracked file and fail on changed or unreadable bytes', async t => {
  const root = await workspace(t);
  await writeFile(join(root, 'first.txt'), 'first'); await writeFile(join(root, 'later.txt'), 'later');
  const hashes = new Map([['first.txt', digest('first')], ['later.txt', digest('later')]]);
  assert.deepEqual(auditSourceFiles(root, hashes), []);
  await writeFile(join(root, 'later.txt'), 'changed');
  assert.deepEqual(auditSourceFiles(root, hashes), ['later.txt']);
  await rm(join(root, 'first.txt'));
  assert.deepEqual(auditSourceFiles(root, hashes), ['first.txt', 'later.txt']);
});

test('ignored subtree notification churn is reconciled without discarding source verification', async t => {
  const body = `import {mkdir,writeFile} from 'node:fs/promises';
    for (const path of ['../generated-cache/','../../node_modules/.cache/']) {
      const cache=new URL(path,import.meta.url); await mkdir(cache,{recursive:true});
      for (let batch=0;batch<16;batch++) await Promise.all(Array.from({length:64},(_,i)=>writeFile(new URL(batch+'-'+i+'.txt',cache),'ignored synthetic output')));
    }
    await new Promise(r=>setTimeout(r,100));`;
  const { root, args } = await fixture(t, { body });
  const { manifest } = await runGate(args, root);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.equal(manifest.sourceMonitor.mode, 'tracked-byte-reconciliation');
  assert.equal(manifest.sourceMonitor.unknownNotifications, manifest.sourceMonitor.reconciledUnknownNotifications);
  assert.equal(manifest.source.verifiedAtEnd, true, JSON.stringify({ setupErrors: manifest.setupErrors, integrityErrors: manifest.integrityErrors, sourceEvents: manifest.sourceEvents, sourceMonitor: manifest.sourceMonitor }));
  assert.deepEqual(manifest.integrityErrors, []);
  assert.equal(manifest.overallStatus, 'NOT-RUN');
});

test('tracked directory rename and restore is observed at its original path', async t => {
  const body = `import {rename} from 'node:fs/promises';
    const from=new URL('./',import.meta.url),to=new URL('../vit121-moved/',import.meta.url);
    await rename(from,to); await new Promise(r=>setTimeout(r,100));
    await rename(to,from); await new Promise(r=>setTimeout(r,100));`;
  const { root, args } = await fixture(t, { body });
  const { manifest } = await runGate(args, root);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'PASS');
  assert.equal(manifest.overallStatus, 'SETUP-ERROR');
  assert.match(manifest.integrityErrors.join('\n'), /Source change observed/);
  assert.ok(manifest.sourceEvents.some(event => event.path === 'eval/vit121/harness.test.mjs'));
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('evidence cannot be written inside the source checkout, including dot-dot-prefixed names', async t => {
  const { root, args } = await fixture(t);
  for (const output of [root, join(root, 'evidence'), join(root, '..evidence')]) await assert.rejects(runGate({ ...args, output }, root), /outside the repository/);
});

test('explicit skips carry a reason and never become a passing run', async t => {
  const { root, args } = await fixture(t);
  const { manifest } = await runGate({ ...args, skip: { eval: 'Synthetic skip example' } }, root);
  assert.equal(manifest.checks.find(check => check.id === 'eval').status, 'SKIPPED');
  assert.equal(manifest.checks.find(check => check.id === 'eval').reason, 'Synthetic skip example');
  assert.notEqual(manifest.exitCode, 0);
});
