import { resolve } from 'node:path';
import { DEV, requireDevMode } from '../dev-fixture.js';
import { listen } from '../http.js';
import { fakeExecution } from './fake.js';
import { piExecution } from './pi.js';
import { fixturePiModel } from './pi-fixture-model.js';
import { LocalRuntime } from './runtime.js';
import { workerService } from './service.js';

requireDevMode();
const provider = process.env.COSEAT_PROVIDER ?? 'fake';
if (!['fake', 'pi-mock'].includes(provider)) throw new Error('Only fake and pi-mock are enabled; live model calls require separate explicit configuration and authorization.');
const runtime = new LocalRuntime({
  provider, version: provider === 'fake' ? '0.1.0' : '1.4.0', memberId: DEV.agentId,
  controlUrl: process.env.COSEAT_CONTROL_URL ?? 'http://127.0.0.1:4317', memberToken: DEV.agentToken,
  execute: provider === 'fake' ? fakeExecution(100) : piExecution(fixturePiModel(), resolve(process.cwd(), '.local', 'worker')),
});
const service = workerService(runtime, DEV.runtimeToken);
const url = await listen(service, Number(process.env.COSEAT_WORKER_PORT ?? '4318'));
console.log(JSON.stringify({ ready: true, service: 'worker', url, pid: process.pid, provider }));
process.on('SIGTERM', () => { void runtime.close().finally(() => service.close()); });
