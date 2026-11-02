import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

interface Ready { url: string; pid: number; service: string }
async function sparePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('no_port');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}
function cleanEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PI_OFFLINE: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
  // No inherited model, cloud, database, GitHub or control-plane administrator secrets.
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...extra };
}
function start(entry: URL, env: Record<string, string>, cwd: string): { process: ChildProcess; ready: Promise<Ready> } {
  const child = spawn(process.execPath, [fileURLToPath(entry), '--dev-fixture'], { cwd, env: cleanEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise<Ready>((resolve, reject) => {
    let buffer = '', errors = '';
    const timeout = setTimeout(() => { reject(new Error(`service_start_timeout: ${errors}`)); }, 15000);
    child.stderr!.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`service_exited_${code}: ${errors}`)); });
    child.stdout!.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.ready) { clearTimeout(timeout); resolve(value); }
        } catch { /* SDK diagnostics are not readiness messages. */ }
      }
    });
  });
  return { process: child, ready };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}
export async function processPair(provider: 'fake' | 'pi-mock') {
  const workspace = await mkdtemp(join(tmpdir(), 'coseat-process-'));
  const workerPort = await sparePort();
  const control = start(new URL('../src/control/main.js', import.meta.url), { COSEAT_CONTROL_PORT: '0', COSEAT_WORKER_URL: `http://127.0.0.1:${workerPort}` }, workspace);
  let worker: ReturnType<typeof start> | undefined;
  const dispose = async () => {
    if (worker) await stop(worker.process);
    await stop(control.process);
    // Only remove the freshly created, verified temporary directory.
    const root = resolve(tmpdir()) + sep;
    if (!resolve(workspace).startsWith(root) || !workspace.includes('coseat-process-')) throw new Error('unexpected_temp_path');
    await rm(workspace, { recursive: true, force: true });
  };
  try {
    const controlReady = await control.ready;
    worker = start(new URL('../src/worker/main.js', import.meta.url), { COSEAT_WORKER_PORT: String(workerPort), COSEAT_CONTROL_URL: controlReady.url, COSEAT_PROVIDER: provider }, workspace);
    const workerReady = await worker.ready;
    return { control: controlReady, worker: workerReady, dispose };
  } catch (error) { await dispose(); throw error; }
}
