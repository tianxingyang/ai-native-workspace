import { setTimeout as delay } from 'node:timers/promises';
import { DEV } from '../src/dev-fixture.js';
import type { Message, Run } from '../src/contracts.js';
import { requestJson } from '../src/http.js';
import { processPair } from './process-pair.js';

const provider = process.argv.includes('--pi-mock') ? 'pi-mock' : 'fake';
const pair = await processPair(provider);
try {
  const scope = { conversationId: DEV.conversationId, threadId: DEV.threadId };
  const url = pair.control.url;
  const post = (text: string, clientEventId: string) => requestJson<{ message: Message }>(url, DEV.humanToken, '/messages', { ...scope, text, clientEventId });
  await post('午饭吃什么？', 'demo-quiet');
  await post('请调研一下插件的取消确认与成员身份边界', 'demo-research');
  await post('我先继续讨论界面。', 'demo-chat');
  const query = new URLSearchParams(scope);
  let result: Run | undefined;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { runs } = await requestJson<{ runs: Run[] }>(url, DEV.humanToken, `/runs?${query}`);
    result = runs[0];
    if (result && ['completed', 'failed', 'unknown', 'stopped'].includes(result.status)) break;
    await delay(25);
  }
  if (result?.status !== 'completed') throw new Error(`demo_failed: ${JSON.stringify(result)}`);
  const { messages } = await requestJson<{ messages: Message[] }>(url, DEV.humanToken, `/messages?${query}`);
  console.log(JSON.stringify({ provider, controlPid: pair.control.pid, workerPid: pair.worker.pid, status: result.status, runId: result.id, receiptId: result.receiptId, eventKinds: result.events.map(e => e.kind), messages: messages.map(m => ({ author: m.authorId, thread: m.threadId, text: m.text, result: m.result })) }, null, 2));
} finally { await pair.dispose(); }
