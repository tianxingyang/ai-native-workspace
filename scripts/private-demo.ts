import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { requestJson } from '../src/http.js';
import { terminal, type Run } from '../src/contracts.js';
import { SnapshotStore } from '../src/private/store.js';
import { cleanEnvironment } from './process-pair.js';

// Explicit synthetic local demo; never export these values to a real deployment.
// Ephemeral test-only values, passed in child environments and discarded at exit.
const ownerToken = randomBytes(32).toString('hex');
const agentToken = randomBytes(32).toString('hex');
const provider = process.argv.includes('--pi-mock') ? 'pi-mock' : 'fake';
const directory = await mkdtemp(join(tmpdir(), 'coseat-private-demo-'));
const processes: ChildProcess[] = [];
const logs: string[] = [];
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited;
}
function start(entry: URL, configPath: string, cwd: string, env: Record<string, string>, readyEvent: string) {
  const child = spawn(process.execPath, [fileURLToPath(entry)], { cwd, env: cleanEnvironment({ ...env, COSEAT_CONFIG: configPath }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  return { child, ready: new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('private_demo_start_timeout')), 15000);
    let buffer = '';
    child.once('error', () => { clearTimeout(timer); reject(new Error('private_demo_start_failed')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('private_demo_early_exit')); });
    child.stderr!.on('data', chunk => logs.push(chunk.toString()));
    child.stdout!.on('data', chunk => {
      logs.push(chunk.toString()); buffer += chunk.toString();
      if (buffer.includes(`"event":"${readyEvent}"`)) { clearTimeout(timer); resolve(); }
    });
  }) };
}
try {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const controlDir = join(directory, 'control'), workerDir = join(directory, 'worker');
  await mkdir(controlDir); await mkdir(workerDir);
  const scope = { conversationId: 'trial-room', threadId: 'research' };
  const databasePath = join(controlDir, 'state.sqlite');
  const controlConfig = join(controlDir, 'config.json'), workerConfig = join(workerDir, 'config.json');
  await writeFile(controlConfig, JSON.stringify({ version: 2, mode: 'private-mock', port, databasePath, researchMemberId: 'agent-demo',
    members: [{ id: 'owner-demo', kind: 'human', name: 'Owner', tokenEnv: 'COSEAT_OWNER_TOKEN', tokenExpiresAt: Date.now() + 3600000, scopes: [scope] }, { id: 'agent-demo', kind: 'agent', name: 'Agent', tokenEnv: 'COSEAT_AGENT_TOKEN', tokenExpiresAt: Date.now() + 3600000, scopes: [scope] }],
    grants: ['owner-demo', 'agent-demo'].map(memberId => ({ id: `grant-${memberId}`, memberId, ...scope, revision: 1, actions: ['read', 'send', 'claim', 'request_approval', 'cancel'], expiresAt: Date.now() + 3600000 })) }));
  await writeFile(workerConfig, JSON.stringify({ version: 1, mode: 'private-mock', controlUrl: url, memberId: 'agent-demo', tokenEnv: 'COSEAT_AGENT_TOKEN', provider, workspace: workerDir }));
  const control = start(new URL('../src/private/control-main.js', import.meta.url), controlConfig, controlDir, { COSEAT_OWNER_TOKEN: ownerToken, COSEAT_AGENT_TOKEN: agentToken }, 'control_ready');
  await control.ready;
  const worker = start(new URL('../src/private/worker-main.js', import.meta.url), workerConfig, workerDir, { COSEAT_AGENT_TOKEN: agentToken }, 'worker_ready');
  await worker.ready;
  await requestJson(url, ownerToken, '/messages', { ...scope, text: '请调研一下插件协议', clientEventId: 'private-demo-source' });
  let run: Run | undefined;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await requestJson<{ runs: Run[] }>(url, ownerToken, `/runs?${new URLSearchParams(scope)}`);
    run = result.runs[0]; if (run && terminal(run.status)) break; await delay(100);
  }
  if (run?.status !== 'completed' || !run.receiptId) throw new Error('private_demo_not_completed');
  await stop(worker.child); await stop(control.child);
  const store = new SnapshotStore(databasePath);
  try {
    const saved = store.load<{ state: { runs: [string, Run][] } }>();
    if (saved?.state.runs.find(([id]) => id === run!.id)?.[1].receiptId !== run.receiptId) throw new Error('receipt_not_durable');
  } finally { store.close(); }
  if (logs.some(line => line.includes(ownerToken) || line.includes(agentToken))) throw new Error('secret_in_logs');
  console.log(JSON.stringify({ mode: 'private-mock', provider, controlPid: control.child.pid, workerPid: worker.child.pid, workerInboundPort: null, status: run.status, durableReceipt: true, logsContainTokens: false, runId: run.id, receiptId: run.receiptId }, null, 2));
} finally {
  for (const child of processes.reverse()) await stop(child);
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('coseat-private-demo-')) throw new Error('unexpected_temp_path');
  await rm(directory, { recursive: true, force: true });
}
