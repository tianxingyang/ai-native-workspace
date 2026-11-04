import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { permittedRequest } from '../scripts/desktop-host.js';
import { startWebDemo } from '../scripts/web-demo.js';
import { cleanEnvironment } from '../scripts/process-pair.js';

test('desktop route boundary excludes URLs, authority changes, arbitrary commands and unknown query fields', () => {
  assert.equal(permittedRequest('http://127.0.0.1/messages?conversationId=a&threadId=b', undefined), false);
  assert.equal(permittedRequest('/\\127.0.0.1/messages?conversationId=a&threadId=b', undefined), false);
  for (const path of ['https://example.invalid/messages?conversationId=a&threadId=b', '//example.invalid/messages?conversationId=a&threadId=b', '/session?token=a', '/messages?conversationId=a&threadId=b&admin=1', '/messages?conversationId=a&conversationId=b&threadId=c', '/admin']) assert.equal(permittedRequest(path, undefined), false);
  for (const path of ['/runs/a%2fcancel/cancel', '/runs/../cancel', '/session', 'file:///anything']) assert.equal(permittedRequest(path, {}), false);
  assert.equal(permittedRequest('/messages?conversationId=a&threadId=b', undefined), true);
  assert.equal(permittedRequest('/sync?conversationId=a&threadId=b', undefined), true);
  assert.equal(permittedRequest('/sync?conversationId=a&threadId=b&cursor=opaque', undefined), true);
  assert.equal(permittedRequest('/sync?conversationId=a&threadId=b', {}), false);
  for (const path of ['/sync?conversationId=a&threadId=b&cursor=', '/sync?conversationId=a&threadId=b&cursor=x&cursor=y', '/sync?conversationId=a&threadId=b&admin=1', '/sync?conversationId=a', '/messages?conversationId=a&threadId=b&cursor=x']) assert.equal(permittedRequest(path, undefined), false);
  assert.equal(permittedRequest('/runs/run_1/cancel', {}), true);
  assert.equal(permittedRequest('/messages/msg_1/edit', {}), true);
  assert.equal(permittedRequest('/messages/msg_1/retract', {}), true);
  for (const path of ['/messages/../edit', '/messages/a%2fretract/retract', '/messages/a/delete']) assert.equal(permittedRequest(path, {}), false);
});

test('desktop demo does not persist owner credentials or serve a remotely privileged web frontend', async t => {
  const demo = await startWebDemo({ web: false, credentialFile: false, lifetimeMs: 1000 }); t.after(() => demo.stop());
  await assert.rejects(access(demo.credentialPath));
  assert.equal((await fetch(demo.url)).status, 401);
  const response = await fetch(`${demo.url}/session`, { headers: { authorization: `Bearer ${demo.ownerToken}` } });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes(demo.ownerToken), false);
});

test('native sidecar performs real authorized HTTP, rejects unshared scope, deduplicates and cleans up on stdin EOF', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/desktop-host.js', import.meta.url))], { env: cleanEnvironment({}), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  t.after(async () => { child.stdin.end(); await exited; });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  let observed: (value: any) => void;
  const incoming = new Promise<any>(resolve => { observed = resolve; });
  lines.on('line', line => { const data = JSON.parse(line); if (data.event === 'message') observed(data.scope); pending.get(data.id)?.(data); pending.delete(data.id); });
  let id = 0;
  const request = (path: string, body?: unknown) => new Promise<any>((resolve, reject) => {
    const next = ++id; const timer = setTimeout(() => reject(new Error('sidecar_timeout')), 10000);
    pending.set(next, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ id: next, path, ...(body === undefined ? {} : { body }) }) + '\n');
  });
  const session = await request('/session'); assert.equal(session.status, 200);
  assert.equal(JSON.stringify(session).includes('Token'), false);
  assert.equal((await request('/messages?conversationId=unshared&threadId=private')).status, 403);
  assert.equal((await request('/sync?conversationId=unshared&threadId=private')).status, 403);
  assert.equal((await request('https://untrusted.invalid')).status, 503);
  const scope = session.value.scopes[0];
  const syncPath = `/sync?${new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId })}`;
  const baseline = await request(syncPath); assert.equal(baseline.status, 200); assert.equal(baseline.value.reset, true);
  const body = { conversationId: scope.conversationId, threadId: scope.threadId, text: '桌面接口验证', clientEventId: 'desktop-retry-001' };
  assert.equal((await request('/messages', body)).status, 201);
  assert.equal((await request('/messages', body)).value.duplicate, true);
  const delta = await request(`${syncPath}&cursor=${encodeURIComponent(baseline.value.cursor)}`);
  assert.equal(delta.status, 200); assert.equal(delta.value.reset, false);
  assert.deepEqual(delta.value.messages.map((m: { text: string }) => m.text), [body.text]);
  await request('/messages', { ...body, text: '请调研一下桌面通知。', clientEventId: 'desktop-notice-001' });
  const deadline = setTimeout(() => observed({ error: 'notification_timeout' }), 12000);
  const notice = await incoming; clearTimeout(deadline);
  assert.deepEqual(notice, { conversationId: scope.conversationId, threadId: scope.threadId });
  child.stdin.end(); assert.equal(await exited, 0);
});
