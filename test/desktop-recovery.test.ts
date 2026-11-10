import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { recoveryConnection } from '../scripts/desktop-recovery.js';
import { startWebDemo } from '../scripts/web-demo.js';
import { cleanEnvironment } from '../scripts/process-pair.js';

test('recovery bootstrap accepts only bounded loopback native-launch connections', () => {
  const valid = { url: 'http://127.0.0.1:12345', ownerToken: 'a'.repeat(64), expiresAt: 2000 };
  assert.deepEqual(recoveryConnection(valid, 1000), valid);
  for (const bad of [null, [], { ...valid, unknown: true }, { ...valid, ownerToken: 'bearer\r\n' },
    { ...valid, expiresAt: 1000 }, { ...valid, expiresAt: 1801001 },
    ...['https://example.com', 'http://localhost:12345', 'http://127.0.0.1:65536',
      'http://127.0.0.1:0123', 'http://127.0.0.1:12345/', 'http://user:secret@127.0.0.1:12345',
      'http://127.0.0.1:12345?token=secret'].map(url => ({ ...valid, url }))]) {
    assert.throws(() => recoveryConnection(bad, 1000), /^Error: invalid_recovery_bootstrap$/);
  }
});

function sidecar(bootstrap: unknown) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/desktop-host.js', import.meta.url)), '--recovery-acceptance'],
    { env: cleanEnvironment({}), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', data => { diagnostics += data.toString(); });
  child.stderr.on('data', data => { diagnostics += data.toString(); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const pending = new Map<number, (value: any) => void>(); let id = 0;
  createInterface({ input: child.stdout }).on('line', line => { const data = JSON.parse(line); pending.get(data.id)?.(data); pending.delete(data.id); });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(bootstrap) + '\n');
  return { exited, diagnostics: () => diagnostics,
    stop: async () => { child.stdin.end(); await exited; },
    request: (path: string, body?: unknown) => new Promise<any>((resolve, reject) => {
      const next = ++id, timer = setTimeout(() => reject(new Error('sidecar_timeout')), 10000);
      pending.set(next, value => { clearTimeout(timer); resolve(value); });
      child.stdin.write(JSON.stringify({ id: next, path, ...(body === undefined ? {} : { body }) }) + '\n');
    }),
  };
}

test('separate sidecar processes reconnect to the same service without persisting credentials or resetting consumption', async t => {
  const demo = await startWebDemo({ web: false, credentialFile: false }); t.after(() => demo.stop());
  const bootstrap = { url: demo.url, ownerToken: demo.ownerToken, expiresAt: demo.expiresAt };
  const first = sidecar(bootstrap); t.after(() => first.stop());
  const session = await first.request('/session'); assert.equal(session.status, 200);
  const scope = session.value.scopes[0], query = new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId });
  const sent = await first.request('/messages', { ...Object.fromEntries(query), text: '跨进程恢复', clientEventId: 'restart-send' });
  assert.equal(sent.status, 201);
  const snapshot = await first.request(`/sync?${query}`);
  await first.stop(); assert.equal(await first.exited, 0);
  const second = sidecar(bootstrap); t.after(() => second.stop());
  const next = await second.request('/session'); assert.equal(next.status, 200);
  assert.equal(next.value.scopes[0].outboxKey, scope.outboxKey);
  const delta = await second.request(`/sync?${query}&cursor=${encodeURIComponent(snapshot.value.cursor)}`);
  assert.equal(delta.status, 200); assert.equal(delta.value.reset, false); assert.deepEqual(delta.value.messages, []);
  const duplicate = await second.request('/messages', { ...Object.fromEntries(query), text: '跨进程恢复', clientEventId: 'restart-send' });
  assert.equal(duplicate.value.message.id, sent.value.message.id); assert.equal(duplicate.value.duplicate, true);
  assert.equal((await second.request('/messages?conversationId=unshared&threadId=private')).status, 403);
  assert.equal((await second.request('https://untrusted.invalid')).status, 503);
  assert.equal(first.diagnostics().includes(demo.ownerToken), false); assert.equal(second.diagnostics().includes(demo.ownerToken), false);
  await second.stop(); assert.equal((await fetch(`${demo.url}/session`, { headers: { authorization: `Bearer ${demo.ownerToken}` } })).status, 200);
});

test('native recovery does not renew the original deadline and never accepts a second bootstrap as IPC', async t => {
  const demo = await startWebDemo({ web: false, credentialFile: false }); t.after(() => demo.stop());
  const host = sidecar({ url: demo.url, ownerToken: demo.ownerToken, expiresAt: Date.now() + 1500 }); t.after(() => host.stop());
  assert.equal((await host.request('/session')).status, 200);
  assert.equal((await host.request('/recovery', { url: demo.url, ownerToken: demo.ownerToken })).status, 503);
  await new Promise(resolve => setTimeout(resolve, 1600));
  for (const [path, body] of [['/session', undefined], ['/messages', {}], ['/runs/test/cancel', {}]] as const) {
    const denied = await host.request(path, body); assert.equal(denied.status, 401); assert.equal(denied.value.error, 'demo_expired');
  }
});

test('invalid native bootstrap fails closed without echoing credentials', async () => {
  const secret = 'b'.repeat(64);
  const host = sidecar({ url: 'https://example.invalid', ownerToken: secret, expiresAt: Date.now() + 10000 });
  assert.equal(await host.exited, 1); assert.equal(host.diagnostics().includes(secret), false);
});
