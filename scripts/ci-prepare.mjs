import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readContext } from './ci-quality.mjs';

export const RUST_TOOLCHAIN = '1.95.0-x86_64-pc-windows-msvc';
const RUNTIME_HASH = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9';

export function preparationPlan(node, npm, root, temp) {
  return [
    ['rustup', ['toolchain', 'install', RUST_TOOLCHAIN, '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy']],
    [node, [npm, 'ci', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--cache', join(temp, 'npm-cache'), '--no-audit', '--no-fund']],
    [node, [join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium']],
    ['cargo', ['fetch', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--target', 'x86_64-pc-windows-msvc']],
    [node, [npm, 'run', 'desktop:prepare'], { CARGO_NET_OFFLINE: 'true' }],
  ];
}

async function run(command, args, env) {
  console.log(`Prepare: ${JSON.stringify([command, ...args])}`);
  await new Promise((ok, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 && !signal ? ok() : reject(new Error(`Preparation failed: ${command}, exit=${code}, signal=${signal}`)));
  });
}

export async function prepare(env = process.env) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 runner required');
  const { paths } = await readContext(env);
  if (env.RUSTUP_TOOLCHAIN !== RUST_TOOLCHAIN) throw new Error('CI must use the explicitly pinned Rust toolchain');
  if (env.NODE_OPTIONS?.trim() || Object.entries(env).some(([key, value]) => key.toLowerCase() === 'npm_config_node_options' && value?.trim())) throw new Error('Nonempty Node options are unsupported');
  const expectedNode = (await readFile('.node-version', 'utf8')).trim();
  if (!/^24\.[0-9]+\.[0-9]+$/.test(expectedNode) || process.versions.node !== expectedNode) throw new Error('Node must exactly match .node-version');
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await access(npm);
  const plannedEnv = { ...env, npm_config_node_options: '', PLAYWRIGHT_BROWSERS_PATH: join(paths.root, 'browsers'), CARGO_TARGET_DIR: join(paths.root, 'cargo-target') };
  // The workflow supplies the same paths to the subsequent gate step.
  if (env.PLAYWRIGHT_BROWSERS_PATH !== plannedEnv.PLAYWRIGHT_BROWSERS_PATH || env.CARGO_TARGET_DIR !== plannedEnv.CARGO_TARGET_DIR) throw new Error('Preparation and gate cache paths must match');
  for (const [command, args, override] of preparationPlan(process.execPath, npm, env.GITHUB_WORKSPACE, paths.root)) await run(command, args, { ...plannedEnv, ...override });
  const runtime = await readFile('.desktop/runtime/node.exe');
  if (createHash('sha256').update(runtime).digest('hex') !== RUNTIME_HASH) throw new Error('Prepared desktop Node runtime checksum mismatch');
  await run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline', '--format-version=1', '--filter-platform', 'x86_64-pc-windows-msvc'], plannedEnv);
  await readContext(env); // Includes a clean checkout check after preparation.
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/ci-prepare.mjs');
    await prepare();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
