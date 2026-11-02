import { OutboundWorker } from '../src/private/outbound-worker.js';
import { parseWorkerConfig, readConfiguration } from '../src/private/config.js';
import { fakeExecution } from '../src/worker/fake.js';

// Demo-only delay makes actual in-flight cancellation observable. No live model.
const worker = new OutboundWorker(parseWorkerConfig(readConfiguration(), process.env), fakeExecution(5000));
process.on('SIGINT', () => worker.requestStop());
process.on('SIGTERM', () => worker.requestStop());
process.on('message', message => { if (message === 'stop') worker.requestStop(); });
process.on('disconnect', () => worker.requestStop());
process.send?.({ ready: true });
await worker.run();
await worker.close();
process.disconnect?.();
