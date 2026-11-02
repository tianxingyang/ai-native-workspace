import assert from 'node:assert/strict';
import test from 'node:test';
import { processPair } from '../scripts/process-pair.js';
import { requestJson } from '../src/http.js';
import { DEV } from '../src/dev-fixture.js';
import type { Message, Run } from '../src/contracts.js';
import { query, scope, waitFor } from './helpers.js';

for (const provider of ['fake', 'pi-mock'] as const) {
  test(`two independent processes complete the ${provider} source-thread loop`, { timeout: 25000 }, async t => {
    const pair = await processPair(provider); t.after(() => pair.dispose());
    assert.notEqual(pair.control.pid, pair.worker.pid);
    assert.notEqual(pair.control.pid, process.pid);
    assert.notEqual(pair.worker.pid, process.pid);
    const { message } = await requestJson<{ message: Message }>(pair.control.url, DEV.humanToken, '/messages', { ...scope, text: '请调研一下插件接口', clientEventId: 'process-research' });
    const run = await waitFor(async () => {
      const { runs } = await requestJson<{ runs: Run[] }>(pair.control.url, DEV.humanToken, `/runs?${query}`);
      return runs.find(r => ['completed', 'failed', 'unknown'].includes(r.status));
    }, 12000);
    assert.equal(run.status, 'completed', JSON.stringify(run.events));
    const { messages } = await requestJson<{ messages: Message[] }>(pair.control.url, DEV.humanToken, `/messages?${query}`);
    const results = messages.filter(m => m.origin === 'research');
    assert.equal(results.length, 1);
    assert.equal(results[0]?.sourceMessageId, message.id);
    assert.equal(results[0]?.result?.evidence, 'synthetic-fixture');
  });
}
