import { DEV, developmentGrants, fixtureSources, members, requireDevMode } from '../dev-fixture.js';
import { listen } from '../http.js';
import { ControlState } from './state.js';
import { RuntimeClient } from './runtime-client.js';
import { controlService } from './service.js';

requireDevMode();
const scope = { conversationId: DEV.conversationId, threadId: DEV.threadId };
const state = new ControlState({ members, grants: developmentGrants(), tokens: { [DEV.humanToken]: DEV.humanId, [DEV.agentToken]: DEV.agentId, [DEV.strangerToken]: 'guest' }, memberships: { alex: [scope], sam: [scope], guest: [] }, researchMemberId: DEV.agentId, sources: fixtureSources });
const runtime = new RuntimeClient(process.env.COSEAT_WORKER_URL ?? 'http://127.0.0.1:4318', DEV.runtimeToken);
const app = controlService(state, runtime);
const url = await listen(app.service, Number(process.env.COSEAT_CONTROL_PORT ?? '4317'));
console.log(JSON.stringify({ ready: true, service: 'control', url, pid: process.pid }));
process.on('SIGTERM', () => { app.stop(); app.service.close(); });
