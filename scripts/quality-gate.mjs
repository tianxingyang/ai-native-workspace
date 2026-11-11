import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, watch } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deliberately a fixed catalog, not a command/workflow configuration language.
export const CHECKS = Object.freeze([
  { id: 'unit', tool: 'npm', args: ['test'], needs: ['npm', 'dependencies'], timeoutMs: 300_000 },
  { id: 'web', tool: 'npm', args: ['run', 'check:web'], needs: ['npm'], timeoutMs: 30_000 },
  { id: 'eval', tool: 'node', args: ['--test', 'eval/vit121/harness.test.mjs'], needs: [], timeoutMs: 30_000 },
  { id: 'browser', tool: 'npm', args: ['run', 'test:browser'], needs: ['npm', 'dependencies', 'chromium'], timeoutMs: 900_000 },
  { id: 'rust-fmt', tool: 'cargo', args: ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--all', '--', '--check'], needs: ['cargo', 'rustfmt'], timeoutMs: 60_000 },
  { id: 'rust-test', tool: 'cargo', args: ['test', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline'], needs: ['cargo', 'rustc', 'cargo-cache', 'desktop-resources'], timeoutMs: 1_200_000 },
  { id: 'rust-clippy', tool: 'cargo', args: ['clippy', '--release', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline', '--all-targets', '--', '-D', 'warnings'], needs: ['cargo', 'rustc', 'clippy', 'cargo-cache', 'desktop-resources'], timeoutMs: 1_200_000 },
].map(check => Object.freeze({ ...check, args: Object.freeze(check.args), needs: Object.freeze(check.needs) })));
const IDS = CHECKS.map(check => check.id);
const INPUTS = ['.node-version', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const STATUSES = ['PASS', 'FAIL', 'SKIPPED', 'SETUP-ERROR', 'NOT-RUN'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const exists = path => access(path).then(() => true, () => false);
const message = error => error instanceof Error ? error.message : String(error);

export function parseArgs(args) {
  const options = { only: [...IDS], skip: {} };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' && args.length === 1) return { help: true };
    if (!['--base', '--head', '--output', '--only', '--skip'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (flag !== '--skip' && seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--only') options.only = value.split(',');
    else if (flag === '--skip') {
      const match = /^([^=]+)=(.+)$/.exec(value);
      if (!match || !match[2].trim() || Object.hasOwn(options.skip, match[1])) throw new Error('Use --skip CHECK=reason once per check');
      options.skip[match[1]] = match[2].trim();
    } else options[flag.slice(2)] = value;
  }
  if (![options.base, options.head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw new Error('--base and --head require full lowercase 40-character commit SHAs');
  if (!options.only.length || new Set(options.only).size !== options.only.length
      || [...options.only, ...Object.keys(options.skip)].some(id => !IDS.includes(id))) throw new Error(`Use only known, non-duplicate check IDs: ${IDS.join(',')}`);
  if (Object.keys(options.skip).some(id => !options.only.includes(id))) throw new Error('Cannot skip a check excluded by --only');
  return options;
}

export function summarize(checks, setupErrors = []) {
  if (checks.length !== IDS.length || new Set(checks.map(check => check.id)).size !== IDS.length
      || checks.some(check => !IDS.includes(check.id) || !STATUSES.includes(check.status))) throw new Error('Incomplete or invalid check catalog');
  for (const check of checks) {
    if (check.status === 'PASS' && (check.exitCode !== 0 || check.signal || check.error || check.timedOut
        || check.logs?.length !== 2 || check.logs.some(log => !/^[a-f0-9]{64}$/.test(log.sha256)))) throw new Error(`Invalid PASS evidence: ${check.id}`);
  }
  const overallStatus = setupErrors.length || checks.some(check => check.status === 'SETUP-ERROR') ? 'SETUP-ERROR'
    : checks.some(check => check.status === 'FAIL') ? 'FAIL'
      : checks.some(check => check.status === 'NOT-RUN') ? 'NOT-RUN'
        : checks.some(check => check.status === 'SKIPPED') ? 'SKIPPED' : 'PASS';
  return { overallStatus, exitCode: overallStatus === 'PASS' ? 0 : overallStatus === 'SETUP-ERROR' ? 2 : 1 };
}

/** No shell. Logs contain exact child stdout/stderr bytes, not reconstructed summaries. */
export async function runCommand(command, { cwd, output, name, timeoutMs = 15_000 }) {
  const startedAt = now(), start = process.hrtime.bigint();
  // A gate invoked from node:test must not silently inherit its "already a test
  // child" marker: nested node --test would otherwise skip the requested files.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['node_test_context', 'node_options', 'npm_config_node_options'].includes(key.toLowerCase())) delete env[key];
  let child;
  const streams = ['stdout', 'stderr'].map(channel => {
    const path = `${name}.${channel}.log`;
    const stream = createWriteStream(join(output, path), { flags: 'wx' });
    stream.on('error', () => child?.kill());
    return { channel, path, stream, digest: createHash('sha256'), bytes: 0 };
  });
  let timedOut = false, error = null, timer;
  const result = await new Promise(resolveResult => {
    try { child = spawn(command[0], command.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (caught) { error = message(caught); resolveResult({ exitCode: null, signal: null }); return; }
    for (const log of streams) child[log.channel].on('data', bytes => {
      log.digest.update(bytes); log.bytes += bytes.length;
      if (!log.stream.write(bytes)) child[log.channel].pause();
    });
    for (const log of streams) log.stream.on('drain', () => child[log.channel].resume());
    child.once('error', caught => { error = message(caught); });
    child.once('close', (exitCode, signal) => resolveResult({ exitCode: error ? null : exitCode, signal }));
    timer = setTimeout(() => {
      timedOut = true; child.kill('SIGKILL');
      // Descendants may retain the inherited pipes. A timeout is never a pass.
      child.stdout.destroy(); child.stderr.destroy();
    }, timeoutMs);
  });
  clearTimeout(timer);
  for (const log of streams) log.stream.end();
  await Promise.all(streams.map(log => finished(log.stream)));
  return {
    command, startedAt, finishedAt: now(), durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
    ...result, timedOut, error,
    logs: streams.map(({ path, digest, bytes }) => ({ path, sha256: digest.digest('hex'), bytes })),
  };
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]}: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

async function sourceIdentity(root, base, head) {
  if (git(root, ['rev-parse', '--show-toplevel']).replaceAll('\\', '/').toLowerCase() !== root.replaceAll('\\', '/').toLowerCase()) throw new Error('Run from the repository root, not a nested directory');
  if (git(root, ['rev-parse', '--verify', `${base}^{commit}`]) !== base || git(root, ['rev-parse', '--verify', `${head}^{commit}`]) !== head) throw new Error('Commit SHA mismatch');
  if (git(root, ['rev-parse', 'HEAD']) !== head) throw new Error('Checked-out HEAD differs from pinned --head');
  git(root, ['merge-base', '--is-ancestor', base, head]);
  if (git(root, ['ls-files', '-v']).split('\n').some(line => /^[a-zS] /.test(line))) throw new Error('Tracked assume-unchanged/skip-worktree flags are not supported');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Worktree is dirty, including untracked files; commit or isolate changes first');
  const inputs = Object.fromEntries(await Promise.all(INPUTS.map(async path => [path, hash(await readFile(join(root, path)))])));
  return { base, baseTree: git(root, ['rev-parse', `${base}^{tree}`]), head, tree: git(root, ['rev-parse', `${head}^{tree}`]), inputs };
}

async function npmCommand() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const candidate of candidates) if (candidate && isAbsolute(candidate) && basename(candidate) === 'npm-cli.js' && await exists(candidate)) return [process.execPath, resolve(candidate), '--node-options='];
  throw new Error('npm CLI not found; invoke with npm run quality:gate');
}

export function browserVersionCommand(module) {
  // require.resolve may select the CJS entry; package import may select ESM.
  const code = `const imported=await import(${JSON.stringify(module)}); const {chromium}=imported.default??imported; const browser=await chromium.launch({headless:true}); try {console.log(browser.version())} finally {await browser.close()}`;
  return [process.execPath, '--input-type=module', '--eval', code];
}

function watchSource(root, manifest) {
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  paths.push('.git/HEAD');
  try { paths.push(`.git/${git(root, ['symbolic-ref', '-q', 'HEAD'])}`); } catch { /* Detached HEAD has no branch ref. */ }
  const hashes = new Map(paths.filter(path => existsSync(join(root, path))).map(path => [path, hash(readFileSync(join(root, path)))]));
  return watch(root, { recursive: true }, (event, filename) => {
    const path = filename?.toString().replaceAll('\\', '/');
    const candidates = !path ? [] : hashes.has(path) ? [path] : event === 'rename' ? paths.filter(file => file.startsWith(`${path}/`)) : [];
    for (const candidate of candidates) {
      let current;
      try { current = hash(readFileSync(join(root, candidate))); } catch { current = null; }
      // Windows may report directory/attribute metadata changes for ordinary
      // reads or ignored outputs. Compare bytes before invalidating source.
      if (current === hashes.get(candidate)) continue;
      if (!manifest.sourceEvents.some(item => item.path === candidate)) manifest.sourceEvents.push({ event, path: candidate, observedAt: now() });
      if (!manifest.integrityErrors.includes('Source change observed during the run')) manifest.integrityErrors.push('Source change observed during the run');
    }
    if (!path) manifest.integrityErrors.push('Source watcher could not identify a changed path');
  });
}

async function prepare(root, selected, output, tools) {
  const needed = new Set(selected.flatMap(check => check.needs)), errors = {}, commands = { node: [process.execPath], cargo: ['cargo'] };
  async function probe(id, command) {
    const result = await runCommand(command, { cwd: root, output, name: `setup-${id}` });
    const text = (await readFile(join(output, result.logs[0].path), 'utf8')).trim();
    tools[id] = { ...result, version: text };
    if (result.exitCode !== 0 || result.error || result.timedOut || result.signal || !text) errors[id] = `${id} unavailable or version not observed; see setup-${id} logs`;
    return text;
  }
  await probe('git', ['git', '--version']);
  await probe('node', [process.execPath, '--version']);
  // Fail visibly rather than letting NODE_OPTIONS select/skip tests or preload
  // code. Child npm calls also clear npm's node-options configuration.
  if (process.env.NODE_OPTIONS?.trim()) throw new Error('Nonempty NODE_OPTIONS is not supported; clear it for this gate invocation to prevent filtered or preloaded tests');
  if (Object.entries(process.env).some(([key, value]) => key.toLowerCase() === 'npm_config_node_options' && value?.trim())) throw new Error('Nonempty npm_config_node_options is not supported; clear it for this gate invocation');
  const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (expectedNode !== process.versions.node || pkg.engines?.node !== '>=24.14.0 <25' || !/^24\./.test(process.versions.node)) throw new Error(`Node must match .node-version (${expectedNode}) and package engines >=24.14.0 <25; actual ${process.versions.node}`);
  if (needed.has('npm')) {
    try { commands.npm = await npmCommand(); await probe('npm', [...commands.npm, '--version']); }
    catch (error) { errors.npm = message(error); }
  }
  if (needed.has('dependencies')) {
    try {
      for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
        if (installed.version !== version) throw new Error(`${name}: expected ${version}, installed ${installed.version}`);
      }
    } catch (error) { errors.dependencies = `Existing dependencies unavailable or mismatched: ${message(error)}; install separately, not through this gate`; }
  }
  if (needed.has('chromium')) {
    try {
      const require = createRequire(join(root, 'package.json'));
      const module = pathToFileURL(require.resolve('playwright')).href;
      // Windows chrome.exe --version is not a reliable CLI. Probe the same
      // headless runtime as the browser suite, without opening a visible UI.
      await probe('chromium', browserVersionCommand(module));
    } catch (error) { errors.chromium = message(error); }
  }
  for (const [id, command] of [['cargo', ['cargo', '--version']], ['rustc', ['rustc', '--version']], ['rustfmt', ['cargo', 'fmt', '--version']], ['clippy', ['cargo', 'clippy', '--version']]]) {
    if (needed.has(id)) await probe(id, command);
  }
  if (needed.has('cargo-cache') && !errors.cargo) {
    const result = await runCommand(['cargo', 'metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline', '--format-version=1', '--filter-platform', 'x86_64-pc-windows-msvc'], { cwd: root, output, name: 'setup-cargo-cache', timeoutMs: 60_000 });
    tools['cargo-cache'] = result;
    if (result.exitCode !== 0 || result.error || result.timedOut) errors['cargo-cache'] = 'Locked offline Cargo dependency metadata unavailable; see setup-cargo-cache logs';
  }
  if (needed.has('desktop-resources') && (process.platform !== 'win32' || process.arch !== 'x64' || !await exists(join(root, '.desktop/runtime/node.exe')))) errors['desktop-resources'] = 'Rust desktop checks need Windows x64 and separately prepared .desktop/runtime resources';
  return { errors, tools, commands };
}

export async function runGate(options, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  root = resolve(root);
  const output = resolve(options.output ?? join(dirname(root), `${basename(root)}.quality-gate`, `${now().replaceAll(/[:.]/g, '-')}-${randomUUID()}`));
  const inside = relative(root, output);
  if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside))) throw new Error('Evidence output must be outside the repository');
  // Never overwrite an earlier run, even an empty directory.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const manifest = {
    schemaVersion: 1, startedAt: now(), finishedAt: null, source: { base: options.base, head: options.head },
    host: { platform: process.platform, arch: process.arch }, environmentPolicy: 'Reject nonempty NODE_OPTIONS/npm_config_node_options; children clear these and NODE_TEST_CONTEXT; npm uses --node-options=',
    environmentPaths: Object.fromEntries(['PLAYWRIGHT_BROWSERS_PATH', 'CARGO_TARGET_DIR', 'CARGO_BUILD_JOBS'].map(key => [key, process.env[key] ?? null])),
    tools: {}, setupErrors: [], integrityErrors: [], sourceEvents: [],
    checks: CHECKS.map(check => ({ id: check.id, required: true, command: [check.tool, ...check.args], status: 'NOT-RUN', reason: 'Not started', exitCode: null, durationMs: 0, logs: [] })),
    overallStatus: 'NOT-RUN', exitCode: 1,
  };
  async function save() {
    Object.assign(manifest, summarize(manifest.checks, [...manifest.setupErrors, ...manifest.integrityErrors]));
    if (manifest.overallStatus === 'PASS' && !manifest.finishedAt) Object.assign(manifest, { overallStatus: 'NOT-RUN', exitCode: 1 });
    await writeFile(join(output, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(join(output, 'manifest.json.tmp'), join(output, 'manifest.json'));
  }
  await save();
  let watcher;
  try {
    manifest.source = await sourceIdentity(root, options.base, options.head);
    watcher = watchSource(root, manifest);
    watcher.on('error', error => manifest.integrityErrors.push(`Source watcher failed: ${message(error)}`));
    const selected = CHECKS.filter(check => options.only.includes(check.id) && !Object.hasOwn(options.skip, check.id));
    const setup = await prepare(root, selected, output, manifest.tools);
    manifest.tools = setup.tools;
    if (setup.errors.git || setup.errors.node) throw new Error(setup.errors.git ?? setup.errors.node);
    for (const check of CHECKS) {
      const record = manifest.checks.find(item => item.id === check.id);
      if (manifest.integrityErrors.length) throw new Error('Source integrity was lost; remaining checks are NOT-RUN');
      if (!options.only.includes(check.id)) { record.reason = 'Excluded by --only; required check still incomplete'; continue; }
      if (Object.hasOwn(options.skip, check.id)) { record.status = 'SKIPPED'; record.reason = options.skip[check.id]; continue; }
      const blockers = check.needs.filter(need => setup.errors[need]).map(need => setup.errors[need]);
      if (blockers.length) { record.status = 'SETUP-ERROR'; record.reason = blockers.join('; '); await save(); continue; }
      record.reason = 'Started; no completed result yet';
      await save();
      const result = await runCommand([...setup.commands[check.tool], ...check.args], { cwd: root, output, name: check.id, timeoutMs: check.timeoutMs });
      Object.assign(record, result, { status: result.error ? 'SETUP-ERROR' : result.exitCode === 0 && !result.signal && !result.timedOut ? 'PASS' : 'FAIL', reason: result.error ?? (result.timedOut ? 'Timed out; process descendants may require inspection' : result.signal ? `Signal: ${result.signal}` : `Exit code ${result.exitCode}`) });
      await save();
    }
  } catch (error) { manifest.setupErrors.push(message(error)); }
  if (manifest.source.tree) {
    try {
      // Repeat only version probes that actually ran, not dependency metadata or checks.
      for (const [id, tool] of Object.entries(manifest.tools).filter(([, tool]) => typeof tool.version === 'string' && tool.exitCode === 0)) {
        const result = await runCommand(tool.command, { cwd: root, output, name: `final-${id}` });
        const version = (await readFile(join(output, result.logs[0].path), 'utf8')).trim();
        tool.finalProbe = result;
        if (result.exitCode !== 0 || result.error || result.signal || result.timedOut || version !== tool.version) throw new Error(`Tool version changed or became unavailable: ${id}`);
      }
      const final = await sourceIdentity(root, options.base, options.head);
      if (JSON.stringify(final) !== JSON.stringify(manifest.source)) throw new Error('Pinned source or input hashes changed during the run');
      // Drain queued fs events before closing the watcher and completing evidence.
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      manifest.source.verifiedAtEnd = manifest.integrityErrors.length === 0;
    } catch (error) { manifest.integrityErrors.push(message(error)); }
  }
  watcher?.close();
  manifest.finishedAt = now();
  await save();
  return { manifest, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(`Usage: npm run quality:gate -- --base FULL_SHA --head FULL_SHA [--output NEW_EXTERNAL_DIR] [--only ${IDS.join(',')}] [--skip CHECK=reason]\nAll seven checks are required. Omitted/skipped checks never pass. No install, publish, merge, or deploy.`);
    else {
      const { manifest, output } = await runGate(options);
      console.log(`${manifest.overallStatus}: ${output}`);
      for (const check of manifest.checks) console.log(`${check.status.padEnd(11)} ${check.id}: ${check.reason}`);
      for (const error of [...manifest.setupErrors, ...manifest.integrityErrors]) console.error(error);
      process.exitCode = manifest.exitCode;
    }
  } catch (error) { console.error(message(error)); process.exitCode = 2; }
}
