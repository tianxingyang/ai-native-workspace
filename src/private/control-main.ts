import { listen, close } from '../http.js';
import { parseControlConfig, readConfiguration, safeLog } from './config.js';
import { PrivateEngine } from './engine.js';
import { privateService } from './service.js';
import { SnapshotStore } from './store.js';

try {
  const config = parseControlConfig(readConfiguration(), process.env);
  const store = new SnapshotStore(config.databasePath);
  const engine = new PrivateEngine(store, config.control, 10000, Date.now, process.argv.includes('--restored-backup'));
  const service = privateService(engine);
  try { await listen(service, config.port); } catch (error) { store.close(); throw error; }
  safeLog('control_ready');
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void close(service).finally(() => store.close());
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch { safeLog('startup_failed'); process.exitCode = 1; }
