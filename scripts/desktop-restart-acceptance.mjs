// Local loose-build acceptance; never installs/registers/deploys anything.
// Run after desktop:prepare + cargo build. Uses only synthetic demo data.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { startWebDemo } from '../dist/scripts/web-demo.js';

const binary = resolve(process.argv[2] ?? 'src-tauri/target/debug/coseat-desktop.exe');
const root = resolve('.local/desktop-restart'); await mkdir(root, { recursive: true });
const run = await mkdtemp(join(root, 'run-'));
const executable = join(run, 'coseat-desktop.exe');
await cp(binary, executable); await cp('.desktop/runtime', join(run, 'runtime'), { recursive: true });
const profile = join(run, 'profile');
const scope = { conversationId: '产品讨论', threadId: '日常交流' };
const background = { conversationId: '研发讨论', threadId: '插件协议' };
const demo = await startWebDemo({ web: false, credentialFile: false });
const report = { executable, sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  startedAt: new Date().toISOString(), installed: false, checks: [], pids: [], profile };
let holdReads = true, offlineSync = false, loseSendResponse = true, holdReceipts = true;
const syncCursors = [], readTargets = [], sendIds = [];
const proxy = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, demo.url), chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), data = body.length ? JSON.parse(body) : undefined;
    const fail = () => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"acceptance_offline"}'); };
    if (url.pathname === '/sync') { syncCursors.push(url.searchParams.get('cursor')); if (offlineSync) return fail(); }
    if (url.pathname === '/read-position') { if (holdReads) return fail(); readTargets.push(data); }
    if (url.pathname === '/messages/receipt' && holdReceipts) return fail();
    if (url.pathname === '/messages' && req.method === 'POST') sendIds.push(data.clientEventId);
    const response = await fetch(url, { method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
      ...(body.length ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(5000) });
    const value = await response.text();
    if (url.pathname === '/messages' && req.method === 'POST' && loseSendResponse) return fail();
    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(value);
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
});
await new Promise(resolveReady => proxy.listen(0, '127.0.0.1', resolveReady));
const endpoint = `http://127.0.0.1:${proxy.address().port}`;
let active;
async function launch() {
  // Reserve an ephemeral port, then release immediately before the WebView launch.
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const child = spawn(executable, ['--recovery-acceptance'], { windowsHide: true, cwd: run,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ['pipe', 'ignore', 'pipe'] });
  child.stderr.resume(); const exited = new Promise(r => child.once('exit', code => r(code)));
  child.stdin.end(JSON.stringify({ url: endpoint, ownerToken: demo.ownerToken, expiresAt: demo.expiresAt, profileDirectory: profile }) + '\n');
  active = { child, exited, port }; report.pids.push(child.pid);
  let version;
  await expect.poll(async () => { try { version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()); return true; } catch { return false; } }, { timeout: 30000 }).toBe(true);
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  report.webviewVersion = version.Browser;
  let page;
  await expect.poll(() => { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://tauri.localhost/'); return Boolean(page); }, { timeout: 15000 }).toBe(true);
  active.browser = browser; active.page = page;
  await expect(page.locator('#connect')).toBeVisible(); await expect(page.locator('#token')).toBeHidden();
  assert.equal(await page.evaluate(async () => (await window.__TAURI__.core.invoke('desktop_status')).storageProtected), true);
  return page;
}
async function quit() {
  const current = active;
  await current.page.evaluate(() => window.__TAURI__.core.invoke('desktop_quit')).catch(() => {});
  await expect.poll(() => current.child.exitCode, { timeout: 15000 }).toBe(0);
  await current.exited;
  await expect.poll(async () => { try { await fetch(`http://127.0.0.1:${current.port}/json/version`); return false; } catch { return true; } }, { timeout: 15000 }).toBe(true);
  const quotedProfile = "'" + profile.replaceAll("'", "''") + "'";
  await expect.poll(() => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${quotedProfile}) }).Count`],
    { encoding: 'utf8', windowsHide: true }).trim()), { timeout: 15000 }).toBe(0);
  active = undefined;
}
async function checkpoint(page, where) {
  return page.evaluate(async where => {
    const { value: session } = await window.__TAURI__.core.invoke('desktop_request', { path: '/session' });
    const scope = session.scopes.find(s => s.conversationId === where.conversationId && s.threadId === where.threadId);
    const { SyncStore } = await import('/sync-store.js'), store = new SyncStore(scope.outboxKey);
    try { return await store.load([session.member.id, scope.conversationId, scope.threadId, scope.membershipGeneration]); } finally { store.close(); }
  }, where);
}
async function inspectProfile(directory, forbidden) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await inspectProfile(file, forbidden);
    else if (entry.isFile()) {
      let bytes;
      try { bytes = await readFile(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const text of forbidden) for (const encoding of ['utf8', 'utf16le']) {
        assert.equal(bytes.includes(Buffer.from(text, encoding)), false, 'Native profile must not contain plaintext credentials, keys or synthetic message bodies');
      }
    }
  }
}
try {
  const seen = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', background, '重启前已看过', 'restart-seen').message);
  const stale = demo.engine.commit(() => demo.engine.state.createMessage('demo-researcher', scope, '重启前旧正文', 'restart-stale').message);
  let page = await launch(); await page.locator('#connect-button').click(); await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.getByRole('button', { name: /研发讨论 插件协议/ }).click(); await expect(page.locator('.message-text')).toHaveText(seen.text);
  await expect.poll(async () => (await checkpoint(page, background))?.pendingReadMessageId).toBe(seen.id);
  await page.getByRole('button', { name: /产品讨论 日常交流/ }).click();
  await page.locator('#message').fill('重启后不能重复发送'); await page.locator('#send').click();
  await expect(page.locator('[data-action="check-receipt"]')).toBeVisible();
  const originalSendId = sendIds[0]; assert.ok(originalSendId);
  await expect.poll(async () => (await checkpoint(page, scope))?.cursor).toBeTruthy();
  const storageKeys = await page.evaluate(async () => (await window.__TAURI__.core.invoke('desktop_request', { path: '/session' })).value.scopes.map(s => s.outboxKey));
  await quit(); report.checks.push('first native app/sidecar/WebView debug endpoint exited; stable service remained alive');
  await inspectProfile(profile, [demo.ownerToken, ...storageKeys, seen.text, stale.text, '重启后不能重复发送']);
  report.checks.push('closed WebView profile contains no UTF-8/UTF-16 plaintext token, recovery key or synthetic message body');
  demo.engine.commit(() => { demo.engine.state.changeMessage('demo-researcher', stale.id, 'retract', 1, 'restart-retract');
    demo.engine.state.createMessage('demo-researcher', background, '重启后尚未看过', 'restart-unseen'); });
  offlineSync = true; syncCursors.length = 0;
  page = await launch(); await expect(page.locator('.message')).toHaveCount(0);
  await page.locator('#connect-button').click(); await expect(page.locator('#sync-error')).toBeVisible();
  await expect(page.locator('.message')).toHaveCount(0); assert.ok(syncCursors.some(Boolean));
  report.checks.push('new native process loaded persisted cursor; old baseline remained hidden while current sync was offline');
  offlineSync = false; holdReads = false; holdReceipts = false; loseSendResponse = false;
  await page.locator('#reconnect').click(); await expect(page.locator('#connection-status')).toHaveText('已连接');
  await expect(page.locator('#app')).not.toContainText(stale.text);
  await expect.poll(() => demo.engine.state.readPosition('demo-owner', background)).toBe(seen.id);
  assert.deepEqual(readTargets.filter(t => t.conversationId === background.conversationId).map(t => t.messageId), [seen.id]);
  await page.locator('[data-action="check-receipt"]').click();
  await expect(page.locator('[data-action="check-receipt"]')).toHaveCount(0);
  assert.deepEqual(sendIds, [originalSendId]);
  assert.equal(demo.engine.state.readMessages('demo-owner', scope).filter(m => m.text === '重启后不能重复发送').length, 1);
  report.checks.push('retracted text absent; fixed observed reading target replayed without marking new background message read; lost send receipt reconciled without retransmission');
  await page.locator('#logout').click(); await expect(page.locator('#connect')).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise(resolveRows => {
    const request = indexedDB.open('coseat-sync-v1', 1); request.onsuccess = () => { const db = request.result, tx = db.transaction('checkpoints'), rows = tx.objectStore('checkpoints').getAll();
      rows.onsuccess = () => resolveRows(rows.result.filter(r => r.ciphertext).length); tx.oncomplete = () => db.close(); };
  }))).toBe(0);
  await quit(); report.checks.push('explicit logout removed checkpoint ciphertext; second native app and inspection endpoint exited');
  assert.equal(new Set(report.pids).size, 2);
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.failure = String(error); process.exitCode = 1; }
finally {
  if (active) { await quit().catch(() => { active?.child.kill(); }); }
  proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); await demo.stop();
  // Delete only this harness-created profile, after processes have exited.
  assert.equal(resolve(profile), join(resolve(run), 'profile'));
  assert.ok(resolve(run).startsWith(root + '\\'));
  await rm(profile, { recursive: true, force: true }); report.profileRemoved = true;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
