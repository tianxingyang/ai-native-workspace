import { mkdir, readFile, writeFile, cp, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname, basename } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 build host required');
const version = '24.22.2';
const archive = `node-v${version}-win-x64.zip`;
const sha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2';
const downloads = resolve('.desktop/downloads'); await mkdir(downloads, { recursive: true });
const zip = join(downloads, archive);
try { await stat(zip); } catch {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archive}`, { redirect: 'error' });
  if (!response.ok) throw new Error('Official Node download failed');
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha256').update(await readFile(zip)).digest('hex') !== sha256) throw new Error('Node archive checksum mismatch');
const extracted = join(downloads, `node-v${version}-win-x64`);
try { await stat(join(extracted, 'node.exe')); } catch {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(downloads)}`], { stdio: 'inherit', windowsHide: true });
  if (result.status) throw new Error('Node extraction failed');
}
const runtime = resolve('.desktop/runtime'); await mkdir(runtime, { recursive: true });
if (createHash('sha256').update(await readFile(join(extracted, 'node.exe'))).digest('hex') !== '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9') throw new Error('Extracted Node checksum mismatch');
await cp(join(extracted, 'node.exe'), join(runtime, 'node.exe'));
await cp(join(extracted, 'LICENSE'), join(runtime, 'NODE-LICENSE.txt'));
await cp('dist/src', join(runtime, 'dist/src'), { recursive: true });
await mkdir(join(runtime, 'dist/scripts'), { recursive: true });
for (const name of ['desktop-host', 'desktop-recovery', 'web-demo', 'web-worker-demo', 'process-pair']) await cp(`dist/scripts/${name}.js`, join(runtime, `dist/scripts/${name}.js`));
await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const metadata = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc'], { cwd: 'src-tauri', encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true });
if (metadata.status) throw new Error('Cargo license metadata unavailable');
const graph = JSON.parse(metadata.stdout), selected = new Set(graph.resolve.nodes.map(n => n.id));
const notices = ['# Bundled third-party notices', '', 'CoSeat project licensing remains undecided. This file describes upstream components only.', '', 'Node.js 24.22.2: see NODE-LICENSE.txt (including its bundled dependencies).', '', 'Rust dependency licenses follow. The filtered graph also includes build-time dependencies; listing does not imply runtime use.', ''];
for (const pkg of graph.packages.filter(p => selected.has(p.id) && p.source)) {
  const root = dirname(pkg.manifest_path), target = join(runtime, 'licenses', `${pkg.name}-${pkg.version}`);
  const files = (await readdir(root)).filter(name => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name));
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(join(root, file), join(target, basename(file)), { recursive: true });
  if (!files.length) {
    const fallback = { 'alloc-stdlib': 'alloc-stdlib.txt', selectors: 'selectors-MPL-2.0.txt', 'tauri-plugin': 'tauri-plugin.txt', 'webview2-com': 'webview2.txt', 'webview2-com-sys': 'webview2.txt', 'webview2-com-macros': 'webview2.txt' }[pkg.name];
    if (!fallback) throw new Error(`Missing upstream notice: ${pkg.name}`);
    await cp(join('docs/third-party-notices', fallback), join(target, 'LICENSE.txt'));
  }
  notices.push(`- ${pkg.name} ${pkg.version}: ${pkg.license ?? 'see license file'}; ${pkg.repository ?? 'https://crates.io/crates/' + pkg.name}; notices in licenses/${pkg.name}-${pkg.version}/`);
  if (pkg.name === 'selectors') notices.push(`  Unmodified MPL source and file-level notices: https://crates.io/api/v1/crates/selectors/${pkg.version}/download ; license text from https://www.mozilla.org/MPL/2.0/ .`);
}
await writeFile(join(runtime, 'THIRD_PARTY_NOTICES.md'), notices.join('\n') + '\n');
console.log(`Desktop resources ready: Node ${version}, checksum-verified official archive; no production npm modules bundled.`);
