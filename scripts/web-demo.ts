import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseControlConfig } from '../src/private/config.js';
import { PrivateEngine } from '../src/private/engine.js';
import { privateService } from '../src/private/service.js';
import { SnapshotStore } from '../src/private/store.js';
import { close, listen } from '../src/http.js';
import { cleanEnvironment } from './process-pair.js';

export async function startWebDemo(options: { port?: number; lifetimeMs?: number; web?: boolean; credentialFile?: boolean } = {}) {
  const lifetimeMs = options.lifetimeMs ?? 30 * 60 * 1000;
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 30 * 60 * 1000) throw new Error('invalid_demo_lifetime');
  const directory = await mkdtemp(join(tmpdir(), 'coseat-web-demo-'));
  const ownerToken = randomBytes(32).toString('hex'), agentToken = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + lifetimeMs;
  const scopes = [{ conversationId: '产品讨论', threadId: '日常交流' }, { conversationId: '研发讨论', threadId: '插件协议' }];
  const env = { COSEAT_OWNER_TOKEN: ownerToken, COSEAT_AGENT_TOKEN: agentToken };
  const config = parseControlConfig({ version: 2, mode: 'private-mock', databasePath: join(directory, 'state.sqlite'), port: 0, researchMemberId: 'demo-researcher',
    members: [{ id: 'demo-owner', kind: 'human', name: '林可（演示）', tokenEnv: 'COSEAT_OWNER_TOKEN', tokenExpiresAt: expiresAt, scopes }, { id: 'demo-researcher', kind: 'agent', name: '研究伙伴', tokenEnv: 'COSEAT_AGENT_TOKEN', tokenExpiresAt: expiresAt, scopes }],
    grants: ['demo-owner', 'demo-researcher'].flatMap(memberId => scopes.map((scope, i) => ({ id: `grant-${memberId}-${i}`, memberId, ...scope, revision: 1, actions: memberId === 'demo-owner' ? ['read', 'send', 'cancel'] : ['read', 'send', 'claim', 'request_approval'], expiresAt }))) }, env);
  const store = new SnapshotStore(config.databasePath), engine = new PrivateEngine(store, config.control);
  const service = privateService(engine, { web: options.web ?? true });
  let worker: ChildProcess | undefined, url = '', stopped: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => stopped ??= (async () => {
    if (timer) clearTimeout(timer);
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const child = worker;
      await new Promise<void>(resolveStop => {
        const force = setTimeout(() => child.kill(), 7000);
        child.once('exit', () => { clearTimeout(force); resolveStop(); });
        if (child.connected) child.send('stop'); else child.kill();
      });
    }
    if (service.listening) {
      // Browsers may keep speculative connections open without ever sending a request.
      // Drain completed API work, then bound shutdown of this disposable local host.
      const closing = close(service);
      const force = setTimeout(() => service.closeAllConnections(), 1500);
      try { await closing; } finally { clearTimeout(force); }
    }
    store.close();
    const resolved = resolve(directory);
    if (!resolved.startsWith(resolve(tmpdir()) + sep) || !resolved.includes('coseat-web-demo-')) throw new Error('unexpected_demo_path');
    await rm(resolved, { recursive: true, force: true });
  })();
  try {
    url = await listen(service, options.port ?? 0);
    const workerDir = join(directory, 'worker'); await mkdir(workerDir);
    const workerConfig = join(directory, 'worker.json');
    await writeFile(workerConfig, JSON.stringify({ version: 1, mode: 'private-mock', controlUrl: url, memberId: 'demo-researcher', tokenEnv: 'COSEAT_AGENT_TOKEN', provider: 'fake', workspace: workerDir }));
    const credentialPath = join(directory, 'local-demo-access.txt');
    if (options.credentialFile !== false) await writeFile(credentialPath, ownerToken, { mode: 0o600 });
    worker = spawn(process.execPath, [fileURLToPath(new URL('./web-worker-demo.js', import.meta.url))], { cwd: workerDir,
      env: cleanEnvironment({ COSEAT_CONFIG: workerConfig, COSEAT_AGENT_TOKEN: agentToken }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const child = worker;
    // Discard diagnostics here; never stream inherited environment/configuration into logs.
    child.stdout?.resume(); child.stderr?.resume();
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('demo_worker_timeout')), 10000);
      child.once('message', () => { clearTimeout(timeout); resolveReady(); });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('demo_worker_failed')); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('demo_worker_exited')); });
    });
    timer = setTimeout(() => void stop(), lifetimeMs);
    return { url, ownerToken, engine, directory, credentialPath, expiresAt, controlPid: process.pid, workerPid: child.pid, stop };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const demo = await startWebDemo();
  console.log(`CoSeat 本地模拟演示：${demo.url}`);
  console.log(`临时访问凭据文件：${demo.credentialPath}`);
  console.log('请在本机打开凭据文件，粘贴到连接界面。30 分钟后自动停止并清理演示数据；Ctrl+C 可提前停止。');
  process.on('SIGINT', () => void demo.stop()); process.on('SIGTERM', () => void demo.stop());
}
