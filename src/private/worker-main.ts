import { parseWorkerConfig, readConfiguration, safeLog } from './config.js';
import { OutboundWorker } from './outbound-worker.js';

try {
  const config = parseWorkerConfig(readConfiguration(), process.env);
  // Only this process is put offline; no host settings are changed.
  process.env.PI_OFFLINE = '1';
  const execute = config.provider === 'fake'
    ? (await import('../worker/fake.js')).fakeExecution(100)
    : (await import('../worker/pi.js')).piExecution((await import('../worker/pi-fixture-model.js')).fixturePiModel(), config.workspace);
  const worker = new OutboundWorker(config, execute);
  process.on('SIGINT', () => worker.requestStop()); process.on('SIGTERM', () => worker.requestStop());
  safeLog('worker_ready');
  await worker.run(() => safeLog('worker_disconnected'));
  await worker.close(); safeLog('worker_stopped');
} catch { safeLog('startup_failed'); process.exitCode = 1; }
