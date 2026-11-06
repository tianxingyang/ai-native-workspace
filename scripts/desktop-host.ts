import { createInterface } from 'node:readline';
import { startWebDemo } from './web-demo.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { recoveryConnection } from './desktop-recovery.js';

// Web IPC has no URL/config/credential input. A native launcher may opt into
// bounded loopback acceptance via the first stdin line. HTTP still authorizes.
export function permittedRequest(path: unknown, body: unknown): path is string {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  if (body !== undefined) return ['/messages', '/read-position', '/threads', '/conversations', '/conversations/rename', '/memberships/add', '/memberships/remove', '/memberships/leave'].includes(path) || /^\/runs\/[a-zA-Z0-9_-]{1,100}\/cancel$/.test(path)
    || /^\/messages\/[a-zA-Z0-9_-]{1,100}\/(edit|retract)$/.test(path);
  if (path === '/session' || path === '/conversations/options') return true;
  const url = new URL(path, 'http://127.0.0.1');
  const keys = [...url.searchParams.keys()].sort().join(',');
  if (url.origin !== 'http://127.0.0.1' || !url.searchParams.get('conversationId') || !url.searchParams.get('threadId')) return false;
  if (['/messages/receipt', '/messages/change-receipt'].includes(url.pathname)) {
    return keys === 'clientEventId,conversationId,threadId' && Boolean(url.searchParams.get('clientEventId'));
  }
  if (url.hash) return false;
  if (url.pathname === '/attachments') return keys === 'conversationId,expectedMembershipGeneration,messageId,threadId'
    && Boolean(url.searchParams.get('messageId')) && Boolean(url.searchParams.get('expectedMembershipGeneration'));
  return ['/messages', '/runs', '/sync', '/memberships'].includes(url.pathname)
    && (keys === 'conversationId,threadId' || (url.pathname === '/sync' && keys === 'conversationId,cursor,threadId' && Boolean(url.searchParams.get('cursor'))));
}

export async function startDesktopHost() {
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  const external = process.argv.includes('--recovery-acceptance');
  let demo;
  try {
    if (external) {
      const first = await lines.next();
      if (first.done || Buffer.byteLength(first.value) > 8192) throw new Error('invalid_recovery_bootstrap');
      const connection = recoveryConnection(JSON.parse(first.value));
      // The launcher owns the stable service; client exit never renews credentials
      // or destroys that service. Default disposable demos still stop as before.
      demo = { ...connection, stop: async () => {} };
    } else { demo = await startWebDemo({ web: false, credentialFile: false }); }
  } catch { input.close(); process.stdin.destroy(); throw new Error('desktop_start_failed'); }
  let stopped = false, polling = false;
  const seen = new Set<string>();
  const request = async (path: string, body?: unknown) => {
    if (Date.now() >= demo.expiresAt) return { status: 401, value: { error: 'demo_expired' } };
    const response = await fetch(new URL(path, demo.url), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${demo.ownerToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, value: await response.json() };
  };
  const timer = setInterval(() => void (async () => {
    if (polling || stopped || Date.now() >= demo.expiresAt) return;
    polling = true;
    try {
      const session = await request('/session');
      if (session.status !== 200) return;
      for (const scope of session.value.scopes) {
        const data = await request(`/messages?${new URLSearchParams({ conversationId: scope.conversationId, threadId: scope.threadId })}`);
        if (data.status !== 200) continue;
        for (const message of data.value.messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          if (message.authorId !== session.value.member.id) output({ event: 'message', expiresAt: demo.expiresAt, scope: { conversationId: scope.conversationId, threadId: scope.threadId } });
        }
      }
    } catch { /* The next UI request reports connection failure honestly. */ }
    finally { polling = false; }
  })(), 1200);
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(timer); input.close();
    await demo.stop(); process.stdin.destroy();
  };
  input.on('close', () => void stop());
  process.stdout.on('error', () => void stop());
  process.on('SIGTERM', () => void stop());
  void (async () => { for await (const line of lines) {
    void (async () => {
    let id: unknown;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error('invalid_request');
      const data = JSON.parse(line); id = data.id;
      if (data.command === 'stop') { await stop(); return; }
      if (!Number.isSafeInteger(id) || !permittedRequest(data.path, data.body)) throw new Error('invalid_request');
      output({ id, ...await request(data.path, data.body) });
    } catch { output({ id, status: 503, value: { error: 'desktop_request_failed' } }); }
    })();
  } await stop(); })().catch(() => void stop());
  return { stop };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await startDesktopHost(); } catch { process.exitCode = 1; }
}
